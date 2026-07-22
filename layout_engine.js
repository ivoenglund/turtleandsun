// layout_engine.js
//
// Arrange feature — the model makes three small STRUCTURAL judgment calls
// (how many columns, which piece deserves the wide/prominent slot, what
// order things run in); it never produces coordinates. A separate renderer
// in the editor does the actual placement, and measures the real rendered
// page afterward to correct for anything the model got wrong — so a bad or
// garbled answer can distort the arrangement, never break the page.
//
// Same LLM path as story_engine.js: fal.ai's `openrouter/router` endpoint,
// the same FAL_API_KEY the app already uses for Kling/story generation — no
// new provider account. DeepSeek is reachable through this the same way any
// other OpenRouter model is: pass its model id.

const { fal } = require('@fal-ai/client');

const ROUTER_ENDPOINT = 'openrouter/router';
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

function buildSystemPrompt() {
  return [
    'You are a print page layout assistant for Turtle & Sun, a family keepsake',
    'and brochure print product. You NEVER produce coordinates, pixel values,',
    'or sizes — a separate rendering engine does the exact placement and',
    'guarantees nothing overlaps or overflows, regardless of what you answer.',
    'Your ONLY job is three structural judgment calls for the page described',
    'below:',
    '',
    '1. "cols" — how many columns to arrange the pieces into (integer, 1-4).',
    '2. "heavyKey" — the key of the ONE piece that deserves a wider, more',
    '   prominent slot than the rest (typically the piece with the richest',
    '   content — more photos, more text, or the most important-sounding',
    '   excerpt) — or null if the page should read as even-handed, with no',
    '   single piece emphasised.',
    '3. "order" — every piece key, in the order they should be placed (most',
    '   eye-catching / most important first). Every key given to you must',
    '   appear exactly once.',
    '',
    'Judge scale from the REAL page size and the REAL rendered type size given',
    'for each piece at a few candidate widths — a page the size of a business',
    'card and a page the size of a poster are not just "the same shape at a',
    'different zoom": the poster can carry dense copy and many columns at a',
    'comfortable reading size, while the card cannot, no matter the ratio of',
    'its sides. Prefer fewer columns and simpler structure on small pages;',
    'prefer more generous, varied structure on large ones.',
    '',
    'Respond with ONLY a JSON object, no markdown fences, matching exactly:',
    '{ "cols": <integer 1-4>, "heavyKey": "<piece key>" or null, "order": ["<piece key>", ...] }',
  ].join('\n');
}

function buildUserPrompt({ paper, pieces, previousPlan }) {
  const lines = [];
  const orientation = paper.wMm >= paper.hMm ? 'landscape' : (paper.wMm === paper.hMm ? 'square' : 'portrait');
  lines.push(`PAGE: ${Math.round(paper.wMm)}mm x ${Math.round(paper.hMm)}mm, ${orientation}. ${pieces.length} piece(s) to arrange.`);
  lines.push('');
  pieces.forEach(p => {
    lines.push(`- key: ${p.key}`);
    lines.push(`  kind: ${p.kind}${p.photoCount ? `, photos: ${p.photoCount}` : ''}`);
    if (p.excerpt) lines.push(`  text excerpt: "${p.excerpt}"`);
    if (Array.isArray(p.sizeAtWidths) && p.sizeAtWidths.length) {
      lines.push('  if given this many columns of width:');
      p.sizeAtWidths.forEach(s => {
        lines.push(`    ${s.colSpan} col(s), ${Math.round(s.wPct)}% of page width: about ${s.pt}pt type, about ${s.lines} line(s)`);
      });
    }
    lines.push('');
  });
  if (previousPlan) {
    lines.push(`YOUR PREVIOUS SUGGESTION for this same page: cols=${previousPlan.cols}, ` +
      `heavyKey=${previousPlan.heavyKey || 'null'}, order=${JSON.stringify(previousPlan.order)}.`);
    lines.push('The person asked to try again because they were not happy with that one — ' +
      'propose something noticeably DIFFERENT this time, not a small nudge.');
    lines.push('');
  }
  lines.push('Return the JSON now.');
  return lines.join('\n');
}

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

// Never trust the model's shape. Clamp columns, drop any key it invented,
// append any key it forgot (order must always account for every real piece).
function validatePlan(raw, pieceKeys) {
  const validKeys = new Set(pieceKeys);
  let cols = Math.round(Number(raw && raw.cols));
  if (!Number.isFinite(cols) || cols < 1) cols = 1;
  if (cols > 4) cols = 4;

  let order = Array.isArray(raw && raw.order)
    ? raw.order.filter(k => typeof k === 'string' && validKeys.has(k))
    : [];
  const seen = new Set();
  order = order.filter(k => (seen.has(k) ? false : (seen.add(k), true)));
  pieceKeys.forEach(k => { if (!seen.has(k)) { order.push(k); seen.add(k); } });

  const heavyKey = (raw && typeof raw.heavyKey === 'string' && validKeys.has(raw.heavyKey))
    ? raw.heavyKey : null;

  return { cols, order, heavyKey };
}

// Returns { plan: {cols, order, heavyKey}, model, costUsd }.
// One automatic retry on parse failure, same as generateStory().
async function suggestArrangement({ paper, pieces, previousPlan, model }) {
  if (!paper || !paper.wMm || !paper.hMm) throw new Error('paper dimensions required');
  if (!Array.isArray(pieces) || !pieces.length) throw new Error('pieces required');
  const pieceKeys = pieces.map(p => p.key);
  const useModel = model || DEFAULT_MODEL;
  const systemPrompt = buildSystemPrompt();
  const prompt = buildUserPrompt({ paper, pieces, previousPlan });

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await fal.subscribe(ROUTER_ENDPOINT, {
        input: { model: useModel, system_prompt: systemPrompt, prompt, temperature: 0.7, max_tokens: 500 },
      });
      const data = result && result.data || {};
      if (data.error) throw new Error(`LLM error: ${data.error}`);
      const raw = extractJson(data.output);
      const plan = validatePlan(raw, pieceKeys);
      return { plan, model: useModel, costUsd: Number((data.usage && data.usage.cost) || 0) };
    } catch (err) {
      lastErr = err;
      if (attempt === 2) break;
    }
  }
  throw new Error(`Layout suggestion failed after 2 attempts: ${lastErr && lastErr.message}`);
}

module.exports = { suggestArrangement, buildSystemPrompt, buildUserPrompt, validatePlan, extractJson };
