// generation.js
//
// Generation provider abstraction.
//
// Purpose: route image and video generation through a single module so that
// (1) the concept admin can pick any registered fal.ai model and only see
// the fields that model accepts, (2) we can add other providers later
// (Replicate, RunwayML, etc.) without touching the call sites in server.js.
//
// Today: only the 'fal' provider exists. Model registry below covers the
// Kling family. Add more entries to MODELS as needed.
//
// Field types are intentionally simple strings; the admin form renders the
// matching input widget for each. Help text is shown inline.

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
  // IMAGE models
  // ---------------------------------------------------------------------
  'fal-ai/kling-image/o1': {
    kind: 'image',
    label: 'Kling O1 — Image (current default)',
    description:
      'Kling O1 image-to-image. Accepts one or more reference images plus a text prompt. Good for style transfer that preserves face/subject identity.',
    fields: [
      {
        name: 'prompt',
        type: 'textarea',
        label: 'Prompt',
        required: true,
        source: 'prompt',
        help: 'Text instruction. Reference the customer photo as @Image1.',
      },
      {
        name: 'image_urls',
        type: 'image_urls',
        label: 'Reference images',
        required: true,
        source: 'photo',
        help: 'Customer photo is added automatically as the first image. Add more via input_extras if needed.',
      },
      {
        name: 'aspect_ratio',
        type: 'enum',
        label: 'Aspect ratio',
        options: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4'],
        default: 'auto',
        help: 'auto = inferred from source. Customer-flow orientation overrides this when set.',
      },
    ],
  },

  // ---------------------------------------------------------------------
  // VIDEO models
  // ---------------------------------------------------------------------
  'fal-ai/kling-video/v3/pro/image-to-video': {
    kind: 'video',
    label: 'Kling v3 Pro — Image-to-Video (current default)',
    description:
      'Kling 3.0 Pro. Native audio. 3–15 second clips. Accepts start frame, optional end frame, and elements (reference characters/objects). Aspect ratio inferred from start image.',
    fields: [
      {
        name: 'prompt',
        type: 'textarea',
        label: 'Prompt',
        source: 'prompt',
        help: 'Text describing the motion. Required unless multi_prompt is used.',
      },
      {
        name: 'start_image_url',
        type: 'image_url',
        label: 'Start image',
        required: true,
        source: 'photo',
        help: 'First frame. Bound to the customer photo at runtime.',
      },
      {
        name: 'end_image_url',
        type: 'image_url',
        label: 'End image (optional)',
        help: 'Optional last frame. Drives a specific transition.',
      },
      {
        name: 'duration',
        type: 'enum',
        label: 'Duration (seconds)',
        options: ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'],
        default: '10',
        help: '3–15 seconds.',
      },
      {
        name: 'generate_audio',
        type: 'boolean',
        label: 'Generate audio',
        default: true,
        help: 'Native audio in Chinese/English. Other languages auto-translated to English.',
      },
      {
        name: 'negative_prompt',
        type: 'text',
        label: 'Negative prompt',
        default: 'blur, distort, and low quality',
        help: 'What to avoid.',
      },
      {
        name: 'cfg_scale',
        type: 'float',
        label: 'CFG scale',
        default: 0.5,
        help: 'Prompt adherence strength, 0–1. Lower = more creative variation.',
      },
      {
        name: 'elements',
        type: 'elements_v3',
        label: 'Elements (reference characters/objects)',
        help:
          'Each element is either an image set (frontal + reference angles) or a single video. ' +
          'Reference in your prompt as @Element1, @Element2, etc. ' +
          'For pet portraits keep this empty unless you have a recurring character.',
      },
    ],
  },

  'fal-ai/kling-video/o1/reference-to-video': {
    kind: 'video',
    label: 'Kling O1 Reference-to-Video — face/identity preservation',
    description:
      'Kling O1 Reference. Specialized for keeping character identity stable across the clip. ' +
      'Accepts up to 7 inputs total combining tracked elements, style references, and start frame. ' +
      'No native audio. 5 or 10 second clips. Aspect ratio is a parameter (16:9, 9:16, 1:1).',
    fields: [
      {
        name: 'prompt',
        type: 'textarea',
        label: 'Prompt',
        required: true,
        source: 'prompt',
        help:
          'Reference the customer photo as @Image1. Reference tracked elements as @Element1, @Element2. ' +
          'Example: "Take @Image1 as the start frame. The character from @Element1 walks into frame..."',
      },
      {
        name: 'image_urls',
        type: 'image_urls',
        label: 'Reference images (max 2 — style + start frame)',
        required: true,
        source: 'photo',
        help:
          'Customer photo is added automatically as @Image1. You can add a second style-reference via input_extras. ' +
          'Total inputs across image_urls + elements must be ≤ 7.',
      },
      {
        name: 'elements',
        type: 'elements_v3',
        label: 'Tracked elements (identity-preserved across frames)',
        help:
          'Up to several elements, each with a frontal image and optional reference angles. ' +
          'This is the model\'s superpower — use it when likeness preservation is the priority.',
      },
      {
        name: 'duration',
        type: 'enum',
        label: 'Duration',
        options: ['5', '10'],
        default: '5',
        help: 'Only 5 or 10 seconds supported.',
      },
      {
        name: 'aspect_ratio',
        type: 'enum',
        label: 'Aspect ratio',
        options: ['16:9', '9:16', '1:1'],
        default: '16:9',
        help: 'Customer-flow orientation overrides this when set.',
      },
    ],
  },
};

function listModels(kind /* 'image' | 'video' */) {
  return Object.entries(MODELS)
    .filter(([, m]) => m.kind === kind)
    .map(([id, m]) => ({ id, label: m.label, description: m.description }));
}

function getModel(id) {
  return MODELS[id] || null;
}

// ---------------------------------------------------------------------------
// Input builder. Takes a model + runtime args + saved input_extras and
// produces the exact dict passed to fal.subscribe.
//
// Resolution order, per field:
//   1. If field has source 'photo' or 'prompt', use the runtime arg.
//   2. Else if input_extras has a value for this field, use that.
//   3. Else if field has a default, use that.
//   4. Else omit the field.
//
// image_urls fields are special: the customer photo is prepended, then any
// extras from input_extras are concatenated.
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

    // Customer-flow orientation overrides aspect_ratio default when applicable
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
// Public API.
// ---------------------------------------------------------------------------
async function generateImage({ provider = 'fal', modelId, prompt, photoUrl, orientation, inputExtras }) {
  if (provider !== 'fal') throw new Error(`Unsupported provider: ${provider}`);
  const model = getModel(modelId);
  if (!model) throw new Error(`Unknown image model: ${modelId}`);
  if (model.kind !== 'image') throw new Error(`Model ${modelId} is not an image model`);

  const input = buildFalInput(model, { photoUrl, prompt, orientation }, inputExtras);
  const result = await fal.subscribe(modelId, { input });
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
  const result = await fal.subscribe(modelId, { input });
  const url = result?.data?.video?.url;
  if (!url) throw new Error('Video generation returned no URL');
  return { url, input, raw: result.data };
}

module.exports = {
  MODELS,
  listModels,
  getModel,
  buildFalInput,
  generateImage,
  generateVideo,
};
