// generation.js
//
// Generation provider abstraction.
//
// Purpose: route image, video, talking-pet, and voice-clone generation
// through a single module so that (1) the concept admin can pick any
// registered fal.ai model and only see the fields that model accepts,
// (2) we can add other providers later without touching call sites in
// server.js, (3) every generation is audited in the `generations` table.
//
// Today: only the 'fal' provider exists. Model registry below covers
// the full Kling family (video v3 + image o3/v3 + create-voice helper)
// plus a legacy Kling O1 entry for revert safety.

const { fal } = require('@fal-ai/client');

// ---------------------------------------------------------------------------
// Field-type catalogue. Each model's `fields` list references these.
// ---------------------------------------------------------------------------
// type:
//   'text'         single-line text
//   'textarea'     multi-line text
//   'number'       integer
//   'float'        decimal
//   'boolean'      checkbox
//   'enum'         dropdown (requires options[])
//   'image_url'    one image URL (file upload or paste)
//   'image_urls'   list of image URLs
//   'video_url'    one video URL
//   'audio_url'    one audio URL (.mp3/.wav/.mp4/.mov)
//   'string_array' plain list of strings (e.g., voice_ids)
//   'elements_v3'  Kling v3-style elements array — each entry is either
//                  { frontal_image_url, reference_image_urls[] }
//                  or { video_url }
//   'multi_prompt' Kling v3-style multi-shot prompt list
//
// Special source markers (where runtime input flows in):
//   source: 'photo'      bound to the customer's source photo URL at runtime
//   source: 'prompt'     bound to concept.image_prompt or concept.video_prompt
//                        (already user-input-substituted upstream)
// If a field has neither `source` nor a saved value, it stays at its default.

const MODELS = {
  // ---------------------------------------------------------------------
  // IMAGE models — Kling Image family (o3 = Omni 3, latest; v3 = simpler tier)
  // Schemas confirmed against fal.ai llms.txt on 2026-05-27.
  // Canonical reference: Claude_Workspace/03_Turtleandsun/01_Context/_KLING_V3_REFERENCE.md
  // ---------------------------------------------------------------------
  'fal-ai/kling-image/o3/image-to-image': {
    kind: 'image',
    label: 'Kling Omni 3 — Image to Image (primary)',
    description:
      'Kling Omni 3 i2i. Up to 10 reference images (referenced in prompt as @Image1..@Image10), 4K-native, image series support. Primary Royal Portrait + Family Portrait model. $0.028/img at 1K/2K, $0.056 at 4K.',
    fields: [
      { name: 'prompt', type: 'textarea', label: 'Prompt', required: true, source: 'prompt', help: 'Describe the desired output. Reference uploaded images as @Image1, @Image2, etc. Max 2500 characters.' },
      { name: 'image_urls', type: 'image_urls', label: 'Reference images', required: true, source: 'photo', help: 'Customer photo lands at @Image1. concept.reference_image_urls are appended. Max 10 total.' },
      { name: 'resolution', type: 'enum', label: 'Resolution', options: ['1K','2K','4K'], default: '1K', help: '1K standard, 2K high-res, 4K ultra (costs 2x).' },
      { name: 'result_type', type: 'enum', label: 'Result type', options: ['single','series'], default: 'single', help: 'single = one image (use num_images). series = related set with consistent style.' },
      { name: 'num_images', type: 'number', label: 'Number of images', default: 1, help: '1-9. Used when result_type=single.' },
      { name: 'series_amount', type: 'number', label: 'Series size', help: '2-9. Used when result_type=series.' },
      { name: 'aspect_ratio', type: 'enum', label: 'Aspect ratio', options: ['auto','16:9','9:16','1:1','4:3','3:4','3:2','2:3','21:9'], default: 'auto', help: 'auto infers from input. Customer-flow orientation overrides.' },
      { name: 'output_format', type: 'enum', label: 'Output format', options: ['jpeg','png','webp'], default: 'png' },
    ],
  },

  'fal-ai/kling-image/o3/text-to-image': {
    kind: 'image',
    label: 'Kling Omni 3 — Text to Image',
    description: 'Kling Omni 3 t2i. No source image. 4K-native, image series support. $0.028/img at 1K/2K.',
    fields: [
      { name: 'prompt', type: 'textarea', label: 'Prompt', required: true, source: 'prompt', help: 'Full scene description. Max 2500 characters.' },
      { name: 'resolution', type: 'enum', label: 'Resolution', options: ['1K','2K','4K'], default: '1K', help: '4K costs 2x.' },
      { name: 'result_type', type: 'enum', label: 'Result type', options: ['single','series'], default: 'single' },
      { name: 'num_images', type: 'number', label: 'Number of images', default: 1, help: '1-9.' },
      { name: 'series_amount', type: 'number', label: 'Series size', help: '2-9.' },
      { name: 'aspect_ratio', type: 'enum', label: 'Aspect ratio', options: ['16:9','9:16','1:1','4:3','3:4','3:2','2:3','21:9'], default: '16:9' },
      { name: 'output_format', type: 'enum', label: 'Output format', options: ['jpeg','png','webp'], default: 'png' },
    ],
  },

  'fal-ai/kling-image/v3/image-to-image': {
    kind: 'image',
    label: 'Kling V3 — Image to Image (cheaper fallback)',
    description: 'Kling Image V3 i2i. Single reference image, 2K max, no 4K. Has negative_prompt that o3 lacks. $0.028/img.',
    fields: [
      { name: 'prompt', type: 'textarea', label: 'Prompt', required: true, source: 'prompt', help: 'Visual edit instruction. Max 2500 characters.' },
      { name: 'image_url', type: 'image_url', label: 'Reference image', required: true, source: 'photo', help: 'Single source. Min 300x300, <=10MB, AR 0.40-2.50.' },
      { name: 'negative_prompt', type: 'text', label: 'Negative prompt', help: 'Things to avoid. v3 supports this; o3 does not.' },
      { name: 'resolution', type: 'enum', label: 'Resolution', options: ['1K','2K'], default: '1K', help: '2K max - no 4K on v3.' },
      { name: 'num_images', type: 'number', label: 'Number of images', default: 1, help: '1-9.' },
      { name: 'aspect_ratio', type: 'enum', label: 'Aspect ratio', options: ['16:9','9:16','1:1','4:3','3:4','3:2','2:3','21:9'], default: '16:9', help: 'Explicit selection - no auto on v3.' },
      { name: 'output_format', type: 'enum', label: 'Output format', options: ['jpeg','png','webp'], default: 'png' },
    ],
  },

  'fal-ai/kling-image/v3/text-to-image': {
    kind: 'image',
    label: 'Kling V3 — Text to Image (cheaper fallback)',
    description: 'Kling Image V3 t2i. 2K max, no series. $0.028/img.',
    fields: [
      { name: 'prompt', type: 'textarea', label: 'Prompt', required: true, source: 'prompt' },
      { name: 'negative_prompt', type: 'text', label: 'Negative prompt' },
      { name: 'resolution', type: 'enum', label: 'Resolution', options: ['1K','2K'], default: '1K' },
      { name: 'num_images', type: 'number', label: 'Number of images', default: 1 },
      { name: 'aspect_ratio', type: 'enum', label: 'Aspect ratio', options: ['16:9','9:16','1:1','4:3','3:4','3:2','2:3','21:9'], default: '16:9' },
      { name: 'output_format', type: 'enum', label: 'Output format', options: ['jpeg','png','webp'], default: 'png' },
    ],
  },

  // Legacy entry kept for revert safety — existing concepts may reference it.
  'fal-ai/kling-image/o1': {
    kind: 'image',
    label: 'Kling O1 — Image (LEGACY)',
    description: 'LEGACY. Older Kling image model. Kept so existing concepts continue to resolve. Migrate to o3 or v3 above.',
    fields: [
      { name: 'prompt', type: 'textarea', label: 'Prompt', required: true, source: 'prompt' },
      { name: 'image_urls', type: 'image_urls', label: 'Reference images', required: true, source: 'photo' },
      { name: 'aspect_ratio', type: 'enum', label: 'Aspect ratio', options: ['auto','1:1','16:9','9:16','4:3','3:4'], default: 'auto' },
    ],
  },

  // ---------------------------------------------------------------------
  // VIDEO models — Kling v3 family
  // ---------------------------------------------------------------------
  'fal-ai/kling-video/v3/pro/image-to-video': {
    kind: 'video',
    label: 'Kling v3 Pro — Image-to-Video (current default)',
    description: 'Kling 3.0 Pro. Native audio. 3-15s clips. $0.112/sec audio off, $0.168/sec audio on, $0.196/sec voice control.',
    fields: [
      { name: 'prompt', type: 'textarea', label: 'Prompt', source: 'prompt', help: 'Motion description.' },
      { name: 'start_image_url', type: 'image_url', label: 'Start image', required: true, source: 'photo', help: 'Customer photo at runtime.' },
      { name: 'end_image_url', type: 'image_url', label: 'End image (optional)' },
      { name: 'duration', type: 'enum', label: 'Duration (seconds)', options: ['3','4','5','6','7','8','9','10','11','12','13','14','15'], default: '5' },
      { name: 'generate_audio', type: 'boolean', label: 'Generate audio', default: true },
      { name: 'negative_prompt', type: 'text', label: 'Negative prompt', default: 'blur, distort, and low quality' },
      { name: 'cfg_scale', type: 'float', label: 'CFG scale', default: 0.5 },
      { name: 'shot_type', type: 'enum', label: 'Shot structure', options: ['customize','intelligent'], default: 'customize' },
      { name: 'elements', type: 'elements_v3', label: 'Elements (reference characters/objects)' },
    ],
  },

  'fal-ai/kling-video/v3/standard/image-to-video': {
    kind: 'video',
    label: 'Kling v3 Standard — Image-to-Video (cheaper)',
    description: 'Kling 3.0 Standard. Same surface as Pro at ~25% lower cost. $0.084/sec audio off, $0.126/sec audio on, $0.154/sec voice control.',
    fields: [
      { name: 'prompt', type: 'textarea', label: 'Prompt', source: 'prompt' },
      { name: 'start_image_url', type: 'image_url', label: 'Start image', required: true, source: 'photo' },
      { name: 'end_image_url', type: 'image_url', label: 'End image (optional)' },
      { name: 'duration', type: 'enum', label: 'Duration (seconds)', options: ['3','4','5','6','7','8','9','10','11','12','13','14','15'], default: '5' },
      { name: 'generate_audio', type: 'boolean', label: 'Generate audio', default: true },
      { name: 'negative_prompt', type: 'text', label: 'Negative prompt', default: 'blur, distort, and low quality' },
      { name: 'cfg_scale', type: 'float', label: 'CFG scale', default: 0.5 },
      { name: 'shot_type', type: 'enum', label: 'Shot structure', options: ['customize','intelligent'], default: 'customize' },
      { name: 'elements', type: 'elements_v3', label: 'Elements' },
    ],
  },

  // -----------------------------------------------------------------
  // TALKING — same Kling v3 endpoints, distinct kind for routing.
  // Dispatched via generateTalking() which composes speech_text into
  // the prompt and respects voice_ids.
  // -----------------------------------------------------------------
  'fal-ai/kling-video/v3/pro/image-to-video__talking': {
    kind: 'talking',
    alias_for: 'fal-ai/kling-video/v3/pro/image-to-video',
    label: 'Kling v3 Pro — Talking Pet (primary)',
    description: 'Kling v3 Pro routed through the talking-pet composer: speech_text + visual_prompt combined, optional voice_ids.',
    fields: [
      { name: 'prompt', type: 'textarea', label: 'Visual prompt (combined with speech_text at runtime)', source: 'prompt' },
      { name: 'start_image_url', type: 'image_url', label: 'Start image', required: true, source: 'photo' },
      { name: 'duration', type: 'enum', label: 'Duration (seconds)', options: ['3','4','5','6','7','8','9','10','11','12','13','14','15'], default: '5', help: 'Keep script <=15 words per 5s.' },
      { name: 'generate_audio', type: 'boolean', label: 'Generate audio', default: true, help: 'Must be true for talking.' },
      { name: 'voice_ids', type: 'string_array', label: 'Cloned voice IDs', help: 'Up to 2. Reference in prompt as <<<voice_1>>>, <<<voice_2>>>.' },
      { name: 'cfg_scale', type: 'float', label: 'CFG scale', default: 0.5 },
      { name: 'negative_prompt', type: 'text', label: 'Negative prompt', default: 'blur, distort, and low quality' },
    ],
  },

  'fal-ai/kling-video/v3/standard/image-to-video__talking': {
    kind: 'talking',
    alias_for: 'fal-ai/kling-video/v3/standard/image-to-video',
    label: 'Kling v3 Standard — Talking Pet (cheaper)',
    description: 'Kling v3 Standard routed as talking. $0.126/sec audio on, $0.154/sec voice control.',
    fields: [
      { name: 'prompt', type: 'textarea', label: 'Visual prompt', source: 'prompt' },
      { name: 'start_image_url', type: 'image_url', label: 'Start image', required: true, source: 'photo' },
      { name: 'duration', type: 'enum', label: 'Duration (seconds)', options: ['3','4','5','6','7','8','9','10','11','12','13','14','15'], default: '5' },
      { name: 'generate_audio', type: 'boolean', label: 'Generate audio', default: true },
      { name: 'voice_ids', type: 'string_array', label: 'Cloned voice IDs' },
      { name: 'cfg_scale', type: 'float', label: 'CFG scale', default: 0.5 },
      { name: 'negative_prompt', type: 'text', label: 'Negative prompt', default: 'blur, distort, and low quality' },
    ],
  },

  // Text-to-video. Rare for Turtleandsun — marketing B-roll without a pet.
  'fal-ai/kling-video/v3/pro/text-to-video': {
    kind: 'video_t2v',
    label: 'Kling v3 Pro — Text-to-Video',
    description: 'Pure t2v. $0.224/sec audio off, $0.336/sec audio on. Marketing B-roll only.',
    fields: [
      { name: 'prompt', type: 'textarea', label: 'Prompt', source: 'prompt' },
      { name: 'duration', type: 'enum', label: 'Duration (seconds)', options: ['3','4','5','6','7','8','9','10','11','12','13','14','15'], default: '5' },
      { name: 'generate_audio', type: 'boolean', label: 'Generate audio', default: true },
      { name: 'voice_ids', type: 'string_array', label: 'Cloned voice IDs' },
      { name: 'aspect_ratio', type: 'enum', label: 'Aspect ratio', options: ['16:9','9:16','1:1'], default: '16:9' },
      { name: 'shot_type', type: 'enum', label: 'Shot structure', options: ['customize','intelligent'], default: 'customize' },
      { name: 'negative_prompt', type: 'text', label: 'Negative prompt', default: 'blur, distort, and low quality' },
      { name: 'cfg_scale', type: 'float', label: 'CFG scale', default: 0.5 },
    ],
  },

  'fal-ai/kling-video/v3/standard/text-to-video': {
    kind: 'video_t2v',
    label: 'Kling v3 Standard — Text-to-Video',
    description: 'Cheaper t2v. $0.084/sec audio off, $0.126/sec audio on.',
    fields: [
      { name: 'prompt', type: 'textarea', label: 'Prompt', source: 'prompt' },
      { name: 'duration', type: 'enum', label: 'Duration (seconds)', options: ['3','4','5','6','7','8','9','10','11','12','13','14','15'], default: '5' },
      { name: 'generate_audio', type: 'boolean', label: 'Generate audio', default: true },
      { name: 'voice_ids', type: 'string_array', label: 'Cloned voice IDs' },
      { name: 'aspect_ratio', type: 'enum', label: 'Aspect ratio', options: ['16:9','9:16','1:1'], default: '16:9' },
      { name: 'shot_type', type: 'enum', label: 'Shot structure', options: ['customize','intelligent'], default: 'customize' },
      { name: 'negative_prompt', type: 'text', label: 'Negative prompt', default: 'blur, distort, and low quality' },
      { name: 'cfg_scale', type: 'float', label: 'CFG scale', default: 0.5 },
    ],
  },

  // Voice cloning helper. Returns a voice_id used in <<<voice_1>>>.
  'fal-ai/kling-video/create-voice': {
    kind: 'voice_clone',
    label: 'Kling — Create Voice (helper)',
    description: 'Clones a voice from a 5-30s clean sample. Returns voice_id. $0.007 per generation.',
    fields: [
      { name: 'voice_url', type: 'audio_url', label: 'Voice sample', required: true, help: 'URL to 5-30s clean single-voice audio. .mp3 .wav .mp4 .mov.' },
    ],
  },

  // Legacy Kling O1 reference-to-video kept for existing concepts.
  'fal-ai/kling-video/o1/reference-to-video': {
    kind: 'video',
    label: 'Kling O1 Reference-to-Video — face/identity preservation (LEGACY)',
    description: 'LEGACY. Kling O1 Reference. Specialized for identity preservation. No native audio. 5/10s clips.',
    fields: [
      { name: 'prompt', type: 'textarea', label: 'Prompt', required: true, source: 'prompt' },
      { name: 'image_urls', type: 'image_urls', label: 'Reference images', required: true, source: 'photo' },
      { name: 'elements', type: 'elements_v3', label: 'Tracked elements' },
      { name: 'duration', type: 'enum', label: 'Duration', options: ['5','10'], default: '5' },
      { name: 'aspect_ratio', type: 'enum', label: 'Aspect ratio', options: ['16:9','9:16','1:1'], default: '16:9' },
    ],
  },
};

function listModels(kind) {
  return Object.entries(MODELS)
    .filter(([, m]) => m.kind === kind)
    .map(([id, m]) => ({ id, label: m.label, description: m.description }));
}

function getModel(id) { return MODELS[id] || null; }

// ---------------------------------------------------------------------------
// Input builder. Resolution order per field:
//   1. source 'photo' or 'prompt' -> use runtime arg.
//   2. extras has value -> use that.
//   3. customer orientation overrides aspect_ratio default.
//   4. field has default -> use default.
//   5. otherwise omit.
// ---------------------------------------------------------------------------
function buildFalInput(model, { photoUrl, prompt, orientation }, inputExtras) {
  const extras = inputExtras || {};
  const out = {};
  const orientationAspect = { landscape: '16:9', portrait: '9:16', square: '1:1' };

  for (const f of model.fields) {
    if (f.source === 'prompt') {
      if (prompt) out[f.name] = prompt;
      continue;
    }
    if (f.source === 'photo') {
      if (f.type === 'image_url') {
        out[f.name] = photoUrl;
      } else if (f.type === 'image_urls') {
        const additional = Array.isArray(extras[f.name]) ? extras[f.name] : [];
        out[f.name] = [photoUrl, ...additional];
      }
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(extras, f.name)) {
      out[f.name] = extras[f.name];
      continue;
    }
    if (f.name === 'aspect_ratio' && orientation && orientationAspect[orientation]) {
      const allowed = f.options || [];
      const mapped = orientationAspect[orientation];
      if (allowed.length === 0 || allowed.includes(mapped) || allowed.includes('auto')) {
        out[f.name] = allowed.includes(mapped) ? mapped : 'auto';
        continue;
      }
    }
    if (Object.prototype.hasOwnProperty.call(f, 'default')) {
      out[f.name] = f.default;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// fal storage setting — keep generated outputs forever (default 7-day expiry
// would silently kill customer Loveogram links a week after purchase).
// ---------------------------------------------------------------------------
const FAL_STORAGE_NEVER_EXPIRES = { expiresIn: 'never' };

async function generateImage({ provider = 'fal', modelId, prompt, photoUrl, orientation, inputExtras }) {
  if (provider !== 'fal') throw new Error(`Unsupported provider: ${provider}`);
  const model = getModel(modelId);
  if (!model) throw new Error(`Unknown image model: ${modelId}`);
  if (model.kind !== 'image') throw new Error(`Model ${modelId} is not an image model`);

  const input = buildFalInput(model, { photoUrl, prompt, orientation }, inputExtras);
  const result = await fal.subscribe(modelId, { input, storageSettings: FAL_STORAGE_NEVER_EXPIRES });
  const url = result?.data?.images?.[0]?.url;
  if (!url) throw new Error('Image generation returned no URL');
  return { url, input, raw: result.data };
}

async function generateVideo({ provider = 'fal', modelId, prompt, photoUrl, orientation, inputExtras }) {
  if (provider !== 'fal') throw new Error(`Unsupported provider: ${provider}`);
  const model = getModel(modelId);
  if (!model) throw new Error(`Unknown video model: ${modelId}`);
  if (model.kind !== 'video') throw new Error(`Model ${modelId} is not a video model`);

  const input = buildFalInput(model, { photoUrl, prompt, orientation }, inputExtras);
  const result = await fal.subscribe(modelId, { input, storageSettings: FAL_STORAGE_NEVER_EXPIRES });
  const url = result?.data?.video?.url;
  if (!url) throw new Error('Video generation returned no URL');
  return { url, input, raw: result.data };
}

// ---------------------------------------------------------------------------
// Talking-pet composer.
// ---------------------------------------------------------------------------
function applyNamePlaceholder(template, name) {
  if (!template) return '';
  const trimmedName = (name || '').trim();
  if (trimmedName) return template.replace(/\{name\}/g, trimmedName);
  return template.replace(/,?\s*\{name\}/g, '').replace(/\s+/g, ' ').trim();
}

function composeTalkingPrompt(visualPrompt, speechText) {
  const v = (visualPrompt || '').trim();
  const s = (speechText || '').trim();
  if (!s) return v;
  const sep = v && !v.endsWith('.') ? '. ' : ' ';
  return `${v}${sep}The subject says clearly: '${s}'`;
}

function resolveTalkingModelId(modelId) {
  const m = MODELS[modelId];
  if (m && m.alias_for) return m.alias_for;
  return modelId;
}

async function generateTalking({
  modelId, photoUrl, visualPrompt, speechText, customerName,
  orientation, inputExtras, voiceIds,
}) {
  const m = getModel(modelId);
  if (!m) throw new Error(`Unknown talking model: ${modelId}`);
  if (m.kind !== 'talking') throw new Error(`Model ${modelId} is not a talking model`);

  const resolvedId = resolveTalkingModelId(modelId);
  const realModel = getModel(resolvedId) || m;

  const speech = applyNamePlaceholder(speechText, customerName);
  const fullPrompt = composeTalkingPrompt(visualPrompt, speech);

  const extras = { ...(inputExtras || {}) };
  if (Array.isArray(voiceIds) && voiceIds.length) {
    extras.voice_ids = voiceIds.slice(0, 2);
  }
  const input = buildFalInput(realModel, { photoUrl, prompt: fullPrompt, orientation }, extras);
  if (Object.prototype.hasOwnProperty.call(input, 'generate_audio')) {
    input.generate_audio = true;
  }

  const result = await fal.subscribe(resolvedId, {
    input, storageSettings: FAL_STORAGE_NEVER_EXPIRES,
  });
  const url = result?.data?.video?.url;
  if (!url) throw new Error('Talking generation returned no URL');
  return { url, input, raw: result.data, modelIdUsed: resolvedId };
}

// ---------------------------------------------------------------------------
// Voice cloning helper.
// ---------------------------------------------------------------------------
async function cloneVoice({ voiceUrl }) {
  if (!voiceUrl) throw new Error('cloneVoice requires voiceUrl');
  const result = await fal.subscribe('fal-ai/kling-video/create-voice', {
    input: { voice_url: voiceUrl },
    storageSettings: FAL_STORAGE_NEVER_EXPIRES,
  });
  const voiceId = result?.data?.voice_id;
  if (!voiceId) throw new Error('cloneVoice returned no voice_id');
  return { voiceId, raw: result.data };
}

// ---------------------------------------------------------------------------
// Generations audit log helpers. Pool loaded lazily so unit tests can
// require() this module without setting up Postgres.
// ---------------------------------------------------------------------------
let _pool = null;
function getPool() {
  if (_pool) return _pool;
  try { _pool = require('./db').pool; } catch (_) { /* db not available */ }
  return _pool;
}

async function logGenerationStart({
  conceptId, modelId, inputPayload, sourceType,
  userId, orderId, testSubjectId,
}) {
  const pool = getPool();
  if (!pool) return { id: null };
  try {
    const { rows } = await pool.query(
      `INSERT INTO generations (
         concept_id, model_id, input_payload, source_type,
         user_id, order_id, test_subject_id, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING id`,
      [
        conceptId || null,
        modelId,
        inputPayload || {},
        sourceType,
        userId || null,
        orderId || null,
        testSubjectId || null,
      ]
    );
    return { id: rows[0].id };
  } catch (err) {
    console.warn('[generation] logGenerationStart failed:', err.message);
    return { id: null };
  }
}

async function logGenerationFinish(id, { outputUrl, falOutputUrl, costUsd }) {
  if (!id) return;
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE generations
       SET status = 'success',
           output_url = $2,
           fal_output_url = $3,
           cost_usd = $4,
           completed_at = NOW()
       WHERE id = $1`,
      [id, outputUrl || null, falOutputUrl || null, costUsd ?? null]
    );
  } catch (err) {
    console.warn('[generation] logGenerationFinish failed:', err.message);
  }
}

async function logGenerationFailure(id, errorMessage) {
  if (!id) return;
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE generations
       SET status = 'failed',
           error_message = $2,
           completed_at = NOW()
       WHERE id = $1`,
      [id, String(errorMessage || '').slice(0, 2000)]
    );
  } catch (err) {
    console.warn('[generation] logGenerationFailure failed:', err.message);
  }
}

module.exports = {
  MODELS,
  listModels,
  getModel,
  buildFalInput,
  generateImage,
  generateVideo,
  // Talking-pet pipeline
  generateTalking,
  applyNamePlaceholder,
  composeTalkingPrompt,
  resolveTalkingModelId,
  // Voice cloning
  cloneVoice,
  // Generations audit log
  logGenerationStart,
  logGenerationFinish,
  logGenerationFailure,
};
