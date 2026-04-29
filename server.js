require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const { fal } = require('@fal-ai/client');
const Stripe = require('stripe');
const { Resend } = require('resend');
const { initDb, pool, seedGallery } = require('./db');
const { uploadStream } = require('./cloudinary');

fal.config({ credentials: process.env.FAL_API_KEY });
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ storage: multer.memoryStorage() });

const PRODUCTS = {
  image:  { name: 'Royal Portrait — Image',  amount: 1900 },
  video:  { name: 'Royal Portrait — Video',  amount: 2900 },
  bundle: { name: 'Royal Portrait — Bundle', amount: 3900 },
};

const ROYAL_PORTRAIT_PROMPT =
  'A regal royal portrait painting of the same person, wearing an ornate crown and royal robes, ' +
  'set in a grand palace with dramatic lighting. Preserve the exact face, facial features, skin tone, ' +
  'age, and likeness of the person. Oil painting style, highly detailed, museum quality.';

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

  console.log('Webhook received:', event.type, event.id);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { email, image_url, product } = session.metadata || {};

    console.log('checkout.session.completed — email:', email, 'product:', product, 'image_url:', image_url);

    if (!image_url || !product) {
      console.warn('Webhook missing image_url or product in metadata, skipping generation');
      return res.json({ received: true });
    }

    // Record order
    let orderId;
    try {
      const orderRes = await pool.query(
        'INSERT INTO orders (email, style_id, product, status, amount) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [email || '', null, product, 'paid', session.amount_total / 100]
      );
      orderId = orderRes.rows[0].id;
      console.log('Order recorded, id:', orderId);
    } catch (err) {
      console.error('Order insert error:', err.message);
    }

    // Mark user as purchased and reset preview counter
    if (email) {
      try {
        await pool.query(
          `INSERT INTO users (email, has_purchased, preview_count)
           VALUES ($1, TRUE, 0)
           ON CONFLICT (email) DO UPDATE SET has_purchased = TRUE, preview_count = 0`,
          [email]
        );
      } catch (err) {
        console.error('User update error:', err.message);
      }
    }

    // Trigger full-quality generation in background
    console.log('Starting generation for order:', orderId);
    generateForOrder(image_url, product, email || '', orderId).catch(err =>
      console.error('Generation error for session:', session.id, err.message)
    );
  }

  res.json({ received: true });
});

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
      payment_intent_data: {
        metadata: { product, image_url, email: email || '' },
      },
      success_url: `${origin}/?order=success`,
      cancel_url: `${origin}/?order=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create checkout session', details: err.message });
  }
});

app.post('/preview', async (req, res) => {
  const { image_url, email } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url is required' });
  if (!email) return res.status(400).json({ error: 'email is required' });

  try {
    const result = await pool.query(
      `INSERT INTO users (email, preview_count)
       VALUES ($1, 1)
       ON CONFLICT (email) DO UPDATE
         SET preview_count = CASE
           WHEN users.has_purchased = TRUE THEN users.preview_count
           ELSE users.preview_count + 1
         END
       RETURNING preview_count, has_purchased`,
      [email]
    );
    const { preview_count, has_purchased } = result.rows[0];

    if (!has_purchased && preview_count > 3) {
      return res.status(403).json({ error: 'Preview limit reached. Purchase to continue.' });
    }
  } catch (err) {
    console.error('Preview user upsert error:', err.message);
  }

  try {
    const result = await fal.subscribe('fal-ai/kling-image/o1', {
      input: {
        prompt: 'Transform @Image1 into a royal portrait painting wearing an ornate golden crown and red velvet royal robes, set in a grand palace. Preserve the exact face and identity of the person in @Image1. Oil painting style, highly detailed.',
        image_urls: [image_url],
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

app.get('/gallery', async (req, res) => {
  const { category } = req.query;
  try {
    let query, params;
    if (category && category !== 'all') {
      query = 'SELECT style_id, style_name, description, example_image_url, category FROM prompts WHERE LOWER(category) = LOWER($1) ORDER BY id';
      params = [category];
    } else {
      query = 'SELECT style_id, style_name, description, example_image_url, category FROM prompts ORDER BY id';
      params = [];
    }
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch gallery', details: err.message });
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

async function generateForOrder(image_url, product, email, orderId) {
  let imageUrl = null;
  let videoUrl = null;

  if (product === 'image' || product === 'bundle') {
    imageUrl = await generateImage(image_url);
    console.log('Generated image:', imageUrl);
    if (orderId) {
      await pool.query('UPDATE orders SET result_url = $1 WHERE id = $2', [imageUrl, orderId]);
    }
  }

  if (product === 'video' || product === 'bundle') {
    videoUrl = await generateVideo(image_url);
    console.log('Generated video:', videoUrl);
    if (orderId) {
      await pool.query('UPDATE orders SET result_video_url = $1 WHERE id = $2', [videoUrl, orderId]);
    }
  }

  if (email) {
    await sendResultEmail(email, product, imageUrl, videoUrl);
  }
}

async function sendResultEmail(email, product, imageUrl, videoUrl) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#FFF9E6;padding:40px 32px;border-radius:12px;">
      <h1 style="font-size:26px;color:#1C0A00;margin-bottom:8px;">Your Loveogram is ready! &#128081;</h1>
      <p style="font-size:16px;color:#3C2000;margin-bottom:24px;">Thank you for your order. Your portrait has been created and is ready to download.</p>
      ${imageUrl ? `<p style="margin:16px 0;"><a href="${imageUrl}" style="display:inline-block;padding:12px 24px;background:#3A6B20;color:white;text-decoration:none;border-radius:8px;font-weight:700;font-family:Arial,sans-serif;">Download your Loveogram</a></p>` : ''}
      ${videoUrl ? `<p style="margin:16px 0;"><a href="${videoUrl}" style="display:inline-block;padding:12px 24px;background:#1C2A14;color:white;text-decoration:none;border-radius:8px;font-weight:700;font-family:Arial,sans-serif;">Download your Loveogram Video</a></p>` : ''}
      <hr style="border:none;border-top:1px solid rgba(0,0,0,0.1);margin:32px 0 16px;" />
      <p style="font-size:13px;color:#888;margin:0;">Reply to this email if you need any help.</p>
      <p style="font-size:13px;color:#888;margin-top:8px;">&#8212; Turtle and Sun</p>
    </div>
  `;

  await resend.emails.send({
    from: 'Turtle and Sun <noreply@turtleandsun.com>',
    to: email,
    subject: 'Your Loveogram is ready! 🎨',
    html,
  });
  console.log('Email sent to', email);
}

initDb()
  .then(() => seedGallery())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
