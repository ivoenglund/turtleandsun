require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { fal } = require('@fal-ai/client');
const Stripe = require('stripe');
const { Resend } = require('resend');
const { initDb, pool, seedGallery } = require('./db');
const { uploadStream } = require('./cloudinary');
const {
  createMagicLink, verifyMagicLink, findOrCreateUser,
  createSession, setSessionCookie, getSessionUser,
  requireAuth, requireRole,
} = require('./auth');

fal.config({ credentials: process.env.FAL_API_KEY });
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ storage: multer.memoryStorage() });

const PRODUCTS = {
  image:  { name: 'Royal Portrait — Image',   amount: 1499 },
  video:  { name: 'Royal Portrait — Video',   amount: 1999 },
  bundle: { name: 'Royal Portrait — Bundle',  amount: 2999 },
};

const ROYAL_VIDEO_PROMPT =
  'The royal portrait painting slowly comes to life — subtle movement in the regal robes and hair, ' +
  'dramatic candlelight flickering across the face, eyes gently alive with regal presence. ' +
  'Cinematic depth of field, atmospheric palace setting with soft volumetric light. ' +
  'Painterly and majestic, museum-quality motion. Preserve the exact face and identity of the subject.';

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
    const { email, image_url, portrait_url, product } = session.metadata || {};

    console.log('checkout.session.completed — email:', email, 'product:', product, 'portrait_url:', portrait_url);

    if (!product) {
      console.warn('Webhook missing product in metadata, skipping generation');
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

    // Deliver portrait — no re-generation needed
    console.log('Delivering for order:', orderId);
    generateForOrder(portrait_url || image_url, product, email || '', orderId).catch(err =>
      console.error('Delivery error for session:', session.id, err.message)
    );
  }

  res.json({ received: true });
});

app.use(cookieParser());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'turtleandsun-landing.html'));
});

// ── Auth ──────────────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/auth/request-link', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  const normalised = email.toLowerCase().trim();
  try {
    const token = await createMagicLink(normalised);
    const origin = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const link = `${origin}/auth/verify?token=${token}`;
    await resend.emails.send({
      from: 'Turtle and Sun <noreply@turtleandsun.com>',
      to: normalised,
      subject: 'Your login link for Turtle and Sun',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:40px 32px;">
          <h2 style="color:#1C0A00;margin-bottom:16px;">Log in to Turtle and Sun</h2>
          <p style="color:#3C2000;margin-bottom:24px;">Click the button below to log in. This link expires in 15 minutes and can only be used once.</p>
          <a href="${link}" style="display:inline-block;padding:12px 28px;background:#3A6B20;color:white;text-decoration:none;border-radius:8px;font-weight:700;">Log in</a>
          <p style="margin-top:24px;font-size:13px;color:#888;">If you didn't request this, you can ignore this email.</p>
        </div>
      `,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Magic link error:', err.message);
    res.status(500).json({ error: 'Failed to send login link' });
  }
});

app.get('/auth/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/login?error=missing');
  try {
    const email = await verifyMagicLink(token);
    if (!email) return res.redirect('/login?error=invalid');
    const userId = await findOrCreateUser(email);
    const { token: sessionToken, expiresAt } = await createSession(userId);
    setSessionCookie(res, sessionToken, expiresAt);
    const adminCheck = await pool.query(
      "SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin'",
      [userId]
    );
    res.redirect(adminCheck.rows.length ? '/admin' : '/account');
  } catch (err) {
    console.error('Verify error:', err.message);
    res.redirect('/login?error=server');
  }
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('ts_session', { path: '/' });
  res.redirect('/login');
});

// ── Admin ─────────────────────────────────────────────────────────────────────

app.get('/admin', requireRole('admin'), (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/api/admin/data', requireRole('admin'), async (req, res) => {
  try {
    const [orders, users] = await Promise.all([
      pool.query(
        'SELECT id, email, product, status, amount, created_at FROM orders ORDER BY created_at DESC LIMIT 200'
      ),
      pool.query(
        `SELECT u.id, u.email, u.preview_count, u.has_purchased, u.created_at,
                COALESCE(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
         FROM users u
         LEFT JOIN user_roles r ON r.user_id = u.id
         GROUP BY u.id ORDER BY u.created_at DESC LIMIT 200`
      ),
    ]);
    res.json({ orders: orders.rows, users: users.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/grant-role', requireRole('admin'), async (req, res) => {
  const { email, role } = req.body;
  if (!['admin', 'moderator', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });
    await pool.query(
      'INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1, $2, $3) ON CONFLICT (user_id, role) DO NOTHING',
      [userRes.rows[0].id, role, req.user.email]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/revoke-role', requireRole('admin'), async (req, res) => {
  const { email, role } = req.body;
  try {
    await pool.query(
      'DELETE FROM user_roles WHERE user_id = (SELECT id FROM users WHERE email = $1) AND role = $2',
      [email, role]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Account ───────────────────────────────────────────────────────────────────

app.get('/account', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'account.html'));
});

app.get('/api/account/data', requireAuth, async (req, res) => {
  try {
    const orders = await pool.query(
      'SELECT id, product, status, amount, result_url, result_video_url, created_at FROM orders WHERE email = $1 ORDER BY created_at DESC',
      [req.user.email]
    );
    res.json({ user: { email: req.user.email, roles: req.user.roles }, orders: orders.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  const { product, image_url, portrait_url, email } = req.body;
  if (!PRODUCTS[product]) return res.status(400).json({ error: 'Invalid product' });
  if (!image_url) return res.status(400).json({ error: 'image_url is required' });

  const origin = `${req.protocol}://${req.get('host')}`;
  try {
    const meta = { product, image_url, portrait_url: portrait_url || '', email: email || '' };
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
      metadata: meta,
      payment_intent_data: { metadata: meta },
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


app.post('/generate-video', async (req, res) => {
  const { image_url, email, order_id } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url is required' });

  try {
    console.log('Generating video for image:', image_url);
    const videoUrl = await generateVideo(image_url);
    console.log('Video generated:', videoUrl);

    if (order_id) {
      await pool.query('UPDATE orders SET result_video_url = $1 WHERE id = $2', [videoUrl, order_id]);
    }

    if (email) {
      await sendResultEmail(email, 'video', null, videoUrl);
    }

    res.json({ url: videoUrl });
  } catch (err) {
    console.error('Video generation error:', err.message);
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

async function generateVideo(portrait_url) {
  const result = await fal.subscribe('fal-ai/kling-video/v3/pro/image-to-video', {
    input: {
      image_url: portrait_url,
      prompt: ROYAL_VIDEO_PROMPT,
      duration: '5',
      enable_audio: true,
    },
  });
  return result.data.video.url;
}

// portrait_url is the already-generated preview image — no re-generation needed for image product
async function generateForOrder(portrait_url, product, email, orderId) {
  let imageUrl = null;
  let videoUrl = null;

  if (product === 'image' || product === 'bundle') {
    imageUrl = portrait_url;
    console.log('Using preview portrait as final image:', imageUrl);
    if (orderId) {
      await pool.query('UPDATE orders SET result_url = $1 WHERE id = $2', [imageUrl, orderId]);
    }
  }

  if (product === 'video' || product === 'bundle') {
    videoUrl = await generateVideo(portrait_url);
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
