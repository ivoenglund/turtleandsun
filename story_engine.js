// story_engine.js
//
// Video Engine — story generator (Video Engine spec 2026-07-04, component 1).
//
// Generates short-video story records via an LLM: hook text, 1-3 scenes with
// durations + per-scene video prompts, ready for the review queue.
//
// LLM path: fal.ai `openrouter/router` endpoint (fal-ai/any-llm is deprecated).
// Same FAL_KEY + @fal-ai/client the app already uses for Kling — no new
// provider account. Charged per token; ~$0.001-0.01 per story depending on
// model. Model is configurable via system_settings key 'story_llm_model'.

const { fal } = require('@fal-ai/client');

const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const ROUTER_ENDPOINT = 'openrouter/router';

const STORY_TYPES = [
  'before_after',   // real pet photo -> transformed reveal (Kling start+end frame)
  'pet_pov',        // the pet narrates / reacts
  'mini_drama',     // tiny 2-scene story with a punchline
  'demo',           // the calendar itself in use, funny + useful
  'celebration',    // birthday / occasion moment
  'absurd_comedy',  // unexpected, loop-friendly gag
];

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------
function buildSystemPrompt() {
  return [
    'You are the story writer for Turtle & Sun, a brand that sells a personalised',
    'FRIDGE BIRTHDAY CALENDAR (a beautiful A2 paper wall calendar showing the',
    "family's own birthdays and occasions, often including pets). We publish",
    'short vertical AI-generated videos (TikTok / Reels / Shorts) that are funny',
    'AND useful, built around pets, family occasions, and the calendar.',
    '',
    'Your job: write ONE story for the first part of a video. Part 2 (the CTA',
    'end-card) already exists and is appended later — do NOT write a CTA scene.',
    '',
    'Hard rules:',
    '- Part 1 total length 5-8 seconds, split into 1-3 scenes.',
    '- Each scene gets a `video_prompt`: a rich, self-contained text-to-video /',
    '  image-to-video prompt in English. Vertical 9:16. Describe subjects,',
    '  action, setting, lighting, camera. Repeat the provided ELEMENT',
    '  descriptions inside every scene prompt that uses them, so the video',
    '  model renders them consistently across scenes.',
    '- NO on-screen text inside the video prompts (the hook text is burned in',
    '  separately during assembly).',
    '- `hook` is the on-screen hook text: max 8 words, English, curiosity or',
    '  humour, no emojis, no hashtags.',
    '- The story should make the viewer feel something in the first second',
    '  (algorithm rewards % watched; the video loops).',
    '- Keep it brand-safe, warm, family-friendly. Humour over hard selling.',
    '',
    'Respond with ONLY a JSON object, no markdown fences, matching exactly:',
    '{',
    '  "hook": "string, max 8 words",',
    `  "story_type": "one of: ${STORY_TYPES.join(', ')}",`,
    '  "mood": "one short word, e.g. funny | heartfelt | absurd",',
    '  "scenes": [',
    '    { "duration_s": <integer 3-8>, "video_prompt": "string" }',
    '  ],',
    '  "notes": "optional: anything the producer should know"',
    '}',
    'Scene durations must sum to 5-8 seconds.',
  ].join('\n');
}

function buildUserPrompt({ situationText, elements, ctaCard, generator }) {
  const lines = [];
  lines.push('SITUATION (build the story around this):');
  lines.push(situationText || 'A funny everyday moment at home involving the fridge calendar.');
  lines.push('');
  lines.push('ELEMENTS (recurring cast/props — use them, keep them consistent):');
  if (elements && elements.length) {
    for (const el of elements) {
      const bits = [`- ${el.name} (${el.kind})`];
      if (el.description) bits.push(`look: ${el.description}`);
      if (el.personality) bits.push(`personality: ${el.personality}`);
      lines.push(bits.join(' — '));
    }
  } else {
    lines.push('- (none provided — invent a charming pet and a cosy kitchen)');
  }
  lines.push('');
  if (ctaCard) {
    lines.push(`TODAY'S OFFER (part 2 end-card, for tone alignment only — do NOT write it): ${ctaCard.label}${ctaCard.cta_text ? ' — "' + ctaCard.cta_text + '"' : ''}`);
    lines.push('');
  }
  if (generator === 'flow' || generator === 'gemini') {
    lines.push('CONSTRAINT: this will be generated as ONE single clip (manual path) — use exactly 1 scene.');
  } else {
    lines.push('CONSTRAINT: 1-3 scenes (multi-scene is fine; generated via Kling multi-prompt).');
  }
  lines.push('');
  lines.push('Write the story JSON now.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON extraction — tolerant of fences / leading prose.
// ---------------------------------------------------------------------------
function extractJson(text) {
  if (!text) throw new Error('LLM returned empty output');
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('No JSON object found in LLM output');
  }
  return JSON.parse(t.slice(first, last + 1));
}

function validateStory(story) {
  const errors = [];
  if (!story.hook || typeof story.hook !== 'string') errors.push('missing hook');
  if (story.hook && story.hook.split(/\s+/).length > 12) errors.push('hook too long');
  if (!Array.isArray(story.scenes) || story.scenes.length < 1 || story.scenes.length > 3) {
    errors.push('scenes must be an array of 1-3');
  } else {
    let total = 0;
    for (const s of story.scenes) {
      const d = Number(s.duration_s);
      if (!Number.isFinite(d) || d < 2 || d > 10) errors.push(`bad scene duration: ${s.duration_s}`);
      if (!s.video_prompt || String(s.video_prompt).length < 40) errors.push('scene video_prompt too short');
      total += d;
    }
    if (total < 4 || total > 10) errors.push(`scene durations sum to ${total}s (want 5-8)`);
  }
  if (!STORY_TYPES.includes(story.story_type)) story.story_type = 'mini_drama';
  return errors;
}

// ---------------------------------------------------------------------------
// Main entry. Returns { story, model, costUsd, raw }.
// One automatic retry on parse/validation failure.
// ---------------------------------------------------------------------------
async function generateStory({ situationText, elements, ctaCard, generator, model }) {
  const useModel = model || DEFAULT_MODEL;
  const systemPrompt = buildSystemPrompt();
  const prompt = buildUserPrompt({ situationText, elements, ctaCard, generator });

  let lastErr = null;
  let totalCost = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await fal.subscribe(ROUTER_ENDPOINT, {
        input: {
          model: useModel,
          system_prompt: systemPrompt,
          prompt,
          temperature: 0.9,
          max_tokens: 1500,
        },
      });
      const data = result?.data || {};
      if (data.error) throw new Error(`LLM error: ${data.error}`);
      totalCost += Number(data?.usage?.cost || 0);

      const story = extractJson(data.output);
      const errors = validateStory(story);
      if (errors.length) throw new Error('Story validation failed: ' + errors.join('; '));

      return { story, model: useModel, costUsd: totalCost, raw: data };
    } catch (err) {
      lastErr = err;
      if (attempt === 2) break;
    }
  }
  throw new Error(`Story generation failed after 2 attempts: ${lastErr.message}`);
}

// ---------------------------------------------------------------------------
// Part-1 video generation — accepted story -> Kling v3 text-to-video on fal.
// Single scene -> `prompt`; multiple scenes -> `multi_prompt` (XOR rule: never
// both — see _KLING_V3_REFERENCE.md). Vertical 9:16, native audio optional.
// Falls back to one concatenated prompt if the multi_prompt call is rejected.
// ---------------------------------------------------------------------------
const VIDEO_MODELS = {
  standard: {
    id: 'fal-ai/kling-video/v3/standard/text-to-video',
    label: 'Kling v3 Standard',
    usdPerSec: { audioOn: 0.126, audioOff: 0.084 },
  },
  pro: {
    id: 'fal-ai/kling-video/v3/pro/text-to-video',
    label: 'Kling v3 Pro',
    usdPerSec: { audioOn: 0.336, audioOff: 0.224 },
  },
};

function clampDuration(totalS) {
  return Math.min(Math.max(Math.round(totalS || 5), 3), 15);
}

function buildVideoInput(scenes, { generateAudio = true } = {}) {
  const list = (Array.isArray(scenes) ? scenes : []).filter(s => s && s.video_prompt);
  if (!list.length) throw new Error('Story has no scenes with video prompts');
  const totalS = clampDuration(list.reduce((a, s) => a + (Number(s.duration_s) || 5), 0));
  const base = {
    duration: String(totalS),
    aspect_ratio: '9:16',
    generate_audio: !!generateAudio,
    negative_prompt: 'blur, distort, low quality, text, watermark, subtitles',
    cfg_scale: 0.5,
    shot_type: 'customize',
  };
  if (list.length === 1) {
    return { input: { ...base, prompt: list[0].video_prompt }, totalS };
  }
  return {
    input: {
      ...base,
      multi_prompt: list.map(s => ({
        prompt: s.video_prompt,
        duration: String(clampDuration(Number(s.duration_s) || 5)),
      })),
    },
    totalS,
  };
}

function estimateVideoCost(tier, totalS, generateAudio) {
  const m = VIDEO_MODELS[tier] || VIDEO_MODELS.standard;
  return totalS * (generateAudio ? m.usdPerSec.audioOn : m.usdPerSec.audioOff);
}

async function generateStoryVideo({ scenes, tier = 'standard', generateAudio = true }) {
  const model = VIDEO_MODELS[tier] || VIDEO_MODELS.standard;
  const { input, totalS } = buildVideoInput(scenes, { generateAudio });

  const run = async (payload) => fal.subscribe(model.id, {
    input: payload,
    storageSettings: { expiresIn: 'never' },
  });

  let result;
  try {
    result = await run(input);
  } catch (err) {
    // Fallback: if multi_prompt was rejected, retry once as a single
    // concatenated prompt (keeps the pipeline alive if the shape changes).
    if (input.multi_prompt) {
      const { multi_prompt, ...rest } = input;
      const joined = multi_prompt.map((p, i) => `Shot ${i + 1} (${p.duration}s): ${p.prompt}`).join('\n');
      result = await run({ ...rest, prompt: joined });
    } else {
      throw err;
    }
  }

  const url = result?.data?.video?.url;
  if (!url) throw new Error('Video generation returned no URL');
  return {
    url,
    input,
    raw: result.data,
    modelId: model.id,
    totalS,
    estCostUsd: estimateVideoCost(tier, totalS, generateAudio),
  };
}

// ---------------------------------------------------------------------------
// Posting kit (spec component 8) — per-platform titles/descriptions/tags,
// LLM-written from the story record. The tracked ?ref= links are passed in
// and MUST appear in the texts (enforced after parsing, belt and braces).
// ---------------------------------------------------------------------------
const KIT_FIELDS = [
  'yt_title', 'yt_description', 'yt_keyword_tags',
  'tiktok_caption', 'tiktok_hashtags',
  'instagram_caption', 'instagram_hashtags', 'instagram_alt_text',
  'fb_caption',
];

function buildPostingKitPrompt({ story, situationText, ctaCard, links }) {
  return [
    'You write social media posting texts for Turtle & Sun, which sells a',
    'personalised FRIDGE BIRTHDAY CALENDAR (A2 paper wall calendar with the',
    "family's own birthdays, pets included). Tone: warm, funny, zero corporate.",
    '',
    'The video being posted (8-15s vertical, ends on an offer end-card):',
    `- Hook text on video: ${story.hook_text || story.hook || ''}`,
    `- Story: ${situationText || ''}`,
    `- Story type: ${story.story_type || ''} · mood: ${story.mood || ''}`,
    ctaCard ? `- Offer at the end: ${ctaCard.label}${ctaCard.cta_text ? ' — "' + ctaCard.cta_text + '"' : ''}` : '',
    '',
    'Tracked links (use EXACTLY as given, do not shorten or alter):',
    `- YouTube description link: ${links.yt}`,
    `- Facebook caption link: ${links.fb}`,
    '(TikTok/Instagram captions cannot carry clickable links — write "link in bio" there.)',
    '',
    'Respond with ONLY a JSON object, no markdown fences:',
    '{',
    '  "yt_title": "max 90 chars, curiosity-driven, no clickbait lies, may end with #Shorts",',
    '  "yt_description": "2-4 short lines. MUST contain the YouTube link. End with 3-5 #hashtags.",',
    '  "yt_keyword_tags": "8-12 comma-separated search keywords",',
    '  "tiktok_caption": "max 150 chars incl. \'link in bio\' nudge",',
    '  "tiktok_hashtags": "3-5 hashtags, space-separated, mix broad + niche",',
    '  "instagram_caption": "1-3 lines, ends with \'link in bio\' nudge",',
    '  "instagram_hashtags": "5-8 hashtags, space-separated",',
    '  "instagram_alt_text": "one factual sentence describing what is seen (accessibility)",',
    '  "fb_caption": "2-3 lines. MUST contain the Facebook link."',
    '}',
    'All texts in English.',
  ].filter(Boolean).join('\n');
}

async function generatePostingKit({ story, situationText, ctaCard, links, model }) {
  const useModel = model || DEFAULT_MODEL;
  const prompt = buildPostingKitPrompt({ story, situationText, ctaCard, links });

  let lastErr = null;
  let totalCost = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await fal.subscribe(ROUTER_ENDPOINT, {
        input: { model: useModel, prompt, temperature: 0.8, max_tokens: 1200 },
      });
      const data = result?.data || {};
      if (data.error) throw new Error(`LLM error: ${data.error}`);
      totalCost += Number(data?.usage?.cost || 0);
      const kit = extractJson(data.output);

      const missing = KIT_FIELDS.filter(f => typeof kit[f] !== 'string' || !kit[f].trim());
      if (missing.length) throw new Error('Posting kit missing fields: ' + missing.join(', '));

      // Enforce the tracked links even if the model dropped them.
      if (!kit.yt_description.includes(links.yt)) {
        kit.yt_description = kit.yt_description.trim() + '\n\n' + links.yt;
      }
      if (!kit.fb_caption.includes(links.fb)) {
        kit.fb_caption = kit.fb_caption.trim() + '\n\n' + links.fb;
      }
      if (kit.yt_title.length > 100) kit.yt_title = kit.yt_title.slice(0, 97) + '…';

      return { kit, model: useModel, costUsd: totalCost };
    } catch (err) {
      lastErr = err;
      if (attempt === 2) break;
    }
  }
  throw new Error(`Posting kit generation failed after 2 attempts: ${lastErr.message}`);
}

// ---------------------------------------------------------------------------
// Situation idea generator — bulk-writes NEW story situations for the library.
// The admin reviews, edits or deletes them in the Situations grid.
// ---------------------------------------------------------------------------
async function generateSituationIdeas({ existing = [], count = 10, themes = [], model }) {
  const useModel = model || DEFAULT_MODEL;
  const n = Math.min(Math.max(parseInt(count, 10) || 10, 1), 20);
  const themeList = (themes || []).filter(Boolean).slice(0, 20);
  const prompt = [
    'You invent story SITUATIONS for Turtle & Sun short videos. The product:',
    "a personalised FRIDGE BIRTHDAY CALENDAR (A2 paper wall calendar with the family's",
    'own birthdays and occasions, pets included). Videos are 8-15s, funny AND useful,',
    'built around pets, family occasions and the calendar on the fridge.',
    '',
    'A situation is ONE sentence: a concrete, filmable everyday moment where the',
    'calendar plays a role. Pets as protagonists work best. No camera directions.',
    '',
    themeList.length === 1
      ? `THEME: every idea must belong to the theme "${themeList[0]}".`
      : themeList.length > 1
        ? 'THEMES (spread the ideas across these; tag each idea with the theme used):\n' + themeList.map(t => '- ' + t).join('\n')
        : 'No theme constraint — free variation.',
    '',
    'ALREADY IN THE LIBRARY (do NOT repeat or closely paraphrase these):',
    ...existing.slice(0, 60).map(t => '- ' + t),
    '',
    `Write ${n} NEW, distinct situations. Vary occasion and angle (birthdays,`,
    'christmas, mothers/fathers day, name days, anniversaries, general everyday).',
    '',
    'Respond with ONLY a JSON object, no markdown fences:',
    '{ "ideas": [ { "text": "one-sentence situation", "occasion": "birthday|christmas|mothers-day|fathers-day|new-year|anniversary|general", "theme": "the theme this idea belongs to" } ] }',
  ].join('\n');

  let lastErr = null;
  let totalCost = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await fal.subscribe(ROUTER_ENDPOINT, {
        input: { model: useModel, prompt, temperature: 1.0, max_tokens: 2000 },
      });
      const data = result?.data || {};
      if (data.error) throw new Error(`LLM error: ${data.error}`);
      totalCost += Number(data?.usage?.cost || 0);
      const parsed = extractJson(data.output);
      const ideas = (Array.isArray(parsed.ideas) ? parsed.ideas : [])
        .filter(i => i && typeof i.text === 'string' && i.text.trim().length >= 20)
        .slice(0, n)
        .map(i => ({
          text: i.text.trim(),
          occasion: (i.occasion || 'general').trim(),
          theme: (i.theme || themeList[0] || '').trim() || null,
        }));
      if (!ideas.length) throw new Error('No usable ideas in LLM output');
      return { ideas, model: useModel, costUsd: totalCost };
    } catch (err) {
      lastErr = err;
      if (attempt === 2) break;
    }
  }
  throw new Error(`Idea generation failed after 2 attempts: ${lastErr.message}`);
}

module.exports = {
  DEFAULT_MODEL,
  ROUTER_ENDPOINT,
  STORY_TYPES,
  VIDEO_MODELS,
  KIT_FIELDS,
  buildPostingKitPrompt,
  generatePostingKit,
  generateSituationIdeas,
  buildSystemPrompt,
  buildUserPrompt,
  extractJson,
  validateStory,
  generateStory,
  buildVideoInput,
  estimateVideoCost,
  generateStoryVideo,
};
