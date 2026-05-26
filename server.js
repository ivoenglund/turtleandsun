require('dotenv').config();

// Sentry must be initialized before express is required so the SDK can
// auto-instrument incoming requests (v10 has no manual requestHandler middleware).
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  });
}

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
const gelato = require('./gelato');
const generation = require('./generation');
const cron = require('node-cron');
const crypto = require('crypto');
const { lookup: geoLookup } = require('./geoip');
const {
  createMagicLink, verifyMagicLink, findOrCreateUser,
  createSession, setSessionCookie, getSessionUser,
  requireAuth, requireRole,
} = require('./auth');
const { sendDailyDigest } = require('./digest');

async function geocodeContact(contact) {
  const parts = [contact.street, contact.city, contact.region, contact.country].filter(Boolean);
  if (parts.length < 2) return null;
  const query = encodeURIComponent(parts.join(', '));
  const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'turtleandsun.com' } });
    const data = await res.json();
    if (data.length > 0) {
      return { latitude: parseFloat(data[0].lat), longitude: parseFloat(data[0].lon) };
    }
  } catch (err) {
    console.error('Geocoding error:', err.message);
  }
  return null;
}

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
  if (process.env.NODE_ENV !== 'production') { return next(); } if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    return next();
  }
  res.redirect(301, `https://${req.get('host')}${req.url}`);
});
const PORT = process.env.PORT || 8080;
const upload = multer({ storage: multer.memoryStorage() });

const PRODUCTS = {
  image:  { name: 'Royal Portrait — Image',  amounts: { sek: 9900,  usd: 999,  eur: 999,  gbp: 799 } },
  video:  { name: 'Royal Portrait — Video',  amounts: { sek: 14900, usd: 1499, eur: 1399, gbp: 1199 } },
  bundle: { name: 'Royal Portrait — Bundle', amounts: { sek: 19900, usd: 1999, eur: 1899, gbp: 1599 } },
};
const SUPPORTED_CURRENCIES = new Set(['sek', 'usd', 'eur', 'gbp']);
const EU_COUNTRIES = new Set(['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES']);

function pickCurrency(countryCode) {
  if (!countryCode) return 'usd';
  const code = countryCode.toUpperCase();
  if (code === 'SE') return 'sek';
  if (code === 'GB') return 'gbp';
  if (EU_COUNTRIES.has(code)) return 'eur';
  return 'usd';
}

function formatPrice(amount, currency) {
  const major = amount / 100;
  if (currency === 'sek') return `${Math.round(major)} kr`;
  if (currency === 'usd') return `$${major.toFixed(2)}`;
  if (currency === 'eur') return `€${major.toFixed(2)}`;
  if (currency === 'gbp') return `£${major.toFixed(2)}`;
  return `${major}`;
}

const ORIENTATION_ASPECT = { landscape: '16:9', portrait: '9:16', square: '1:1' };

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
    const { email, image_url, portrait_url, product, currency } = session.metadata || {};

    console.log('checkout.session.completed — email:', email, 'product:', product, 'portrait_url:', portrait_url);

    if (!product) {
      console.warn('Webhook missing product in metadata, skipping generation');
      return res.json({ received: true });
    }

    // Record order
    let orderId;
    try {
      const orderRes = await pool.query(
        'INSERT INTO orders (email, style_id, product, status, amount, currency) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [email || '', null, product, 'paid', session.amount_total / 100, currency || 'sek']
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
    generateForOrder(portrait_url || image_url, product, email || '', orderId).catch(async (err) => {
      console.error('Delivery error for session:', session.id, err.message);

      // Record the failure so it can be retried from the admin panel
      try {
        await pool.query(
          `INSERT INTO failed_deliveries (order_id, email, product, portrait_url, error_message)
           VALUES ($1, $2, $3, $4, $5)`,
          [orderId || null, email || '', product, portrait_url || image_url, err.message]
        );
      } catch (dbErr) {
        console.error('failed_deliveries insert error:', dbErr.message);
      }

      // Alert admin — own try/catch so a Resend failure can't crash the handler
      try {
        await resend.emails.send({
          from: 'Turtle and Sun <noreply@turtleandsun.com>',
          to: 'ivo.englund@gmail.com',
          subject: `Turtleandsun: delivery failed for order #${orderId}`,
          html: `<p>A Loveogram delivery failed and needs attention.</p>
                 <ul>
                   <li><strong>Order:</strong> #${orderId}</li>
                   <li><strong>Email:</strong> ${email || '(none)'}</li>
                   <li><strong>Product:</strong> ${product}</li>
                   <li><strong>Error:</strong> ${err.message}</li>
                 </ul>
                 <p><a href="https://turtleandsun.com/admin/failed-deliveries">Open failed deliveries</a></p>`,
        });
      } catch (mailErr) {
        console.error('Admin alert email error:', mailErr.message);
      }
    });
  }

  res.json({ received: true });
});

app.use(cookieParser());
app.use(express.json());

// Prevent caching of HTML pages and API responses so deploys and auth changes take effect immediately
app.use((req, res, next) => {
  const isHtml = req.path.endsWith('.html') || req.path === '/' || (!req.path.includes('.') && !req.path.startsWith('/api/'));
  const isApi = req.path.startsWith('/api/');
  if (isHtml || isApi) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

// ── Visitor logging ─────────────────────────────────────────────────────────
const VISITS_ASSET_RE = /\.(?:js|css|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|map|mmdb|txt|xml|json|webmanifest)$/i;

function visitorIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip;
}

app.use((req, res, next) => {
  const p = req.path;
  if (p === '/webhook' || p.startsWith('/admin/') || p.startsWith('/api/') || VISITS_ASSET_RE.test(p)) return next();

  const requestId = crypto.randomUUID();
  req.requestId = requestId;

  res.on('finish', () => {
    const ip = visitorIp(req) || 'unknown';
    const statusCode = res.statusCode;
    const method = req.method;
    const reqPath = req.path; // query string intentionally dropped
    const userAgent = req.headers['user-agent'] || null;
    const referrer = req.headers['referer'] || req.headers['referrer'] || null;

    (async () => {
      try {
        let userId = null;
        try {
          const user = await getSessionUser(req);
          userId = user ? user.id : null;
        } catch { /* anonymous or session error — leave null */ }

        const geo = await geoLookup(ip);

        await pool.query(
          `INSERT INTO visits
             (ip, method, path, status_code, user_agent, referrer,
              country, region, city, lat, lng, user_id, request_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [ip, method, reqPath, statusCode, userAgent, referrer,
           geo.country, geo.region, geo.city, geo.lat, geo.lng, userId, requestId]
        );
      } catch (err) {
        console.error('[visits] insert error:', err.message);
      }
    })();
  });

  next();
});

// Block direct-by-filename access to non-public *.html (route handlers use
// res.sendFile and bypass this URL-path check, so gated pages still render).
const PUBLIC_HTML = new Set([
  '/turtleandsun-landing.html',
  '/pricing.html',
  '/faq.html',
  '/login.html',
]);
app.use((req, res, next) => {
  if (req.path.endsWith('.html') && !PUBLIC_HTML.has(req.path)) {
    return res.status(404).send('Not found');
  }
  next();
});

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
          <p style="margin-top:8px;font-size:13px;color:#888;">Questions? This inbox isn't monitored &#8212; write to <a href="mailto:hello@turtleandsun.com" style="color:#3A6B20;">hello@turtleandsun.com</a> and we'll reply.</p>
        </div>
      `,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Magic link error:', err.message);
    res.status(500).json({ error: 'Failed to send login link' });
  }
});

async function ensureIsMe(userId, email) {
  const existing = await pool.query(
    `SELECT id FROM contacts WHERE user_id = $1 AND is_me = TRUE`, [userId]
  );
  if (!existing.rows.length) {
    await pool.query(
      `INSERT INTO contacts (user_id, email, is_me) VALUES ($1, $2, TRUE)`,
      [userId, email]
    );
  }
}

async function ensureFamilyGroup(userId) {
  const existing = await pool.query(
    `SELECT id FROM groups WHERE user_id = $1 AND name = 'Family'`, [userId]
  );
  if (existing.rows.length) return;
  const gRes = await pool.query(
    `INSERT INTO groups (user_id, name) VALUES ($1, 'Family') RETURNING id`, [userId]
  );
  const gid = gRes.rows[0].id;
  const pairs = [
    ['Mother of', 'Son of'],
    ['Mother of', 'Daughter of'],
    ['Father of', 'Son of'],
    ['Father of', 'Daughter of'],
    ['Spouse', 'Spouse'],
    ['Owner of', 'Pet of'],
  ];
  for (const [a, b] of pairs) {
    const aRes = await pool.query(
      `INSERT INTO relationship_types (group_id, name) VALUES ($1, $2) RETURNING id`, [gid, a]
    );
    const aId = aRes.rows[0].id;
    if (a === b) {
      await pool.query(`UPDATE relationship_types SET mirror_id=$1 WHERE id=$1`, [aId]);
    } else {
      const bRes = await pool.query(
        `INSERT INTO relationship_types (group_id, name) VALUES ($1, $2) RETURNING id`, [gid, b]
      );
      const bId = bRes.rows[0].id;
      await pool.query(`UPDATE relationship_types SET mirror_id=$1 WHERE id=$2`, [bId, aId]);
      await pool.query(`UPDATE relationship_types SET mirror_id=$1 WHERE id=$2`, [aId, bId]);
    }
  }
}

app.get('/auth/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/login?error=missing');
  try {
    const email = await verifyMagicLink(token);
    if (!email) return res.redirect('/login?error=invalid');
    const userId = await findOrCreateUser(email);
    await ensureFamilyGroup(userId);
    await ensureIsMe(userId, email);
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
  console.log('[auth] cookies:', req.cookies, 'session token present:', !!req.cookies?.ts_session);
  const user = await getSessionUser(req);
  console.log('[auth] resolved user:', user?.email || 'none');
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
        personFields: 'names,emailAddresses,phoneNumbers,addresses,birthdays,organizations',
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
      const company = c.organizations?.[0]?.name  || null;
      const addr = c.addresses?.[0] || null;
      const street = addr?.streetAddress || null;
      const street_2 = addr?.extendedAddress || null;
      const city = addr?.city || null;
      const region = addr?.region || null;
      const country = addr?.country || null;
      const postal_code = addr?.postalCode || null;
      const bd = c.birthdays?.[0]?.date;
      const birthday = bd ? `${bd.year || ''}-${String(bd.month).padStart(2,'0')}-${String(bd.day).padStart(2,'0')}` : null;
      await pool.query(
        `INSERT INTO contacts (user_id, google_id, name, email, phone, company, street, street_2, city, region, country, postal_code, birthday)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (user_id, google_id) DO UPDATE
           SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone,
               company = EXCLUDED.company,
               street = EXCLUDED.street, street_2 = EXCLUDED.street_2,
               city = EXCLUDED.city, region = EXCLUDED.region, country = EXCLUDED.country,
               postal_code = EXCLUDED.postal_code, birthday = EXCLUDED.birthday`,
        [user.id, googleId, name, email, phone, company, street, street_2, city, region, country, postal_code, birthday]
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
  const card = (title, desc, href, external) => {
    const ext = external ? ' target="_blank" rel="noopener"' : '';
    return `<a class="admin-card" href="${href}"${ext}>
      <div class="admin-card-title">${escapeHtml(title)}${external ? ' ↗' : ''}</div>
      <div class="admin-card-desc">${escapeHtml(desc)}</div>
    </a>`;
  };
  const section = (heading, cards) =>
    `<h2 class="admin-section">${heading}</h2><div class="admin-grid">${cards}</div>`;

  const digestCard = `<div class="admin-card">
      <div class="admin-card-title">Trigger daily digest</div>
      <div class="admin-card-desc">Send the daily ops email now.</div>
      <div style="margin-top:8px;"><button type="button" class="btn small" id="btnDigest" onclick="sendDigest()">Send now</button>
        <span id="digestStatus" class="muted" style="margin-left:8px;"></span></div>
    </div>`;

  const body = `
    <h1>Admin dashboard</h1>
    <style>
      .admin-section{font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#1C0A00;margin:28px 0 12px;}
      .admin-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;}
      .admin-card{display:block;background:#fff;border:1px solid #eee;border-radius:10px;padding:14px 16px;text-decoration:none;color:#1C0A00;transition:box-shadow 0.15s,transform 0.15s;}
      .admin-card:hover{box-shadow:0 6px 20px rgba(0,0,0,0.08);transform:translateY(-1px);}
      .admin-card-title{font-weight:700;font-size:14px;margin-bottom:4px;}
      .admin-card-desc{font-size:12px;color:#888;line-height:1.4;}
    </style>
    ${section('\u{1F4CA} Analytics',
      card('Visits & visitor map', 'Traffic log, geo map, and IP labels.', '/admin/visits') +
      card('Failed deliveries', 'Orders that failed generation or email.', '/admin/failed-deliveries') +
      digestCard +
      card('Sentry', 'Error tracking and alerts.', 'https://turtle-and-sun.sentry.io/', true) +
      card('Plausible', 'Privacy-friendly traffic analytics.', 'https://plausible.io/turtleandsun.com', true) +
      card('Google Search Console', 'Search indexing and performance.', 'https://search.google.com/search-console', true)
    )}
    ${section('\u{1F3A8} Content',
      card('Concepts library', 'Manage style concepts and prompts.', '/admin/concepts') +
      card('Add new concept', 'Create a new style concept.', '/admin/concepts/new')
    )}
    ${section('\u{1F4B3} Payments',
      card('Stripe dashboard', 'Payments, payouts, and customers.', 'https://dashboard.stripe.com', true)
    )}
    ${section('\u{1F6E0}️ Integrations',
      card('fal.ai', 'AI generation credits and usage.', 'https://fal.ai/dashboard', true) +
      card('Resend', 'Transactional email delivery.', 'https://resend.com/emails', true) +
      card('Cloudinary', 'Media storage and uploads.', 'https://cloudinary.com/console', true) +
      card('ImprovMX', 'Inbound email forwarding.', 'https://app.improvmx.com/', true) +
      card('Railway', 'App hosting and deploys.', 'https://railway.app/', true)
    )}
    <script>
      async function sendDigest(){
        var b=document.getElementById('btnDigest'); var s=document.getElementById('digestStatus');
        b.disabled=true; s.textContent='Sending…';
        try { var r=await fetch('/admin/_digest_test'); if(!r.ok) throw new Error('HTTP '+r.status); s.textContent='Sent ✓'; }
        catch(e){ s.textContent='Failed: '+e.message; }
        b.disabled=false;
      }
    </script>`;
  res.send(conceptAdminPage('Admin dashboard', body));
});

app.get('/admin/visits', requireRole('admin'), (req, res) => {
  res.sendFile(path.join(__dirname, 'visits.html'));
});

const VISITS_MAX_ROWS = 5000;
const UTC_DAY_START = `date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

app.get('/admin/visits/data', requireRole('admin'), async (req, res) => {
  try {
    const { from, to, search, flagged_only } = req.query;
    const where = [];
    const params = [];

    if (from) { params.push(from); where.push(`v.created_at >= $${params.length}`); }
    if (to)   { params.push(to);   where.push(`v.created_at <= $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(v.ip ILIKE $${params.length} OR v.path ILIKE $${params.length} OR v.country ILIKE $${params.length} OR l.label ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
    }
    if (flagged_only === 'true' || flagged_only === '1') {
      where.push(`v.flagged = true`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(VISITS_MAX_ROWS);

    const visitsResult = await pool.query(
      `SELECT v.id, v.ip, v.created_at, v.method, v.path, v.status_code, v.user_agent,
              v.referrer, v.country, v.region, v.city, v.lat, v.lng, v.user_id, v.request_id, v.flagged,
              u.email AS email, l.label AS label
       FROM visits v
       LEFT JOIN users u ON v.user_id = u.id
       LEFT JOIN ip_labels l ON v.ip = l.ip
       ${whereSql}
       ORDER BY v.created_at DESC
       LIMIT $${params.length}`,
      params
    );

    const [totals, topCountry, topPath] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total, COUNT(DISTINCT ip)::int AS unique_ips
         FROM visits WHERE created_at >= ${UTC_DAY_START}`
      ),
      pool.query(
        `SELECT country, COUNT(*)::int AS c FROM visits
         WHERE created_at >= ${UTC_DAY_START} AND country IS NOT NULL
         GROUP BY country ORDER BY c DESC LIMIT 1`
      ),
      pool.query(
        `SELECT path, COUNT(*)::int AS c FROM visits
         WHERE created_at >= ${UTC_DAY_START}
         GROUP BY path ORDER BY c DESC LIMIT 1`
      ),
    ]);

    res.json({
      visits: visitsResult.rows,
      capped: visitsResult.rows.length >= VISITS_MAX_ROWS,
      stats: {
        total_today: totals.rows[0].total,
        unique_ips_today: totals.rows[0].unique_ips,
        top_country: topCountry.rows[0] || null,
        top_path: topPath.rows[0] || null,
      },
    });
  } catch (err) {
    console.error('[visits] data query error:', err.message);
    res.status(500).json({ error: 'Failed to load visits', details: err.message });
  }
});

app.post('/admin/visits/flag', requireRole('admin'), async (req, res) => {
  const { id, flagged } = req.body;
  if (!Number.isInteger(id) || typeof flagged !== 'boolean') {
    return res.status(400).json({ error: 'id (integer) and flagged (boolean) required' });
  }
  try {
    const result = await pool.query(
      `UPDATE visits SET flagged = $1 WHERE id = $2 RETURNING id, flagged`,
      [flagged, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Visit not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[visits] flag error:', err.message);
    res.status(500).json({ error: 'Failed to update flag', details: err.message });
  }
});

app.post('/admin/visits/label', requireRole('admin'), async (req, res) => {
  const { ip, label } = req.body;
  if (!ip || typeof ip !== 'string') return res.status(400).json({ error: 'ip required' });
  if (typeof label !== 'string' || !label.trim()) return res.status(400).json({ error: 'label required' });
  try {
    await pool.query(
      `INSERT INTO ip_labels (ip, label) VALUES ($1, $2)
       ON CONFLICT (ip) DO UPDATE SET label = $2, updated_at = NOW()`,
      [ip, label.trim()]
    );
    res.json({ ok: true, ip, label: label.trim() });
  } catch (err) {
    console.error('[visits] label save error:', err.message);
    res.status(500).json({ error: 'Failed to save label', details: err.message });
  }
});

app.delete('/admin/visits/label', requireRole('admin'), async (req, res) => {
  const { ip } = req.body;
  if (!ip || typeof ip !== 'string') return res.status(400).json({ error: 'ip required' });
  try {
    await pool.query(`DELETE FROM ip_labels WHERE ip = $1`, [ip]);
    res.json({ ok: true, ip });
  } catch (err) {
    console.error('[visits] label delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete label', details: err.message });
  }
});

app.get('/admin/failed-deliveries', requireRole('admin'), (req, res) => {
  res.sendFile(path.join(__dirname, 'failed-deliveries.html'));
});

app.get('/admin/failed-deliveries/data', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, order_id, email, product, portrait_url, error_message, retry_count, resolved, created_at
       FROM failed_deliveries ORDER BY created_at DESC`
    );
    res.json({ rows: result.rows });
  } catch (err) {
    console.error('[failed-deliveries] data query error:', err.message);
    res.status(500).json({ error: 'Failed to load failed deliveries', details: err.message });
  }
});

app.post('/admin/failed-deliveries/retry', requireRole('admin'), async (req, res) => {
  const { id } = req.body;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id (integer) required' });
  try {
    const lookup = await pool.query('SELECT * FROM failed_deliveries WHERE id = $1', [id]);
    if (!lookup.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = lookup.rows[0];

    await pool.query('UPDATE failed_deliveries SET retry_count = retry_count + 1 WHERE id = $1', [id]);

    try {
      await generateForOrder(row.portrait_url, row.product, row.email, row.order_id);
      await pool.query('UPDATE failed_deliveries SET resolved = true WHERE id = $1', [id]);
      res.json({ ok: true, resolved: true });
    } catch (genErr) {
      console.error('[failed-deliveries] retry generation error:', genErr.message);
      await pool.query('UPDATE failed_deliveries SET error_message = $1 WHERE id = $2', [genErr.message, id]);
      res.status(500).json({ ok: false, error: genErr.message });
    }
  } catch (err) {
    console.error('[failed-deliveries] retry error:', err.message);
    res.status(500).json({ error: 'Retry failed', details: err.message });
  }
});

app.post('/admin/failed-deliveries/resolve', requireRole('admin'), async (req, res) => {
  const { id } = req.body;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id (integer) required' });
  try {
    const result = await pool.query(
      'UPDATE failed_deliveries SET resolved = true WHERE id = $1 RETURNING id, resolved',
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[failed-deliveries] resolve error:', err.message);
    res.status(500).json({ error: 'Resolve failed', details: err.message });
  }
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

app.get('/account/occasions', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'occasions.html'));
});

app.get('/account/library', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'library.html'));
});

app.get('/api/library/orders', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, product, status, amount, result_url, created_at
       FROM orders
       WHERE result_url IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 20`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gelato/meta', requireAuth, (req, res) => {
  res.json({ testAddress: gelato.TEST_ADDRESS, cardProductUid: gelato.CARD_PRODUCT_UID });
});

app.post('/api/gelato/test-print', requireAuth, async (req, res) => {
  const { imageUrl, orderId } = req.body;
  if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required' });
  try {
    const result = await gelato.testPrint(imageUrl, orderId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/print/loveogram', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'print-loveogram.html'));
});

app.get('/print/labels', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'print-labels.html'));
});

app.get('/print/calendar', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'print-calendar.html'));
});

// ── Groups ────────────────────────────────────────────────────────────────────

app.get('/api/groups', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, parent_group_id FROM groups WHERE user_id = $1 ORDER BY name`, [req.user.id]
    );
    const byParent = {};
    result.rows.forEach(g => {
      const pid = g.parent_group_id || 0;
      if (!byParent[pid]) byParent[pid] = [];
      byParent[pid].push(g);
    });
    function buildTree(g) {
      const children = (byParent[g.id] || []).sort((a, b) => a.name.localeCompare(b.name));
      return { id: g.id, name: g.name, parent_group_id: g.parent_group_id || null, subgroups: children.map(buildTree) };
    }
    const nested = (byParent[0] || []).map(buildTree);
    nested.sort((a, b) => a.name === 'Family' ? -1 : b.name === 'Family' ? 1 : a.name.localeCompare(b.name));
    res.json(nested);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/group-memberships', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT contact_id, group_id FROM contact_group_memberships WHERE user_id = $1`, [req.user.id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/groups', requireAuth, async (req, res) => {
  const { name, parent_group_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  if (parent_group_id) {
    const parent = await pool.query(
      `SELECT name FROM groups WHERE id = $1 AND user_id = $2`, [parent_group_id, req.user.id]
    );
    if (!parent.rows.length) return res.status(404).json({ error: 'Parent group not found' });
    if (parent.rows[0].name === 'Family') return res.status(400).json({ error: 'Family cannot have subgroups.' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO groups (user_id, name, parent_group_id) VALUES ($1, $2, $3) RETURNING id, name, parent_group_id`,
      [req.user.id, name.trim(), parent_group_id || null]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function deleteGroupCascade(groupId, userId) {
  const subs = await pool.query(
    `SELECT id FROM groups WHERE parent_group_id = $1 AND user_id = $2`, [groupId, userId]
  );
  for (const sub of subs.rows) await deleteGroupCascade(sub.id, userId);
  await pool.query(`DELETE FROM contact_group_memberships WHERE group_id = $1 AND user_id = $2`, [groupId, userId]);
  await pool.query(`DELETE FROM groups WHERE id = $1 AND user_id = $2`, [groupId, userId]);
}

app.delete('/api/groups/:id', requireAuth, async (req, res) => {
  try {
    const check = await pool.query(`SELECT name FROM groups WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
    if (!check.rows.length || check.rows[0].name === 'Family') return res.status(400).json({ error: 'Cannot delete this group.' });
    await deleteGroupCascade(req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Contact group memberships ─────────────────────────────────────────────────

app.get('/api/contacts/:id/groups', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT g.id, g.name FROM contact_group_memberships m
     JOIN groups g ON g.id = m.group_id
     WHERE m.contact_id = $1 AND m.user_id = $2`,
    [req.params.id, req.user.id]
  );
  res.json(result.rows);
});

app.post('/api/contacts/:id/groups', requireAuth, async (req, res) => {
  const { group_ids } = req.body;
  try {
    await pool.query(`DELETE FROM contact_group_memberships WHERE contact_id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    for (const gid of (group_ids || [])) {
      await pool.query(
        `INSERT INTO contact_group_memberships (user_id, contact_id, group_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [req.user.id, req.params.id, gid]
      );
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Occasions ─────────────────────────────────────────────────────────────────

app.get('/api/contacts/:id/occasions', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, start_date, frequency, notes FROM occasions WHERE contact_id = $1 AND user_id = $2 ORDER BY start_date`,
    [req.params.id, req.user.id]
  );
  res.json(result.rows);
});

app.post('/api/contacts/:id/occasions', requireAuth, async (req, res) => {
  const { name, start_date, frequency, notes } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO occasions (user_id, contact_id, name, start_date, frequency, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.user.id, req.params.id, name, start_date, frequency, notes || null]
    );
    res.json({ id: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/occasions/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM occasions WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/occasions/upcoming', requireAuth, async (req, res) => {
  try {
    const [occasions, contacts] = await Promise.all([
      pool.query(
        `SELECT o.id, o.name, o.start_date, o.frequency, o.notes, c.id AS contact_id, c.name AS contact_name
         FROM occasions o JOIN contacts c ON c.id = o.contact_id
         WHERE o.user_id = $1`, [req.user.id]
      ),
      pool.query(
        `SELECT id, name, birthday, died_on FROM contacts WHERE user_id = $1`, [req.user.id]
      ),
    ]);
    res.json({ occasions: occasions.rows, contacts: contacts.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/network', requireAuth, async (req, res) => {
  try {
    const contacts = await pool.query(
      `SELECT id, name, email, birthday, city, died_on, is_pet, is_me, latitude, longitude FROM contacts WHERE user_id = $1`,
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
      `SELECT cgm.group_id, g.name AS group_name, g.parent_group_id, cgm.contact_id
       FROM contact_group_memberships cgm
       JOIN groups g ON g.id = cgm.group_id
       WHERE cgm.user_id = $1`,
      [req.user.id]
    );
    const groups = await pool.query(
      `SELECT id, name, parent_group_id FROM groups WHERE user_id = $1 ORDER BY name`, [req.user.id]
    );
    res.json({
      contacts: contacts.rows,
      relationships: relationships.rows,
      group_memberships: groupMemberships.rows,
      groups: groups.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Contacts management API ───────────────────────────────────────────────────

app.get('/api/contacts', requireAuth, async (req, res) => {
  try {
    const contacts = await pool.query(
      `SELECT id, google_id, name, email, phone, company, street, street_2, city, region, country, postal_code, birthday, is_placeholder, died_on, is_pet, is_me
       FROM contacts WHERE user_id = $1 ORDER BY is_me DESC NULLS LAST, name ASC NULLS LAST`,
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

app.get('/api/contacts/related-ids', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT contact_a_id AS id FROM contact_relationships WHERE user_id = $1
      UNION
      SELECT DISTINCT contact_b_id AS id FROM contact_relationships WHERE user_id = $1
      UNION
      SELECT DISTINCT contact_id AS id FROM contact_group_memberships WHERE user_id = $1
    `, [req.user.id]);
    res.json(result.rows.map(r => r.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/contacts/:id', requireAuth, async (req, res) => {
  try {
    const contact = await pool.query(
      `SELECT id, google_id, name, email, phone, company, street, street_2, city, region, country, postal_code, birthday, is_placeholder, died_on, is_pet, is_me
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
  const { name, email, phone, company, street, street_2, city, region, country, postal_code, birthday, died_on, is_pet } = req.body;
  try {
    await pool.query(
      `UPDATE contacts SET name=$1, email=$2, phone=$3, company=$4, street=$5, street_2=$6, city=$7, region=$8, country=$9, postal_code=$10, birthday=$11, died_on=$12, is_pet=$13
       WHERE id=$14 AND user_id=$15`,
      [name, email, phone, company, street, street_2, city, region, country, postal_code, birthday || null, died_on || null, !!is_pet, req.params.id, req.user.id]
    );
    res.json({ ok: true });

    // Async background geocoding — check if address changed and re-geocode
    const existing = await pool.query(
      `SELECT latitude, longitude, street, city, region, country FROM contacts WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (existing.rows.length) {
      const row = existing.rows[0];
      const addressChanged = row.street !== (street || null) || row.city !== (city || null) ||
                             row.region !== (region || null) || row.country !== (country || null);
      if (addressChanged || (!row.latitude && (city || country))) {
        const coords = await geocodeContact({ street, city, region, country });
        if (coords) {
          await pool.query(
            `UPDATE contacts SET latitude=$1, longitude=$2 WHERE id=$3 AND user_id=$4`,
            [coords.latitude, coords.longitude, req.params.id, req.user.id]
          );
        }
      }
    }
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else console.error('Background geocode error:', err.message);
  }
});

app.delete('/api/contacts/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const uid = req.user.id;
    await pool.query(`DELETE FROM contact_relationships WHERE (contact_a_id = $1 OR contact_b_id = $1) AND user_id = $2`, [id, uid]);
    await pool.query(`DELETE FROM contact_group_memberships WHERE contact_id = $1 AND user_id = $2`, [id, uid]);
    await pool.query(`DELETE FROM occasions WHERE contact_id = $1 AND user_id = $2`, [id, uid]);
    await pool.query(`DELETE FROM contacts WHERE id = $1 AND user_id = $2`, [id, uid]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

app.get('/api/currency', async (req, res) => {
  let country = null;
  try { country = (await geoLookup(visitorIp(req))).country; } catch (e) { /* geo unavailable */ }
  const detected = pickCurrency(country);
  const prices = {};
  for (const cur of SUPPORTED_CURRENCIES) {
    prices[cur] = {};
    for (const key of Object.keys(PRODUCTS)) {
      const amount = PRODUCTS[key].amounts[cur];
      prices[cur][key] = { amount, display: formatPrice(amount, cur) };
    }
  }
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ detected, country, supported: [...SUPPORTED_CURRENCIES], prices });
});

app.post('/create-checkout-session', async (req, res) => {
  const { product, image_url, portrait_url, email, orientation } = req.body;
  if (!PRODUCTS[product]) return res.status(400).json({ error: 'Invalid product' });
  if (!image_url) return res.status(400).json({ error: 'image_url is required' });

  let currency = req.body.currency;
  if (currency) {
    currency = String(currency).toLowerCase();
    if (!SUPPORTED_CURRENCIES.has(currency)) return res.status(400).json({ error: 'Unsupported currency' });
  } else {
    let country = null;
    try { country = (await geoLookup(visitorIp(req))).country; } catch (e) { /* geo unavailable */ }
    currency = pickCurrency(country);
  }

  const origin = `${req.protocol}://${req.get('host')}`;
  try {
    const meta = { product, image_url, portrait_url: portrait_url || '', email: email || '', orientation: orientation || '', currency };
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency,
          product_data: { name: PRODUCTS[product].name },
          unit_amount: PRODUCTS[product].amounts[currency],
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
    console.error('Checkout session error:', err);
    res.status(500).json({ error: 'Failed to create checkout session', details: err.message });
  }
});

app.post('/preview', async (req, res) => {
  const { image_url, email, orientation } = req.body;
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
        aspect_ratio: ORIENTATION_ASPECT[orientation] || 'auto',
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
      duration: '10',
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
      <p style="font-size:13px;color:#888;margin:0;">Questions? This inbox isn't monitored &#8212; write to <a href="mailto:hello@turtleandsun.com" style="color:#3A6B20;">hello@turtleandsun.com</a> and we'll reply.</p>
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



app.get('/admin/geocode-all', requireRole('admin'), async (req, res) => {
  const contacts = await pool.query(
    'SELECT * FROM contacts WHERE user_id = $1 AND latitude IS NULL AND city IS NOT NULL',
    [req.user.id]
  );
  let geocoded = 0;
  for (const c of contacts.rows) {
    const coords = await geocodeContact(c);
    if (coords) {
      await pool.query(
        'UPDATE contacts SET latitude = $1, longitude = $2 WHERE id = $3',
        [coords.latitude, coords.longitude, c.id]
      );
      geocoded++;
    }
    await new Promise(r => setTimeout(r, 1100));
  }
  res.send(`Geocoded ${geocoded} of ${contacts.rows.length} contacts`);
});

// ----- Concept admin tool -----

const CONCEPT_INPUT_TYPES = ['image_video', 'image', 'video'];
const TEST_COST_IMAGE = '$0.04';
const TEST_COST_VIDEO = '$0.25';

// Substitutes the customer's text into a prompt's {variable} token after sanitizing it.
// Shared by the admin test endpoints and (later) the live generation path.
function applyUserInput(prompt, concept, userInputValue) {
  if (!concept.user_input_enabled || !userInputValue) return prompt;
  if (!concept.user_input_variable) return prompt;
  let v = String(userInputValue).trim();
  v = v.replace(/[\u0000-\u001F\u007F]/g, ''); // strip control chars (incl. CR/LF/tab)
  v = v.replace(/["'`]/g, ''); // strip quote chars
  v = v.slice(0, concept.user_input_max_length || 50);
  if (!v) return prompt;
  const token = '{' + concept.user_input_variable + '}';
  return prompt.split(token).join(v);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function conceptAdminPage(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;color:#1C0A00;background:#FFF9E6;margin:0;padding:32px;}
  .wrap{max-width:1000px;margin:0 auto;}
  h1{font-size:24px;margin:0 0 20px;}
  a{color:#3A6B20;}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #eee;border-radius:8px;overflow:hidden;}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eee;font-size:14px;vertical-align:middle;}
  th{background:#FFF3C4;text-transform:uppercase;font-size:11px;letter-spacing:0.04em;}
  img.thumb{width:48px;height:48px;object-fit:cover;border-radius:6px;border:1px solid #ddd;background:#f3f3f3;}
  .btn{display:inline-block;padding:9px 16px;background:#3A6B20;color:#FFF9E6;border:none;border-radius:8px;font-size:14px;font-weight:700;text-decoration:none;cursor:pointer;}
  .btn.secondary{background:#1C0A00;}
  .btn.danger{background:#a12a1a;}
  .btn.small{padding:5px 10px;font-size:12px;}
  .flash{padding:12px 16px;border-radius:8px;margin-bottom:18px;font-size:14px;}
  .flash.ok{background:#e3f3d8;color:#2c5016;}
  .flash.err{background:#f7d9d4;color:#7a2114;}
  form.inline{display:inline;margin:0;}
  .field{margin-bottom:16px;}
  label{display:block;font-weight:700;font-size:13px;margin-bottom:6px;}
  input[type=text],input[type=number],textarea,select{width:100%;padding:9px 11px;border:1px solid #ccc;border-radius:8px;font-size:14px;font-family:inherit;box-sizing:border-box;}
  textarea{min-height:90px;resize:vertical;}
  .row{display:flex;gap:18px;flex-wrap:wrap;}
  .row .field{flex:1;min-width:220px;}
  .preview{margin-top:6px;}
  .preview img,.preview video{max-width:160px;max-height:120px;border-radius:6px;border:1px solid #ddd;display:block;}
  .muted{color:#888;font-size:12px;}
  .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

app.get('/admin/concepts', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, slug, name, filter_category, input_type, before_image_url, after_image_url,
              example_video_url, active, sort_order
       FROM concepts ORDER BY sort_order ASC, id ASC`
    );
    let flash = '';
    if (req.query.saved) flash = `<div class="flash ok">Concept saved.</div>`;
    else if (req.query.deleted) flash = `<div class="flash ok">Concept deleted.</div>`;
    else if (req.query.error) flash = `<div class="flash err">${escapeHtml(req.query.error)}</div>`;
    if (req.query.warn) flash += `<div class="flash err">${escapeHtml(req.query.warn)}</div>`;

    const tableRows = rows.map((c) => {
      const before = c.before_image_url
        ? `<img class="thumb" src="${escapeHtml(c.before_image_url)}" alt="before">` : '<span class="muted">—</span>';
      const after = c.after_image_url
        ? `<img class="thumb" src="${escapeHtml(c.after_image_url)}" alt="after">` : '<span class="muted">—</span>';
      return `<tr>
        <td>${c.sort_order}</td>
        <td>${before}</td>
        <td>${after}</td>
        <td><strong>${escapeHtml(c.name)}</strong><br><span class="muted">${escapeHtml(c.slug)}</span></td>
        <td>${escapeHtml(c.filter_category)}</td>
        <td>${escapeHtml(c.input_type)}</td>
        <td>
          <form class="inline" method="POST" action="/admin/concepts/toggle/${c.id}">
            <button class="btn small ${c.active ? '' : 'secondary'}" type="submit">${c.active ? 'Active' : 'Inactive'}</button>
          </form>
        </td>
        <td>
          <a class="btn small" href="/admin/concepts/edit/${c.id}">Edit</a>
          <form class="inline" method="POST" action="/admin/concepts/delete/${c.id}" onsubmit="return confirm('Delete concept &quot;${escapeHtml(c.name)}&quot;? This cannot be undone.');">
            <button class="btn small danger" type="submit">Delete</button>
          </form>
        </td>
      </tr>`;
    }).join('');

    const body = `
      <div class="top">
        <h1>Concepts</h1>
        <a class="btn" href="/admin/concepts/new">+ Add new concept</a>
      </div>
      ${flash}
      <table>
        <thead><tr>
          <th>Sort</th><th>Before</th><th>After</th><th>Name</th><th>Category</th>
          <th>Input</th><th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody>${tableRows || '<tr><td colspan="8" class="muted">No concepts yet.</td></tr>'}</tbody>
      </table>`;
    res.send(conceptAdminPage('Concepts', body));
  } catch (err) {
    console.error('[concepts] list error:', err.message);
    res.status(500).send('Failed to load concepts: ' + escapeHtml(err.message));
  }
});

function conceptFormBody(concept, errorMsg) {
  const c = concept || {};
  const isEdit = !!c.id;
  const v = (key) => escapeHtml(c[key] == null ? '' : c[key]);
  const inputTypeOptions = CONCEPT_INPUT_TYPES.map((t) =>
    `<option value="${t}"${(c.input_type || 'image_video') === t ? ' selected' : ''}>${t}</option>`
  ).join('');
  const mediaPreview = (url, kind) => {
    if (!url) return '';
    if (kind === 'video') return `<div class="preview"><video src="${escapeHtml(url)}" controls muted></video></div>`;
    return `<div class="preview"><img src="${escapeHtml(url)}" alt="current"></div>`;
  };
  const falImage = c.fal_image_model || 'fal-ai/kling-image/o1';
  const falVideo = c.fal_video_model || 'fal-ai/kling-video/v3/pro/image-to-video';
  const activeChecked = (isEdit ? c.active : true) ? ' checked' : '';
  const uiEnabledChecked = c.user_input_enabled ? ' checked' : '';

  return `
    <div class="top"><h1>${isEdit ? 'Edit concept' : 'New concept'}</h1><a href="/admin/concepts">&larr; Back to list</a></div>
    ${errorMsg ? `<div class="flash err">${escapeHtml(errorMsg)}</div>` : ''}
    <form method="POST" action="/admin/concepts/save" enctype="multipart/form-data">
      ${isEdit ? `<input type="hidden" name="id" value="${c.id}">` : ''}
      <input type="hidden" name="current_before_image_url" value="${v('before_image_url')}">
      <input type="hidden" name="current_after_image_url" value="${v('after_image_url')}">
      <input type="hidden" name="current_example_video_url" value="${v('example_video_url')}">
      <div class="row">
        <div class="field"><label>Name *</label><input type="text" name="name" value="${v('name')}" required></div>
        <div class="field"><label>Slug *</label><input type="text" name="slug" value="${v('slug')}" required>
          <span class="muted">Lowercase, no spaces — e.g. royal-portrait</span></div>
      </div>
      <div class="row">
        <div class="field"><label>Filter category *</label><input type="text" name="filter_category" value="${v('filter_category')}" required></div>
        <div class="field"><label>Input type</label><select name="input_type">${inputTypeOptions}</select></div>
        <div class="field"><label>Sort order</label><input type="number" name="sort_order" value="${c.sort_order == null ? 0 : escapeHtml(c.sort_order)}"></div>
      </div>
      <div class="field"><label>Image prompt *</label><textarea name="image_prompt" required>${v('image_prompt')}</textarea></div>
      <div class="field"><label>Video prompt</label><textarea name="video_prompt">${v('video_prompt')}</textarea></div>
      <div class="row">
        <div class="field"><label>fal image model</label><input type="text" name="fal_image_model" value="${escapeHtml(falImage)}"></div>
        <div class="field"><label>fal video model</label><input type="text" name="fal_video_model" value="${escapeHtml(falVideo)}"></div>
      </div>
      <div class="field"><label>Social caption</label><textarea name="social_caption">${v('social_caption')}</textarea></div>
      <div class="field" style="border-top:1px solid #eee;padding-top:16px;">
        <label><input type="checkbox" name="user_input_enabled" id="uiEnabled" value="on"${uiEnabledChecked} onchange="toggleUserInput()"> Enable customer text input (optional)</label>
      </div>
      <div id="uiFields" style="${uiEnabledChecked ? '' : 'display:none;'}">
        <div class="row">
          <div class="field"><label>Label</label><input type="text" name="user_input_label" value="${v('user_input_label')}" placeholder="Recipient's name"></div>
          <div class="field"><label>Placeholder</label><input type="text" name="user_input_placeholder" value="${v('user_input_placeholder')}" placeholder="Anna"></div>
        </div>
        <div class="row">
          <div class="field"><label>Variable name</label><input type="text" name="user_input_variable" value="${v('user_input_variable')}" placeholder="name" pattern="[a-z_][a-z0-9_]*"></div>
          <div class="field"><label>Max length</label><input type="number" name="user_input_max_length" value="${c.user_input_max_length == null ? 50 : escapeHtml(c.user_input_max_length)}"></div>
        </div>
        <p class="muted">Use {variable_name} in your prompts where the customer's text should appear. Example: variable 'name' + prompt containing '{name}' → customer types 'Anna' → prompt becomes 'Anna' at that position.</p>
      </div>
      <div class="row">
        <div class="field"><label>Before image</label><input type="file" name="before_image" accept="image/*">${mediaPreview(c.before_image_url, 'image')}</div>
        <div class="field"><label>After image</label><input type="file" name="after_image" accept="image/*">${mediaPreview(c.after_image_url, 'image')}</div>
        <div class="field"><label>Example video</label><input type="file" name="example_video" accept="video/*">${mediaPreview(c.example_video_url, 'video')}</div>
      </div>
      <div class="field"><label><input type="checkbox" name="active" value="on"${activeChecked}> Active</label></div>
      <button class="btn" type="submit">${isEdit ? 'Save changes' : 'Create concept'}</button>
    </form>

    <div style="border-top:1px solid #eee;margin-top:28px;padding-top:18px;">
      <h2 style="font-size:18px;margin:0 0 6px;">Test this concept</h2>
      <p class="muted" style="margin:0 0 14px;">Generates with the current (even unsaved) form values — no checkout, no email, no preview limit. Admin pays the fal.ai cost. Cost: ≈ ${TEST_COST_IMAGE} image / ≈ ${TEST_COST_VIDEO} video.</p>
      <div class="field"><label>Test photo</label><input type="file" id="testPhoto" accept="image/*"></div>
      <div class="field" id="testInputWrap" style="display:none;"><label id="testInputLabel">Customer text</label><input type="text" id="testUserInput"></div>
      <button type="button" class="btn secondary" id="btnTestImage" onclick="runTestImage()">Test image</button>
      <button type="button" class="btn secondary" id="btnTestVideo" onclick="runTestVideo()" disabled>Test video</button>
      <div id="testStatus" class="muted" style="margin-top:12px;"></div>
      <div id="testResult" style="margin-top:14px;"></div>
    </div>

    <script>
      function escJs(s){ var d=document.createElement('div'); d.textContent = (s==null?'':s); return d.innerHTML; }
      function toggleUserInput(){
        var on = document.getElementById('uiEnabled').checked;
        document.getElementById('uiFields').style.display = on ? '' : 'none';
        syncTestInput();
      }
      function syncTestInput(){
        var on = document.getElementById('uiEnabled').checked;
        var wrap = document.getElementById('testInputWrap');
        if(!wrap) return;
        wrap.style.display = on ? '' : 'none';
        document.getElementById('testInputLabel').textContent = (document.querySelector('[name=user_input_label]').value || 'Customer text');
        var ml = parseInt(document.querySelector('[name=user_input_max_length]').value, 10);
        var inp = document.getElementById('testUserInput');
        if(ml > 0) inp.maxLength = ml;
        inp.placeholder = (document.querySelector('[name=user_input_placeholder]').value || '');
      }
      function formVals(){
        var q = function(n){ var el=document.querySelector('[name='+n+']'); return el ? el.value : ''; };
        return {
          slug: q('slug'),
          image_prompt: q('image_prompt'),
          video_prompt: q('video_prompt'),
          fal_image_model: q('fal_image_model'),
          fal_video_model: q('fal_video_model'),
          user_input_variable: q('user_input_variable'),
          user_input_max_length: q('user_input_max_length'),
          user_input_enabled: document.getElementById('uiEnabled').checked
        };
      }
      function setStatus(m){ document.getElementById('testStatus').textContent = m || ''; }
      function setBusy(busy){
        document.getElementById('btnTestImage').disabled = busy;
        document.getElementById('testPhoto').disabled = busy;
        document.getElementById('btnTestVideo').disabled = busy || !window.__testImageUrl;
      }
      async function runTestImage(){
        var f = document.getElementById('testPhoto').files[0];
        if(!f){ setStatus('Choose a test photo first.'); return; }
        setBusy(true); setStatus('Uploading photo…');
        try {
          var fd = new FormData(); fd.append('image', f);
          var up = await fetch('/upload', { method:'POST', body: fd });
          var upj = await up.json();
          if(!up.ok) throw new Error(upj.error || 'Upload failed');
          setStatus('Generating image…');
          var v = formVals();
          var body = {
            image_url: upj.url,
            image_prompt: v.image_prompt,
            fal_image_model: v.fal_image_model,
            user_input_variable: v.user_input_enabled ? v.user_input_variable : '',
            user_input_value: document.getElementById('testUserInput').value,
            user_input_max_length: v.user_input_max_length,
            concept_slug: v.slug
          };
          var r = await fetch('/admin/concepts/test-image', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
          var j = await r.json();
          if(!r.ok) throw new Error(j.error || 'Image test failed');
          window.__testImageUrl = j.url;
          document.getElementById('testResult').innerHTML =
            '<img src="'+j.url+'" style="max-width:320px;border-radius:8px;display:block;margin-bottom:8px;">' +
            '<div class="muted">Image prompt used:</div><pre style="white-space:pre-wrap;background:#fff;padding:10px;border-radius:6px;border:1px solid #eee;">'+escJs(j.prompt_used)+'</pre>';
          setStatus('');
        } catch(e){ setStatus('Error: '+e.message); }
        setBusy(false);
      }
      async function runTestVideo(){
        if(!window.__testImageUrl){ setStatus('Generate a test image first.'); return; }
        setBusy(true); setStatus('Generating video… this can take a minute.');
        try {
          var v = formVals();
          var body = {
            portrait_url: window.__testImageUrl,
            video_prompt: v.video_prompt,
            fal_video_model: v.fal_video_model,
            user_input_variable: v.user_input_enabled ? v.user_input_variable : '',
            user_input_value: document.getElementById('testUserInput').value,
            user_input_max_length: v.user_input_max_length,
            concept_slug: v.slug
          };
          var r = await fetch('/admin/concepts/test-video', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
          var j = await r.json();
          if(!r.ok) throw new Error(j.error || 'Video test failed');
          document.getElementById('testResult').innerHTML +=
            '<video src="'+j.url+'" controls style="max-width:320px;border-radius:8px;display:block;margin-top:12px;"></video>' +
            '<div class="muted">Video prompt used:</div><pre style="white-space:pre-wrap;background:#fff;padding:10px;border-radius:6px;border:1px solid #eee;">'+escJs(j.prompt_used)+'</pre>';
          setStatus('');
        } catch(e){ setStatus('Error: '+e.message); }
        setBusy(false);
      }
      ['user_input_label','user_input_placeholder','user_input_max_length'].forEach(function(n){
        var el=document.querySelector('[name='+n+']'); if(el) el.addEventListener('input', syncTestInput);
      });
      syncTestInput();
    </script>`;
}

app.get('/admin/concepts/new', requireRole('admin'), (req, res) => {
  res.send(conceptAdminPage('New concept', conceptFormBody(null, req.query.error)));
});

app.get('/admin/concepts/edit/:id', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM concepts WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.redirect('/admin/concepts?error=' + encodeURIComponent('Concept not found'));
    res.send(conceptAdminPage('Edit concept', conceptFormBody(rows[0], req.query.error)));
  } catch (err) {
    console.error('[concepts] edit load error:', err.message);
    res.status(500).send('Failed to load concept: ' + escapeHtml(err.message));
  }
});

const conceptUploadFields = upload.fields([
  { name: 'before_image', maxCount: 1 },
  { name: 'after_image', maxCount: 1 },
  { name: 'example_video', maxCount: 1 },
]);

app.post('/admin/concepts/save', requireRole('admin'), conceptUploadFields, async (req, res) => {
  const editId = req.body.id ? parseInt(req.body.id, 10) : null;
  const backTo = editId ? `/admin/concepts/edit/${editId}` : '/admin/concepts/new';
  const fail = (msg) => res.redirect(`${backTo}?error=` + encodeURIComponent(msg));

  try {
    const name = (req.body.name || '').trim();
    const slug = (req.body.slug || '').trim();
    const filterCategory = (req.body.filter_category || '').trim();
    const imagePrompt = (req.body.image_prompt || '').trim();
    const videoPrompt = (req.body.video_prompt || '').trim() || null;
    const socialCaption = (req.body.social_caption || '').trim() || null;
    let inputType = (req.body.input_type || 'image_video').trim();
    if (!CONCEPT_INPUT_TYPES.includes(inputType)) inputType = 'image_video';
    const falImage = (req.body.fal_image_model || '').trim() || 'fal-ai/kling-image/o1';
    const falVideo = (req.body.fal_video_model || '').trim() || 'fal-ai/kling-video/v3/pro/image-to-video';
    const sortOrder = parseInt(req.body.sort_order, 10) || 0;
    const active = req.body.active === 'on' || req.body.active === 'true' || req.body.active === '1';

    const userInputEnabled = req.body.user_input_enabled === 'on' || req.body.user_input_enabled === 'true' || req.body.user_input_enabled === '1';
    const userInputLabel = (req.body.user_input_label || '').trim() || null;
    const userInputPlaceholder = (req.body.user_input_placeholder || '').trim() || null;
    const userInputVariable = (req.body.user_input_variable || '').trim() || null;
    let userInputMaxLength = parseInt(req.body.user_input_max_length, 10);
    if (!Number.isInteger(userInputMaxLength) || userInputMaxLength <= 0) userInputMaxLength = 50;

    if (!name) return fail('Name is required.');
    if (!slug) return fail('Slug is required.');
    if (!filterCategory) return fail('Filter category is required.');
    if (!imagePrompt) return fail('Image prompt is required.');

    if (userInputEnabled) {
      if (!userInputLabel) return fail('Label is required when customer text input is enabled.');
      if (!userInputVariable) return fail('Variable name is required when customer text input is enabled.');
      if (!/^[a-z_][a-z0-9_]*$/.test(userInputVariable)) {
        return fail('Variable name must be lowercase letters, digits, or underscores and start with a letter or underscore.');
      }
    }

    let warn = '';
    if (userInputEnabled && userInputVariable) {
      const token = '{' + userInputVariable + '}';
      if (!imagePrompt.includes(token) && !(videoPrompt || '').includes(token)) {
        warn = `Heads up: the placeholder ${token} doesn't appear in the image or video prompt, so customer input won't be substituted.`;
      }
    }

    const dup = await pool.query('SELECT id FROM concepts WHERE slug = $1 AND id <> $2', [slug, editId || 0]);
    if (dup.rows.length) return fail('A concept with that slug already exists.');

    const uploadField = async (field, resourceType) => {
      const f = req.files && req.files[field] && req.files[field][0];
      if (!f) return null;
      const opts = resourceType ? { resource_type: resourceType } : {};
      const result = await uploadStream(f.buffer, opts);
      return result.secure_url;
    };

    const beforeUrl = (await uploadField('before_image')) || req.body.current_before_image_url || null;
    const afterUrl = (await uploadField('after_image')) || req.body.current_after_image_url || null;
    const videoUrl = (await uploadField('example_video', 'video')) || req.body.current_example_video_url || null;

    if (editId) {
      await pool.query(
        `UPDATE concepts SET
           slug = $1, name = $2, filter_category = $3, input_type = $4,
           before_image_url = $5, after_image_url = $6, example_video_url = $7,
           image_prompt = $8, video_prompt = $9, fal_image_model = $10, fal_video_model = $11,
           social_caption = $12, active = $13, sort_order = $14,
           user_input_enabled = $15, user_input_label = $16, user_input_placeholder = $17,
           user_input_variable = $18, user_input_max_length = $19, updated_at = NOW()
         WHERE id = $20`,
        [slug, name, filterCategory, inputType, beforeUrl, afterUrl, videoUrl,
         imagePrompt, videoPrompt, falImage, falVideo, socialCaption, active, sortOrder,
         userInputEnabled, userInputLabel, userInputPlaceholder, userInputVariable, userInputMaxLength, editId]
      );
    } else {
      await pool.query(
        `INSERT INTO concepts
           (slug, name, filter_category, input_type, before_image_url, after_image_url, example_video_url,
            image_prompt, video_prompt, fal_image_model, fal_video_model, social_caption, active, sort_order,
            user_input_enabled, user_input_label, user_input_placeholder, user_input_variable, user_input_max_length)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [slug, name, filterCategory, inputType, beforeUrl, afterUrl, videoUrl,
         imagePrompt, videoPrompt, falImage, falVideo, socialCaption, active, sortOrder,
         userInputEnabled, userInputLabel, userInputPlaceholder, userInputVariable, userInputMaxLength]
      );
    }
    res.redirect('/admin/concepts?saved=1' + (warn ? '&warn=' + encodeURIComponent(warn) : ''));
  } catch (err) {
    console.error('[concepts] save error:', err.message);
    return fail('Save failed: ' + err.message);
  }
});

app.post('/admin/concepts/toggle/:id', requireRole('admin'), async (req, res) => {
  try {
    await pool.query('UPDATE concepts SET active = NOT active, updated_at = NOW() WHERE id = $1', [req.params.id]);
    res.redirect('/admin/concepts');
  } catch (err) {
    console.error('[concepts] toggle error:', err.message);
    res.redirect('/admin/concepts?error=' + encodeURIComponent('Toggle failed: ' + err.message));
  }
});

app.post('/admin/concepts/delete/:id', requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM concepts WHERE id = $1', [req.params.id]);
    res.redirect('/admin/concepts?deleted=1');
  } catch (err) {
    console.error('[concepts] delete error:', err.message);
    res.redirect('/admin/concepts?error=' + encodeURIComponent('Delete failed: ' + err.message));
  }
});

// Builds a concept-shaped object for applyUserInput from raw test-form fields.
function testConcept(body) {
  const variable = (body.user_input_variable || '').trim();
  return {
    user_input_enabled: !!variable,
    user_input_variable: variable,
    user_input_max_length: parseInt(body.user_input_max_length, 10) || 50,
  };
}

// Admin-only stateless test generation. Does NOT touch preview_count, orders, or email.
// Routes through generation.js so any registered model in the registry works
// with the right field shape. input_extras (JSON object or JSON string) is
// merged on top of the model's defaults.
function parseExtras(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

app.post('/admin/concepts/test-image', requireRole('admin'), async (req, res) => {
  try {
    const { image_url, image_prompt, fal_image_model, user_input_value, concept_slug, image_input_extras, orientation } = req.body;
    if (!image_url) return res.status(400).json({ error: 'image_url is required' });
    if (!image_prompt || !String(image_prompt).trim()) return res.status(400).json({ error: 'image_prompt is required' });
    const modelId = (fal_image_model || '').trim() || 'fal-ai/kling-image/o1';
    const finalPrompt = applyUserInput(image_prompt, testConcept(req.body), user_input_value);
    console.log('[admin-test] image —', { model: modelId, concept_slug: concept_slug || null, prompt_used: finalPrompt, cost_estimate: TEST_COST_IMAGE });
    const { url, input } = await generation.generateImage({
      modelId,
      prompt: finalPrompt,
      photoUrl: image_url,
      orientation: orientation || null,
      inputExtras: parseExtras(image_input_extras),
    });
    res.json({ url, prompt_used: finalPrompt, input_used: input });
  } catch (err) {
    console.error('[admin-test] image error:', err.message);
    res.status(500).json({ error: 'Test image failed', details: err.message });
  }
});

app.post('/admin/concepts/test-video', requireRole('admin'), async (req, res) => {
  try {
    const { portrait_url, video_prompt, fal_video_model, user_input_value, concept_slug, video_input_extras, orientation } = req.body;
    if (!portrait_url) return res.status(400).json({ error: 'portrait_url is required' });
    if (!video_prompt || !String(video_prompt).trim()) return res.status(400).json({ error: 'video_prompt is required' });
    const modelId = (fal_video_model || '').trim() || 'fal-ai/kling-video/v3/pro/image-to-video';
    const finalPrompt = applyUserInput(video_prompt, testConcept(req.body), user_input_value);
    console.log('[admin-test] video —', { model: modelId, concept_slug: concept_slug || null, prompt_used: finalPrompt, cost_estimate: TEST_COST_VIDEO });
    const { url, input } = await generation.generateVideo({
      modelId,
      prompt: finalPrompt,
      photoUrl: portrait_url,
      orientation: orientation || null,
      inputExtras: parseExtras(video_input_extras),
    });
    res.json({ url, prompt_used: finalPrompt, input_used: input });
  } catch (err) {
    console.error('[admin-test] video error:', err.message);
    res.status(500).json({ error: 'Test video failed', details: err.message });
  }
});

app.get('/admin/_digest_test', requireRole('admin'), async (req, res) => {
  try {
    await sendDailyDigest();
    res.send('Sent');
  } catch (err) {
    res.status(500).send('Failed: ' + err.message);
  }
});

// Sentry Express error handler — after all routes, before any catch-all handler.
// v10 equivalent of the old Sentry.Handlers.errorHandler() middleware.
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// Daily cleanup of old, unflagged visits at 03:00 UTC
cron.schedule('0 3 * * *', async () => {
  try {
    const result = await pool.query(
      `DELETE FROM visits WHERE created_at < NOW() - INTERVAL '90 days' AND flagged = false`
    );
    console.log(`[visits] daily cleanup deleted ${result.rowCount} rows older than 90 days`);
  } catch (err) {
    console.error('[visits] daily cleanup error:', err.message);
  }
}, { timezone: 'UTC' });

// Daily operational digest email to admin at 06:00 UTC (07:00/08:00 CET)
cron.schedule('0 6 * * *', () => sendDailyDigest().catch((err) => console.error('[digest] cron error:', err.message)), { timezone: 'UTC' });

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
