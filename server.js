const express = require('express');
const path = require('path');
const multer = require('multer');
const { fal } = require('@fal-ai/client');
const { initDb } = require('./db');
const { uploadStream } = require('./cloudinary');

fal.config({ credentials: process.env.FAL_API_KEY });

const app = express();
const PORT = process.env.PORT || 3000;
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

app.post('/preview', async (req, res) => {
  const { image_url, prompt } = req.body;
  if (!image_url || !prompt) {
    return res.status(400).json({ error: 'image_url and prompt are required' });
  }
  try {
    const result = await fal.subscribe('fal-ai/flux/dev', {
      input: {
        prompt,
        image_url,
        image_size: { width: 1024, height: 1024 },
        num_images: 1,
      },
    });
    const previewUrl = result.data.images[0].url;
    res.json({ url: previewUrl });
  } catch (err) {
    res.status(500).json({ error: 'Preview generation failed', details: err.message });
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
