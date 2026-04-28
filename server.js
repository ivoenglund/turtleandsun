const express = require('express');
const path = require('path');
const multer = require('multer');
const { fal } = require('@fal-ai/client');
const { initDb } = require('./db');
const { uploadStream } = require('./cloudinary');

fal.config({ credentials: process.env.FAL_API_KEY });

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'turtleandsun-landing.html'));
});

app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided' });
  try {
    const result = await uploadStream(req.file.buffer);
    res.json({ url: result.secure_url, public_id: result.public_id });
  } catch (err) {
    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

const ROYAL_PORTRAIT_PROMPT =
  'A regal royal portrait painting of the same person, wearing an ornate crown and royal robes, ' +
  'set in a grand palace with dramatic lighting. Preserve the exact face, facial features, skin tone, ' +
  'age, and likeness of the person. Oil painting style, highly detailed, museum quality.';

app.post('/preview', async (req, res) => {
  const { image_url } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url is required' });
  try {
    const result = await fal.subscribe('fal-ai/kling-image/v3/image-to-image', {
      input: {
        image_url,
        prompt: ROYAL_PORTRAIT_PROMPT + ' @Element1',
        aspect_ratio: '1:1',
        resolution: '1K',
        num_images: 1,
        elements: [{ frontal_image_url: image_url }],
      },
    });
    res.json({ url: result.data.images[0].url });
  } catch (err) {
    res.status(500).json({ error: 'Preview generation failed', details: err.message });
  }
});

app.post('/generate', async (req, res) => {
  const { image_url } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url is required' });
  try {
    const result = await fal.subscribe('fal-ai/kling-image/v3/image-to-image', {
      input: {
        image_url,
        prompt: ROYAL_PORTRAIT_PROMPT,
        aspect_ratio: '1:1',
        resolution: '2K',
        num_images: 1,
      },
    });
    res.json({ url: result.data.images[0].url });
  } catch (err) {
    res.status(500).json({ error: 'Image generation failed', details: err.message });
  }
});

app.post('/video', async (req, res) => {
  const { image_url } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url is required' });
  try {
    const result = await fal.subscribe('fal-ai/kling-video/v3/pro/image-to-video', {
      input: {
        image_url,
        prompt: ROYAL_PORTRAIT_PROMPT,
        duration: '10',
        enable_audio: true,
      },
    });
    res.json({ url: result.data.video.url });
  } catch (err) {
    res.status(500).json({ error: 'Video generation failed', details: err.message });
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
