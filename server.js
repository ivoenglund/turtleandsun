require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const { fal } = require('@fal-ai/client');
const Stripe = require('stripe');
const { initDb, pool } = require('./db');
const { uploadStream } = require('./cloudinary');

fal.config({ credentials: process.env.FAL_API_KEY });
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ storage: multer.memoryStorage() });

// Webhook must use raw body before express.json()
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { email, image_url, product } = session.metadata;

    // Record order
    try {
      await pool.query(
        'INSERT INTO orders (email, style_id, product, status, amount) VALUES ($1, $2, $3, $4, $5)',
        [email, null, product, 'paid', session.amount_total / 100]
      );
    } catch (err) {
      console.error('Order insert error:', err.message);
    }

    // Trigger generation in background
    generateForOrder(image_url, product).catch(err =>
      console.error('Generation error for order:', session.id, err.message)
    );
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const PRODUCTS = {
  image:  { name: 'Royal Portrait — Image',  amount: 1900 },
  video:  { name: 'Royal Portrait — Video',  amount: 2900 },
  bundle: { name: 'Royal Portrait — Bundle', amount: 3900 },
};

const ROYAL_PORTRAIT_PROMPT =
  'A regal royal portrait painting of the same person, wearing an ornate crown and royal robes, ' +
  'set in a grand palace with dramatic lighting. Preserve the exact face, facial features, skin tone, ' +
  'age, and likeness of the person. Oil painting style, highly detailed, museum quality.';

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

app.post('/create-checkout-session', async (req, res) => {
  const { product, image_url, email } = req.body;
  if (!PRODUCTS[product]) return res.status(400).json({ error: 'Invalid product' });
  if (!image_url) return res.status(400).json({ error: 'image_url is required' });

  const origin = `${req.protocol}://${req.get('host')}`;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: PRODUCTS[product].name },
          unit_amount: PRODUCTS[product].amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      customer_email: email || undefined,
      metadata: { product, image_url, email: email || '' },
      success_url: `${origin}/?order=success`,
      cancel_url: `${origin}/?order=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create checkout session', details: err.message });
  }
});

app.post('/preview', async (req, res) => {
  const { image_url } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url is required' });
  try {
    const result = await fal.subscribe('fal-ai/kling-image/v3/image-to-image', {
      input: {
        image_url,
        prompt: ROYAL_PORTRAIT_PROMPT,
        aspect_ratio: '1:1',
        resolution: '1K',
        num_images: 1,
      },
    });
    res.json({ url: result.data.images[0].url });
  } catch (err) {
    console.error('Preview error:', JSON.stringify(err, null, 2));
    res.status(500).json({ error: 'Preview generation failed', details: err.message, body: err.body ?? null });
  }
});

app.post('/generate', async (req, res) => {
  const { image_url } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url is required' });
  try {
    const result = await generateImage(image_url);
    res.json({ url: result });
  } catch (err) {
    res.status(500).json({ error: 'Image generation failed', details: err.message });
  }
});

app.post('/video', async (req, res) => {
  const { image_url } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url is required' });
  try {
    const result = await generateVideo(image_url);
    res.json({ url: result });
  } catch (err) {
    res.status(500).json({ error: 'Video generation failed', details: err.message });
  }
});

async function generateImage(image_url) {
  const result = await fal.subscribe('fal-ai/kling-image/v3/image-to-image', {
    input: {
      image_url,
      prompt: ROYAL_PORTRAIT_PROMPT,
      aspect_ratio: '1:1',
      resolution: '2K',
      num_images: 1,
    },
  });
  return result.data.images[0].url;
}

async function generateVideo(image_url) {
  const result = await fal.subscribe('fal-ai/kling-video/v3/pro/image-to-video', {
    input: {
      image_url,
      prompt: ROYAL_PORTRAIT_PROMPT,
      duration: '10',
      enable_audio: true,
    },
  });
  return result.data.video.url;
}

async function generateForOrder(image_url, product) {
  if (product === 'image' || product === 'bundle') {
    const url = await generateImage(image_url);
    console.log('Generated image:', url);
  }
  if (product === 'video' || product === 'bundle') {
    const url = await generateVideo(image_url);
    console.log('Generated video:', url);
  }
}

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
