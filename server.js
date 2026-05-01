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
const { google } = require('googleapis');
const {
  createMagicLink, verifyMagicLink, findOrCreateUser,
  createSession, setSessionCookie, getSessionUser,
  requireAuth, requireRole,
} = require('./auth');

function googleOAuthClient() {
  const base = process.env.APP_URL || 'http://localhost:8080';
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${base}/auth/google/callback`
  );
}

fal.config({ credentials: process.env.FAL_API_KEY });
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
app.set('trust proxy', true);
app.use((req, res, next) => {
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    return next();
  }
  res.redirect(301, `https://${req.get('host')}${req.url}`);
});
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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'turtleandsun-landing.html')));
app.get('/faq', (req, res) => res.sendFile(path.join(__dirname, 'faq.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'pricing.html')));

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

app.get('/api/auth/status', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, email: user.email, isAdmin: user.roles.includes('admin') });
});

app.get('/auth/logout', (req, res) => {
  res.clearCookie('ts_session', { path: '/' });
  res.redirect('/');
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('ts_session', { path: '/' });
  res.redirect('/');
});

// ── Google OAuth (contacts) ───────────────────────────────────────────────────

app.get('/auth/google/contacts', requireAuth, (req, res) => {
  const client = googleOAuthClient();
  const url = client.generateAuthUrl({
    access_type: 'online',
    scope: ['https://www.googleapis.com/auth/contacts.readonly'],
    prompt: 'consent',
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/account/contacts?error=cancelled');

  const user = await getSessionUser(req);
  if (!user) return res.redirect('/login');

  try {
    const client = googleOAuthClient();
    const { tokens } = await client.getToken({ code, redirect_uri: 'https://turtleandsun.com/auth/google/callback' });
    client.setCredentials(tokens);

    const people = google.people({ version: 'v1', auth: client });
    let connections = [];
    let pageToken;
    do {
      const resp = await people.people.connections.list({
        resourceName: 'people/me',
        pageSize: 1000,
        personFields: 'names,emailAddresses,phoneNumbers,addresses,birthdays',
        ...(pageToken && { pageToken }),
      });
      connections = connections.concat(resp.data.connections || []);
      pageToken = resp.data.nextPageToken;
    } while (pageToken);

    let saved = 0;
    for (const c of connections) {
      const googleId = c.resourceName;
      if (!googleId) continue;
      const name  = c.names?.[0]?.displayName    || null;
      const email = c.emailAddresses?.[0]?.value  || null;
      const phone = c.phoneNumbers?.[0]?.value    || null;
      const addr = c.addresses?.[0] || null;
      const street = addr?.streetAddress || null;
      const city = addr?.city || null;
      const country = addr?.country || null;
      const postal_code = addr?.postalCode || null;
      const bd = c.birthdays?.[0]?.date;
      const birthday = bd ? `${bd.year || ''}-${String(bd.month).padStart(2,'0')}-${String(bd.day).padStart(2,'0')}` : null;
      await pool.query(
        `INSERT INTO contacts (user_id, google_id, name, email, phone, street, city, country, postal_code, birthday)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (user_id, google_id) DO UPDATE
           SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone,
               street = EXCLUDED.street, city = EXCLUDED.city, country = EXCLUDED.country,
               postal_code = EXCLUDED.postal_code, birthday = EXCLUDED.birthday`,
        [user.id, googleId, name, email, phone, street, city, country, postal_code, birthday]
      );
      saved++;
    }
    console.log(`Synced ${saved} contacts for user ${user.id}`);
    res.redirect(`/account/contacts?synced=${saved}`);
  } catch (err) {
    console.error('Google contacts sync error:', err.message);
    res.redirect('/account/contacts?error=failed');
  }
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

app.get('/account/contacts', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'contacts.html'));
});

app.get('/account/network', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'network.html'));
});

app.get('/api/network', requireAuth, async (req, res) => {
  try {
    const contacts = await pool.query(
      `SELECT id, name, email, birthday, city FROM contacts WHERE user_id = $1`,
      [req.user.id]
    );
    const relationships = await pool.query(
      `SELECT cr.contact_a_id, cr.contact_b_id, rt.name AS relationship, g.name AS group_name
       FROM contact_relationships cr
       JOIN relationship_types rt ON rt.id = cr.relationship_type_id
       JOIN groups g ON g.id = rt.group_id
       WHERE cr.user_id = $1`,
      [req.user.id]
    );
    const groupMemberships = await pool.query(
      `SELECT cgm.group_id, g.name AS group_name, cgm.contact_id
       FROM contact_group_memberships cgm
       JOIN groups g ON g.id = cgm.group_id
       WHERE cgm.user_id = $1`,
      [req.user.id]
    );
    res.json({
      contacts: contacts.rows,
      relationships: relationships.rows,
      group_memberships: groupMemberships.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Contacts management API ───────────────────────────────────────────────────

app.get('/api/contacts', requireAuth, async (req, res) => {
  try {
    const contacts = await pool.query(
      `SELECT id, google_id, name, email, phone, street, city, country, postal_code, birthday, is_placeholder
       FROM contacts WHERE user_id = $1 ORDER BY name ASC NULLS LAST`,
      [req.user.id]
    );
    res.json(contacts.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts/placeholder', requireAuth, async (req, res) => {
  const { name } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO contacts (user_id, name, is_placeholder) VALUES ($1, $2, TRUE) RETURNING id`,
      [req.user.id, name]
    );
    res.json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/contacts/:id', requireAuth, async (req, res) => {
  try {
    const contact = await pool.query(
      `SELECT id, google_id, name, email, phone, street, city, country, postal_code, birthday, is_placeholder
       FROM contacts WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!contact.rows.length) return res.status(404).json({ error: 'Not found' });

    const relationships = await pool.query(
      `SELECT cr.id, cr.contact_b_id, c.name AS related_name, rt.name AS relationship_name
       FROM contact_relationships cr
       JOIN contacts c ON c.id = cr.contact_b_id
       JOIN relationship_types rt ON rt.id = cr.relationship_type_id
       WHERE cr.contact_a_id = $1 AND cr.user_id = $2`,
      [req.params.id, req.user.id]
    );

    const orders = await pool.query(
      `SELECT id, product, status, amount, created_at FROM orders WHERE email = $1 ORDER BY created_at DESC`,
      [contact.rows[0].email || '']
    );

    res.json({ ...contact.rows[0], relationships: relationships.rows, loveograms: orders.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/contacts/:id', requireAuth, async (req, res) => {
  const { name, email, phone, street, city, country, postal_code, birthday } = req.body;
  try {
    await pool.query(
      `UPDATE contacts SET name=$1, email=$2, phone=$3, street=$4, city=$5, country=$6, postal_code=$7, birthday=$8
       WHERE id=$9 AND user_id=$10`,
      [name, email, phone, street, city, country, postal_code, birthday, req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/relationship-types', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT rt.id, rt.name, rt.mirror_id, g.name AS group_name
       FROM relationship_types rt
       JOIN groups g ON g.id = rt.group_id
       WHERE g.user_id = $1
       ORDER BY g.name, rt.name`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contact-relationships', requireAuth, async (req, res) => {
  const { contact_a_id, contact_b_id, relationship_type_id } = req.body;
  try {
    await pool.query(
      `INSERT INTO contact_relationships (user_id, contact_a_id, contact_b_id, relationship_type_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [req.user.id, contact_a_id, contact_b_id, relationship_type_id]
    );
    const mirror = await pool.query(
      `SELECT mirror_id FROM relationship_types WHERE id = $1`,
      [relationship_type_id]
    );
    if (mirror.rows[0]?.mirror_id) {
      await pool.query(
        `INSERT INTO contact_relationships (user_id, contact_a_id, contact_b_id, relationship_type_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [req.user.id, contact_b_id, contact_a_id, mirror.rows[0].mirror_id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/contact-relationships/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM contact_relationships WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/account/contacts', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, google_id, name, email, phone, created_at FROM contacts WHERE user_id = $1 ORDER BY name ASC NULLS LAST',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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


app.get('/admin/run-seed-demo', async (req, res) => {
  try {
    const seed = require('./seed-demo-user');
    await seed();
    res.send('Seed complete. Now remove this route from server.js.');
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).send('Seed failed: ' + err.message);
  }
});

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
