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
const { uploadStream, downloadAndStore } = require('./storage');
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
const { sendDailyDigest, gatherDigestSections, block: digestBlock } = require('./digest');
const reviews = require('./reviews');
const emailEngine = require('./email_engine');

// Drop handler used by both /admin/concepts and /admin/triplets so a thumbnail
// dragged from /admin/gallery (even in a separate browser window) can populate
// any slot picker. The picker is wrapped in a `.ts-drop-slot` element with a
// `data-slot-kind` attribute ("image" or "video"). The dragged payload is
// `{ id, kind, url }` JSON in the "application/x-ts-media" MIME type.
const TS_DROP_HANDLER_JS = `<script>
(function(){
  document.querySelectorAll('.ts-drop-slot').forEach(function(zone){
    zone.addEventListener('dragover', function(e){
      var types = e.dataTransfer && e.dataTransfer.types ? e.dataTransfer.types : [];
      var ok = false;
      for (var i=0;i<types.length;i++) if (types[i]==='application/x-ts-media' || types[i]==='text/plain') ok = true;
      if (!ok) return;
      e.preventDefault();
      zone.classList.add('dragover');
    });
    zone.addEventListener('dragleave', function(){ zone.classList.remove('dragover'); });
    zone.addEventListener('drop', function(e){
      zone.classList.remove('dragover');
      var json = e.dataTransfer.getData('application/x-ts-media');
      if (!json) return;
      e.preventDefault();
      var data;
      try { data = JSON.parse(json); } catch(err){ return; }
      var slotKind = zone.dataset.slotKind;
      if (data.kind !== slotKind) { alert('This slot expects a '+slotKind+', the dropped item is a '+data.kind); return; }
      var sel = zone.querySelector('select');
      if (!sel) return;
      var opt = sel.querySelector('option[value="'+data.id+'"]');
      if (!opt) {
        var n = document.createElement('option');
        n.value = String(data.id);
        n.textContent = 'New · ' + (data.url || '').split('/').pop().split('?')[0];
        sel.appendChild(n);
      }
      sel.value = String(data.id);
      sel.classList.add('dropped');
      // Update the local thumbnail preview if there is one next to the select.
      var prev = zone.querySelector('img, video, div[style*="background:#f0ede6"], div[style*="background: #f0ede6"]');
      if (prev) {
        var tagName = data.kind === 'video' ? 'video' : 'img';
        if (prev.tagName.toLowerCase() !== tagName) {
          var newEl = document.createElement(tagName);
          newEl.style.cssText = prev.style.cssText || 'width:54px;height:40px;object-fit:cover;border-radius:4px;background:#000;';
          if (tagName === 'video') { newEl.muted = true; }
          newEl.src = data.url;
          prev.replaceWith(newEl);
        } else {
          prev.src = data.url;
        }
      }
    });
  });
})();
</script>`;
const pricing = require('./pricing');
const { scheduleFxRefresh } = require('./fx_cron');

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

// --- Crash guards: keep the process alive under load; report to Sentry. ---
// A single unhandled promise rejection would otherwise take the whole
// process down mid-request. We log + report and stay up.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', (reason && reason.stack) ? reason.stack : reason);
  try { if (process.env.SENTRY_DSN) Sentry.captureException(reason); } catch (_) {}
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', (err && err.stack) ? err.stack : err);
  try { if (process.env.SENTRY_DSN) Sentry.captureException(err); } catch (_) {}
});

// --- Free-preview cost guards. /preview calls fal.ai (paid) on every hit and
// the email-based quota is bypassable, so we add a per-connection rate limit
// plus a hard global daily ceiling (kill-switch) so spend cannot run away
// unattended at launch. All tunable via env. ---
const PREVIEW_IP_MAX = parseInt(process.env.PREVIEW_IP_MAX || '8', 10);            // previews per IP per window
const PREVIEW_IP_WINDOW_MS = parseInt(process.env.PREVIEW_IP_WINDOW_MS || '600000', 10); // 10 min
const PREVIEW_DAILY_MAX = parseInt(process.env.PREVIEW_DAILY_MAX || '600', 10);    // global previews per day
const _previewRlMap = new Map();
function previewClientIp(req) {
  return ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.ip || 'unknown';
}
function previewRateLimited(ip) {
  const now = Date.now();
  const arr = (_previewRlMap.get(ip) || []).filter((t) => now - t < PREVIEW_IP_WINDOW_MS);
  if (arr.length >= PREVIEW_IP_MAX) { _previewRlMap.set(ip, arr); return true; }
  arr.push(now); _previewRlMap.set(ip, arr);
  if (_previewRlMap.size > 5000) { for (const k of _previewRlMap.keys()) { if (!_previewRlMap.get(k).length) _previewRlMap.delete(k); } }
  return false;
}
let _previewDay = new Date().toISOString().slice(0, 10);
let _previewDayCount = 0;
function previewGlobalExceeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _previewDay) { _previewDay = today; _previewDayCount = 0; }
  if (_previewDayCount >= PREVIEW_DAILY_MAX) return true;
  _previewDayCount += 1;
  return false;
}

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
  // DB-driven: country→currency mapping lives in currencies.country_codes,
  // loaded by pricing.js at boot.
  return pricing.pickCurrencyByCountry(countryCode);
}

function formatPrice(amount, currency) {
  // DB-aware: delegates to pricing.formatDisplay so new currencies render
  // correctly without code edits. Falls back to hardcoded switch if
  // CURRENCY_META is unloaded.
  return pricing.formatDisplay(amount, currency);
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

  // Idempotency — Stripe retries webhook deliveries on slow/failed responses.
  // Record each event id once; a duplicate short-circuits before any order
  // insert, generation, or email, preventing double fal spend / double sends.
  try {
    const _dup = await pool.query(
      `INSERT INTO processed_webhook_events (event_id) VALUES ($1)
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [event.id]
    );
    if (_dup.rowCount === 0) {
      console.log('Webhook duplicate ignored:', event.id);
      return res.json({ received: true, duplicate: true });
    }
  } catch (e) {
    console.error('[webhook] idempotency guard error (continuing):', e.message);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { email, image_url, portrait_url, product, currency, concept_id, customer_name } = session.metadata || {};

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

    // Mark a review win-back discount code as used, if one was applied to this order.
    if (session.metadata && session.metadata.discount_code && orderId) {
      reviews.markDiscountUsed(session.metadata.discount_code, orderId).catch((e) => console.error('[webhook] markDiscountUsed:', e.message));
    }

    // ---------------------------------------------------------------
    // Infrastructure foundation: write order_line_items row alongside
    // the legacy orders insert. Additive audit trail — failure here
    // must NOT break delivery, so wrapped in try/catch.
    // For pre-foundation orders the legacy `orders.product/amount` is
    // still the source of truth; line items are the new shape.
    // ---------------------------------------------------------------
    if (orderId) {
      try {
        const amountMinor = session.amount_total;  // already in minor units
        const cur = (currency || 'sek').toLowerCase();
        // SEK total: convert back from display via fx rate if non-SEK
        let sekMinor = amountMinor;
        if (cur !== 'sek') {
          try {
            const rates = await pricing.getFxRates();
            const rate = pricing.getFxRateSync(rates, cur);
            if (rate > 0) sekMinor = Math.round(amountMinor / rate);
          } catch (e) { /* fall back to display amount as SEK */ }
        }
        await pool.query(
          `INSERT INTO order_line_items (
             order_id, product_key, quantity,
             unit_price_sek_minor, total_sek_minor,
             display_currency, display_price_minor, fx_rate_used
           ) VALUES ($1, $2, 1, $3, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING`,
          [
            orderId,
            product,
            sekMinor,
            cur,
            amountMinor,
            cur === 'sek' ? 1.0 : (amountMinor > 0 ? amountMinor / sekMinor : 1.0),
          ]
        );
        console.log('[line_items] recorded for order', orderId);
      } catch (err) {
        console.error('[line_items] insert error (non-fatal):', err.message);
      }
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

    // First purchase -> enroll into the post-purchase email journey. Gated by
    // EMAIL_ENGINE_ENABLED; enrollments accrue even while sending is OFF.
    if (email) {
      try {
        const _oc = await pool.query('SELECT COUNT(*)::int AS n FROM orders WHERE email = $1', [email]);
        if (_oc.rows[0].n <= 1) {
          let _code = '';
          try { const _dc = await reviews.generateDiscountCode(email, orderId, { percent: 50, days: 30 }); _code = (_dc && _dc.code) ? _dc.code : ''; } catch (e) {}
          emailEngine.onEvent('first_purchase', {
            email: email,
            context: { customer_name: customer_name || '', order_id: orderId || null, code: _code,
                       review_url: (process.env.PUBLIC_BASE_URL || 'https://turtleandsun.com') + '/account/review' }
          }).catch(function (e) { console.error('[email] first_purchase enroll:', e.message); });
        }
      } catch (e) { console.error('[email] first_purchase check:', e.message); }
    }

    // Deliver portrait — no re-generation needed
    console.log('Delivering for order:', orderId);
    // Save input photo (already in R2 from upload step)
      if (orderId && (image_url || portrait_url)) {
        pool.query('UPDATE orders SET input_asset_url=$1 WHERE id=$2', [image_url || portrait_url, orderId]).catch(e => console.warn('[asset] input save failed:', e.message));
      }
      generateForOrder(portrait_url || image_url, product, email || '', orderId, concept_id, customer_name).catch(async (err) => {
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
app.use(express.urlencoded({ extended: true }));

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

// Mark the current visitor's recent visit rows as engaged (i.e. a human
// did something a bot wouldn't — clicked the gallery, uploaded a photo,
// paid, etc.). Applies to all visits in the last 30 minutes from this IP
// so the entire session is highlighted in the admin view.
async function markEngaged(req) {
  const ip = visitorIp(req) || 'unknown';
  try {
    await pool.query(
      `UPDATE visits SET engaged = TRUE
       WHERE ip = $1 AND created_at > NOW() - INTERVAL '30 minutes'`,
      [ip]
    );
  } catch (err) {
    console.error('[engage] mark error:', err.message);
  }
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
  '/privacy.html',
  '/terms.html',
  '/refund.html',
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
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));
app.get('/refund', (req, res) => res.sendFile(path.join(__dirname, 'refund.html')));

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

// ── Dev mode (Stripe bypass for testing) ─────────────────────────────────────
// Cached so synchronous template helpers (conceptAdminPage) can read it without
// awaiting the DB on every render. Loaded at startup + refreshed after toggle.
let cachedDevMode = false;
async function loadDevMode() {
  try {
    const r = await pool.query(`SELECT value FROM system_settings WHERE key = 'dev_mode'`);
    cachedDevMode = r.rows.length > 0 && r.rows[0].value === 'true';
  } catch (e) {
    console.error('[dev-mode] load failed:', e.message);
    cachedDevMode = false;
  }
  return cachedDevMode;
}
// Don't block startup on this — best-effort.
loadDevMode().then((v) => console.log('[dev-mode] initial state:', v));

async function setDevMode(on) {
  await pool.query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ('dev_mode', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [on ? 'true' : 'false']
  );
  cachedDevMode = !!on;
}

app.post('/admin/dev-mode/toggle', requireRole('admin'), async (req, res) => {
  const next = !cachedDevMode;
  await setDevMode(next);
  console.log('[dev-mode] toggled →', next, 'by', (await getSessionUser(req))?.email);
  res.redirect(req.body.return_to || '/admin');
});

// Yellow ribbon HTML — injected at top of every admin page when dev mode is on.
// Customers never see this because /admin/* routes are all behind requireRole('admin').
function devRibbonHtml() {
  if (!cachedDevMode) return '';
  return `<div style="background:#FFE800;color:#1C0A00;padding:8px 16px;text-align:center;font-weight:800;font-size:13px;letter-spacing:0.04em;border-bottom:2px solid #1C0A00;font-family:'Plus Jakarta Sans',Arial,sans-serif;">
    ⚠ DEV MODE — Stripe payment is bypassed. Customers see no change; admin-only checkout shortcut is live.
    <form method="POST" action="/admin/dev-mode/toggle" style="display:inline;margin-left:14px;">
      <input type="hidden" name="return_to" value="/admin">
      <button type="submit" style="background:#1C0A00;color:#FFE800;border:none;padding:3px 12px;border-radius:14px;font-size:11px;font-weight:700;cursor:pointer;letter-spacing:0.04em;">TURN OFF</button>
    </form>
  </div>`;
}

app.get('/api/auth/status', async (req, res) => {
  console.log('[auth] cookies:', req.cookies, 'session token present:', !!req.cookies?.ts_session);
  const user = await getSessionUser(req);
  console.log('[auth] resolved user:', user?.email || 'none');
  if (!user) return res.json({ loggedIn: false, devMode: false });
  const isAdmin = user.roles.includes('admin');
  // devMode is only surfaced when the requester is admin — customers never see this flag.
  res.json({ loggedIn: true, email: user.email, isAdmin, devMode: isAdmin && cachedDevMode });
});

// Stripe bypass — creates a "paid" order and triggers generation WITHOUT going to Stripe.
// HARD-LOCKED: requires admin role AND dev_mode = true. Either failing → 403.
// Body: { email, cloudinaryUrl, product, conceptId?, customerName? }
// DEV-only preview generator. No quota, no email gate. Generates an image
// using the concept's model + prompt and returns the URL so the widget can
// display it inline. Use this to validate the concept setup before buying.
app.post('/api/dev/preview', requireRole('admin'), async (req, res) => {
  if (!cachedDevMode) return res.status(403).json({ error: 'Dev mode is OFF' });
  const { cloudinaryUrl, conceptId, orientation } = req.body || {};
  if (!cloudinaryUrl) return res.status(400).json({ error: 'cloudinaryUrl required' });
  if (!conceptId)    return res.status(400).json({ error: 'conceptId required' });
  try {
    const c = await pool.query(
      `SELECT image_prompt, fal_image_model, image_input_extras, name
       FROM concepts WHERE id = $1`,
      [parseInt(conceptId, 10)]
    );
    if (!c.rows.length) return res.status(404).json({ error: 'Concept not found' });
    const cc = c.rows[0];
    const modelId = cc.fal_image_model || 'fal-ai/kling-image/o1';
    console.log('[dev-preview]', cc.name, '→', modelId);
    const result = await generation.generateImage({
      modelId,
      prompt: cc.image_prompt || '',
      photoUrl: cloudinaryUrl,
      orientation: orientation || 'portrait',
      inputExtras: cc.image_input_extras || {},
    });
    res.json({ ok: true, url: result.url });
  } catch (err) {
    console.error('[dev-preview] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/dev/skip-checkout', requireRole('admin'), async (req, res) => {
  if (!cachedDevMode) return res.status(403).json({ error: 'Dev mode is OFF' });
  const { email, cloudinaryUrl, previewImageUrl, product, conceptId, customerName } = req.body || {};
  if (!cloudinaryUrl) return res.status(400).json({ error: 'cloudinaryUrl required' });
  if (!product)       return res.status(400).json({ error: 'product required' });
  try {
    // The `orders` table columns are minimal — image/portrait/concept aren't
    // persisted there; they're passed directly to generateForOrder() (same as
    // what the Stripe webhook does after reading them from session.metadata).
    const ins = await pool.query(
      `INSERT INTO orders (email, style_id, product, status, amount, currency)
       VALUES ($1, NULL, $2, 'paid', 0, 'sek')
       RETURNING id`,
      [email || 'dev@turtleandsun.com', product]
    );
    const orderId = ins.rows[0].id;
    console.log('[dev-skip-checkout] order', orderId, 'product', product, 'concept', conceptId,
      'previewImageUrl:', previewImageUrl ? previewImageUrl.slice(-60) : 'NONE',
      'cloudinaryUrl:', cloudinaryUrl ? cloudinaryUrl.slice(-60) : 'NONE');
    // Respond now — generation can take 30–60s. The widget already shows the
    // order-confirmation alert; the user picks up the result in /admin or email.
    res.json({ ok: true, orderId, note: 'DEV: order marked paid without Stripe. Generation started.' });

    // ---- Generation / delivery (background) --------------------------------
    // Priority:
    //   1. If the widget sent previewImageUrl (the picture the admin is looking
    //      at after Regenerate), use it as-is. NO re-generation. That's what
    //      the customer expects: "I'm buying THIS one."
    //   2. Otherwise, for image/bundle products without a preview, generate
    //      one from the raw upload so result_url is a real Loveogram, not the
    //      cobra upload.
    //   3. Talking/video products: generateForOrder handles its own generation.
    (async () => {
      try {
        let portraitUrl = previewImageUrl || cloudinaryUrl;
        const usingProvidedPreview = !!previewImageUrl;
        const needsPreGen = !usingProvidedPreview && (product === 'image' || product === 'bundle');
        if (needsPreGen && conceptId) {
          const c = await pool.query(
            `SELECT image_prompt, fal_image_model, image_input_extras
             FROM concepts WHERE id = $1`, [parseInt(conceptId, 10)]
          );
          if (c.rows.length) {
            const cc = c.rows[0];
            const modelId = cc.fal_image_model || 'fal-ai/kling-image/o1';
            console.log('[dev-skip-checkout] no preview supplied — pre-generating with', modelId);
            const result = await generation.generateImage({
              modelId,
              prompt: cc.image_prompt || '',
              photoUrl: cloudinaryUrl,
              orientation: 'portrait',
              inputExtras: cc.image_input_extras || {},
            });
            portraitUrl = result.url;
            console.log('[dev-skip-checkout] preview generated:', portraitUrl);
          }
        } else if (usingProvidedPreview) {
          console.log('[dev-skip-checkout] using supplied preview:', portraitUrl);
        }
        await generateForOrder(portraitUrl, product, email || '', orderId, conceptId || null, customerName || null);
      } catch (err) {
        console.error('[dev-skip-checkout] generation error:', err.message);
      }
    })();
  } catch (err) {
    console.error('[dev-skip-checkout] error:', err.message);
    res.status(500).json({ error: err.message });
  }
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

  // Layout intent: top sections are things Ivo works with daily; bottom is
  // third-party services he only occasionally clicks into.
  const body = `
    <h1>Admin dashboard</h1>
    <style>
      .admin-section{font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#1C0A00;margin:28px 0 12px;}
      .admin-section-sub{font-size:12px;color:#888;text-transform:none;letter-spacing:0;font-weight:400;margin-left:8px;}
      .admin-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;}
      .admin-card{display:block;background:#fff;border:1px solid #eee;border-radius:10px;padding:14px 16px;text-decoration:none;color:#1C0A00;transition:box-shadow 0.15s,transform 0.15s;}
      .admin-card:hover{box-shadow:0 6px 20px rgba(0,0,0,0.08);transform:translateY(-1px);}
      .admin-card-title{font-weight:700;font-size:14px;margin-bottom:4px;}
      .admin-card-desc{font-size:12px;color:#888;line-height:1.4;}
      .admin-divider{margin:36px 0 0;border-top:1px solid #eee;}
    </style>

    ${section('\u{1F4C5} Daily — what to check this morning',
      card('Daily digest', 'Live revenue, visitors, humans, delivery health.', '/admin/digest') +
      card('Failed deliveries', 'Orders that failed generation or email.', '/admin/failed-deliveries') +
      card('Visits & visitors map', 'Traffic log, geo map, and IP labels.', '/admin/visits')
    )}

    ${section('\u{1F3A8} Content',
      card('Concepts library', 'Manage style concepts and prompts.', '/admin/concepts') +
      card('Gallery', 'Manage public gallery items (images, videos, cards, books).', '/admin/gallery') +
      card('Triplets', 'Group Before / After-Picture / After-Video into rolling demo sets.', '/admin/triplets') +
      card('Reviews', 'Moderate customer reviews; approve to publish on the landing.', '/admin/reviews')
    )}

    ${section('\u{1F4B0} Pricing',
      card('Currencies & FX', 'Live FX rates, supported currencies, manual refresh.', '/admin/currencies')
    )}

    ${section('\u{1F4C6} Occasions & campaigns',
      card('Gifting occasions', 'National occasions, live dates, markets — what the campaign agent runs on.', '/admin/occasions') +
      card('Campaign queue', 'What is queued to draft, print, and send.', '/admin/occasions/queue') +
      card('Email engine', 'Lifecycle email: templates, sequences, enrollments, unsubscribes.', '/admin/email') +
      card('Generation review', 'Quality-check every AI output — flag bad ones, trigger regeneration.', '/admin/generations')
    )}

    <h2 class="admin-section">\u{1F527} Developer mode <span class="admin-section-sub">— admin-only, never visible to customers</span></h2>
    <div class="admin-grid">
      <form method="POST" action="/admin/dev-mode/toggle" style="margin:0;">
        <input type="hidden" name="return_to" value="/admin">
        <button type="submit" class="admin-card" style="background:${cachedDevMode ? '#FFE800' : '#fff'};border:1px solid ${cachedDevMode ? '#1C0A00' : '#eee'};text-align:left;cursor:pointer;width:100%;font-family:inherit;">
          <div class="admin-card-title">Dev mode: <strong style="color:${cachedDevMode ? '#1C0A00' : '#a12a1a'};">${cachedDevMode ? 'ON' : 'OFF'}</strong></div>
          <div class="admin-card-desc">${cachedDevMode ? 'Stripe bypass live for admin sessions. Yellow ribbon shown across admin pages. Click to TURN OFF.' : 'When ON, you can click Buy on the widget to skip Stripe and trigger generation directly. Click to TURN ON.'}</div>
        </button>
      </form>
    </div>

    <div class="admin-divider"></div>

    ${section('\u{1F517} External services <span class="admin-section-sub">— monitoring &amp; vendor consoles</span>',
      card('Stripe dashboard', 'Payments, payouts, and customers.', 'https://dashboard.stripe.com', true) +
      card('Sentry', 'Error tracking and alerts.', 'https://turtle-and-sun.sentry.io/', true) +
      card('Plausible', 'Privacy-friendly traffic analytics.', 'https://plausible.io/turtleandsun.com', true) +
      card('Google Search Console', 'Search indexing and performance.', 'https://search.google.com/search-console', true) +
      card('fal.ai', 'AI generation credits and usage.', 'https://fal.ai/dashboard', true) +
      card('Resend', 'Transactional email delivery.', 'https://resend.com/emails', true) +
      card('Cloudinary', 'Media storage and uploads.', 'https://cloudinary.com/console', true) +
      card('ImprovMX', 'Inbound email forwarding.', 'https://app.improvmx.com/', true) +
      card('Railway', 'App hosting and deploys.', 'https://railway.app/', true) +
      card('Namecheap', 'Domain registration &amp; DNS records.', 'https://ap.www.namecheap.com/domains/domaincontrolpanel/turtleandsun.com/advancedns', true)
    )}`;
  res.send(conceptAdminPage('Admin dashboard', body));
});

// ---------------------------------------------------------------------------
// /admin/digest — live, on-demand view of the same data shown in the
// 06:00 UTC daily email. Includes a "Send me a fresh copy" button that
// triggers /admin/_digest_test (existing endpoint).
// ---------------------------------------------------------------------------
app.get('/admin/digest', requireRole('admin'), async (req, res) => {
  let sections;
  try {
    sections = await gatherDigestSections();
  } catch (err) {
    return res.status(500).send('Digest data fetch failed: ' + err.message);
  }
  const body = `
    <style>
      .digest-wrap{max-width:680px;margin:0 auto;background:#FFF9E6;padding:24px;border-radius:12px;}
      .digest-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:18px;}
      .digest-head h1{font-family:Arial,sans-serif;font-size:22px;color:#1C0A00;margin:0;}
      .digest-meta{font-size:12px;color:#888;font-family:Arial,sans-serif;}
      .digest-send{padding:9px 16px;background:#3A6B20;color:#fff;border:none;border-radius:8px;font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:13px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:8px;}
      .digest-send:hover{background:#1C0A00;}
      .digest-send:disabled{opacity:0.6;cursor:not-allowed;}
      #digestStatus{font-size:12px;color:#3A6B20;margin-left:10px;font-family:Arial,sans-serif;}
    </style>
    <div class="digest-wrap">
      <div class="digest-head">
        <div>
          <h1>Turtleandsun Daily — ${escapeHtml(sections.date)}</h1>
          <div class="digest-meta">Live snapshot (last 24h from now). The same data ships to your inbox at 06:00 UTC.</div>
        </div>
        <div>
          <button type="button" class="digest-send" id="btnDigest" onclick="sendDigest()">Send me a fresh email</button>
          <span id="digestStatus"></span>
        </div>
      </div>
      ${digestBlock('Revenue (last 24h)', sections.revenueHtml)}
      ${digestBlock('Orders by product (last 24h)', sections.productsHtml)}
      ${digestBlock('Visitors (last 24h)', sections.visitorsHtml)}
      ${digestBlock('Currency suggestions', sections.suggestionsHtml)}
      ${digestBlock('Delivery health (last 24h)', sections.healthHtml)}
    </div>
    <script>
      async function sendDigest(){
        var b=document.getElementById('btnDigest'); var s=document.getElementById('digestStatus');
        b.disabled=true; s.textContent='Sending…'; s.style.color='#888';
        try {
          var r=await fetch('/admin/_digest_test');
          if(!r.ok) throw new Error('HTTP '+r.status);
          s.textContent='Sent ✓ — check your inbox'; s.style.color='#3A6B20';
        } catch(e) {
          s.textContent='Failed: '+e.message; s.style.color='#C13D2A';
        }
        b.disabled=false;
      }
    </script>`;
  res.send(conceptAdminPage('Daily digest', body));
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
              v.referrer, v.country, v.region, v.city, v.lat, v.lng, v.user_id, v.request_id, v.flagged, v.engaged,
              u.email AS email, l.label AS label
       FROM visits v
       LEFT JOIN users u ON v.user_id = u.id
       LEFT JOIN ip_labels l ON v.ip = l.ip
       ${whereSql}
       ORDER BY v.created_at DESC
       LIMIT $${params.length}`,
      params
    );

    const [totals, topCountry, topPath, salesByEmailRes, salesTotalRes] = await Promise.all([
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
      // Paid spend per customer email (across the same time range as the
      // visit filter, when one is provided — otherwise lifetime)
      pool.query(
        from
          ? `SELECT email, SUM(amount)::float AS total, COUNT(*)::int AS orders, MAX(currency) AS currency
             FROM orders WHERE status = 'paid' AND created_at >= $1
             GROUP BY email`
          : `SELECT email, SUM(amount)::float AS total, COUNT(*)::int AS orders, MAX(currency) AS currency
             FROM orders WHERE status = 'paid'
             GROUP BY email`,
        from ? [from] : []
      ),
      pool.query(
        from
          ? `SELECT COALESCE(SUM(amount), 0)::float AS total, COUNT(*)::int AS orders
             FROM orders WHERE status = 'paid' AND created_at >= $1`
          : `SELECT COALESCE(SUM(amount), 0)::float AS total, COUNT(*)::int AS orders
             FROM orders WHERE status = 'paid'`,
        from ? [from] : []
      ),
    ]);

    const salesByEmail = {};
    salesByEmailRes.rows.forEach((r) => {
      if (r.email) salesByEmail[r.email] = { total: r.total, orders: r.orders, currency: r.currency };
    });

    res.json({
      visits: visitsResult.rows,
      capped: visitsResult.rows.length >= VISITS_MAX_ROWS,
      stats: {
        total_today: totals.rows[0].total,
        unique_ips_today: totals.rows[0].unique_ips,
        top_country: topCountry.rows[0] || null,
        top_path: topPath.rows[0] || null,
        sales_total: salesTotalRes.rows[0].total,
        sales_orders: salesTotalRes.rows[0].orders,
      },
      salesByEmail,
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


// ---------------------------------------------------------------------------
// Admin: pricing preview. Read-only sanity-check of the pricing engine.
// GET /admin/api/pricing/preview?concept_id=12&currency=usd&quantity=1
// Returns: { concept, resolved, base_tier, fx_rate_used, charm_ladder }
// No customer impact — admin-only, used to verify FX + charm + tier math
// against real concepts in production.
// ---------------------------------------------------------------------------
app.get('/admin/api/pricing/preview', requireRole('admin'), async (req, res) => {
  try {
    const conceptId = parseInt(req.query.concept_id, 10);
    const currency = (req.query.currency || 'sek').toLowerCase();
    const quantity = Math.max(1, parseInt(req.query.quantity, 10) || 1);
    const modifiers = req.query.modifiers ? JSON.parse(req.query.modifiers) : {};
    const recipients = req.query.recipients ? JSON.parse(req.query.recipients) : [];

    if (!Number.isInteger(conceptId)) {
      return res.status(400).json({ error: 'concept_id (integer) required' });
    }

    const { rows } = await pool.query(
      `SELECT id, slug, name, input_type, price_tier, unit_price_sek_minor, pricing_rules
       FROM concepts WHERE id = $1`,
      [conceptId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Concept not found' });

    const concept = rows[0];
    const resolved = await pricing.priceLineItem(
      { concept, quantity, modifiers, recipients },
      currency
    );

    const tier = concept.price_tier || pricing.defaultTierFor(concept.input_type);
    const tierBase = pricing.PRICE_TIERS[tier] || null;

    res.json({
      concept: {
        id: concept.id,
        slug: concept.slug,
        name: concept.name,
        input_type: concept.input_type,
        price_tier: concept.price_tier,
        unit_price_sek_minor: concept.unit_price_sek_minor,
        pricing_rules: concept.pricing_rules,
      },
      resolved,
      tier_used: tier,
      tier_base_sek_minor: tierBase ? tierBase.sek_minor : null,
      display_human: pricing.formatDisplay(resolved.display_price_minor, resolved.display_currency),
      sek_human: pricing.formatDisplay(resolved.total_sek_minor, 'sek'),
    });
  } catch (err) {
    console.error('[admin pricing preview] error:', err.message);
    res.status(500).json({ error: 'Pricing preview failed', details: err.message });
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
      await generateForOrder(row.portrait_url, row.product, row.email, row.order_id, null, null);
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
      'SELECT id, product, status, amount, result_url, result_video_url, output_asset_url, output_video_asset_url, input_asset_url, created_at FROM orders WHERE email = $1 ORDER BY created_at DESC',
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
    const result = await uploadStream(req.file.buffer, {
      kind: 'upload',
      contentType: req.file.mimetype,
      originalName: req.file.originalname,
    });
    markEngaged(req); // uploading a photo is high-confidence human signal
    res.json({ url: result.secure_url, public_id: result.public_id });
  } catch (err) {
    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

// Lightweight beacon endpoint — fired from the landing page when the user
// does something a bot wouldn't (gallery card click, lightbox open, etc).
// Marks the session as engaged so it stands out in /admin/visits.
app.post('/api/engage', async (req, res) => {
  markEngaged(req);
  res.json({ ok: true });
});

app.get('/api/currency', async (req, res) => {
  let country = null;
  try { country = (await geoLookup(visitorIp(req))).country; } catch (e) { /* geo unavailable */ }
  const detected = pickCurrency(country);

  // Source prices from the pricing engine (FX-converted + charm-rounded
  // from a single SEK base) when fx_rates is populated. Falls back to the
  // legacy PRODUCTS hardcoded amounts if the engine is unreachable.
  let prices = {};
  let usedEngine = false;
  try {
    const rates = await pricing.getFxRates();
    for (const cur of pricing.getSupportedCurrencies()) {
      prices[cur] = {};
      for (const key of Object.keys(PRODUCTS)) {
        const tier = key === 'bundle' ? 'bundle' : key;
        const tierEntry = pricing.PRICE_TIERS[tier];
        const sekMinor = tierEntry ? tierEntry.sek_minor : (PRODUCTS[key].amounts && PRODUCTS[key].amounts.sek);
        if (sekMinor == null) continue;
        const amount = pricing.convertAndCharm(sekMinor, cur, rates);
        prices[cur][key] = { amount, display: pricing.formatDisplay(amount, cur) };
      }
    }
    usedEngine = true;
  } catch (err) {
    // Fall back to hardcoded PRODUCTS amounts
    console.warn('[api/currency] pricing engine unavailable, using legacy amounts:', err.message);
    prices = {};
    for (const cur of pricing.getSupportedCurrencies()) {
      prices[cur] = {};
      for (const key of Object.keys(PRODUCTS)) {
        const amount = PRODUCTS[key].amounts && PRODUCTS[key].amounts[cur];
        if (amount != null) prices[cur][key] = { amount, display: formatPrice(amount, cur) };
      }
    }
  }

  res.set('Cache-Control', 'public, max-age=300');
  res.json({ detected, country, supported: pricing.getSupportedCurrencies(), prices, source: usedEngine ? 'engine' : 'legacy' });
});

app.post('/create-checkout-session', async (req, res) => {
  const { product, image_url, portrait_url, email, orientation, concept_id, quantity, modifiers, recipients, customer_name, discount_code } = req.body;
  // Either a concept_id OR a legacy product key is required.
  if (!concept_id && !PRODUCTS[product]) return res.status(400).json({ error: 'Invalid product (no concept_id or known product key)' });
  if (!image_url) return res.status(400).json({ error: 'image_url is required' });
  markEngaged(req);

  let currency = req.body.currency;
  if (currency) {
    currency = String(currency).toLowerCase();
    if (!SUPPORTED_CURRENCIES.has(currency)) return res.status(400).json({ error: 'Unsupported currency' });
  } else {
    let country = null;
    try { country = (await geoLookup(visitorIp(req))).country; } catch (e) { /* geo unavailable */ }
    currency = pickCurrency(country);
  }

  // ---- Resolve price -----------------------------------------------------
  // Priority order:
  //   1) If `product` is a known legacy key (image/video/bundle), use PRODUCTS pricing.
  //      This is the hero-widget path: customer picked Image / Video / Bundle, those have fixed prices.
  //      We still load the concept (for displayName + downstream generation), but pricing comes from PRODUCTS.
  //   2) Else if `concept_id` is present (premium concept with bespoke pricing), use the pricing engine.
  //   3) Else error.
  let displayName = null;
  let unitAmount = null;
  let conceptRow = null;
  let priced = null;
  try {
    // Always load the concept if its id is provided — needed for delivery / display.
    if (concept_id) {
      const { rows } = await pool.query(
        `SELECT id, slug, name, input_type, price_tier, unit_price_sek_minor, pricing_rules
         FROM concepts WHERE id = $1`,
        [parseInt(concept_id, 10)]
      );
      if (!rows.length) return res.status(404).json({ error: 'Concept not found' });
      conceptRow = rows[0];
    }

    if (product && PRODUCTS[product]) {
      // Hero-widget path: standard image / video / bundle pricing.
      displayName = conceptRow ? `${conceptRow.name} — ${PRODUCTS[product].name.split('— ').pop()}` : PRODUCTS[product].name;
      unitAmount = PRODUCTS[product].amounts[currency];
      if (unitAmount == null) return res.status(400).json({ error: `No price for ${product} in ${currency}` });
    } else if (conceptRow) {
      // Concept-driven pricing path (premium concepts without an image/video/bundle product key).
      priced = await pricing.priceLineItem(
        { concept: conceptRow, quantity: Math.max(1, parseInt(quantity, 10) || 1), modifiers: modifiers || {}, recipients: recipients || [] },
        currency
      );
      displayName = conceptRow.name;
      unitAmount = priced.display_price_minor;
    } else {
      return res.status(400).json({ error: 'Cannot resolve price (no product and no concept)' });
    }
  } catch (err) {
    console.error('[checkout] price resolution error:', err.message);
    return res.status(500).json({ error: 'Failed to resolve price', details: err.message });
  }

  const origin = `${req.protocol}://${req.get('host')}`;
  try {
    const meta = {
      product: product || (conceptRow ? `concept:${conceptRow.slug}` : ''),
      concept_id: conceptRow ? String(conceptRow.id) : '',
      customer_name: customer_name || '',
      image_url,
      portrait_url: portrait_url || '',
      email: email || '',
      orientation: orientation || '',
      currency,
    };
    // Review win-back discount - applied IN-APP (no Stripe coupon). We reduce the
    // unit price by the code's percent_off before creating the session.
    if (discount_code) {
      try {
        const dc = await reviews.validateDiscountCode(email, discount_code);
        if (dc.valid) {
          const pct = Math.max(0, Math.min(100, dc.percent_off || 0));
          unitAmount = Math.max(1, Math.round(unitAmount * (100 - pct) / 100));
          meta.discount_code = String(discount_code).trim();
          meta.discount_percent = String(pct);
          displayName = displayName + ' (\u2212' + pct + '%)';
        }
      } catch (e) { console.error('[checkout] discount apply error:', e.message); }
    }
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency,
          product_data: { name: displayName },
          unit_amount: unitAmount,
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
    res.json({ url: session.url, priced: priced ? { display_currency: priced.display_currency, display_price_minor: priced.display_price_minor } : null });
  } catch (err) {
    console.error('Checkout session error:', err);
    res.status(500).json({ error: 'Failed to create checkout session', details: err.message });
  }
});

app.post('/preview', async (req, res) => {
  const { image_url, email, orientation, concept_id, customer_name } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url is required' });
  if (!email) return res.status(400).json({ error: 'email is required' });
  markEngaged(req);

  // Per-connection rate limit — caps free-preview abuse / fal cost from one source.
  const _previewIp = previewClientIp(req);
  if (previewRateLimited(_previewIp)) {
    return res.status(429).json({ error: 'Too many previews from this connection — please wait a few minutes and try again.' });
  }

  // Preview quota
  try {
    const result = await pool.query(
      `INSERT INTO users (email, preview_count)
       VALUES ($1, 1)
       ON CONFLICT (email) DO UPDATE
         SET preview_count = CASE
           WHEN users.has_purchased = TRUE THEN users.preview_count
           ELSE users.preview_count + 1
         END
       RETURNING id, preview_count, has_purchased`,
      [email]
    );
    const { preview_count, has_purchased } = result.rows[0];
    if (!has_purchased && preview_count > 3) {
      return res.status(403).json({ error: 'Preview limit reached. Purchase to continue.' });
    }
  } catch (err) {
    console.error('Preview user upsert error:', err.message);
  }

  // Resolve user id for audit log (best-effort).
  let userId = null;
  try {
    const u = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    userId = u.rows[0]?.id || null;
  } catch (e) { /* non-fatal */ }

  // Look up concept if concept_id provided.
  let concept = null;
  if (concept_id) {
    try {
      const c = await pool.query(
        `SELECT id, slug, name, input_type, image_prompt, video_prompt, fal_image_model, fal_video_model,
                talking_model, speech_text, voice_ids, reference_image_urls,
                image_input_extras, video_input_extras, user_input_variable
         FROM concepts WHERE id = $1 AND active = TRUE`,
        [parseInt(concept_id, 10)]
      );
      concept = c.rows[0] || null;
    } catch (e) { console.warn('[preview] concept lookup failed:', e.message); }
  }

  // Decide which model + prompt to use.
  // - If concept is present and is talking type, dispatch through generateTalking (still returns an image preview via the underlying i2v's first frame is impractical, so for talking we fall through to image preview using the concept's image_prompt as a stand-in).
  // - If concept is present (image/image_video), dispatch through generateImage with concept's stored model + prompt.
  // - Otherwise, hardcoded Royal Portrait (legacy).
  const useConcept = !!concept;
  const modelId = useConcept ? (concept.fal_image_model || 'fal-ai/kling-image/o1') : 'fal-ai/kling-image/o1';
  const promptText = useConcept
    ? (concept.image_prompt || 'Transform @Image1 into a royal portrait painting wearing an ornate golden crown and red velvet royal robes, set in a grand palace. Preserve the exact face and identity of the person in @Image1. Oil painting style, highly detailed.')
    : 'Transform @Image1 into a royal portrait painting wearing an ornate golden crown and red velvet royal robes, set in a grand palace. Preserve the exact face and identity of the person in @Image1. Oil painting style, highly detailed.';
  const inputExtras = useConcept ? (concept.image_input_extras || {}) : {};

  // Global daily ceiling — hard safety cap so preview spend can't run away unattended.
  if (previewGlobalExceeded()) {
    console.warn('[preview] global daily ceiling reached (' + PREVIEW_DAILY_MAX + ') — shedding load');
    return res.status(503).json({ error: 'Previews are extremely busy right now — please try again in a little while.' });
  }

  // Log the attempt before firing.
  const logged = await generation.logGenerationStart({
    conceptId: concept ? concept.id : null,
    modelId,
    inputPayload: { image_url, orientation, prompt: promptText },
    sourceType: 'preview',
    userId,
  });

  try {
    const result = await generation.generateImage({
      provider: 'fal',
      modelId,
      prompt: promptText,
      photoUrl: image_url,
      orientation,
      inputExtras,
    });
    await generation.logGenerationFinish(logged.id, {
      outputUrl: null, // R2 rehosting happens at delivery time, not preview
      falOutputUrl: result.url,
    });
    res.json({ url: result.url });
  } catch (err) {
    console.error('Preview error:', JSON.stringify(err, null, 2));
    await generation.logGenerationFailure(logged.id, err.message);
    res.status(500).json({ error: 'We could not create that preview just now — please try again in a moment.' });
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

// Returns filter chip data + the concepts behind it for the landing gallery.
// Filters are derived from active concepts' comma-separated `filter_category`
// values, but only concepts that actually have at least one active media item
// are included so empty chips don't appear.
app.get('/gallery/meta', async (req, res) => {
  try {
    const conceptsRes = await pool.query(
      `SELECT DISTINCT c.id, c.slug, c.name, c.description, c.filter_category, c.sort_order
       FROM concepts c
       JOIN concept_media cm ON cm.concept_id = c.id
       WHERE c.active = TRUE AND cm.active = TRUE
       ORDER BY c.sort_order ASC, c.name ASC`
    );
    const concepts = conceptsRes.rows;
    // Pull every distinct filter token, from BOTH the concept-level
    // filter_category and the per-item filter_category on concept_media.
    const filterSet = new Set();
    const accumulate = (str) => {
      String(str || '').split(',').forEach((part) => {
        const t = part.trim().toLowerCase();
        if (t) filterSet.add(t);
      });
    };
    concepts.forEach((c) => accumulate(c.filter_category));
    const itemsRes = await pool.query(
      `SELECT DISTINCT cm.filter_category
       FROM concept_media cm
       JOIN concepts c ON c.id = cm.concept_id
       WHERE cm.active = TRUE AND c.active = TRUE AND cm.filter_category IS NOT NULL`
    );
    itemsRes.rows.forEach((row) => accumulate(row.filter_category));
    const filters = Array.from(filterSet).sort();

    const kindsRes = await pool.query(
      `SELECT DISTINCT cm.kind
       FROM concept_media cm
       JOIN concepts c ON c.id = cm.concept_id
       WHERE cm.active = TRUE AND c.active = TRUE`
    );
    const kinds = kindsRes.rows.map((r) => r.kind).sort();
    res.json({ filters, concepts, kinds });
  } catch (err) {
    console.error('[gallery/meta] error:', err.message);
    res.status(500).json({ error: 'Failed to load gallery meta', details: err.message });
  }
});

// What the landing-page rolling-demo widget reads. Each active concept is
// returned with its array of triplets (in_rolling_demo=TRUE, sorted). If a
// concept has no triplets yet but has the legacy single-slot URLs set on the
// concept row, we synthesize an implicit triplet #1 from those so nothing
// breaks during the transition.
app.get('/api/widget-concepts', async (req, res) => {
  try {
    const { rows: concepts } = await pool.query(
      `SELECT id, name, before_image_url, after_image_url, example_video_url, sort_order,
              price_tier, input_type
       FROM concepts
       WHERE active = TRUE
       ORDER BY sort_order ASC, id ASC
       LIMIT 12`
    );
    // Premium concepts (talking pet, family portrait, etc.) skip the free
    // preview step — too expensive to generate just for a preview. The Buy
    // button on the widget goes live as soon as a photo is uploaded.
    const NO_PREVIEW_TIERS = new Set(['talking', 'premium', 'premium_video']);
    const { rows: triplets } = await pool.query(
      `SELECT t.id, t.concept_id, t.triplet_number, t.sort_order,
              bm.url AS before_url, im.url AS image_url, vm.url AS video_url
       FROM concept_triplets t
       LEFT JOIN concept_media bm ON bm.id = t.before_media_id AND bm.active = TRUE
       LEFT JOIN concept_media im ON im.id = t.image_media_id  AND im.active = TRUE
       LEFT JOIN concept_media vm ON vm.id = t.video_media_id  AND vm.active = TRUE
       WHERE t.in_rolling_demo = TRUE AND t.active = TRUE
       ORDER BY t.sort_order ASC, t.triplet_number ASC`
    );
    const tripletsByConcept = new Map();
    for (const t of triplets) {
      if (!t.before_url && !t.image_url && !t.video_url) continue;
      if (!tripletsByConcept.has(t.concept_id)) tripletsByConcept.set(t.concept_id, []);
      tripletsByConcept.get(t.concept_id).push({
        number: t.triplet_number,
        before_url: t.before_url,
        image_url: t.image_url,
        video_url: t.video_url,
      });
    }
    const result = [];
    for (const c of concepts) {
      let cTriplets = tripletsByConcept.get(c.id) || [];
      // Fallback: synthesize an implicit triplet #1 from the legacy single-slot URLs.
      if (cTriplets.length === 0 && (c.before_image_url || c.after_image_url || c.example_video_url)) {
        cTriplets = [{
          number: 1,
          before_url: c.before_image_url || null,
          image_url:  c.after_image_url  || null,
          video_url:  c.example_video_url || null,
        }];
      }
      if (cTriplets.length === 0) continue; // skip concepts with nothing to show
      // "No free preview" applies when:
      //   • price_tier is a premium tier (talking/premium/premium_video), OR
      //   • input_type === 'video' (no still image to preview anyway)
      // Either way the Buy button goes live immediately after upload.
      const noPreview =
        NO_PREVIEW_TIERS.has(c.price_tier || '') ||
        (c.input_type || '') === 'video';
      result.push({
        id: c.id,
        name: c.name,
        triplets: cTriplets,
        input_type: c.input_type || 'image_video',
        no_free_preview: noPreview,
      });
    }
    res.set('Cache-Control', 'public, max-age=30');
    res.json(result);
  } catch (err) {
    console.error('[widget-concepts] error:', err.message);
    res.status(500).json({ error: 'Failed' });
  }
});

// Create or update a triplet. Body: { id?, concept_id, triplet_number,
// before_media_id?, image_media_id?, video_media_id?, in_rolling_demo, sort_order, caption? }
app.post('/admin/triplets/save', requireRole('admin'), async (req, res) => {
  try {
    const id = parseInt(req.body.id, 10) || null;
    const conceptId = parseInt(req.body.concept_id, 10);
    if (!conceptId) return res.redirect((req.body.return_to || '/admin/triplets') + '?error=' + encodeURIComponent('Missing concept'));
    const tripletNumber = parseInt(req.body.triplet_number, 10) || 1;
    const sortOrder = parseInt(req.body.sort_order, 10) || 0;
    const inRolling = req.body.in_rolling_demo === 'on' || req.body.in_rolling_demo === 'true' || req.body.in_rolling_demo === '1';
    const inGallery = req.body.in_gallery === 'on' || req.body.in_gallery === 'true' || req.body.in_gallery === '1';
    const active = !(req.body.active === 'false' || req.body.active === '0' || req.body.active === 'off');
    const beforeMediaId = req.body.before_media_id ? parseInt(req.body.before_media_id, 10) : null;
    const imageMediaId  = req.body.image_media_id  ? parseInt(req.body.image_media_id,  10) : null;
    const videoMediaId  = req.body.video_media_id  ? parseInt(req.body.video_media_id,  10) : null;
    const caption = req.body.caption ? String(req.body.caption).trim() || null : null;

    if (id) {
      await pool.query(
        `UPDATE concept_triplets SET
           concept_id = $1, triplet_number = $2, sort_order = $3,
           in_rolling_demo = $4, in_gallery = $5, active = $6,
           before_media_id = $7, image_media_id = $8, video_media_id = $9,
           caption = $10
         WHERE id = $11`,
        [conceptId, tripletNumber, sortOrder, inRolling, inGallery, active, beforeMediaId, imageMediaId, videoMediaId, caption, id]
      );
    } else {
      // Auto-assign triplet_number if not set or collides.
      const existing = await pool.query(
        `SELECT triplet_number FROM concept_triplets WHERE concept_id = $1 ORDER BY triplet_number ASC`,
        [conceptId]
      );
      let n = tripletNumber;
      const taken = new Set(existing.rows.map((r) => r.triplet_number));
      if (taken.has(n) || !n) {
        n = 1;
        while (taken.has(n)) n++;
      }
      await pool.query(
        `INSERT INTO concept_triplets (concept_id, triplet_number, sort_order, in_rolling_demo, in_gallery, active,
           before_media_id, image_media_id, video_media_id, caption)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [conceptId, n, sortOrder, inRolling, inGallery, active, beforeMediaId, imageMediaId, videoMediaId, caption]
      );
    }
    if (wantsJson(req)) return res.json({ ok: true });
    res.redirect(req.body.return_to || '/admin/concepts');
  } catch (err) {
    console.error('[triplets-save] error:', err.message);
    res.redirect((req.body.return_to || '/admin/triplets') + '?error=' + encodeURIComponent(err.message));
  }
});

app.post('/admin/triplets/:id/delete', requireRole('admin'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM concept_triplets WHERE id = $1`, [parseInt(req.params.id, 10)]);
    res.redirect(req.body.return_to || '/admin/triplets?deleted=1');
  } catch (err) {
    console.error('[triplets-delete] error:', err.message);
    res.redirect((req.body.return_to || '/admin/triplets') + '?error=' + encodeURIComponent(err.message));
  }
});

// Move a triplet to a different concept. Called by the t-card concept select
// onchange handler on /admin/gallery so the user doesn't have to open the full
// triplet editor. Note: this does NOT move the underlying media items — those
// stay attached to whatever concept they came from.
app.post('/admin/triplets/:id/move-concept', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const conceptId = parseInt(req.body.concept_id, 10);
  if (!id || !conceptId) return res.status(400).json({ error: 'Bad id/concept' });
  try {
    const exists = await pool.query(`SELECT 1 FROM concepts WHERE id = $1`, [conceptId]);
    if (!exists.rows.length) return res.status(400).json({ error: 'Unknown concept' });
    await pool.query(`UPDATE concept_triplets SET concept_id = $1 WHERE id = $2`, [conceptId, id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[triplet-move-concept] error:', err.message);
    res.status(500).json({ error: 'Move failed' });
  }
});

// Quick-toggle for one boolean field on a triplet — used by the card-grid toggles
// on the redesigned /admin/gallery so they don't need a full-form Save click.
app.post('/admin/triplets/:id/toggle', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const field = String(req.body.field || '').trim();
  const allowed = { active: 'active', rolling: 'in_rolling_demo', gallery: 'in_gallery' };
  const column = allowed[field];
  if (!id || !column) return res.status(400).json({ error: 'Bad field' });
  try {
    await pool.query(`UPDATE concept_triplets SET ${column} = NOT ${column} WHERE id = $1`, [id]);
    const r = await pool.query(`SELECT ${column} AS value FROM concept_triplets WHERE id = $1`, [id]);
    res.json({ ok: true, value: r.rows[0] ? r.rows[0].value : null });
  } catch (err) {
    console.error('[triplet-toggle] error:', err.message);
    res.status(500).json({ error: 'Toggle failed' });
  }
});

// Standalone triplets manager.
app.get('/admin/triplets', requireRole('admin'), async (req, res) => {
  try {
    const filterConcept = req.query.concept ? parseInt(req.query.concept, 10) : null;
    const { rows: concepts } = await pool.query(
      `SELECT id, name FROM concepts WHERE active = TRUE ORDER BY name ASC`
    );
    const { rows: media } = await pool.query(
      `SELECT cm.id, cm.kind, cm.url, c.name AS concept_name
       FROM concept_media cm
       JOIN concepts c ON c.id = cm.concept_id
       WHERE cm.active = TRUE
       ORDER BY c.name ASC, cm.sort_order ASC, cm.created_at DESC`
    );
    const imageItems = media.filter((m) => m.kind === 'image');
    const videoItems = media.filter((m) => m.kind === 'video');

    const whereSql = filterConcept ? 'WHERE t.concept_id = $1' : '';
    const params = filterConcept ? [filterConcept] : [];
    const { rows: triplets } = await pool.query(
      `SELECT t.id, t.concept_id, t.triplet_number, t.sort_order, t.in_rolling_demo,
              t.before_media_id, t.image_media_id, t.video_media_id, t.caption,
              c.name AS concept_name,
              bm.url AS before_url, im.url AS image_url, vm.url AS video_url
       FROM concept_triplets t
       JOIN concepts c ON c.id = t.concept_id
       LEFT JOIN concept_media bm ON bm.id = t.before_media_id
       LEFT JOIN concept_media im ON im.id = t.image_media_id
       LEFT JOIN concept_media vm ON vm.id = t.video_media_id
       ${whereSql}
       ORDER BY c.name ASC, t.sort_order ASC, t.triplet_number ASC`,
      params
    );

    const fname = (url) => (url ? (String(url).split('?')[0].split('/').pop() || '').slice(0, 28) : '');
    const slotPicker = (selectName, currentMediaId, currentUrl, items, kindLabel) => {
      const opts = `<option value="">— (none) —</option>` + items.map((m) => {
        const lbl = `${m.concept_name} · ${fname(m.url)}`;
        const sel = m.id === currentMediaId ? ' selected' : '';
        return `<option value="${m.id}"${sel}>${escapeHtml(lbl)}</option>`;
      }).join('');
      // Match by regex — kindLabel may be 'Video' (from /admin/concepts) or 'After Video' (from /admin/triplets).
      const isVideo = /video/i.test(kindLabel);
      // Portrait 9:16 thumbnail since all assets are 9:16 portrait.
      const thumbStyle = 'width:54px;height:96px;object-fit:cover;border-radius:4px;';
      const preview = currentUrl
        ? (isVideo
            ? `<video src="${escapeHtml(currentUrl)}" muted playsinline preload="metadata" style="${thumbStyle}background:#000;"></video>`
            : `<img src="${escapeHtml(currentUrl)}" alt="" style="${thumbStyle}">`)
        : `<div style="width:54px;height:96px;border-radius:4px;background:#f0ede6;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:11px;">none</div>`;
      const slotKind = isVideo ? 'video' : 'image';
      return `<div class="ts-drop-slot" data-slot-kind="${slotKind}" style="display:flex;flex-direction:column;gap:3px;padding:4px;border-radius:6px;border:2px dashed transparent;transition:border-color 0.15s,background 0.15s;">
        <div style="font-size:10px;color:#888;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;">${escapeHtml(kindLabel)}</div>
        <div style="display:flex;align-items:center;gap:6px;">${preview}<select name="${selectName}" style="flex:1;padding:5px 7px;font-size:12px;min-width:180px;">${opts}</select></div>
      </div>`;
    };

    const tripletCard = (t) => `<div style="background:#fff;border:1px solid #eee;border-radius:10px;padding:14px;margin-bottom:12px;">
      <form method="POST" action="/admin/triplets/save">
        <input type="hidden" name="id" value="${t.id || ''}">
        <input type="hidden" name="return_to" value="${escapeHtml('/admin/triplets' + (filterConcept ? `?concept=${filterConcept}` : ''))}">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;flex-wrap:wrap;">
          <div style="background:#1C2A14;color:#FFE800;font-weight:800;font-size:13px;padding:5px 12px;border-radius:14px;">${escapeHtml(t.concept_name)} · #${t.triplet_number}</div>
          <select name="concept_id" style="padding:5px 9px;font-size:12px;">
            ${concepts.map((c) => `<option value="${c.id}"${c.id === t.concept_id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
          </select>
          <label style="font-size:12px;">Number <input type="number" name="triplet_number" value="${t.triplet_number}" style="width:60px;padding:5px;"></label>
          <label style="font-size:12px;">Order <input type="number" name="sort_order" value="${t.sort_order}" style="width:60px;padding:5px;"></label>
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;font-weight:700;color:#3A6B20;cursor:pointer;"><input type="checkbox" name="in_rolling_demo"${t.in_rolling_demo ? ' checked' : ''}> Rolling demo</label>
          <input type="text" name="caption" value="${escapeHtml(t.caption || '')}" placeholder="caption (optional)" style="flex:1;min-width:180px;padding:5px 9px;font-size:12px;">
          <button type="submit" class="btn small">Save</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;">
          ${slotPicker('before_media_id', t.before_media_id, t.before_url, imageItems, 'Before')}
          ${slotPicker('image_media_id',  t.image_media_id,  t.image_url,  imageItems, 'After Picture')}
          ${slotPicker('video_media_id',  t.video_media_id,  t.video_url,  videoItems, 'After Video')}
        </div>
      </form>
      <form method="POST" action="/admin/triplets/${t.id}/delete" class="inline" style="margin-top:10px;text-align:right;" onsubmit="return confirm('Delete triplet #${t.triplet_number} for ${escapeHtml(t.concept_name).replace(/"/g, '&quot;').replace(/'/g, '&#39;')}?');">
        <input type="hidden" name="return_to" value="${escapeHtml('/admin/triplets' + (filterConcept ? `?concept=${filterConcept}` : ''))}">
        <button type="submit" class="btn small" style="background:#fff;border-color:#c33;color:#c33;">Delete</button>
      </form>
    </div>`;

    const conceptFilterOpts = `<option value="">All concepts</option>` + concepts.map((c) => `<option value="${c.id}"${c.id === filterConcept ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('');

    const body = `
      <div class="top">
        <h1>Triplets</h1>
        <a class="btn" href="/admin/concepts">&larr; Back to concepts</a>
      </div>
      <p class="muted" style="margin:0 0 16px;">A triplet groups a Before photo, an After Picture, and an After Video into one set under a concept. Triplets marked <strong>Rolling demo</strong> are cycled in the landing-page widget — each visit to a concept's row in the carousel advances to the next triplet.</p>
      <form method="GET" action="/admin/triplets" style="display:flex;gap:10px;align-items:end;margin-bottom:20px;">
        <div class="field" style="margin:0;"><label>Concept</label><select name="concept">${conceptFilterOpts}</select></div>
        <button type="submit" class="btn secondary">Filter</button>
        <a href="/admin/triplets" class="muted" style="align-self:center;">Reset</a>
      </form>
      ${req.query.error ? `<div class="flash err">${escapeHtml(req.query.error)}</div>` : ''}
      ${req.query.deleted ? `<div class="flash ok">Deleted.</div>` : ''}
      ${triplets.length ? triplets.map(tripletCard).join('') : '<p class="muted">No triplets yet. Add one from the Concepts page (sub-grid under each concept) or below.</p>'}
      <h2 style="font-size:16px;margin-top:32px;">Add new triplet</h2>
      <form method="POST" action="/admin/triplets/save" style="background:#FFF9E6;border:1px solid #e8d870;border-radius:10px;padding:14px;">
        <input type="hidden" name="return_to" value="${escapeHtml('/admin/triplets' + (filterConcept ? `?concept=${filterConcept}` : ''))}">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;flex-wrap:wrap;">
          <select name="concept_id" required style="padding:5px 9px;font-size:12px;">
            <option value="">— pick concept —</option>
            ${concepts.map((c) => `<option value="${c.id}"${c.id === filterConcept ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
          </select>
          <label style="font-size:12px;">Number <input type="number" name="triplet_number" value="" placeholder="auto" style="width:80px;padding:5px;"></label>
          <label style="font-size:12px;">Order <input type="number" name="sort_order" value="0" style="width:60px;padding:5px;"></label>
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;font-weight:700;color:#3A6B20;cursor:pointer;"><input type="checkbox" name="in_rolling_demo" checked> Rolling demo</label>
          <input type="text" name="caption" placeholder="caption (optional)" style="flex:1;min-width:180px;padding:5px 9px;font-size:12px;">
          <button type="submit" class="btn">Create triplet</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;">
          ${slotPicker('before_media_id', null, null, imageItems, 'Before')}
          ${slotPicker('image_media_id',  null, null, imageItems, 'After Picture')}
          ${slotPicker('video_media_id',  null, null, videoItems, 'After Video')}
        </div>
      </form>
      <style>
        .ts-drop-slot.dragover{border-color:#3A6B20 !important;background:rgba(58,107,32,0.08);}
        .ts-drop-slot select.dropped{background:#FFF3C4 !important;font-weight:600;}
      </style>
      ${TS_DROP_HANDLER_JS}`;
    res.send(conceptAdminPage('Triplets', body));
  } catch (err) {
    console.error('[triplets-list] error:', err.message);
    res.status(500).send('Failed: ' + escapeHtml(err.message));
  }
});

app.get('/gallery', async (req, res) => {
  const { category, kind } = req.query;
  try {
    const params = [];
    let where = `WHERE cm.active = TRUE AND c.active = TRUE`;
    if (category && category !== 'all') {
      params.push(`%${category}%`);
      // filter_category is comma-separated on both the concept and the item.
      // An item matches if EITHER its own categories OR its concept's contain the term.
      where += ` AND (c.filter_category ILIKE $${params.length} OR cm.filter_category ILIKE $${params.length})`;
    }
    if (kind && kind !== 'all' && CONCEPT_MEDIA_KINDS.includes(kind)) {
      params.push(kind);
      where += ` AND cm.kind = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT cm.id, cm.kind, cm.url, cm.thumbnail_url, cm.caption, cm.sort_order, cm.is_primary,
              cm.source_url,
              c.id AS concept_id, c.slug AS concept_slug, c.name AS concept_name,
              c.description AS concept_description, c.filter_category
       FROM concept_media cm
       JOIN concepts c ON c.id = cm.concept_id
       ${where}
       ORDER BY cm.is_primary DESC, cm.sort_order ASC, cm.created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch gallery', details: err.message });
  }
});

// ---- Quality warning email -----------------------------------------------
async function sendQualityWarning({ orderId, email, concept, reason, thumbUrl }) {
  try {
    const adminUrl = `https://turtleandsun.com/admin/generations`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;padding:24px;">
      <h2 style="color:#e53935;">&#9888; Loveogram quality warning</h2>
      <p><strong>Reason:</strong> ${reason}</p>
      <p><strong>Order:</strong> #${orderId || '?'} &mdash; ${email || 'unknown email'}</p>
      <p><strong>Concept:</strong> ${concept || '?'}</p>
      ${thumbUrl ? `<p><img src="${thumbUrl}" style="max-width:200px;border-radius:8px;display:block;margin:12px 0;"></p>` : ''}
      <p><a href="${adminUrl}" style="display:inline-block;padding:10px 20px;background:#1C2A14;color:#FFE800;text-decoration:none;border-radius:8px;font-weight:700;">Review in admin &rarr;</a></p>
    </div>`;
    await resend.emails.send({
      from: 'Turtle and Sun <hello@turtleandsun.com>',
      to: 'hello@turtleandsun.com',
      subject: `⚠️ Quality warning — Order #${orderId || '?'} — ${reason}`,
      html,
    });
    console.warn('[quality] warning sent for order', orderId, '—', reason);
  } catch(e) {
    console.error('[quality] failed to send warning email:', e.message);
  }
}


async function generateVideo(portrait_url) {
  const result = await fal.subscribe('fal-ai/kling-video/v3/pro/image-to-video', {
    input: {
      image_url: portrait_url,
      prompt: ROYAL_VIDEO_PROMPT,
      duration: '10',
      enable_audio: true,
    },
    storageSettings: { expiresIn: 'never' },
  });
  return result.data.video.url;
}

// portrait_url is the already-generated preview image — no re-generation needed for image product.
// Now concept-aware: if conceptId is provided, the function dispatches via the registry
// (generation.generateTalking / generation.generateVideo) using the concept's stored fields.
// Legacy orders without conceptId continue to use the hardcoded local generateVideo(portrait_url).
async function generateForOrder(portrait_url, product, email, orderId, conceptId, customerName) {
  let imageUrl = null;
  let videoUrl = null;
  let concept = null;

  // Load the concept if conceptId was passed through (new path).
  if (conceptId) {
    try {
      const { rows } = await pool.query(
        `SELECT id, slug, name, input_type, image_prompt, video_prompt,
                fal_image_model, fal_video_model, talking_model,
                speech_text, voice_ids, reference_image_urls,
                image_input_extras, video_input_extras
         FROM concepts WHERE id = $1`,
        [parseInt(conceptId, 10)]
      );
      concept = rows[0] || null;
    } catch (err) {
      console.warn('[generateForOrder] concept lookup failed (falling back to legacy path):', err.message);
    }
  }

  // Resolve user id for audit log (best-effort).
  let userId = null;
  if (email) {
    try {
      const u = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      userId = u.rows[0]?.id || null;
    } catch (e) { /* non-fatal */ }
  }

  // What did the customer actually pay for?
  // `product` is authoritative when present (the new hero-widget always sends one
  // of image/video/bundle). Falls back to the concept's input_type only for
  // legacy / direct-link orders that lack a product field.
  const hasProduct = (product === 'image' || product === 'video' || product === 'bundle');
  const isTalkingConcept = !!(concept && concept.input_type === 'talking');
  let wantsImage, wantsVideo, wantsTalking;
  if (hasProduct) {
    wantsImage   = (product === 'image' || product === 'bundle');
    // For a talking concept, the "video" half of the bundle is the talking clip.
    wantsTalking = isTalkingConcept && (product === 'video' || product === 'bundle');
    wantsVideo   = !isTalkingConcept && (product === 'video' || product === 'bundle');
  } else {
    // Legacy fallback: derive from concept input_type
    wantsImage   = !!(concept && (concept.input_type === 'image' || concept.input_type === 'image_video'));
    wantsTalking = isTalkingConcept;
    wantsVideo   = !!(concept && (concept.input_type === 'image_video' || concept.input_type === 'video')) && !isTalkingConcept;
  }

  // Image side — the preview the customer already accepted IS the deliverable.
  if (wantsImage) {
    imageUrl = portrait_url;
    console.log('Using preview portrait as final image:', imageUrl);
    if (orderId) {
      await pool.query('UPDATE orders SET result_url = $1 WHERE id = $2', [imageUrl, orderId]);
      try {
        const r2img = await downloadAndStore({ remoteUrl: imageUrl, kind: 'order', orderId });
        await pool.query('UPDATE orders SET output_asset_url=$1, asset_status=$2 WHERE id=$3', [r2img.url, 'stored', orderId]);
        imageUrl = r2img.url;
        if (r2img.bytes < 51200) sendQualityWarning({ orderId, email, concept: concept && concept.name, reason: 'Image too small (' + r2img.bytes + ' bytes) - may be blank', thumbUrl: r2img.url });
      } catch(e) { console.warn('[asset] R2 image store failed:', e.message); }
      // Log to generations table so image orders appear in admin review
      try {
        const imgModelId = (concept && concept.fal_image_model) || 'image-reuse';
        const imgLogged = await generation.logGenerationStart({ conceptId: concept && concept.id, modelId: imgModelId, inputPayload: { photoUrl: portrait_url }, sourceType: 'customer_order', userId, orderId });
        await generation.logGenerationFinish(imgLogged.id, { falOutputUrl: imageUrl });
      } catch(e) { console.warn('[gen-log] image log failed:', e.message); }
    }
  }

  if (wantsTalking) {
    const modelId = concept.talking_model || 'fal-ai/kling-video/v3/pro/image-to-video__talking';
    const logged = await generation.logGenerationStart({
      conceptId: concept.id,
      modelId,
      inputPayload: { photoUrl: portrait_url, speech: concept.speech_text, name: customerName },
      sourceType: 'customer_order',
      userId, orderId,
    });
    try {
      const result = await generation.generateTalking({
        modelId,
        photoUrl: portrait_url,
        visualPrompt: concept.video_prompt || concept.image_prompt,
        speechText: concept.speech_text,
        customerName,
        inputExtras: concept.video_input_extras || {},
        voiceIds: concept.voice_ids || [],
      });
      videoUrl = result.url;
      await generation.logGenerationFinish(logged.id, { falOutputUrl: videoUrl });
      console.log('[generateForOrder] talking video generated:', videoUrl);
      if (orderId) {
        await pool.query('UPDATE orders SET result_video_url = $1 WHERE id = $2', [videoUrl, orderId]);
      }
    } catch (err) {
      await generation.logGenerationFailure(logged.id, err.message);
      throw err;
    }
  } else if (wantsVideo) {
    // For concept-aware video orders, route through the registry. For legacy
    // orders (no concept), fall back to the hardcoded local generateVideo().
    const modelId = concept && concept.fal_video_model ? concept.fal_video_model : null;
    if (concept && modelId) {
      const logged = await generation.logGenerationStart({
        conceptId: concept.id,
        modelId,
        inputPayload: { photoUrl: portrait_url, prompt: concept.video_prompt },
        sourceType: 'customer_order',
        userId, orderId,
      });
      try {
        const result = await generation.generateVideo({
          provider: 'fal',
          modelId,
          prompt: concept.video_prompt,
          photoUrl: portrait_url,
          inputExtras: concept.video_input_extras || {},
        });
        videoUrl = result.url;
        await generation.logGenerationFinish(logged.id, { falOutputUrl: videoUrl });
      } catch (err) {
        await generation.logGenerationFailure(logged.id, err.message);
        throw err;
      }
    } else {
      // Legacy hardcoded path — Royal Portrait video.
      videoUrl = await generateVideo(portrait_url);
    }
    console.log('Generated video:', videoUrl);
    if (orderId) {
      await pool.query('UPDATE orders SET result_video_url = $1 WHERE id = $2', [videoUrl, orderId]);
      try {
        const r2vid = await downloadAndStore({ remoteUrl: videoUrl, kind: 'order', orderId });
        await pool.query('UPDATE orders SET output_video_asset_url=$1, asset_status=$2 WHERE id=$3', [r2vid.url, 'stored', orderId]);
        videoUrl = r2vid.url;
        if (r2vid.bytes < 512000) sendQualityWarning({ orderId, email, concept: concept && concept.name, reason: 'Video too small (' + Math.round(r2vid.bytes/1024) + 'KB) - may be corrupted', thumbUrl: null });
      } catch(e) { console.warn('[asset] R2 video store failed:', e.message); }
    }
  }

  if (email) {
    // Deliver via email — for talking, we surface the video alongside the still preview.
    await sendResultEmail(email, wantsTalking ? 'talking' : product, imageUrl, videoUrl);
  }
}

async function sendResultEmail(email, product, imageUrl, videoUrl) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:linear-gradient(180deg,#FFFEF5 0%,#FFFBE8 40%,#FFF0A0 75%,#FFE800 100%);padding:40px 32px;border-radius:12px;">
      <img src="https://turtleandsun.com/logo.png" alt="Turtle and Sun" style="width:200px;height:auto;display:block;margin-bottom:20px;">
      <h1 style="font-size:26px;color:#1C2A14;margin-bottom:8px;">Your Loveogram is ready! &#128081;</h1>
      <p style="font-size:16px;color:#1C0A00;margin-bottom:24px;">It's waiting for you in your account. Click below to view and download it.</p>
      <p style="margin:24px 0;"><a href="https://turtleandsun.com/account" style="display:inline-block;padding:14px 28px;background:#81C784;color:#000;text-decoration:none;border-radius:10px;border:2px solid #000;font-weight:700;font-family:Arial,sans-serif;font-size:16px;">View your Loveogram →</a></p>
      <hr style="border:none;border-top:1px solid rgba(0,0,0,0.1);margin:32px 0 16px;" />
      <p style="font-size:13px;color:#555;margin:0;">Questions? Write to <a href="mailto:hello@turtleandsun.com" style="color:#1C2A14;">hello@turtleandsun.com</a></p>
      <p style="font-size:13px;color:#555;margin-top:8px;">&#8212; Turtle and Sun</p>
    </div>
  `;

  await resend.emails.send({
    from: 'Turtle and Sun <hello@turtleandsun.com>',
    to: email,
    subject: 'Your Loveogram is ready! 🐢',
    html,
  });
  console.log('Result email sent to', email);
}



// ---- Admin: Generation quality review dashboard --------------------------------
app.get('/admin/generations', requireRole('admin'), (req, res) => {
  res.sendFile(require('path').join(__dirname, 'admin-generations.html'));
});

app.get('/admin/api/generations', requireRole('admin'), async (req, res) => {
  try {
    const { source, status, flagged, page = 1 } = req.query;
    const limit = 40;
    const offset = (parseInt(page) - 1) * limit;
    const conds = [];
    const params = [];
    if (source)  { params.push(source);  conds.push(`g.source_type = $${params.length}`); }
    if (status)  { params.push(status);  conds.push(`g.status = $${params.length}`); }
    if (flagged === '1') { conds.push('g.flagged = true'); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    params.push(limit); params.push(offset);
    const { rows } = await pool.query(`
      SELECT g.id, g.status, g.source_type, g.flagged, g.flag_note,
             g.fal_output_url, g.output_url, g.error_message,
             g.created_at, g.completed_at,
             EXTRACT(EPOCH FROM (g.completed_at - g.created_at))::int AS secs,
             c.name AS concept_name,
             o.email, o.product, o.id AS order_id,
             o.output_asset_url, o.output_video_asset_url
      FROM generations g
      LEFT JOIN concepts c ON c.id = g.concept_id
      LEFT JOIN orders o ON o.id = g.order_id
      ${where}
      ORDER BY g.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    res.json({ rows, page: parseInt(page), limit });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/api/generations/:id/flag', requireRole('admin'), async (req, res) => {
  try {
    const { flagged, note } = req.body;
    await pool.query(
      'UPDATE generations SET flagged=$2, flag_note=$3 WHERE id=$1',
      [req.params.id, !!flagged, note || null]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/api/generations/:id/regenerate', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.concept_id, g.input_payload, o.email, o.product, o.id AS oid, o.input_asset_url
       FROM generations g LEFT JOIN orders o ON o.id = g.order_id WHERE g.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const gen = rows[0];
    const portrait_url = (gen.input_payload && gen.input_payload.photoUrl) || gen.input_asset_url;
    if (!portrait_url) return res.status(400).json({ error: 'No source photo found' });
    res.json({ ok: true, message: 'Regeneration started' });
    generateForOrder(portrait_url, gen.product, gen.email || '', gen.oid, gen.concept_id, null)
      .catch(e => console.error('[regenerate] failed:', e.message));
  } catch(e) { res.status(500).json({ error: e.message }); }
});


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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  body{font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;color:#1C0A00;margin:0;padding:0;min-height:100vh;display:flex;flex-direction:column;}
  .wrap{max-width:1100px;margin:0 auto;padding:8px 24px 48px;width:100%;box-sizing:border-box;position:relative;z-index:1;flex:1;}
  .wrap > h1:first-child, .wrap > .top:first-child{margin-top:0;}
  footer.ts-footer{text-align:center;padding:32px 20px;font-size:13px;opacity:0.6;position:relative;z-index:1;}
  h1{font-size:24px;margin:0 0 20px;}
  a{color:#3A6B20;}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #eee;border-radius:8px;overflow:hidden;}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eee;font-size:14px;vertical-align:middle;}
  th{background:#FFF3C4;text-transform:uppercase;font-size:11px;letter-spacing:0.04em;}
  img.thumb,video.thumb{width:48px;height:48px;object-fit:cover;border-radius:6px;border:1px solid #ddd;background:#f3f3f3;}
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
  /* "Generating…" feedback for the concept-edit Test buttons */
  .btn.is-busy{background:#FFB400 !important;color:#1C0A00 !important;cursor:progress;}
  .ts-test-spinner{display:inline-block;width:13px;height:13px;border:2.4px solid rgba(28,10,0,0.18);border-top-color:#1C0A00;border-radius:50%;animation:ts-test-spin 0.7s linear infinite;vertical-align:-2px;margin-right:6px;}
  @keyframes ts-test-spin{to{transform:rotate(360deg);}}
  /* Make the test-status text more visible while a job is in-flight */
  #testImageStatus:not(:empty),#testVideoStatus:not(:empty){background:#FFF3C4;color:#1C0A00;padding:8px 12px;border-radius:6px;font-weight:600;border:1px solid rgba(28,10,0,0.12);display:inline-block;margin-top:10px !important;font-size:13px;}
</style></head><body class="ts-nav-loggedin ts-nav-admin">
<div class="sun"></div>
<script src="/currency.js?v=20260526a"></script>
<script src="/nav.js?v=20260526b"></script>
<script>NavBar.init({ requireAuth: true });</script>
${devRibbonHtml()}
<div class="wrap">${body}</div>
<footer class="ts-footer">
  <p>Questions? Write to <a href="mailto:hello@turtleandsun.com" style="color:inherit;">hello@turtleandsun.com</a></p>
  <p>Turtle and Sun is a service by 3doc AB · Org.nr 556723-1864 · Fleminggatan 15, 112 26 Stockholm</p>
</footer>
</body></html>`;
}


// ---------------------------------------------------------------------------
// Admin: Currencies page. Shows live FX rates, last refresh time, supported
// currencies + their charm ladder size, and a "Refresh now" button to force
// the ECB fetch on demand.
// ---------------------------------------------------------------------------
app.get('/admin/currencies', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (target_currency)
        target_currency, rate, fetched_at, source
      FROM fx_rates
      WHERE base_currency = 'sek'
      ORDER BY target_currency, fetched_at DESC
    `);

    const supported = Object.keys(pricing.CHARM_LADDERS);
    const rateMap = {};
    for (const r of rows) rateMap[r.target_currency] = r;

    const fmtDate = (d) => d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '<span class="muted">—</span>';

    const renderRow = (cur) => {
      const r = rateMap[cur];
      const fallback = pricing.FALLBACK_RATES[cur];
      const ladderLen = (pricing.CHARM_LADDERS[cur] || []).length;
      const liveRate = r
        ? Number(r.rate).toFixed(8)
        : '<em class="muted">using fallback ' + fallback + '</em>';
      const exampleSek = 14900;
      const rateMapForExample = r ? { [cur]: Number(r.rate), sek: 1 } : pricing.FALLBACK_RATES;
      const exampleMinor = pricing.convertAndCharm(exampleSek, cur, rateMapForExample);
      const examplePretty = pricing.formatDisplay(exampleMinor, cur);
      const actions = '<form class="inline" method="POST" action="/admin/currencies/toggle/' + cur + '"><button class="btn small" type="submit">Toggle</button></form>' +
        ' <a class="btn small" href="/admin/currencies/edit/' + cur + '">Edit</a>';
      return '<tr>' +
        '<td><strong>' + cur.toUpperCase() + '</strong></td>' +
        '<td>' + liveRate + '</td>' +
        '<td>' + (r ? escapeHtml(r.source || '') : '<span class="muted">—</span>') + '</td>' +
        '<td>' + fmtDate(r ? r.fetched_at : null) + '</td>' +
        '<td>' + ladderLen + '</td>' +
        '<td>149 kr → <strong>' + examplePretty + '</strong></td>' +
        '<td>' + actions + '</td>' +
      '</tr>';
    };

    let flash = '';
    if (req.query.refreshed) flash = '<div class="flash ok">FX rates refreshed.</div>';
    else if (req.query.error) flash = '<div class="flash err">' + escapeHtml(req.query.error) + '</div>';

    const body = `
      <div class="top">
        <h1>Currencies & FX rates</h1>
        <a href="/admin">← Back to admin</a>
      </div>
      ${flash}
      <p class="muted">FX rates are fetched daily from the ECB reference feed (04:00 UTC) and cached in the <code>fx_rates</code> table. SEK is the base currency. Charm ladders live in <code>pricing.js</code>.</p>

      <form method="POST" action="/admin/currencies/refresh" style="margin:18px 0;">
        <button type="submit" class="btn">Refresh now (force ECB fetch)</button>
        <span class="muted" style="margin-left:12px;">Use after an ECB outage or for ad-hoc updates.</span>
      </form>

      <table style="margin-top:8px;">
        <thead><tr>
          <th>Currency</th><th>SEK → X rate</th><th>Source</th><th>Fetched at</th><th>Ladder size</th><th>149 kr example</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${supported.map(renderRow).join('')}
        </tbody>
      </table>


      <h2 style="margin-top:32px;font-size:18px;">Add a new currency</h2>
      <form method="POST" action="/admin/currencies/save" style="background:#FFF9E6;border-radius:10px;padding:18px;margin-top:8px;border:1px solid rgba(0,0,0,0.08);">
        <input type="hidden" name="action" value="create">
        <div class="row">
          <div class="field"><label>Code (3 letters, lowercase) *</label><input type="text" name="code" required pattern="[a-z]{3}" placeholder="dkk" maxlength="3" style="text-transform:lowercase;"></div>
          <div class="field"><label>Display name *</label><input type="text" name="display_name" required placeholder="Danish krone"></div>
        </div>
        <div class="row">
          <div class="field"><label>Symbol *</label><input type="text" name="symbol" required maxlength="4" placeholder="kr"></div>
          <div class="field"><label>Symbol position</label><select name="symbol_position"><option value="after" selected>after — 99 kr</option><option value="before">before — $9.99</option></select></div>
          <div class="field"><label>Decimal places</label><select name="decimal_places"><option value="0">0 — integer (SEK/JPY)</option><option value="2" selected>2 — $9.99 / €9.99</option></select></div>
        </div>
        <div class="field"><label>Country codes (comma-separated ISO 3166-1 alpha-2)</label>
          <input type="text" name="country_codes" placeholder="DK">
          <span class="muted">Visitors from these countries see this currency by default. Leave blank if it's only available via manual currency-picker.</span>
        </div>
        <div class="field"><label>Fallback FX rate (1 SEK → X target)</label>
          <input type="number" step="0.0000001" name="fallback_rate" placeholder="0.65" required>
          <span class="muted">Used until ECB cron fetches a live rate. Daily refresh overwrites this. For DKK ≈ 0.65, NOK ≈ 1.00, JPY ≈ 14.5.</span>
        </div>
        <div class="field"><label>Charm ladder (JSON array of psychologically-attractive prices)</label>
          <textarea name="charm_ladder" rows="3" placeholder='[9, 19, 29, 49, 69, 99, 149, 199, 299, 499, 999]' required></textarea>
          <span class="muted">Each FX-converted price snaps UP to the nearest ladder value. Include enough granularity around your launch prices (typically ~50 values from 0.99 up to 999.99 in 2-decimal currencies, or 9 up to 9999 in integer currencies). See sek/usd ladders above for reference shape.</span>
        </div>
        <div class="field"><label>Sort order</label><input type="number" name="sort_order" value="5" min="0"></div>
        <div class="field"><label><input type="checkbox" name="active" value="on" checked> Active</label></div>
        <button type="submit" class="btn">Add currency</button>
      </form>


      <h2 style="margin-top:32px;font-size:18px;">How the engine flows</h2>
      <ol class="muted" style="margin-top:8px;">
        <li>You add a currency above. The row is written to the <code>currencies</code> table.</li>
        <li>The pricing engine immediately reloads — new currency is live for display + checkout.</li>
        <li>Next ECB cron run (or "Refresh now") fetches the live rate from the European Central Bank.</li>
        <li>Customer-facing prices auto-convert: SEK base → charm-rounded display in the target currency.</li>
      </ol>
      <p class="muted">If the ECB feed doesn't include your currency (rare — they list ~30 majors), the fallback rate you entered stays in use until you update it.</p>
    `;
    res.send(conceptAdminPage('Currencies', body));
  } catch (err) {
    console.error('[admin currencies] error:', err.message);
    res.status(500).send('Failed to load currencies: ' + escapeHtml(err.message));
  }
});

app.post('/admin/currencies/refresh', requireRole('admin'), async (req, res) => {
  try {
    const { refreshFxRates } = require('./fx_cron');
    const result = await refreshFxRates();
    if (!result) return res.redirect('/admin/currencies?error=' + encodeURIComponent('ECB fetch failed — see Railway logs.'));
    res.redirect('/admin/currencies?refreshed=1');
  } catch (err) {
    res.redirect('/admin/currencies?error=' + encodeURIComponent('Refresh error: ' + err.message));
  }
});

// POST /admin/currencies/save — create or update a currency.
app.post('/admin/currencies/save', requireRole('admin'), async (req, res) => {
  const action = req.body.action || 'create';
  const codeRaw = String(req.body.code || '').trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(codeRaw)) {
    return res.redirect('/admin/currencies?error=' + encodeURIComponent('Currency code must be exactly 3 lowercase letters (e.g. dkk).'));
  }
  const displayName = String(req.body.display_name || '').trim();
  const symbol = String(req.body.symbol || '').trim();
  const symbolPosition = req.body.symbol_position === 'before' ? 'before' : 'after';
  const decimalPlaces = Math.max(0, Math.min(4, parseInt(req.body.decimal_places, 10) || 0));
  const sortOrder = parseInt(req.body.sort_order, 10) || 0;
  const active = req.body.active === 'on' || req.body.active === 'true' || req.body.active === '1';
  const fallbackRate = parseFloat(req.body.fallback_rate);
  if (!Number.isFinite(fallbackRate) || fallbackRate <= 0) {
    return res.redirect('/admin/currencies?error=' + encodeURIComponent('Fallback rate must be a positive number.'));
  }
  if (!displayName || !symbol) {
    return res.redirect('/admin/currencies?error=' + encodeURIComponent('Display name and symbol are required.'));
  }
  let charmLadder;
  try {
    charmLadder = JSON.parse(req.body.charm_ladder || '[]');
    if (!Array.isArray(charmLadder) || charmLadder.length === 0) throw new Error('must be a non-empty array');
    for (const v of charmLadder) {
      if (typeof v !== 'number' || !isFinite(v) || v <= 0) throw new Error('all values must be positive numbers');
    }
  } catch (e) {
    return res.redirect('/admin/currencies?error=' + encodeURIComponent('Charm ladder must be valid JSON array of positive numbers: ' + e.message));
  }
  const countryCodes = String(req.body.country_codes || '')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

  try {
    if (action === 'update') {
      await pool.query(
        `UPDATE currencies SET
           display_name = $1, symbol = $2, symbol_position = $3, decimal_places = $4,
           charm_ladder = $5::jsonb, fallback_rate = $6, country_codes = $7::text[],
           active = $8, sort_order = $9, updated_at = NOW()
         WHERE code = $10`,
        [displayName, symbol, symbolPosition, decimalPlaces, JSON.stringify(charmLadder),
         fallbackRate, countryCodes, active, sortOrder, codeRaw]
      );
    } else {
      await pool.query(
        `INSERT INTO currencies (code, display_name, symbol, symbol_position, decimal_places, charm_ladder, fallback_rate, country_codes, active, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::text[], $9, $10)
         ON CONFLICT (code) DO UPDATE SET
           display_name = EXCLUDED.display_name, symbol = EXCLUDED.symbol,
           symbol_position = EXCLUDED.symbol_position, decimal_places = EXCLUDED.decimal_places,
           charm_ladder = EXCLUDED.charm_ladder, fallback_rate = EXCLUDED.fallback_rate,
           country_codes = EXCLUDED.country_codes, active = EXCLUDED.active,
           sort_order = EXCLUDED.sort_order, updated_at = NOW()`,
        [codeRaw, displayName, symbol, symbolPosition, decimalPlaces, JSON.stringify(charmLadder),
         fallbackRate, countryCodes, active, sortOrder]
      );
    }
    await pricing.refreshCurrencyCache();
    res.redirect('/admin/currencies?refreshed=1');
  } catch (err) {
    console.error('[admin currencies save] error:', err.message);
    res.redirect('/admin/currencies?error=' + encodeURIComponent('Save failed: ' + err.message));
  }
});

// POST /admin/currencies/toggle/:code — flip active.
app.post('/admin/currencies/toggle/:code', requireRole('admin'), async (req, res) => {
  const code = String(req.params.code || '').toLowerCase();
  if (!/^[a-z]{3}$/.test(code)) return res.redirect('/admin/currencies?error=' + encodeURIComponent('Invalid currency code.'));
  try {
    await pool.query('UPDATE currencies SET active = NOT active, updated_at = NOW() WHERE code = $1', [code]);
    await pricing.refreshCurrencyCache();
    res.redirect('/admin/currencies?refreshed=1');
  } catch (err) {
    res.redirect('/admin/currencies?error=' + encodeURIComponent('Toggle failed: ' + err.message));
  }
});

// GET /admin/currencies/edit/:code — pre-filled edit form (renders the
// existing add form with values populated; uses action=update on submit).
app.get('/admin/currencies/edit/:code', requireRole('admin'), async (req, res) => {
  const code = String(req.params.code || '').toLowerCase();
  try {
    const { rows } = await pool.query('SELECT * FROM currencies WHERE code = $1', [code]);
    if (!rows.length) return res.redirect('/admin/currencies?error=' + encodeURIComponent('Currency not found.'));
    const c = rows[0];
    const v = (s) => escapeHtml(s == null ? '' : s);
    const body = `
      <div class="top"><h1>Edit currency: ${escapeHtml(c.code.toUpperCase())}</h1><a href="/admin/currencies">← Back</a></div>
      <form method="POST" action="/admin/currencies/save" style="background:#FFF9E6;border-radius:10px;padding:18px;border:1px solid rgba(0,0,0,0.08);">
        <input type="hidden" name="action" value="update">
        <input type="hidden" name="code" value="${v(c.code)}">
        <div class="row">
          <div class="field"><label>Code (read-only)</label><input type="text" value="${v(c.code)}" disabled></div>
          <div class="field"><label>Display name *</label><input type="text" name="display_name" required value="${v(c.display_name)}"></div>
        </div>
        <div class="row">
          <div class="field"><label>Symbol *</label><input type="text" name="symbol" required value="${v(c.symbol)}"></div>
          <div class="field"><label>Symbol position</label>
            <select name="symbol_position">
              <option value="after"${c.symbol_position === 'after' ? ' selected' : ''}>after — 99 kr</option>
              <option value="before"${c.symbol_position === 'before' ? ' selected' : ''}>before — $9.99</option>
            </select>
          </div>
          <div class="field"><label>Decimal places</label>
            <select name="decimal_places">
              <option value="0"${c.decimal_places === 0 ? ' selected' : ''}>0</option>
              <option value="2"${c.decimal_places === 2 ? ' selected' : ''}>2</option>
            </select>
          </div>
        </div>
        <div class="field"><label>Country codes (comma-separated)</label>
          <input type="text" name="country_codes" value="${v((c.country_codes || []).join(','))}">
        </div>
        <div class="field"><label>Fallback FX rate (1 SEK → X)</label>
          <input type="number" step="0.0000001" name="fallback_rate" value="${v(c.fallback_rate)}" required>
        </div>
        <div class="field"><label>Charm ladder (JSON array)</label>
          <textarea name="charm_ladder" rows="4" required>${v(JSON.stringify(c.charm_ladder))}</textarea>
        </div>
        <div class="field"><label>Sort order</label><input type="number" name="sort_order" value="${v(c.sort_order)}"></div>
        <div class="field"><label><input type="checkbox" name="active" value="on"${c.active ? ' checked' : ''}> Active</label></div>
        <button type="submit" class="btn">Save changes</button>
      </form>
    `;
    res.send(conceptAdminPage('Edit currency', body));
  } catch (err) {
    console.error('[admin currencies edit] error:', err.message);
    res.redirect('/admin/currencies?error=' + encodeURIComponent('Edit failed: ' + err.message));
  }
});




// Mount occasions-engine admin (national occasions + campaign queue).
require('./admin_occasions').register(app, { requireRole, escapeHtml, conceptAdminPage });
reviews.register(app, { requireRole, escapeHtml, conceptAdminPage });
emailEngine.register(app, { requireRole, escapeHtml, conceptAdminPage });

app.get('/admin/concepts', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, slug, name, filter_category, input_type, before_image_url, after_image_url,
              example_video_url, active, sort_order
       FROM concepts ORDER BY sort_order ASC, id ASC`
    );

    // Library of all active media items, used to populate the inline slot dropdowns.
    const { rows: mediaItems } = await pool.query(
      `SELECT cm.id, cm.kind, cm.url, cm.concept_id, c.name AS concept_name
       FROM concept_media cm
       JOIN concepts c ON c.id = cm.concept_id
       WHERE cm.active = TRUE
       ORDER BY c.name ASC, cm.sort_order ASC, cm.created_at DESC`
    );
    const imageItems = mediaItems.filter((m) => m.kind === 'image');
    const videoItems = mediaItems.filter((m) => m.kind === 'video');

    // Triplets across all concepts. We'll render them grouped under each concept.
    const { rows: allTriplets } = await pool.query(
      `SELECT t.id, t.concept_id, t.triplet_number, t.sort_order, t.in_rolling_demo,
              t.before_media_id, t.image_media_id, t.video_media_id, t.caption,
              bm.url AS before_url, im.url AS image_url, vm.url AS video_url
       FROM concept_triplets t
       LEFT JOIN concept_media bm ON bm.id = t.before_media_id
       LEFT JOIN concept_media im ON im.id = t.image_media_id
       LEFT JOIN concept_media vm ON vm.id = t.video_media_id
       ORDER BY t.concept_id ASC, t.sort_order ASC, t.triplet_number ASC`
    );
    const tripletsByConcept = new Map();
    for (const t of allTriplets) {
      if (!tripletsByConcept.has(t.concept_id)) tripletsByConcept.set(t.concept_id, []);
      tripletsByConcept.get(t.concept_id).push(t);
    }

    let flash = '';
    if (req.query.saved) flash = `<div class="flash ok">Concept saved.</div>`;
    else if (req.query.deleted) flash = `<div class="flash ok">Concept deleted.</div>`;
    else if (req.query.error) flash = `<div class="flash err">${escapeHtml(req.query.error)}</div>`;
    if (req.query.warn) flash += `<div class="flash err">${escapeHtml(req.query.warn)}</div>`;

    const slotFilename = (url) => {
      if (!url) return '';
      return (String(url).split('?')[0].split('/').pop() || '').slice(0, 36);
    };
    // Render one media slot picker (Before/After-Pic/After-Vid) inside a triplet row.
    // Wrapped in a `.ts-drop-slot` zone so the receiving end of cross-tab drag-drop
    // (from /admin/gallery thumbnails) can populate the select on drop.
    const tripletSlot = (selectName, currentMediaId, currentUrl, items, kindLabel) => {
      const isVideo = /video/i.test(kindLabel);
      const slotKind = isVideo ? 'video' : 'image';
      const opts = `<option value="">— (none) —</option>` + items.map((m) => {
        const label = `${m.concept_name} · ${slotFilename(m.url)}`;
        const sel = m.id === currentMediaId ? ' selected' : '';
        return `<option value="${m.id}"${sel}>${escapeHtml(label)}</option>`;
      }).join('');
      // Portrait 9:16 thumbnail (all source assets are portrait).
      const tStyle = 'width:42px;height:75px;object-fit:cover;border-radius:4px;';
      const preview = currentUrl
        ? (isVideo
            ? `<video src="${escapeHtml(currentUrl)}" muted playsinline preload="metadata" style="${tStyle}background:#000;"></video>`
            : `<img src="${escapeHtml(currentUrl)}" alt="" style="${tStyle}">`)
        : `<div style="width:42px;height:75px;border-radius:4px;background:#f0ede6;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:10px;">${kindLabel.charAt(0)}</div>`;
      return `<div class="ts-drop-slot" data-slot-kind="${slotKind}" style="display:flex;align-items:center;gap:6px;flex:1;min-width:200px;padding:4px;border-radius:6px;border:2px dashed transparent;transition:border-color 0.15s,background 0.15s;">
        <div style="flex-shrink:0;">${preview}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:10px;color:#888;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;">${escapeHtml(kindLabel)}</div>
          <select name="${selectName}" style="width:100%;padding:4px 6px;font-size:11px;">${opts}</select>
        </div>
      </div>`;
    };
    // Render one triplet row as a save-as-you-go form.
    const tripletRow = (conceptId, t, fallbackUrls) => {
      // `t` may be a real row from concept_triplets OR a synthesized object with
      // null id and the legacy concept URLs as the visible state.
      const isExisting = !!(t && t.id);
      const idField = isExisting ? `<input type="hidden" name="id" value="${t.id}">` : '';
      const number = t ? t.triplet_number : '';
      const sortOrder = t ? t.sort_order : 0;
      const inRolling = t ? !!t.in_rolling_demo : true;
      const captionVal = t && t.caption ? escapeHtml(t.caption) : '';
      const beforeId = t ? t.before_media_id : null;
      const imageId  = t ? t.image_media_id  : null;
      const videoId  = t ? t.video_media_id  : null;
      const beforeUrl = (t && t.before_url) || (fallbackUrls && fallbackUrls.before) || null;
      const imageUrl  = (t && t.image_url)  || (fallbackUrls && fallbackUrls.image)  || null;
      const videoUrl  = (t && t.video_url)  || (fallbackUrls && fallbackUrls.video)  || null;
      const deleteBtn = isExisting
        ? `<form method="POST" action="/admin/triplets/${t.id}/delete" class="inline" style="display:inline-block;margin-left:6px;" onsubmit="return confirm('Delete triplet ${number}?');"><input type="hidden" name="return_to" value="/admin/concepts"><button type="submit" class="btn small" style="background:#fff;border-color:#c33;color:#c33;font-size:10px;padding:3px 7px;">Delete</button></form>`
        : '';
      // Use a stable colour per triplet number so two triplets read as visually distinct sets.
      const palette = ['#3A6B20','#1C2A14','#a85c14','#7e1c66','#1c4e7e','#7a1c14'];
      const accent = palette[((number || 0) - 1) % palette.length] || '#3A6B20';
      // Save form and Delete form are siblings inside a wrapper div — NEVER nest forms
      // (browser merges hidden inputs and breaks return_to on submit).
      return `<div style="background:#fff;border:1px solid #e6e2d8;border-left:5px solid ${accent};border-radius:8px;padding:10px 12px;margin-bottom:8px;">
        <form method="POST" action="/admin/triplets/save">
          ${idField}
          <input type="hidden" name="concept_id" value="${conceptId}">
          <input type="hidden" name="return_to" value="/admin/concepts">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap;">
            <div style="background:${accent};color:#fff;font-weight:800;font-size:14px;padding:5px 12px;border-radius:14px;letter-spacing:0.04em;">Triplet #${number || 'NEW'}</div>
            <label style="font-size:11px;color:#666;display:flex;align-items:center;gap:4px;">Num <input type="number" name="triplet_number" value="${number}" placeholder="num" style="width:55px;padding:3px 5px;font-size:11px;" title="Triplet number (unique per concept)"></label>
            <label style="font-size:11px;color:#666;display:flex;align-items:center;gap:4px;">Order <input type="number" name="sort_order" value="${sortOrder}" style="width:55px;padding:3px 5px;font-size:11px;" title="Display order in the carousel"></label>
            <label style="display:flex;align-items:center;gap:4px;font-size:12px;font-weight:700;color:${accent};cursor:pointer;"><input type="checkbox" name="in_rolling_demo"${inRolling ? ' checked' : ''}> Rolling demo</label>
            <input type="text" name="caption" value="${captionVal}" placeholder="caption (optional)" style="flex:1;min-width:120px;padding:4px 8px;font-size:12px;">
            <button type="submit" class="btn small" style="padding:4px 12px;font-size:12px;">Save</button>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${tripletSlot('before_media_id', beforeId, beforeUrl, imageItems, 'Before')}
            ${tripletSlot('image_media_id',  imageId,  imageUrl,  imageItems, 'Picture')}
            ${tripletSlot('video_media_id',  videoId,  videoUrl,  videoItems, 'Video')}
          </div>
        </form>
        ${deleteBtn ? `<div style="text-align:right;margin-top:6px;">${deleteBtn}</div>` : ''}
      </div>`;
    };
    // Empty form for adding a new triplet.
    const newTripletForm = (conceptId, suggestedNumber) => tripletRow(conceptId, {
      id: null,
      triplet_number: suggestedNumber,
      sort_order: 0,
      in_rolling_demo: true,
      before_media_id: null, image_media_id: null, video_media_id: null,
      before_url: null, image_url: null, video_url: null,
      caption: null,
    });

    const tableRows = rows.map((c) => {
      const before = c.before_image_url
        ? `<img class="thumb" src="${escapeHtml(c.before_image_url)}" alt="before">` : '<span class="muted">—</span>';
      const after = c.after_image_url
        ? `<img class="thumb" src="${escapeHtml(c.after_image_url)}" alt="after">` : '<span class="muted">—</span>';
      const video = c.example_video_url
        ? `<video class="thumb" src="${escapeHtml(c.example_video_url)}" muted preload="metadata" style="object-fit:cover;background:#1A0C04;"></video>` : '<span class="muted">—</span>';
      const mainRow = `<tr>
        <td>${c.sort_order}</td>
        <td>${before}</td>
        <td>${after}</td>
        <td>${video}</td>
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
      // The inline sub-grid sits under each concept row and lists its triplets.
      // If the concept has no triplet rows but has legacy single-slot URLs set,
      // show a single synthetic triplet #1 as a starting point.
      const existingTriplets = tripletsByConcept.get(c.id) || [];
      const hasFallback = !existingTriplets.length && (c.before_image_url || c.after_image_url || c.example_video_url);
      const tripletRows = existingTriplets.length
        ? existingTriplets.map((t) => tripletRow(c.id, t, null)).join('')
        : (hasFallback
            ? `<div style="font-size:11px;color:#888;margin-bottom:6px;">No triplets yet — the legacy single Before/After URLs on this concept will be used as triplet #1 until you save one.</div>`
            : '');
      const nextNumber = existingTriplets.length
        ? Math.max(...existingTriplets.map((t) => t.triplet_number || 0)) + 1
        : 1;
      const subRow = `<tr class="slot-subrow"><td colspan="9" style="background:#fafaf6;padding:8px 14px 14px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.04em;">Triplets for "${escapeHtml(c.name)}" — each ticked "Rolling demo" rotates in the widget carousel.</div>
          <a href="/admin/triplets?concept=${c.id}" class="muted" style="font-size:11px;">Manage all triplets &rarr;</a>
        </div>
        ${tripletRows}
        <details style="margin-top:6px;">
          <summary style="cursor:pointer;font-size:12px;color:#3A6B20;font-weight:600;">+ New triplet #${nextNumber}</summary>
          <div style="margin-top:8px;">${newTripletForm(c.id, nextNumber)}</div>
        </details>
      </td></tr>`;
      return mainRow + subRow;
    }).join('');

    const body = `
      <div class="top">
        <h1>Concepts</h1>
        <a class="btn" href="/admin/concepts/new">+ Add new concept</a>
      </div>
      ${flash}
      <style>
        .slot-subrow td{border-top:none !important;}
        .ts-drop-slot.dragover{border-color:#3A6B20 !important;background:rgba(58,107,32,0.08);}
        .ts-drop-slot select.dropped{background:#FFF3C4 !important;font-weight:600;}
      </style>
      <p class="muted" style="font-size:12px;margin:8px 0 14px;">💡 Open <a href="/admin/gallery" target="_blank">the gallery in a second window</a> and drag thumbnails onto any slot below. Hit Save on the triplet after the drop to persist.</p>
      <table>
        <thead><tr>
          <th>Sort</th><th>Before</th><th>After</th><th>Video</th><th>Name</th><th>Category</th>
          <th>Input</th><th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody>${tableRows || '<tr><td colspan="9" class="muted">No concepts yet.</td></tr>'}</tbody>
      </table>
      ${TS_DROP_HANDLER_JS}`;
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

  // Image and video models, embedded so the client-side renderer can build
  // the dynamic field UI without an extra round-trip.
  const imageModelsJson = JSON.stringify(generation.listModels('image').reduce((acc, m) => {
    acc[m.id] = { ...generation.getModel(m.id), label: m.label };
    return acc;
  }, {}));
  const videoModelsJson = JSON.stringify(generation.listModels('video').reduce((acc, m) => {
    acc[m.id] = { ...generation.getModel(m.id), label: m.label };
    return acc;
  }, {}));
  const imageExtrasJson = JSON.stringify(c.image_input_extras || {});
  const videoExtrasJson = JSON.stringify(c.video_input_extras || {});

  const modelOption = (id, model, selected) =>
    `<option value="${escapeHtml(id)}"${id === selected ? ' selected' : ''}>${escapeHtml(model.label)}</option>`;
  const imageOptions = generation.listModels('image').map((m) => modelOption(m.id, generation.getModel(m.id), falImage)).join('');
  // Pre-serialize pricing_rules JSONB for the textarea.
  if (c && c.pricing_rules != null && typeof c.pricing_rules === 'object') {
    c.pricing_rules_json = Object.keys(c.pricing_rules).length === 0 ? '' : JSON.stringify(c.pricing_rules, null, 2);
  } else {
    c.pricing_rules_json = '';
  }
  const videoOptions = generation.listModels('video').map((m) => modelOption(m.id, generation.getModel(m.id), falVideo)).join('');

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
        <div class="field"><label>Filter category *</label><input type="text" name="filter_category" value="${v('filter_category')}" required>
          <span class="muted">Comma-separated, e.g. <code>royal, pets</code>. Each value becomes a separate filter chip on the landing gallery.</span></div>
        <div class="field"><label>Input type</label><select name="input_type" id="inputTypeSelect" onchange="applyInputType(this.value)">${inputTypeOptions}</select>
          <span class="muted">Controls which tabs are visible: image_video = both, image = only Image tab, video = only Video tab.</span></div>
        <div class="field"><label>Sort order</label><input type="number" name="sort_order" value="${c.sort_order == null ? 0 : escapeHtml(c.sort_order)}"></div>
      </div>
      <div class="field"><label>Description</label><textarea name="description" rows="3" placeholder="One short paragraph shown above the gallery tiles on the landing page.">${v('description')}</textarea></div>

      <style>
        .ts-tabs{display:flex;gap:4px;border-bottom:2px solid #eee;margin:18px 0 0;}
        .ts-tab-btn{background:none;border:none;padding:10px 18px;font-size:15px;font-weight:600;cursor:pointer;color:#888;border-bottom:2px solid transparent;margin-bottom:-2px;}
        .ts-tab-btn.active{color:#3A6B20;border-bottom-color:#3A6B20;}
        .ts-tab{display:none;padding-top:18px;}
        .ts-tab.active{display:block;}
        .ts-test{margin-top:24px;padding-top:18px;border-top:1px solid #eee;}
      </style>

      <div class="ts-tabs">
        <button type="button" class="ts-tab-btn active" id="tabBtnImage" onclick="showTab('image')">1. Image</button>
        <button type="button" class="ts-tab-btn" id="tabBtnVideo" onclick="showTab('video')">2. Video</button>
      </div>

      <div class="ts-tab active" id="tabImage">
        <div class="field">
          <label>Image model</label>
          <select name="fal_image_model" id="imageModelSelect" onchange="renderModelFields('image')">${imageOptions}</select>
          <p class="muted" id="imageModelDesc" style="margin:6px 0 0;"></p>
        </div>
        <div class="field"><label>Image prompt *</label><textarea name="image_prompt" required>${v('image_prompt')}</textarea>
          <span class="muted">Reference the customer photo as @Image1. Use {variable_name} for customer-supplied text.</span></div>
        <div id="imageFields"></div>

        <div class="ts-test">
          <h2 style="font-size:18px;margin:0 0 6px;">Test image</h2>
          <p class="muted" style="margin:0 0 14px;">Generates with the current (unsaved) values. Admin pays the fal.ai cost (≈ ${TEST_COST_IMAGE}).</p>
          <div class="field"><label>Test photo</label><input type="file" id="testPhoto" accept="image/*"></div>
          <div class="field" id="testInputWrap" style="display:none;"><label id="testInputLabel">Customer text</label><input type="text" id="testUserInput"></div>
          <button type="button" class="btn secondary" id="btnTestImage" onclick="runTestImage()">Test image</button>
          <div id="testImageStatus" class="muted" style="margin-top:12px;"></div>
          <div id="testImageResult" style="margin-top:14px;"></div>
        </div>
      </div>

      <div class="ts-tab" id="tabVideo">
        <div class="field">
          <label>Video model</label>
          <select name="fal_video_model" id="videoModelSelect" onchange="renderModelFields('video')">${videoOptions}</select>
          <p class="muted" id="videoModelDesc" style="margin:6px 0 0;"></p>
        </div>
        <div class="field"><label>Video prompt</label><textarea name="video_prompt">${v('video_prompt')}</textarea>
          <span class="muted">Empty = no video produced. Reference the generated portrait as @Image1.</span></div>
        <div id="videoFields"></div>

        <div class="ts-test">
          <h2 style="font-size:18px;margin:0 0 6px;">Test video</h2>
          <p class="muted" style="margin:0 0 14px;">Admin pays the fal.ai cost (≈ ${TEST_COST_VIDEO}).</p>
          <div id="videoTestHint" class="muted" style="margin-bottom:10px;">Pick a starting picture below, then click Test video.</div>

          <!-- Starting-picture chooser: use the just-generated test image, upload a different one, or pick from the gallery library. -->
          <div class="field" style="background:#FFF9E6;border-radius:8px;padding:12px 14px;margin-bottom:12px;">
            <label style="margin-bottom:8px;">Starting picture for video</label>
            <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:8px;">
              <label style="font-weight:normal;font-size:13px;display:flex;align-items:center;gap:5px;cursor:pointer;"><input type="radio" name="videoStart" value="generated" checked> Use generated test image</label>
              <label style="font-weight:normal;font-size:13px;display:flex;align-items:center;gap:5px;cursor:pointer;"><input type="radio" name="videoStart" value="upload"> Upload different image</label>
              <label style="font-weight:normal;font-size:13px;display:flex;align-items:center;gap:5px;cursor:pointer;"><input type="radio" name="videoStart" value="gallery"> Pick from gallery</label>
            </div>
            <div id="videoStartUploadWrap" style="display:none;">
              <input type="file" id="videoStartUpload" accept="image/*">
              <span id="videoStartUploadStatus" class="muted" style="margin-left:8px;"></span>
            </div>
            <div id="videoStartGalleryWrap" style="display:none;">
              <select id="videoStartGallery" style="width:100%;"></select>
            </div>
            <div id="videoStartPreview" style="margin-top:10px;"></div>
          </div>

          <button type="button" class="btn secondary" id="btnTestVideo" onclick="runTestVideo()" disabled>Test video</button>
          <div id="testVideoStatus" class="muted" style="margin-top:12px;"></div>
          <div id="testVideoResult" style="margin-top:14px;"></div>
        </div>
      </div>

      <div class="field" style="border-top:1px solid #eee;padding-top:16px;margin-top:24px;"><label>Social caption</label><textarea name="social_caption">${v('social_caption')}</textarea></div>
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

      <div style="margin:24px 0 8px;padding:18px;background:#FFF9E6;border-radius:10px;border:1px solid rgba(0,0,0,0.08);">
        <h2 style="font-size:18px;margin:0 0 6px;">Pricing</h2>
        <p class="muted" style="margin:0 0 14px;">Per-concept pricing. Tier picks a baseline; SEK override forces a specific SEK price; rules JSONB handles quantity breaks, modifiers, recipient fees. Leave all blank to inherit the default tier for this concept's input_type.</p>
        <div class="row">
          <div class="field">
            <label>Price tier</label>
            <select name="price_tier">
              <option value=""${v('price_tier') ? '' : ' selected'}>(use default for input_type)</option>
              <option value="image"${v('price_tier') === 'image' ? ' selected' : ''}>image — 99 kr</option>
              <option value="video"${v('price_tier') === 'video' ? ' selected' : ''}>video — 149 kr</option>
              <option value="talking"${v('price_tier') === 'talking' ? ' selected' : ''}>talking — 149 kr</option>
              <option value="bundle"${v('price_tier') === 'bundle' ? ' selected' : ''}>bundle — 199 kr</option>
              <option value="premium"${v('price_tier') === 'premium' ? ' selected' : ''}>premium — 399 kr (Family Portrait)</option>
              <option value="premium_video"${v('price_tier') === 'premium_video' ? ' selected' : ''}>premium_video — 899 kr (Talking ancestor)</option>
            </select>
            <span class="muted">Overrides the input_type default. NULL = derived from input_type at runtime.</span>
          </div>
          <div class="field">
            <label>SEK override (minor units / öre)</label>
            <input type="number" name="unit_price_sek_minor" value="${c.unit_price_sek_minor == null ? '' : escapeHtml(c.unit_price_sek_minor)}" placeholder="e.g. 12900 = 129 kr">
            <span class="muted">Optional. Bypasses the tier entirely. 12900 öre = 129 kr. Leave blank to use tier.</span>
          </div>
        </div>
        <div class="field">
          <label>Pricing rules (JSON, advanced)</label>
          <textarea name="pricing_rules" rows="4" placeholder='{"min_quantity":1,"quantity_breaks":[{"min":1,"unit_price_sek_minor":9900},{"min":5,"unit_price_sek_minor":8900}],"per_recipient_fee_sek_minor":1000,"modifiers":{"resolution_4K":{"type":"flat","add_sek_minor":5000}}}'>${v('pricing_rules_json')}</textarea>
          <span class="muted">JSONB. Powers quantity breaks, per-recipient fees, modifiers (4K, A3, rush). Schema: {min_quantity, max_quantity, quantity_breaks[], per_recipient_fee_sek_minor, modifiers{}}. Leave empty for simple unit pricing.</span>
        </div>
        <p class="muted" style="margin:10px 0 0;">Preview the resolved price: <a href="/admin/api/pricing/preview?concept_id=${c.id || ''}&currency=sek" target="_blank">SEK</a> · <a href="/admin/api/pricing/preview?concept_id=${c.id || ''}&currency=usd" target="_blank">USD</a> · <a href="/admin/api/pricing/preview?concept_id=${c.id || ''}&currency=eur" target="_blank">EUR</a> · <a href="/admin/api/pricing/preview?concept_id=${c.id || ''}&currency=gbp" target="_blank">GBP</a> (after save).</p>
      </div>

      <div class="field"><label><input type="checkbox" name="active" value="on"${activeChecked}> Active</label></div>
      <button class="btn" type="submit">${isEdit ? 'Save changes' : 'Create concept'}</button>
    </form>
    ${isEdit ? `<p class="muted" style="margin-top:18px;">Gallery items for this concept are managed under <a href="/admin/gallery?concept=${c.id}">Gallery</a>.</p>` : ''}

    <script>
      var MODELS_IMAGE = ${imageModelsJson};
      var MODELS_VIDEO = ${videoModelsJson};
      var SAVED_IMAGE_EXTRAS = ${imageExtrasJson};
      var SAVED_VIDEO_EXTRAS = ${videoExtrasJson};

      function escJs(s){ var d=document.createElement('div'); d.textContent = (s==null?'':s); return d.innerHTML; }
      function escAttr(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

      // Render one field as HTML for the dynamic area.
      function fieldHtml(field, kind, saved) {
        var name = kind + '_extra__' + field.name;
        var val = (saved !== undefined && saved !== null) ? saved : (field.default !== undefined ? field.default : '');
        var label = '<label>' + escJs(field.label) + (field.required ? ' *' : '') + '</label>';
        var help  = field.help ? '<span class="muted">' + escJs(field.help) + '</span>' : '';
        var w = '';
        switch (field.type) {
          case 'text':
            w = '<input type="text" name="' + name + '" value="' + escAttr(val) + '">';
            break;
          case 'textarea':
            w = '<textarea name="' + name + '">' + escAttr(val) + '</textarea>';
            break;
          case 'number':
            w = '<input type="number" step="1" name="' + name + '" value="' + escAttr(val) + '">';
            break;
          case 'float':
            w = '<input type="number" step="0.01" name="' + name + '" value="' + escAttr(val) + '">';
            break;
          case 'boolean':
            w = '<label style="font-weight:normal;display:flex;align-items:center;gap:8px;">' +
                '<input type="checkbox" name="' + name + '" value="on"' + (val ? ' checked' : '') + '> ' +
                'Enabled</label>';
            break;
          case 'enum':
            var opts = (field.options || []).map(function(o){
              return '<option value="' + escAttr(o) + '"' + (String(o) === String(val) ? ' selected' : '') + '>' + escJs(o) + '</option>';
            }).join('');
            w = '<select name="' + name + '">' + opts + '</select>';
            break;
          case 'image_url':
          case 'video_url':
            w = '<input type="url" placeholder="https://..." name="' + name + '" value="' + escAttr(val) + '">';
            break;
          case 'image_urls':
            var joined = Array.isArray(val) ? val.join('\\n') : (typeof val === 'string' ? val : '');
            w = '<textarea placeholder="One URL per line — customer photo is added automatically as the first" name="' + name + '">' + escAttr(joined) + '</textarea>';
            break;
          case 'elements_v3':
            var elJson = (Array.isArray(val) ? JSON.stringify(val, null, 2) : '');
            w = '<textarea placeholder=\\'[{"frontal_image_url": "https://...", "reference_image_urls": ["https://..."]}, {"video_url": "https://..."}]\\' name="' + name + '">' + escAttr(elJson) + '</textarea>';
            break;
          case 'multi_prompt':
            var mpJson = (Array.isArray(val) ? JSON.stringify(val, null, 2) : '');
            w = '<textarea placeholder=\\'[{"prompt": "Shot 1...", "duration": "5"}, {"prompt": "Shot 2...", "duration": "5"}]\\' name="' + name + '">' + escAttr(mpJson) + '</textarea>';
            break;
          default:
            w = '<input type="text" name="' + name + '" value="' + escAttr(val) + '">';
        }
        return '<div class="field">' + label + w + help + '</div>';
      }

      function renderModelFields(kind) {
        var sel = document.getElementById(kind + 'ModelSelect');
        var container = document.getElementById(kind + 'Fields');
        var desc = document.getElementById(kind + 'ModelDesc');
        var registry = kind === 'image' ? MODELS_IMAGE : MODELS_VIDEO;
        var saved = kind === 'image' ? SAVED_IMAGE_EXTRAS : SAVED_VIDEO_EXTRAS;
        var model = registry[sel.value];
        if (!model) { container.innerHTML = ''; desc.textContent = ''; return; }
        desc.textContent = model.description || '';
        var html = '';
        for (var i = 0; i < model.fields.length; i++) {
          var f = model.fields[i];
          if (f.source === 'prompt') continue;       // handled by dedicated prompt textarea
          if (f.source === 'photo') {
            html += '<div class="field"><label>' + escJs(f.label) + ' (bound to customer photo at runtime)</label>' +
                    '<p class="muted" style="margin:4px 0 0;">' + escJs(f.help || '') + '</p></div>';
            continue;
          }
          html += fieldHtml(f, kind, saved[f.name]);
        }
        container.innerHTML = html;
      }

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

      // Build an extras object from the dynamic-field area, coercing each
      // field to the right type per its registry definition.
      function collectExtrasJs(kind) {
        var sel = document.getElementById(kind + 'ModelSelect');
        var registry = kind === 'image' ? MODELS_IMAGE : MODELS_VIDEO;
        var model = registry[sel.value];
        if (!model) return {};
        var out = {};
        for (var i = 0; i < model.fields.length; i++) {
          var f = model.fields[i];
          if (f.source) continue;
          var name = kind + '_extra__' + f.name;
          var el = document.querySelector('[name="' + name + '"]');
          if (!el) continue;
          if (f.type === 'boolean') { out[f.name] = el.checked; continue; }
          var raw = el.value;
          if (raw === '' || raw == null) continue;
          if (f.type === 'number') { var n = parseInt(raw, 10); if (!isNaN(n)) out[f.name] = n; continue; }
          if (f.type === 'float')  { var fl = parseFloat(raw); if (!isNaN(fl)) out[f.name] = fl; continue; }
          if (f.type === 'image_urls') {
            var t = raw.trim();
            if (t.charAt(0) === '[') { try { out[f.name] = JSON.parse(t); } catch(e){} }
            else { out[f.name] = t.split(/\\r?\\n/).map(function(s){return s.trim();}).filter(Boolean); }
            continue;
          }
          if (f.type === 'elements_v3' || f.type === 'multi_prompt') {
            try { var p = JSON.parse(raw); if (Array.isArray(p) && p.length) out[f.name] = p; } catch(e){}
            continue;
          }
          out[f.name] = raw;
        }
        return out;
      }

      function formVals(){
        var q = function(n){ var el=document.querySelector('[name='+n+']'); return el ? el.value : ''; };
        return {
          slug: q('slug'),
          image_prompt: q('image_prompt'),
          video_prompt: q('video_prompt'),
          fal_image_model: q('fal_image_model'),
          fal_video_model: q('fal_video_model'),
          image_input_extras: collectExtrasJs('image'),
          video_input_extras: collectExtrasJs('video'),
          user_input_variable: q('user_input_variable'),
          user_input_max_length: q('user_input_max_length'),
          user_input_enabled: document.getElementById('uiEnabled').checked
        };
      }
      function showTab(name) {
        var tabs = ['image','video'];
        for (var i = 0; i < tabs.length; i++) {
          var t = tabs[i];
          document.getElementById('tab' + t.charAt(0).toUpperCase() + t.slice(1)).classList.toggle('active', t === name);
          document.getElementById('tabBtn' + t.charAt(0).toUpperCase() + t.slice(1)).classList.toggle('active', t === name);
        }
      }
      // Reflect the input_type setting in the tab visibility.
      // image_video = both tabs; image = only Image; video = only Video.
      function applyInputType(val) {
        var showImage = (val === 'image_video' || val === 'image');
        var showVideo = (val === 'image_video' || val === 'video');
        document.getElementById('tabBtnImage').style.display = showImage ? '' : 'none';
        document.getElementById('tabBtnVideo').style.display = showVideo ? '' : 'none';
        if (!showImage) document.getElementById('tabImage').classList.remove('active');
        if (!showVideo) document.getElementById('tabVideo').classList.remove('active');
        var imageActive = document.getElementById('tabImage').classList.contains('active');
        var videoActive = document.getElementById('tabVideo').classList.contains('active');
        if (!imageActive && !videoActive) {
          showTab(showImage ? 'image' : 'video');
        }
        // Don't keep the required attribute on inputs inside a hidden tab —
        // the browser can't focus a hidden field on validation failure, so the
        // Create button silently does nothing.
        var imgPrompt = document.querySelector('[name=image_prompt]');
        if (imgPrompt) { if (showImage) imgPrompt.setAttribute('required',''); else imgPrompt.removeAttribute('required'); }
      }
      function setStatus(kind, m){
        var el = document.getElementById('test' + (kind === 'image' ? 'Image' : 'Video') + 'Status');
        if (el) el.textContent = m || '';
      }
      // Idle labels — captured once so we can restore them after busy state.
      window.__btnLabels = window.__btnLabels || {
        image: (document.getElementById('btnTestImage') || {}).textContent || 'Test image',
        video: (document.getElementById('btnTestVideo') || {}).textContent || 'Test video',
      };
      function applyBusyButton(btn, busy, idleLabel){
        if (!btn) return;
        if (busy) {
          btn.dataset.idleLabel = btn.dataset.idleLabel || idleLabel || btn.textContent;
          btn.innerHTML = '<span class="ts-test-spinner" aria-hidden="true"></span> Generating…';
          btn.classList.add('is-busy');
        } else {
          btn.innerHTML = btn.dataset.idleLabel || idleLabel || 'Test';
          btn.classList.remove('is-busy');
        }
      }
      function setBusy(kind, busy){
        if (kind === 'image') {
          applyBusyButton(document.getElementById('btnTestImage'), busy, window.__btnLabels.image);
          document.getElementById('btnTestImage').disabled = busy;
          document.getElementById('testPhoto').disabled = busy;
          document.getElementById('btnTestVideo').disabled = busy || !window.__testImageUrl;
        } else {
          applyBusyButton(document.getElementById('btnTestVideo'), busy, window.__btnLabels.video);
          document.getElementById('btnTestVideo').disabled = busy;
        }
      }
      async function runTestImage(){
        var f = document.getElementById('testPhoto').files[0];
        if(!f){ setStatus('image', 'Choose a test photo first.'); return; }
        setBusy('image', true); setStatus('image', 'Uploading photo…');
        try {
          var fd = new FormData(); fd.append('image', f);
          var up = await fetch('/upload', { method:'POST', body: fd });
          var upj = await up.json();
          if(!up.ok) throw new Error(upj.error || 'Upload failed');
          setStatus('image', 'Generating image…');
          var v = formVals();
          var body = {
            image_url: upj.url,
            image_prompt: v.image_prompt,
            fal_image_model: v.fal_image_model,
            image_input_extras: v.image_input_extras,
            user_input_variable: v.user_input_enabled ? v.user_input_variable : '',
            user_input_value: document.getElementById('testUserInput').value,
            user_input_max_length: v.user_input_max_length,
            concept_slug: v.slug
          };
          var r = await fetch('/admin/concepts/test-image', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
          var j = await r.json();
          if(!r.ok) throw new Error(j.error || 'Image test failed');
          window.__testImageUrl = j.url;
          var inputDump = j.input_used ? '<div class="muted" style="margin-top:8px;">fal input used:</div><pre style="white-space:pre-wrap;background:#fff;padding:10px;border-radius:6px;border:1px solid #eee;font-size:11px;">'+escJs(JSON.stringify(j.input_used, null, 2))+'</pre>' : '';
          document.getElementById('testImageResult').innerHTML =
            '<img src="'+j.url+'" style="max-width:320px;border-radius:8px;display:block;margin-bottom:8px;">' +
            '<button type="button" class="btn small" onclick="saveTestToGallery(\\''+j.url+'\\', \\'image\\', this)">💾 Save to gallery</button>' +
            '<div class="muted" style="margin-top:8px;">Image prompt used:</div><pre style="white-space:pre-wrap;background:#fff;padding:10px;border-radius:6px;border:1px solid #eee;">'+escJs(j.prompt_used)+'</pre>' +
            inputDump;
          setStatus('image', '');
          // Refresh the starting-picture preview (which defaults to "generated").
          refreshVideoStartPreview();
          // Unlock the Test video button now that we have an image
          var hint = document.getElementById('videoTestHint');
          if (hint) hint.textContent = 'Image ready. Switch to the Video tab and click Test video.';
        } catch(e){ setStatus('image', 'Error: '+e.message); }
        setBusy('image', false);
      }
      async function runTestVideo(){
        var portrait = getVideoStartingUrl();
        if(!portrait){ setStatus('video', 'Pick or generate a starting picture first.'); return; }
        setBusy('video', true); setStatus('video', 'Generating video… this can take a minute.');
        try {
          var v = formVals();
          var body = {
            portrait_url: portrait,
            video_prompt: v.video_prompt,
            fal_video_model: v.fal_video_model,
            video_input_extras: v.video_input_extras,
            user_input_variable: v.user_input_enabled ? v.user_input_variable : '',
            user_input_value: document.getElementById('testUserInput').value,
            user_input_max_length: v.user_input_max_length,
            concept_slug: v.slug
          };
          var r = await fetch('/admin/concepts/test-video', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
          var j = await r.json();
          if(!r.ok) throw new Error(j.error || 'Video test failed');
          var inputDump2 = j.input_used ? '<div class="muted" style="margin-top:8px;">fal input used:</div><pre style="white-space:pre-wrap;background:#fff;padding:10px;border-radius:6px;border:1px solid #eee;font-size:11px;">'+escJs(JSON.stringify(j.input_used, null, 2))+'</pre>' : '';
          document.getElementById('testVideoResult').innerHTML =
            '<video src="'+j.url+'" controls style="max-width:320px;border-radius:8px;display:block;margin-top:12px;"></video>' +
            '<button type="button" class="btn small" style="margin-top:8px;" onclick="saveTestToGallery(\\''+j.url+'\\', \\'video\\', this)">💾 Save to gallery</button>' +
            '<div class="muted" style="margin-top:8px;">Video prompt used:</div><pre style="white-space:pre-wrap;background:#fff;padding:10px;border-radius:6px;border:1px solid #eee;">'+escJs(j.prompt_used)+'</pre>' +
            inputDump2;
          setStatus('video', '');
        } catch(e){ setStatus('video', 'Error: '+e.message); }
        setBusy('video', false);
      }
      ['user_input_label','user_input_placeholder','user_input_max_length'].forEach(function(n){
        var el=document.querySelector('[name='+n+']'); if(el) el.addEventListener('input', syncTestInput);
      });
      syncTestInput();

      // ---------------------------------------------------------------------
      // Save-to-gallery (called from result-panel buttons after a test runs)
      // ---------------------------------------------------------------------
      window.__conceptId = ${c && c.id ? c.id : 'null'};
      async function saveTestToGallery(url, kind, btn){
        if(!window.__conceptId){ alert('Cannot save: no concept id (save the concept first).'); return; }
        btn.disabled = true; btn.textContent = 'Saving…';
        try {
          var r = await fetch('/admin/concepts/save-to-gallery', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({concept_id: window.__conceptId, url: url, kind: kind})});
          var j = await r.json();
          if(!r.ok) throw new Error(j.error || 'Save failed');
          btn.textContent = j.deduplicated ? '✓ Already in gallery' : '✓ Saved to gallery';
          btn.style.background = '#3A6B20'; btn.style.color = '#fff';
          // Refresh the library picker in case the user wants to use this new item as a starting picture.
          loadVideoStartGallery();
        } catch(e){
          btn.disabled = false; btn.textContent = '💾 Save to gallery (retry)';
          alert('Error: '+e.message);
        }
      }

      // ---------------------------------------------------------------------
      // Video starting-picture chooser
      // ---------------------------------------------------------------------
      window.__videoStartUploadUrl = null;
      function getVideoStartingUrl(){
        var picked = (document.querySelector('input[name="videoStart"]:checked') || {}).value || 'generated';
        if (picked === 'generated') return window.__testImageUrl || null;
        if (picked === 'upload')    return window.__videoStartUploadUrl || null;
        if (picked === 'gallery') {
          var sel = document.getElementById('videoStartGallery');
          return (sel && sel.value) ? sel.value : null;
        }
        return null;
      }
      function refreshVideoStartPreview(){
        var url = getVideoStartingUrl();
        var prev = document.getElementById('videoStartPreview');
        if (!prev) return;
        prev.innerHTML = url
          ? '<img src="'+url+'" style="max-width:140px;border-radius:6px;border:1px solid #ddd;display:block;">'
          : '<span class="muted" style="font-size:12px;">No starting picture selected yet.</span>';
        var btn = document.getElementById('btnTestVideo');
        if (btn) btn.disabled = !url;
      }
      document.querySelectorAll('input[name="videoStart"]').forEach(function(r){
        r.addEventListener('change', function(){
          var picked = r.value;
          document.getElementById('videoStartUploadWrap').style.display  = picked === 'upload'  ? 'block' : 'none';
          document.getElementById('videoStartGalleryWrap').style.display = picked === 'gallery' ? 'block' : 'none';
          if (picked === 'gallery') loadVideoStartGallery();
          refreshVideoStartPreview();
        });
      });
      // Upload handler — when a file is chosen for the "upload different" option,
      // push it through /upload and remember the resulting URL.
      var vUp = document.getElementById('videoStartUpload');
      if (vUp) vUp.addEventListener('change', async function(){
        var f = vUp.files[0]; if(!f) return;
        var st = document.getElementById('videoStartUploadStatus');
        st.textContent = 'Uploading…';
        try {
          var fd = new FormData(); fd.append('image', f);
          var up = await fetch('/upload', { method:'POST', body: fd });
          var upj = await up.json();
          if(!up.ok) throw new Error(upj.error || 'Upload failed');
          window.__videoStartUploadUrl = upj.url;
          st.textContent = '✓ Ready';
          refreshVideoStartPreview();
        } catch(e){ st.textContent = 'Error: '+e.message; }
      });
      // Library picker — populate the gallery dropdown lazily on first open.
      var galleryLoaded = false;
      async function loadVideoStartGallery(){
        var sel = document.getElementById('videoStartGallery');
        if (!sel) return;
        if (galleryLoaded) return;
        sel.innerHTML = '<option>Loading…</option>';
        try {
          var r = await fetch('/admin/media/library?kind=image');
          var rows = await r.json();
          if (!Array.isArray(rows) || rows.length === 0) { sel.innerHTML = '<option value="">(no images in library yet)</option>'; galleryLoaded = true; return; }
          sel.innerHTML = '<option value="">— pick an image —</option>' + rows.map(function(m){
            var fname = (String(m.url).split('?')[0].split('/').pop() || '').slice(0, 60);
            return '<option value="'+m.url+'">'+(m.concept_name + ' · ' + fname).replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</option>';
          }).join('');
          galleryLoaded = true;
        } catch(e){
          sel.innerHTML = '<option value="">Failed to load library</option>';
        }
      }
      var vGal = document.getElementById('videoStartGallery');
      if (vGal) vGal.addEventListener('change', refreshVideoStartPreview);
      refreshVideoStartPreview();
      renderModelFields('image');
      renderModelFields('video');
      applyInputType(document.getElementById('inputTypeSelect').value);

      // Visible submit-validator. If HTML5 validation fails (required field
      // empty, pattern mismatch, etc.), find the first invalid field, switch
      // to its tab if needed, scroll to it, focus it, and surface a banner.
      (function(){
        var form = document.querySelector('form[action="/admin/concepts/save"]');
        if (!form) return;
        form.addEventListener('submit', function(e){
          if (form.checkValidity()) return; // valid → let it submit normally
          e.preventDefault();
          var bad = form.querySelector(':invalid');
          if (!bad) return;
          // Which tab is this field in? Walk up to find .ts-tab id.
          var tab = bad.closest('.ts-tab');
          if (tab && tab.id === 'tabVideo') showTab('video');
          else if (tab && tab.id === 'tabImage') showTab('image');
          // Banner so the user sees what's wrong instead of a silent fail.
          var label = bad.closest('.field') ? bad.closest('.field').querySelector('label') : null;
          var name = (label && label.textContent.trim()) || bad.name || 'a required field';
          var msg = bad.validationMessage || 'Required';
          var banner = document.getElementById('ts-form-err');
          if (!banner) {
            banner = document.createElement('div');
            banner.id = 'ts-form-err';
            banner.className = 'flash err';
            banner.style.cssText = 'position:sticky;top:10px;z-index:100;margin:10px 0;';
            form.parentNode.insertBefore(banner, form);
          }
          banner.textContent = 'Cannot create concept — ' + name + ': ' + msg;
          banner.scrollIntoView({behavior:'smooth', block:'start'});
          try { bad.focus({preventScroll:true}); } catch(e2){ try{bad.focus();}catch(e3){} }
          bad.style.outline = '2px solid #c33';
          setTimeout(function(){ bad.style.outline = ''; }, 3000);
        });
      })();
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

// Collects per-model input-extra fields from a posted form. Each non-source
// field of the chosen model is read at `<prefix>__<field.name>` and coerced
// to the right type before being merged into the JSONB column.
function collectInputExtras(body, prefix, modelId) {
  const model = generation.getModel(modelId);
  if (!model) return {};
  const out = {};
  for (const f of model.fields) {
    if (f.source) continue; // 'photo' and 'prompt' are bound at runtime, not stored as extras
    const key = `${prefix}__${f.name}`;
    const raw = body[key];

    if (f.type === 'boolean') {
      out[f.name] = raw === 'on' || raw === 'true' || raw === '1';
      continue;
    }
    if (raw === undefined || raw === null || raw === '') continue;

    if (f.type === 'number') {
      const n = parseInt(raw, 10);
      if (!Number.isNaN(n)) out[f.name] = n;
      continue;
    }
    if (f.type === 'float') {
      const n = parseFloat(raw);
      if (!Number.isNaN(n)) out[f.name] = n;
      continue;
    }
    if (f.type === 'image_urls') {
      const trimmed = String(raw).trim();
      if (trimmed.startsWith('[')) {
        try { const parsed = JSON.parse(trimmed); if (Array.isArray(parsed)) out[f.name] = parsed; } catch {}
      } else {
        const lines = trimmed.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        if (lines.length) out[f.name] = lines;
      }
      continue;
    }
    if (f.type === 'elements_v3' || f.type === 'multi_prompt') {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) out[f.name] = parsed;
      } catch {}
      continue;
    }
    out[f.name] = raw;
  }
  return out;
}

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
    const description = (req.body.description || '').trim() || null;
    let inputType = (req.body.input_type || 'image_video').trim();
    if (!CONCEPT_INPUT_TYPES.includes(inputType)) inputType = 'image_video';
    const falImage = (req.body.fal_image_model || '').trim() || 'fal-ai/kling-image/o1';
    const falVideo = (req.body.fal_video_model || '').trim() || 'fal-ai/kling-video/v3/pro/image-to-video';
    const imageInputExtras = collectInputExtras(req.body, 'image_extra', falImage);
    const videoInputExtras = collectInputExtras(req.body, 'video_extra', falVideo);
    const sortOrder = parseInt(req.body.sort_order, 10) || 0;
    const active = req.body.active === 'on' || req.body.active === 'true' || req.body.active === '1';

    // Pricing fields.
    const priceTier = (req.body.price_tier || '').trim() || null;
    const validTiers = new Set(['image','video','talking','bundle','premium','premium_video']);
    if (priceTier && !validTiers.has(priceTier)) {
      return fail('Invalid price_tier.');
    }
    let unitPriceSekMinor = null;
    if (req.body.unit_price_sek_minor != null && String(req.body.unit_price_sek_minor).trim() !== '') {
      const n = parseInt(req.body.unit_price_sek_minor, 10);
      if (!Number.isInteger(n) || n < 0) return fail('SEK price override must be a non-negative integer (minor units / öre).');
      unitPriceSekMinor = n;
    }
    let pricingRules = {};
    const pricingRulesRaw = (req.body.pricing_rules || '').trim();
    if (pricingRulesRaw) {
      try { pricingRules = JSON.parse(pricingRulesRaw); }
      catch (e) { return fail('Pricing rules must be valid JSON: ' + e.message); }
      if (typeof pricingRules !== 'object' || Array.isArray(pricingRules)) return fail('Pricing rules must be a JSON object {...}.');
    }

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
      const opts = {
        kind: 'concept_media',
        contentType: f.mimetype,
        originalName: f.originalname,
        ...(resourceType ? { resource_type: resourceType } : {}),
      };
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
           user_input_variable = $18, user_input_max_length = $19,
           image_input_extras = $20, video_input_extras = $21, description = $22,
           price_tier = $23, unit_price_sek_minor = $24, pricing_rules = $25,
           updated_at = NOW()
         WHERE id = $26`,
        [slug, name, filterCategory, inputType, beforeUrl, afterUrl, videoUrl,
         imagePrompt, videoPrompt, falImage, falVideo, socialCaption, active, sortOrder,
         userInputEnabled, userInputLabel, userInputPlaceholder, userInputVariable, userInputMaxLength,
         imageInputExtras, videoInputExtras, description,
         priceTier, unitPriceSekMinor, pricingRules,
         editId]
      );
    } else {
      await pool.query(
        `INSERT INTO concepts
           (slug, name, filter_category, input_type, before_image_url, after_image_url, example_video_url,
            image_prompt, video_prompt, fal_image_model, fal_video_model, social_caption, active, sort_order,
            user_input_enabled, user_input_label, user_input_placeholder, user_input_variable, user_input_max_length,
            image_input_extras, video_input_extras, description,
            price_tier, unit_price_sek_minor, pricing_rules)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
        [slug, name, filterCategory, inputType, beforeUrl, afterUrl, videoUrl,
         imagePrompt, videoPrompt, falImage, falVideo, socialCaption, active, sortOrder,
         userInputEnabled, userInputLabel, userInputPlaceholder, userInputVariable, userInputMaxLength,
         imageInputExtras, videoInputExtras, description,
         priceTier, unitPriceSekMinor, pricingRules]
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

// ----- Concept media (gallery items) CRUD -----

const CONCEPT_MEDIA_KINDS = ['image', 'video', 'card', 'book'];

// Upload a new media item for a concept. Accepts either a file under field
// "media" (uploaded to Cloudinary) or a direct url_override string.
app.post('/admin/concepts/:id/media', requireRole('admin'), upload.single('media'), async (req, res) => {
  const conceptId = parseInt(req.params.id, 10);
  const back = `/admin/concepts/edit/${conceptId}`;
  try {
    const kind = (req.body.kind || '').trim();
    if (!CONCEPT_MEDIA_KINDS.includes(kind)) {
      return res.redirect(`${back}?error=` + encodeURIComponent('Invalid media kind'));
    }
    const caption = (req.body.caption || '').trim() || null;
    const filterCategory = (req.body.filter_category || '').trim() || null;
    const isPrimary = req.body.is_primary === 'on' || req.body.is_primary === 'true';
    const urlOverride = (req.body.url_override || '').trim();

    let url = urlOverride;
    if (req.file && req.file.buffer) {
      const resourceType = kind === 'video' ? 'video' : 'image';
      const result = await uploadStream(req.file.buffer, {
        kind: 'gallery',
        contentType: req.file.mimetype,
        originalName: req.file.originalname,
        resource_type: resourceType,
      });
      url = result.secure_url;
    }
    if (!url) return res.redirect(`${back}?error=` + encodeURIComponent('Provide a file or a URL'));

    const maxRes = await pool.query(
      `SELECT COALESCE(MAX(sort_order), 0) AS m FROM concept_media WHERE concept_id = $1`,
      [conceptId]
    );
    const sortOrder = (maxRes.rows[0].m || 0) + 1;

    if (isPrimary) {
      await pool.query(`UPDATE concept_media SET is_primary = FALSE WHERE concept_id = $1`, [conceptId]);
    }

    await pool.query(
      `INSERT INTO concept_media (concept_id, kind, url, caption, sort_order, is_primary, filter_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [conceptId, kind, url, caption, sortOrder, isPrimary, filterCategory]
    );
    res.redirect(`${back}?saved_media=1`);
  } catch (err) {
    console.error('[concept-media] add error:', err.message);
    res.redirect(`${back}?error=` + encodeURIComponent('Add media failed: ' + err.message));
  }
});

// Set one of a concept's three widget slots (Before / After-Picture / After-Video)
// by referencing an existing gallery item. media_id="" or "0" clears the slot.
const SLOT_TO_COLUMN = { before: 'before_image_url', image: 'after_image_url', video: 'example_video_url' };
app.post('/admin/concepts/:id/slot', requireRole('admin'), async (req, res) => {
  const conceptId = parseInt(req.params.id, 10);
  const slot = String(req.body.slot || '').trim();
  const column = SLOT_TO_COLUMN[slot];
  if (!conceptId || !column) {
    if (wantsJson(req)) return res.status(400).json({ error: 'Bad slot or concept id' });
    return res.redirect((req.body.return_to || '/admin/concepts') + '?error=' + encodeURIComponent('Bad slot'));
  }
  const mediaIdRaw = req.body.media_id;
  const mediaId = mediaIdRaw && String(mediaIdRaw).trim() && parseInt(mediaIdRaw, 10) ? parseInt(mediaIdRaw, 10) : null;
  let url = null;
  try {
    if (mediaId) {
      const r = await pool.query('SELECT url FROM concept_media WHERE id = $1', [mediaId]);
      if (!r.rows.length) {
        if (wantsJson(req)) return res.status(404).json({ error: 'Media not found' });
        return res.redirect((req.body.return_to || '/admin/concepts') + '?error=' + encodeURIComponent('Media not found'));
      }
      url = r.rows[0].url;
    }
    await pool.query(`UPDATE concepts SET ${column} = $1 WHERE id = $2`, [url, conceptId]);
  } catch (err) {
    console.error('[concept-slot] update error:', err.message);
    if (wantsJson(req)) return res.status(500).json({ error: 'Update failed', details: err.message });
    return res.redirect((req.body.return_to || '/admin/concepts') + '?error=' + encodeURIComponent('Update failed'));
  }
  if (wantsJson(req)) return res.json({ ok: true, url });
  res.redirect(req.body.return_to || '/admin/concepts?saved=1');
});
function wantsJson(req) { return req.headers.accept === 'application/json' || req.xhr; }

// Save a test-image or test-video output to the gallery library so it can be
// reused as a slot, browsed, or shown to customers. Body: { concept_id, url, kind }.
app.post('/admin/concepts/save-to-gallery', requireRole('admin'), async (req, res) => {
  try {
    const conceptId = parseInt(req.body.concept_id, 10);
    const url = String(req.body.url || '').trim();
    const kind = String(req.body.kind || '').trim();
    if (!conceptId) return res.status(400).json({ error: 'concept_id required' });
    if (!url) return res.status(400).json({ error: 'url required' });
    if (!CONCEPT_MEDIA_KINDS.includes(kind)) return res.status(400).json({ error: 'Invalid kind' });

    // Avoid creating a duplicate row if this exact URL is already in the concept's gallery.
    const dup = await pool.query(
      `SELECT id FROM concept_media WHERE concept_id = $1 AND url = $2 LIMIT 1`,
      [conceptId, url]
    );
    if (dup.rows.length) return res.json({ ok: true, id: dup.rows[0].id, deduplicated: true });

    const maxRes = await pool.query(
      `SELECT COALESCE(MAX(sort_order), 0) AS m FROM concept_media WHERE concept_id = $1`,
      [conceptId]
    );
    const sortOrder = (maxRes.rows[0].m || 0) + 1;
    const ins = await pool.query(
      `INSERT INTO concept_media (concept_id, kind, url, sort_order, active)
       VALUES ($1, $2, $3, $4, TRUE) RETURNING id`,
      [conceptId, kind, url, sortOrder]
    );
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (err) {
    console.error('[save-to-gallery] error:', err.message);
    res.status(500).json({ error: 'Save failed', details: err.message });
  }
});

// Lists all active image-kind media items, used by the "Pick from gallery"
// dropdown when starting a test video from an existing library image.
app.get('/admin/media/library', requireRole('admin'), async (req, res) => {
  try {
    const kind = req.query.kind && CONCEPT_MEDIA_KINDS.includes(req.query.kind) ? req.query.kind : 'image';
    const { rows } = await pool.query(
      `SELECT cm.id, cm.url, cm.kind, c.id AS concept_id, c.name AS concept_name
       FROM concept_media cm
       JOIN concepts c ON c.id = cm.concept_id
       WHERE cm.active = TRUE AND cm.kind = $1
       ORDER BY c.name ASC, cm.sort_order ASC, cm.created_at DESC`,
      [kind]
    );
    res.json(rows);
  } catch (err) {
    console.error('[media-library] error:', err.message);
    res.status(500).json({ error: 'Failed' });
  }
});

// ---------------------------------------------------------------------------
// /admin/gallery — dense triplet-card grid (new default view).
// Grouped by concept. Each card shows the three thumbnails, concept · #N badge,
// caption, and quick toggles for Active / Rolling demo / In bottom gallery.
// Unassigned media items (no triplet yet) appear below in a smaller grid.
// ---------------------------------------------------------------------------
app.get('/admin/gallery', requireRole('admin'), async (req, res) => {
  try {
    const filterConcept = req.query.concept ? parseInt(req.query.concept, 10) : null;
    const showInactive  = req.query.show_inactive === '1' || req.query.show_inactive === 'true';
    // 'triplet' = all 3 slots filled, 'duplex' = exactly 2, 'single' = exactly 1, '' = all.
    const filterKind = ['triplet','duplex','single'].includes(req.query.kind) ? req.query.kind : '';

    const concepts = (await pool.query(
      `SELECT id, name FROM concepts WHERE active = TRUE ORDER BY name ASC`
    )).rows;

    // Triplets with resolved media URLs.
    const whereTrip = filterConcept ? 'WHERE t.concept_id = $1' : '';
    const tripParams = filterConcept ? [filterConcept] : [];
    const { rows: tRows } = await pool.query(
      `SELECT t.id, t.concept_id, t.triplet_number, t.sort_order, t.active, t.in_rolling_demo, t.in_gallery, t.caption,
              t.before_media_id, t.image_media_id, t.video_media_id,
              c.name AS concept_name,
              bm.url AS before_url, im.url AS image_url, vm.url AS video_url,
              bm.id  AS bm_id,       im.id  AS im_id,       vm.id  AS vm_id
       FROM concept_triplets t
       JOIN concepts c ON c.id = t.concept_id
       LEFT JOIN concept_media bm ON bm.id = t.before_media_id
       LEFT JOIN concept_media im ON im.id = t.image_media_id
       LEFT JOIN concept_media vm ON vm.id = t.video_media_id
       ${whereTrip}
       ORDER BY c.name ASC, t.sort_order ASC, t.triplet_number ASC`,
      tripParams
    );
    const tripletsAfterActive = showInactive ? tRows : tRows.filter((t) => t.active);
    // Filter by slot-fill kind so the user can see only triplets, only duplexes, etc.
    const slotCount = (t) => (t.before_media_id ? 1 : 0) + (t.image_media_id ? 1 : 0) + (t.video_media_id ? 1 : 0);
    const triplets = filterKind
      ? tripletsAfterActive.filter((t) => {
          const n = slotCount(t);
          if (filterKind === 'triplet') return n === 3;
          if (filterKind === 'duplex')  return n === 2;
          if (filterKind === 'single')  return n === 1;
          return true;
        })
      : tripletsAfterActive;
    // Group by concept_id
    const tripsByConcept = new Map();
    for (const t of triplets) {
      if (!tripsByConcept.has(t.concept_id)) tripsByConcept.set(t.concept_id, []);
      tripsByConcept.get(t.concept_id).push(t);
    }

    // Media library — every active media item (or all if show_inactive), with the fields we
    // expose for editing right on the card. We also flag which triplet slots (if any) use the
    // item so the card can carry the green badges.
    const assignedIds = new Set();
    const mediaBadgesById = new Map(); // mediaId -> ["Royal Portrait #1 · Before", …]
    function addBadge(mediaId, label) {
      if (!mediaId) return;
      if (!mediaBadgesById.has(mediaId)) mediaBadgesById.set(mediaId, []);
      mediaBadgesById.get(mediaId).push(label);
    }
    for (const t of tRows) {
      const label = `${t.concept_name} #${t.triplet_number}`;
      if (t.before_media_id) { assignedIds.add(t.before_media_id); addBadge(t.before_media_id, `${label} · Before`); }
      if (t.image_media_id ) { assignedIds.add(t.image_media_id ); addBadge(t.image_media_id , `${label} · Picture`); }
      if (t.video_media_id ) { assignedIds.add(t.video_media_id ); addBadge(t.video_media_id , `${label} · Video`); }
    }
    const mediaWhere = [];
    const mediaParams = [];
    if (!showInactive) mediaWhere.push('cm.active = TRUE');
    if (filterConcept) { mediaParams.push(filterConcept); mediaWhere.push(`cm.concept_id = $${mediaParams.length}`); }
    const { rows: allMedia } = await pool.query(
      `SELECT cm.id, cm.kind, cm.url, cm.concept_id, cm.created_at, cm.sort_order, cm.is_primary,
              cm.active, cm.filter_category, cm.source_url, c.name AS concept_name
       FROM concept_media cm
       JOIN concepts c ON c.id = cm.concept_id
       ${mediaWhere.length ? 'WHERE ' + mediaWhere.join(' AND ') : ''}
       ORDER BY c.name ASC, cm.sort_order ASC, cm.created_at DESC`,
      mediaParams
    );
    const unassigned = allMedia.filter((m) => !assignedIds.has(m.id));

    const escUrl = (u) => escapeHtml(u || '');
    const fname = (u) => (u ? (String(u).split('?')[0].split('/').pop() || '').slice(0, 22) : '');
    const thumb = (m, label) => {
      if (!m || !m.url) return `<div class="g-thumb g-thumb--empty"><span>${label || '—'}</span></div>`;
      const drag = m.id ? ` draggable="true" data-mid="${m.id}" data-mkind="${m.kind}" data-murl="${escUrl(m.url)}"` : '';
      return m.kind === 'video'
        ? `<video class="g-thumb"${drag} src="${escUrl(m.url)}" muted preload="metadata" title="${escapeHtml(fname(m.url))}"></video>`
        : `<img class="g-thumb"${drag} src="${escUrl(m.url)}" alt="" title="${escapeHtml(fname(m.url))}">`;
    };

    const tripletCard = (t) => {
      const palette = ['#3A6B20','#1C2A14','#a85c14','#7e1c66','#1c4e7e','#7a1c14'];
      const accent = palette[((t.triplet_number || 0) - 1) % palette.length] || '#3A6B20';
      const beforeM = t.bm_id ? { id: t.bm_id, url: t.before_url, kind: 'image' } : null;
      const imageM  = t.im_id ? { id: t.im_id, url: t.image_url,  kind: 'image' } : null;
      const videoM  = t.vm_id ? { id: t.vm_id, url: t.video_url,  kind: 'video' } : null;
      return `<div class="t-card ${t.active ? '' : 't-card--off'}" data-trip-id="${t.id}" style="--accent:${accent};">
        <div class="t-card-head">
          <span class="t-badge">#${t.triplet_number}</span>
          <select class="t-concept-pick" data-trip-id="${t.id}" title="CONCEPT — move this triplet to a different concept. Note: the underlying media items in the slots stay attached to their original concept; this only re-files the triplet grouping.">
            ${concepts.map((co) => `<option value="${co.id}"${co.id === t.concept_id ? ' selected' : ''}>${escapeHtml(co.name)}</option>`).join('')}
          </select>
          <a class="t-edit" href="/admin/triplets?concept=${t.concept_id}#trip-${t.id}" title="Open this triplet in the full editor (change slot assignments, caption, sort order, number).">Edit</a>
        </div>
        <div class="t-thumbs">
          <div class="t-slot"><span class="t-slot-lbl">Before</span>${thumb(beforeM, 'B')}</div>
          <div class="t-slot"><span class="t-slot-lbl">Picture</span>${thumb(imageM, 'P')}</div>
          <div class="t-slot"><span class="t-slot-lbl">Video</span>${thumb(videoM, 'V')}</div>
        </div>
        ${t.caption ? `<div class="t-caption">${escapeHtml(t.caption)}</div>` : ''}
        <div class="t-toggles">
          <label class="t-toggle ${t.active ? 'on' : ''}" data-field="active" title="ACTIVE — master switch. When OFF, this triplet is hidden from the rolling demo AND from the public gallery, regardless of the other toggles."><input type="checkbox"${t.active ? ' checked' : ''}><span>Active</span></label>
          <label class="t-toggle ${t.in_rolling_demo ? 'on' : ''}" data-field="rolling" title="ROLLING — include this triplet in the home-page rolling demo (the cycling Before/After/Video carousel under the hero). Each visit to this concept's row in the carousel advances to the next rolling triplet."><input type="checkbox"${t.in_rolling_demo ? ' checked' : ''}><span>Rolling</span></label>
          <label class="t-toggle ${t.in_gallery ? 'on' : ''}" data-field="gallery" title="GALLERY — show this triplet on the public /gallery page. Independent of the rolling demo, so you can showcase a triplet on the gallery page without putting it in the home-page carousel."><input type="checkbox"${t.in_gallery ? ' checked' : ''}><span>Gallery</span></label>
          <form method="POST" action="/admin/triplets/${t.id}/delete" class="t-del" onsubmit="return confirm('Delete triplet #${t.triplet_number} for ${escapeHtml(t.concept_name).replace(/'/g, '&#39;').replace(/"/g, '&quot;')}?');">
            <input type="hidden" name="return_to" value="/admin/gallery${filterConcept ? '?concept='+filterConcept : ''}">
            <button type="submit" title="Delete this triplet record. The underlying media items in the library are NOT deleted — only this grouping.">×</button>
          </form>
        </div>
      </div>`;
    };

    // Render concept sections
    const sectionsHtml = concepts
      .filter((c) => !filterConcept || c.id === filterConcept)
      .filter((c) => (tripsByConcept.get(c.id) || []).length > 0)
      .map((c) => {
        const tList = tripsByConcept.get(c.id) || [];
        return `<section class="g-section">
          <header class="g-section-head">
            <h2>${escapeHtml(c.name)} <span class="g-count">${tList.length} triplet${tList.length === 1 ? '' : 's'}</span></h2>
            <a class="g-mini-link" href="/admin/triplets?concept=${c.id}">Manage →</a>
          </header>
          <div class="t-grid">
            ${tList.map(tripletCard).join('')}
          </div>
        </section>`;
      }).join('');

    // Media library section — every media item with editable fields.
    const KIND_OPTS = (current) => CONCEPT_MEDIA_KINDS.map((k) => `<option value="${k}"${k === current ? ' selected' : ''}>${k}</option>`).join('');
    const CONCEPT_SELECT_OPTS = (currentId) => concepts.map((c) =>
      `<option value="${c.id}"${c.id === currentId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`
    ).join('');
    const mediaCard = (m) => {
      const badges = (mediaBadgesById.get(m.id) || []).map((b) =>
        `<span class="m-badge">${escapeHtml(b)}</span>`).join('');
      const dragAttrs = `draggable="true" data-mid="${m.id}" data-mkind="${m.kind}" data-murl="${escUrl(m.url)}"`;
      const thumbEl = m.kind === 'video'
        ? `<video class="m-thumb" ${dragAttrs} src="${escUrl(m.url)}" muted preload="metadata"></video>`
        : `<img class="m-thumb" ${dragAttrs} src="${escUrl(m.url)}" alt="">`;
      return `<div class="m-card ${m.active ? '' : 'm-card--off'}">
        ${thumbEl}
        <form method="POST" action="/admin/media/${m.id}/update" class="m-edit">
          <input type="hidden" name="return_to" value="/admin/gallery${filterConcept ? '?concept='+filterConcept : ''}">
          <div class="m-name" title="Full file URL (hover): ${escapeHtml(m.url)}">${escapeHtml(fname(m.url))}</div>
          <label title="CONCEPT — which concept this media item belongs to. Change here to move the item to another concept (e.g. move a dog photo from Royal Portrait → Talking Pet).">Concept <select name="concept_id">${CONCEPT_SELECT_OPTS(m.concept_id)}</select></label>
          ${badges ? `<div class="m-badges" title="This media item is currently used in these triplet slots. If you delete it, those slots will go empty.">${badges}</div>` : ''}
          <label title="KIND — image or video. Determines whether the file is used as a Before/After Picture (image) or as an After Video (video).">Kind <select name="kind">${KIND_OPTS(m.kind)}</select></label>
          <label title="FILTERS — comma-separated tags used on the public /gallery page filter chips (e.g. pet, royal, family). An item shows up under a chip if either its own tags or its concept's tags match.">Filters <input type="text" name="filter_category" value="${escapeHtml(m.filter_category || '')}" placeholder="e.g. pet, royal"></label>
          <div class="m-row">
            <label class="m-flex" title="SORT — display order within the concept. Lower numbers appear first.">Sort <input type="number" name="sort_order" value="${m.sort_order || 0}"></label>
            <label class="m-chk" title="ACTIVE — master switch for this media item. When OFF, the item is hidden from the public gallery and from new triplet slot pickers. Triplets that already reference it will show a broken slot."><input type="checkbox" name="active"${m.active ? ' checked' : ''}> Active</label>
          </div>
          <div class="m-actions">
            <button type="submit" class="btn small" title="Save the field changes above (Kind, Filters, Sort, Active).">Save</button>
            <a href="/admin/media/${m.id}/download" class="m-dl" title="Download the original file through the server (bypasses Chrome enterprise download blocks that hit direct R2 links).">↓</a>
            <button type="submit" formaction="/admin/media/${m.id}/delete" formnovalidate onclick="return confirm('Delete this gallery item?');" class="m-del" title="Delete this media item permanently. The file in R2 storage stays, but the DB row is removed. Triplets that reference this item will lose that slot.">×</button>
          </div>
        </form>
      </div>`;
    };
    const unassignedHtml = allMedia.length ? `<section class="g-section">
      <header class="g-section-head">
        <h2>Media library <span class="g-count">${allMedia.length} item${allMedia.length === 1 ? '' : 's'}${unassigned.length !== allMedia.length ? ` · ${unassigned.length} not in any triplet` : ''}</span></h2>
        <span class="muted" style="font-size:12px;">Drag any thumbnail onto a triplet slot in /admin/concepts or /admin/triplets.</span>
      </header>
      <div class="m-grid">
        ${allMedia.map(mediaCard).join('')}
      </div>
    </section>` : '';

    const conceptOpts = `<option value="">All concepts</option>` + concepts.map((c) =>
      `<option value="${c.id}"${filterConcept === c.id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`
    ).join('');

    const flash = (req.query.saved_media ? `<div class="flash ok">Saved.</div>` : '') +
                  (req.query.deleted ? `<div class="flash ok">Deleted.</div>` : '') +
                  (req.query.error ? `<div class="flash err">${escapeHtml(req.query.error)}</div>` : '');

    const body = `
      <style>
        .g-top{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:14px;}
        .g-top h1{margin:0;font-size:22px;}
        .g-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
        .g-filters{display:flex;gap:8px;align-items:center;background:#fff;border:1px solid #eee;border-radius:8px;padding:6px 10px;margin-bottom:16px;font-size:12px;}
        .g-filters select{padding:4px 8px;font-size:12px;border:1px solid #ccc;border-radius:6px;background:#fff;}
        .g-filters label{font-weight:600;color:#666;margin:0;font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer;}
        .g-section{margin-bottom:24px;}
        .g-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:8px;border-bottom:1px solid #eee;padding-bottom:5px;}
        .g-section-head h2{margin:0;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#1C0A00;font-weight:700;}
        .g-count{font-size:11px;font-weight:500;color:#888;text-transform:none;letter-spacing:0;margin-left:4px;}
        .g-mini-link{font-size:11px;color:#3A6B20;text-decoration:none;}
        .g-mini-link:hover{text-decoration:underline;}
        .t-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;}
        .t-card{background:#fff;border:1px solid #e6e2d8;border-left:4px solid var(--accent,#3A6B20);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;font-size:11px;transition:opacity 0.15s,box-shadow 0.15s;}
        .t-card:hover{box-shadow:0 4px 14px rgba(0,0,0,0.06);}
        .t-card--off{opacity:0.5;}
        .t-card-head{display:flex;align-items:center;gap:6px;}
        .t-badge{background:var(--accent,#3A6B20);color:#fff;font-weight:800;font-size:10px;padding:2px 7px;border-radius:8px;letter-spacing:0.04em;flex-shrink:0;}
        .t-concept{font-weight:700;color:#1C0A00;font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .t-concept-pick{flex:1;min-width:0;font-size:11px;font-weight:700;color:#1C0A00;padding:3px 5px;border:1px solid #e0dcd0;border-radius:4px;background:#fff;cursor:pointer;}
        .t-concept-pick:hover{border-color:#3A6B20;}
        .t-edit{font-size:10px;color:#888;text-decoration:none;flex-shrink:0;}
        .t-edit:hover{color:#3A6B20;text-decoration:underline;}
        .t-thumbs{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;}
        .t-slot{display:flex;flex-direction:column;gap:2px;align-items:center;}
        .t-slot-lbl{font-size:8px;font-weight:700;color:#888;letter-spacing:0.05em;text-transform:uppercase;}
        .g-thumb{width:100%;aspect-ratio:9/16;object-fit:cover;border-radius:4px;background:#1A0C04;display:block;}
        .g-thumb--empty{aspect-ratio:9/16;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:18px;font-weight:700;background:#f0ede6;border-radius:4px;}
        .t-caption{font-size:11px;color:#666;font-style:italic;line-height:1.3;}
        .t-toggles{display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-top:auto;}
        .t-toggle{display:inline-flex;align-items:center;gap:3px;background:#f3f0e6;border-radius:10px;padding:2px 7px;font-size:10px;font-weight:600;color:#888;cursor:pointer;transition:background 0.15s,color 0.15s;user-select:none;}
        .t-toggle input{display:none;}
        .t-toggle.on{background:var(--accent,#3A6B20);color:#fff;}
        .t-del{margin-left:auto;display:inline;}
        .t-del button{background:transparent;border:none;color:#c33;font-size:16px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:4px;}
        .t-del button:hover{background:#fee;}

        /* Media-library cards — portrait thumb on top, editable form below */
        .m-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;}
        .m-card{background:#fff;border:1px solid #e6e2d8;border-radius:8px;overflow:hidden;display:flex;flex-direction:column;font-size:11px;transition:opacity 0.15s,box-shadow 0.15s;}
        .m-card:hover{box-shadow:0 4px 14px rgba(0,0,0,0.06);}
        .m-card--off{opacity:0.5;}
        .m-thumb{width:100%;aspect-ratio:9/16;object-fit:cover;background:#1A0C04;display:block;cursor:grab;}
        .m-edit{padding:8px 9px;display:flex;flex-direction:column;gap:5px;}
        .m-edit label{font-size:10px;font-weight:600;color:#666;margin:0;display:flex;flex-direction:column;gap:2px;}
        .m-edit select,.m-edit input[type=text],.m-edit input[type=number]{font-family:inherit;font-size:11px;padding:3px 6px;border:1px solid #ddd;border-radius:4px;width:100%;box-sizing:border-box;background:#fff;}
        .m-row{display:flex;gap:6px;align-items:end;}
        .m-flex{flex:1;}
        .m-chk{flex-shrink:0;flex-direction:row !important;align-items:center !important;gap:3px !important;color:#3A6B20 !important;font-weight:700 !important;cursor:pointer;}
        .m-chk input{width:auto !important;}
        .m-name{font-family:monospace;font-size:10px;color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .m-concept{font-size:10px;color:#888;font-weight:600;}
        .m-badges{display:flex;flex-direction:column;gap:2px;}
        .m-badge{background:#3A6B20;color:#fff;font-size:9px;font-weight:700;padding:1px 6px;border-radius:8px;letter-spacing:0.04em;line-height:1.3;}
        .m-actions{display:flex;gap:6px;align-items:center;margin-top:2px;}
        .m-actions .btn.small{flex:1;padding:5px;font-size:11px;}
        .m-del{background:transparent;border:1px solid #ddd;color:#c33;font-size:14px;line-height:1;cursor:pointer;padding:4px 9px;border-radius:4px;}
        .m-del:hover{background:#fee;border-color:#c33;}
        .m-dl{display:inline-flex;align-items:center;justify-content:center;background:transparent;border:1px solid #ddd;color:#3A6B20;font-size:14px;font-weight:700;line-height:1;text-decoration:none;padding:4px 9px;border-radius:4px;}
        .m-dl:hover{background:#eef6e2;border-color:#3A6B20;}
      </style>

      <div class="g-top">
        <h1>Gallery</h1>
        <div class="g-actions">
          <a class="btn" href="/admin/gallery/new${filterConcept ? `?concept=${filterConcept}` : ''}">+ Upload</a>
          <a class="btn secondary" href="/admin/triplets${filterConcept ? `?concept=${filterConcept}` : ''}">+ Triplet</a>
          <a class="muted" style="font-size:11px;" href="/admin/gallery/table${filterConcept ? `?concept=${filterConcept}` : ''}">Legacy table view ↗</a>
        </div>
      </div>
      <form method="GET" action="/admin/gallery" class="g-filters">
        <span style="font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#888;">Filter</span>
        <label title="Show only triplets that belong to this concept">Concept <select name="concept" onchange="this.form.submit()">${conceptOpts}</select></label>
        <label title="Triplets are sets of three media slots: Before, After Picture, After Video. Triplets = all 3 filled; Duplexes = exactly 2 filled (one missing); Singles = only one slot filled.">Type <select name="kind" onchange="this.form.submit()">
          <option value=""${filterKind === '' ? ' selected' : ''}>All</option>
          <option value="triplet"${filterKind === 'triplet' ? ' selected' : ''}>Triplets (3/3)</option>
          <option value="duplex"${filterKind === 'duplex' ? ' selected' : ''}>Duplexes (2/3)</option>
          <option value="single"${filterKind === 'single' ? ' selected' : ''}>Singles (1/3)</option>
        </select></label>
        <label title="Include items where Active is OFF (normally hidden)"><input type="checkbox" name="show_inactive" value="1" onchange="this.form.submit()"${showInactive ? ' checked' : ''}> Show inactive</label>
        <a href="/admin/gallery" class="muted" style="font-size:11px;" title="Clear all filters">Reset</a>
      </form>
      ${flash}
      ${sectionsHtml || `<p class="muted">No triplets in${filterConcept ? ' this concept' : ' the library yet'}. <a href="/admin/triplets${filterConcept ? `?concept=${filterConcept}` : ''}">Create one →</a></p>`}
      ${unassignedHtml}

      <!-- Drop overlay (drag files from Explorer) -->
      <div id="ts-drop-overlay" style="display:none;position:fixed;inset:0;background:rgba(28,42,20,0.85);z-index:9000;align-items:center;justify-content:center;flex-direction:column;color:#fff;font-family:'Plus Jakarta Sans',sans-serif;padding:30px;text-align:center;">
        <div style="font-size:46px;font-weight:800;margin-bottom:12px;">Drop to upload</div>
        <div style="font-size:16px;opacity:0.85;margin-bottom:20px;">Files will be added to the gallery as new items.</div>
        <div style="background:#fff;color:#1C0A00;padding:18px 22px;border-radius:12px;min-width:320px;max-width:520px;">
          <label style="display:block;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#666;margin-bottom:6px;">Assign to concept</label>
          <select id="ts-drop-concept" style="width:100%;padding:9px 11px;font-size:14px;border:1px solid #ccc;border-radius:8px;">
            ${concepts.map((c) => `<option value="${c.id}"${filterConcept === c.id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="ts-drop-progress" style="display:none;position:fixed;bottom:24px;right:24px;background:#1C2A14;color:#fff;border-radius:10px;padding:14px 18px;box-shadow:0 12px 32px rgba(0,0,0,0.3);z-index:9100;font-family:'Plus Jakarta Sans',sans-serif;font-size:13px;min-width:260px;"></div>

      <script>
        // Make every thumbnail with [data-mid] draggable. Payload is JSON with
        // media id / kind / url so the receiving window can populate a slot picker.
        document.querySelectorAll('[data-mid]').forEach(function(el){
          el.addEventListener('dragstart', function(e){
            try {
              var url  = el.dataset.murl || '';
              var kind = el.dataset.mkind || '';
              var payload = { id: parseInt(el.dataset.mid, 10), kind: kind, url: url };
              e.dataTransfer.setData('application/x-ts-media', JSON.stringify(payload));
              e.dataTransfer.setData('text/plain', url);
              e.dataTransfer.setData('text/uri-list', url);
              // Chrome's "drag file from browser to OS file explorer" hook.
              // Format: <mime>:<filename>:<absolute URL>
              var fname = (url.split('?')[0].split('/').pop() || 'download');
              var ext = (fname.split('.').pop() || '').toLowerCase();
              var mime =
                kind === 'video' ? (ext === 'webm' ? 'video/webm' : 'video/mp4') :
                ext === 'png'  ? 'image/png'  :
                ext === 'gif'  ? 'image/gif'  :
                ext === 'webp' ? 'image/webp' :
                'image/jpeg';
              e.dataTransfer.setData('DownloadURL', mime + ':' + fname + ':' + url);
              e.dataTransfer.effectAllowed = 'copy';
            } catch(err){}
            el.style.opacity = '0.5';
          });
          el.addEventListener('dragend', function(){ el.style.opacity = ''; });
          // Double-click → fullscreen lightbox with sound (videos) / full resolution (images).
          el.addEventListener('dblclick', function(){
            openGalleryLightbox(el.dataset.murl || el.src || '', el.dataset.mkind || (el.tagName === 'VIDEO' ? 'video' : 'image'));
          });
        });

        function openGalleryLightbox(url, kind){
          if (!url) return;
          var overlay = document.getElementById('g-lightbox');
          if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'g-lightbox';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9500;display:flex;align-items:center;justify-content:center;padding:30px;cursor:zoom-out;';
            overlay.addEventListener('click', function(e){ if (e.target === overlay) closeGalleryLightbox(); });
            document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeGalleryLightbox(); });
            document.body.appendChild(overlay);
          }
          overlay.innerHTML = '';
          overlay.style.display = 'flex';
          var close = document.createElement('button');
          close.type = 'button'; close.textContent = '×';
          close.style.cssText = 'position:absolute;top:18px;right:24px;background:none;border:none;color:#fff;font-size:42px;cursor:pointer;line-height:1;padding:0;';
          close.onclick = closeGalleryLightbox;
          overlay.appendChild(close);
          var media;
          if (kind === 'video') {
            media = document.createElement('video');
            media.src = url; media.controls = true; media.autoplay = true; media.loop = true; media.muted = false; media.playsInline = true;
            media.style.cssText = 'max-width:92vw;max-height:90vh;border-radius:10px;display:block;';
          } else {
            media = document.createElement('img');
            media.src = url; media.alt = '';
            media.style.cssText = 'max-width:92vw;max-height:90vh;border-radius:10px;display:block;object-fit:contain;';
          }
          overlay.appendChild(media);
        }
        function closeGalleryLightbox(){
          var o = document.getElementById('g-lightbox');
          if (!o) return;
          o.innerHTML = '';
          o.style.display = 'none';
        }

        // Toggle handlers — fetch /admin/triplets/:id/toggle for instant flip.
        document.querySelectorAll('.t-toggle').forEach(function(lbl){
          lbl.addEventListener('click', async function(e){
            e.preventDefault();
            var card = lbl.closest('.t-card');
            var tripId = card.dataset.tripId;
            var field = lbl.dataset.field;
            try {
              var r = await fetch('/admin/triplets/'+tripId+'/toggle', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'field='+encodeURIComponent(field) });
              var j = await r.json();
              if (!r.ok) throw new Error(j.error || 'toggle failed');
              lbl.classList.toggle('on', !!j.value);
              lbl.querySelector('input').checked = !!j.value;
              if (field === 'active') card.classList.toggle('t-card--off', !j.value);
            } catch(err){ alert('Toggle failed: '+err.message); }
          });
        });
        // Concept move — fetch /admin/triplets/:id/move-concept.
        // We reload after a successful move so the triplet re-files into the right
        // concept section in the grid.
        document.querySelectorAll('.t-concept-pick').forEach(function(sel){
          sel.addEventListener('change', async function(){
            var tripId = sel.dataset.tripId;
            var newConcept = sel.value;
            sel.disabled = true;
            try {
              var r = await fetch('/admin/triplets/'+tripId+'/move-concept', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'concept_id='+encodeURIComponent(newConcept) });
              var j = await r.json();
              if (!r.ok) throw new Error(j.error || 'move failed');
              location.reload();
            } catch(err){ alert('Move failed: '+err.message); sel.disabled = false; }
          });
        });
        // Drag-drop upload (same flow as before)
        (function(){
          var overlay = document.getElementById('ts-drop-overlay');
          var progress = document.getElementById('ts-drop-progress');
          var sel = document.getElementById('ts-drop-concept');
          if (!overlay || !sel) return;
          var depth = 0;
          function isFileDrag(e){ if(!e.dataTransfer) return false; var t=e.dataTransfer.types; if(!t) return false; for(var i=0;i<t.length;i++) if(t[i]==='Files') return true; return false; }
          window.addEventListener('dragenter', function(e){ if(!isFileDrag(e)) return; e.preventDefault(); depth++; overlay.style.display='flex'; });
          window.addEventListener('dragover',  function(e){ if(!isFileDrag(e)) return; e.preventDefault(); });
          window.addEventListener('dragleave', function(e){ if(!isFileDrag(e)) return; depth=Math.max(0,depth-1); if(depth===0) overlay.style.display='none'; });
          window.addEventListener('drop', async function(e){
            if(!isFileDrag(e)) return;
            e.preventDefault(); depth=0; overlay.style.display='none';
            var files = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
            if (!files.length) return;
            var conceptId = parseInt(sel.value, 10);
            if (!conceptId) { alert('Pick a concept first'); return; }
            progress.style.display='block';
            var done=0, failed=0, current='';
            function render(){ progress.innerHTML='<div style="font-weight:700;margin-bottom:4px;">Uploading '+done+'/'+files.length+'</div>'+(failed?'<div style="color:#FFB400;font-size:12px;">'+failed+' failed</div>':'')+(current?'<div style="font-size:12px;color:#bbb;margin-top:4px;">'+current.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</div>':''); }
            for (var i=0;i<files.length;i++) {
              var f=files[i]; current=f.name; render();
              try {
                var kind=f.type.startsWith('video/')?'video':'image';
                var fd=new FormData(); fd.append('image',f);
                var up=await fetch('/upload',{method:'POST',body:fd}); var upj=await up.json();
                if(!up.ok || !upj.url) throw new Error(upj.error||'Upload failed');
                var save=await fetch('/admin/concepts/save-to-gallery',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({concept_id:conceptId,url:upj.url,kind:kind})});
                var sj=await save.json(); if(!save.ok) throw new Error(sj.error||'Save failed');
                done++;
              } catch(err){ failed++; console.warn('[drop]',f.name,err.message); }
              render();
            }
            current=''; progress.innerHTML='<div style="font-weight:700;">Done · '+done+'/'+files.length+(failed?' ('+failed+' failed)':'')+'</div>';
            setTimeout(function(){ location.reload(); }, 700);
          });
        })();
      </script>`;
    res.send(conceptAdminPage('Gallery', body));
  } catch (err) {
    console.error('[gallery] list error:', err.message);
    res.status(500).send('Failed to load gallery: ' + escapeHtml(err.message));
  }
});

// Same as /admin/concepts/:id/slot but reads concept_id from the request body,
// so the gallery row's slot-assign forms can name the concept inline.
app.post('/admin/concepts/slot/assign', requireRole('admin'), async (req, res) => {
  const conceptId = parseInt(req.body.concept_id, 10);
  const slot = String(req.body.slot || '').trim();
  const column = SLOT_TO_COLUMN[slot];
  if (!conceptId || !column) {
    return res.redirect((req.body.return_to || '/admin/gallery') + '?error=' + encodeURIComponent('Pick a concept and a slot'));
  }
  const mediaIdRaw = req.body.media_id;
  const mediaId = mediaIdRaw && String(mediaIdRaw).trim() && parseInt(mediaIdRaw, 10) ? parseInt(mediaIdRaw, 10) : null;
  let url = null;
  try {
    if (mediaId) {
      const r = await pool.query('SELECT url FROM concept_media WHERE id = $1', [mediaId]);
      if (!r.rows.length) return res.redirect((req.body.return_to || '/admin/gallery') + '?error=' + encodeURIComponent('Media not found'));
      url = r.rows[0].url;
    }
    await pool.query(`UPDATE concepts SET ${column} = $1 WHERE id = $2`, [url, conceptId]);
  } catch (err) {
    console.error('[concept-slot-assign] error:', err.message);
    return res.redirect((req.body.return_to || '/admin/gallery') + '?error=' + encodeURIComponent('Update failed'));
  }
  res.redirect(req.body.return_to || '/admin/gallery?saved_media=1');
});

// Update one media item — caption, kind, sort_order, is_primary, active.
app.post('/admin/media/:id/update', requireRole('admin'), async (req, res) => {
  const mediaId = parseInt(req.params.id, 10);
  try {
    const row = await pool.query(`SELECT concept_id FROM concept_media WHERE id = $1`, [mediaId]);
    if (!row.rows.length) return res.status(404).send('Not found');
    const currentConceptId = row.rows[0].concept_id;
    // Allow moving the media item to a different concept. If not provided or invalid,
    // keep the current concept.
    const newConceptId = req.body.concept_id ? parseInt(req.body.concept_id, 10) : null;
    let conceptId = currentConceptId;
    if (newConceptId && newConceptId !== currentConceptId) {
      const exists = await pool.query(`SELECT 1 FROM concepts WHERE id = $1`, [newConceptId]);
      if (exists.rows.length) conceptId = newConceptId;
    }

    const caption = req.body.caption == null ? null : (String(req.body.caption).trim() || null);
    const kind = (req.body.kind || '').trim();
    if (kind && !CONCEPT_MEDIA_KINDS.includes(kind)) {
      return res.status(400).send('Invalid kind');
    }
    const sortOrder = req.body.sort_order != null ? parseInt(req.body.sort_order, 10) : null;
    const isPrimary = req.body.is_primary === 'on' || req.body.is_primary === 'true';
    const active = !(req.body.active === 'false' || req.body.active === '0' || req.body.active === 'off');
    const filterCategory = req.body.filter_category == null ? null : (String(req.body.filter_category).trim() || null);
    const sourceUrl = req.body.source_url == null ? null : (String(req.body.source_url).trim() || null);

    if (isPrimary) {
      await pool.query(`UPDATE concept_media SET is_primary = FALSE WHERE concept_id = $1`, [conceptId]);
    }

    await pool.query(
      `UPDATE concept_media SET
         concept_id = $9,
         caption = COALESCE($1, caption),
         kind = COALESCE(NULLIF($2, ''), kind),
         sort_order = COALESCE($3, sort_order),
         is_primary = $4,
         active = $5,
         filter_category = $6,
         source_url = $7
       WHERE id = $8`,
      [caption, kind, sortOrder, isPrimary, active, filterCategory, sourceUrl, mediaId, conceptId]
    );

    if (req.headers.accept === 'application/json' || req.xhr) return res.json({ ok: true });
    const returnTo = req.body.return_to || `/admin/gallery?saved_media=1`;
    const sep = returnTo.includes('?') ? '&' : '?';
    res.redirect(returnTo + sep + 'saved_media=1');
  } catch (err) {
    console.error('[concept-media] update error:', err.message);
    res.status(500).json({ error: 'Update failed', details: err.message });
  }
});

// Download proxy. Streams an R2 file through the app with Content-Disposition:
// attachment, so an enterprise-managed Chrome that blocks direct downloads from
// the R2 origin will still allow it (since it comes from turtleandsun.com).
app.get('/admin/media/:id/download', requireRole('admin'), async (req, res) => {
  const mediaId = parseInt(req.params.id, 10);
  try {
    const r = await pool.query(`SELECT url, kind FROM concept_media WHERE id = $1`, [mediaId]);
    if (!r.rows.length) return res.status(404).send('Not found');
    const { url, kind } = r.rows[0];
    if (!url) return res.status(404).send('No URL');
    // Derive filename + mime from the URL extension.
    const fname = (String(url).split('?')[0].split('/').pop() || 'download');
    const ext = (fname.split('.').pop() || '').toLowerCase();
    const mime =
      kind === 'video' ? (ext === 'webm' ? 'video/webm' : 'video/mp4') :
      ext === 'png'  ? 'image/png'  :
      ext === 'gif'  ? 'image/gif'  :
      ext === 'webp' ? 'image/webp' :
      ext === 'mp4'  ? 'video/mp4'  :
      'image/jpeg';
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(502).send('Upstream fetch failed: ' + upstream.status);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${fname.replace(/"/g, '')}"`);
    if (upstream.headers.get('content-length')) {
      res.setHeader('Content-Length', upstream.headers.get('content-length'));
    }
    // Stream the body through. Node 18+ fetch returns a web ReadableStream.
    const reader = upstream.body.getReader();
    res.on('close', () => { try { reader.cancel(); } catch (e) {} });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error('[media-download] error:', err.message);
    res.status(500).send('Download failed: ' + err.message);
  }
});

app.post('/admin/media/:id/delete', requireRole('admin'), async (req, res) => {
  const mediaId = parseInt(req.params.id, 10);
  try {
    await pool.query(`DELETE FROM concept_media WHERE id = $1`, [mediaId]);
    res.redirect(req.body.return_to || '/admin/gallery?deleted=1');
  } catch (err) {
    console.error('[concept-media] delete error:', err.message);
    res.redirect('/admin/gallery?error=' + encodeURIComponent('Delete media failed: ' + err.message));
  }
});

// ----- /admin/gallery — list + add page -----

// Legacy wide-table gallery — kept under /admin/gallery/table for the rare
// "show me the raw rows" need. The default /admin/gallery now serves the
// dense triplet-card grid below.
app.get('/admin/gallery/table', requireRole('admin'), async (req, res) => {
  try {
    const filterConcept = req.query.concept ? parseInt(req.query.concept, 10) : null;
    const filterKind = req.query.kind && CONCEPT_MEDIA_KINDS.includes(req.query.kind) ? req.query.kind : null;
    const filterActive = req.query.active; // 'true' | 'false' | undefined

    const where = [];
    const params = [];
    if (filterConcept) { params.push(filterConcept); where.push(`cm.concept_id = $${params.length}`); }
    if (filterKind)    { params.push(filterKind);    where.push(`cm.kind = $${params.length}`); }
    if (filterActive === 'true')  where.push(`cm.active = TRUE`);
    if (filterActive === 'false') where.push(`cm.active = FALSE`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows: items } = await pool.query(
      `SELECT cm.*, c.name AS concept_name, c.slug AS concept_slug
       FROM concept_media cm
       JOIN concepts c ON c.id = cm.concept_id
       ${whereSql}
       ORDER BY cm.created_at DESC, cm.id DESC`,
      params
    );

    // Resolve which concepts (and triplets) use each gallery item as a slot,
    // so the table cells can show "Royal Portrait #1" badges. Two sources:
    //   - Legacy: concepts.before_image_url / after_image_url / example_video_url (matched by URL).
    //   - New:    concept_triplets.before_media_id / image_media_id / video_media_id (matched by media id).
    const { rows: conceptSlots } = await pool.query(
      `SELECT id, name, before_image_url, after_image_url, example_video_url
       FROM concepts WHERE active = TRUE ORDER BY name ASC`
    );
    const itemSlotsByUrl = new Map();     // url    → { before:[label], image:[label], video:[label] }
    const itemSlotsByMediaId = new Map(); // mediaId → same shape
    function ensureUrlBucket(url){ if (!itemSlotsByUrl.has(url)) itemSlotsByUrl.set(url, {before:[], image:[], video:[]}); return itemSlotsByUrl.get(url); }
    function ensureIdBucket(id){ if (!itemSlotsByMediaId.has(id)) itemSlotsByMediaId.set(id, {before:[], image:[], video:[]}); return itemSlotsByMediaId.get(id); }
    for (const c of conceptSlots) {
      if (c.before_image_url)  ensureUrlBucket(c.before_image_url ).before.push(`${c.name} (legacy)`);
      if (c.after_image_url)   ensureUrlBucket(c.after_image_url  ).image .push(`${c.name} (legacy)`);
      if (c.example_video_url) ensureUrlBucket(c.example_video_url).video .push(`${c.name} (legacy)`);
    }
    const { rows: tripletAssignments } = await pool.query(
      `SELECT t.id, t.concept_id, t.triplet_number, t.before_media_id, t.image_media_id, t.video_media_id, c.name AS concept_name
       FROM concept_triplets t
       JOIN concepts c ON c.id = t.concept_id
       WHERE c.active = TRUE
       ORDER BY c.name ASC, t.triplet_number ASC`
    );
    for (const t of tripletAssignments) {
      const label = `${t.concept_name} #${t.triplet_number}`;
      if (t.before_media_id) ensureIdBucket(t.before_media_id).before.push(label);
      if (t.image_media_id)  ensureIdBucket(t.image_media_id ).image .push(label);
      if (t.video_media_id)  ensureIdBucket(t.video_media_id ).video .push(label);
    }
    // Used to render the per-row concept picker in each slot column (legacy slot endpoint).
    const conceptOptsAll = `<option value="">— (none) —</option>` +
      conceptSlots.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');

    const concepts = (await pool.query(`SELECT id, name FROM concepts ORDER BY name ASC`)).rows;
    const conceptOpts = `<option value="">All concepts</option>` + concepts.map((c) =>
      `<option value="${c.id}"${filterConcept === c.id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`
    ).join('');
    const kindOpts = `<option value="">All kinds</option>` + CONCEPT_MEDIA_KINDS.map((k) =>
      `<option value="${k}"${filterKind === k ? ' selected' : ''}>${k}</option>`
    ).join('');
    const activeOpts =
      `<option value=""${!filterActive ? ' selected' : ''}>All</option>` +
      `<option value="true"${filterActive === 'true' ? ' selected' : ''}>Active</option>` +
      `<option value="false"${filterActive === 'false' ? ' selected' : ''}>Inactive</option>`;

    // Returns the cell for one slot column on one gallery item row.
    // Combines legacy URL-based assignments AND new triplet assignments.
    const returnTo = '/admin/gallery' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
    const slotCell = (mediaItem, slot, applicable) => {
      if (!applicable) return `<td class="muted" style="text-align:center;font-size:11px;">—</td>`;
      const urlMap = itemSlotsByUrl.get(mediaItem.url) || { before: [], image: [], video: [] };
      const idMap  = itemSlotsByMediaId.get(mediaItem.id) || { before: [], image: [], video: [] };
      const assignedTo = urlMap[slot].concat(idMap[slot]);
      const badges = assignedTo.length
        ? assignedTo.map((name) => `<span style="display:inline-block;background:#3A6B20;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;margin:1px 0;">${escapeHtml(name)}</span>`).join('<br>')
        : `<span class="muted" style="font-size:11px;">(not set)</span>`;
      // Clear buttons — one per concept already using this item in this slot.
      const clearButtons = assignedTo.map((conceptName) => {
        const c = conceptSlots.find((x) => x.name === conceptName);
        if (!c) return '';
        return `<form method="POST" action="/admin/concepts/slot/assign" class="inline" style="display:inline;">
          <input type="hidden" name="concept_id" value="${c.id}">
          <input type="hidden" name="slot" value="${slot}">
          <input type="hidden" name="media_id" value="">
          <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
          <button type="submit" class="btn small" style="padding:2px 6px;font-size:10px;background:#fff;border-color:#aaa;color:#666;" title="Clear ${escapeHtml(conceptName)}'s ${slot}">✕</button>
        </form>`;
      }).join(' ');
      return `<td style="vertical-align:top;">
        <div style="display:flex;flex-direction:column;gap:4px;">
          ${badges}
          <form method="POST" action="/admin/concepts/slot/assign" class="inline" style="display:flex;gap:4px;">
            <input type="hidden" name="slot" value="${slot}">
            <input type="hidden" name="media_id" value="${mediaItem.id}">
            <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
            <select name="concept_id" style="font-size:11px;padding:3px 5px;flex:1;min-width:90px;">${conceptOptsAll}</select>
            <button type="submit" class="btn small" style="padding:3px 7px;font-size:10px;" title="Set this item as ${slot} for the selected concept">→</button>
          </form>
          ${clearButtons ? `<div style="display:flex;gap:3px;flex-wrap:wrap;">${clearButtons}</div>` : ''}
        </div>
      </td>`;
    };

    const rowHtml = items.map((m) => {
      const isVideo = m.kind === 'video';
      const slotInfo = itemSlotsByUrl.get(m.url) || { before: [], image: [], video: [] };
      const inAnySlot = slotInfo.before.length || slotInfo.image.length || slotInfo.video.length;
      const urlStr = String(m.url || '');
      const filename = (urlStr.split('?')[0].split('/').pop() || urlStr).slice(0, 48);
      const thumbBlock = isVideo
        ? `<video src="${escapeHtml(m.url)}" muted style="width:96px;height:64px;object-fit:cover;border-radius:4px;background:#000;"></video>`
        : `<img src="${escapeHtml(m.url)}" alt="" style="width:96px;height:64px;object-fit:cover;border-radius:4px;">`;
      const thumb = `
        <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-start;">
          ${thumbBlock}
          <div title="${escapeHtml(urlStr)}" style="font-family:monospace;font-size:10px;color:#666;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(filename)}</div>
        </div>`;
      const kindOptsRow = CONCEPT_MEDIA_KINDS.map((k) => `<option value="${k}"${k === m.kind ? ' selected' : ''}>${k}</option>`).join('');
      return `
        <tr${inAnySlot ? ' style="background:rgba(58,107,32,0.04);"' : ''}>
          <td>${thumb}</td>
          <td><a href="/admin/concepts/edit/${m.concept_id}">${escapeHtml(m.concept_name)}</a></td>
          ${slotCell(m, 'before', !isVideo)}
          ${slotCell(m, 'image',  !isVideo)}
          ${slotCell(m, 'video',   isVideo)}
          <td>
            <form method="POST" action="/admin/media/${m.id}/update" class="inline" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
              <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
              <select name="kind" style="width:90px;padding:6px 8px;">${kindOptsRow}</select>
              <input type="text" name="filter_category" value="${escapeHtml(m.filter_category || '')}" placeholder="filters e.g. pet, royal" style="width:160px;padding:6px 8px;">
              <input type="number" name="sort_order" value="${m.sort_order}" style="width:60px;padding:6px 8px;">
              <label style="font-weight:normal;display:flex;align-items:center;gap:4px;font-size:12px;"><input type="checkbox" name="active"${m.active ? ' checked' : ''}> Active</label>
              <button type="submit" class="btn small">Save</button>
            </form>
          </td>
          <td class="muted" style="font-size:12px;">${new Date(m.created_at).toISOString().slice(0,10)}</td>
          <td>
            <form method="POST" action="/admin/media/${m.id}/delete" class="inline" onsubmit="return confirm('Delete this gallery item?');">
              <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
              <button type="submit" class="btn small" style="background:#fff;border-color:#c33;color:#c33;">Delete</button>
            </form>
          </td>
        </tr>`;
    }).join('');

    const body = `
      <div class="top">
        <h1>Gallery</h1>
        <a class="btn" href="/admin/gallery/new${filterConcept ? `?concept=${filterConcept}` : ''}">+ Add gallery item</a>
      </div>
      <form method="GET" action="/admin/gallery" style="display:flex;gap:10px;align-items:end;margin:14px 0 18px;flex-wrap:wrap;">
        <div class="field" style="margin:0;"><label>Concept</label><select name="concept">${conceptOpts}</select></div>
        <div class="field" style="margin:0;"><label>Kind</label><select name="kind">${kindOpts}</select></div>
        <div class="field" style="margin:0;"><label>Active</label><select name="active">${activeOpts}</select></div>
        <button type="submit" class="btn secondary">Filter</button>
        <a href="/admin/gallery" class="muted" style="align-self:center;">Reset</a>
      </form>
      ${req.query.saved_media ? '<div class="flash">Saved.</div>' : ''}
      ${req.query.deleted ? '<div class="flash">Deleted.</div>' : ''}
      ${req.query.error ? `<div class="flash err">${escapeHtml(req.query.error)}</div>` : ''}
      <table class="admin-table">
        <thead><tr>
          <th>Preview</th>
          <th>Origin&nbsp;concept</th>
          <th style="min-width:160px;">Before<br><span class="muted" style="font-weight:400;font-size:10px;">(widget left)</span></th>
          <th style="min-width:160px;">After Picture<br><span class="muted" style="font-weight:400;font-size:10px;">(widget still)</span></th>
          <th style="min-width:160px;">After Video<br><span class="muted" style="font-weight:400;font-size:10px;">(widget video)</span></th>
          <th>Settings</th>
          <th>Created</th>
          <th></th>
        </tr></thead>
        <tbody>${rowHtml || '<tr><td colspan="8" class="muted">No gallery items yet.</td></tr>'}</tbody>
      </table>

      <!-- Drag-and-drop upload from the file system. Activates on any drag onto the page. -->
      <div id="ts-drop-overlay" style="display:none;position:fixed;inset:0;background:rgba(28,42,20,0.85);z-index:9000;align-items:center;justify-content:center;flex-direction:column;color:#fff;font-family:'Plus Jakarta Sans',sans-serif;padding:30px;text-align:center;">
        <div style="font-size:46px;font-weight:800;margin-bottom:12px;">Drop to upload</div>
        <div style="font-size:16px;opacity:0.85;margin-bottom:20px;">Files will be added to the gallery as new items.</div>
        <div style="background:#fff;color:#1C0A00;padding:18px 22px;border-radius:12px;min-width:320px;max-width:520px;">
          <label style="display:block;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#666;margin-bottom:6px;">Assign uploaded files to concept</label>
          <select id="ts-drop-concept" style="width:100%;padding:9px 11px;font-size:14px;border:1px solid #ccc;border-radius:8px;">
            ${concepts.map((c) => `<option value="${c.id}"${filterConcept === c.id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
          </select>
          <div style="font-size:12px;color:#888;margin-top:6px;">${filterConcept ? 'Pre-filled from the page filter.' : 'Pick a concept before releasing the files.'}</div>
        </div>
      </div>
      <div id="ts-drop-progress" style="display:none;position:fixed;bottom:24px;right:24px;background:#1C2A14;color:#fff;border-radius:10px;padding:14px 18px;box-shadow:0 12px 32px rgba(0,0,0,0.3);z-index:9100;font-family:'Plus Jakarta Sans',sans-serif;font-size:13px;min-width:260px;"></div>
      <script>
        (function dropUpload(){
          var overlay = document.getElementById('ts-drop-overlay');
          var progress = document.getElementById('ts-drop-progress');
          var sel = document.getElementById('ts-drop-concept');
          if (!overlay || !sel) return;
          var depth = 0;
          function isFileDrag(e){
            if (!e.dataTransfer) return false;
            var t = e.dataTransfer.types;
            if (!t) return false;
            for (var i = 0; i < t.length; i++) if (t[i] === 'Files') return true;
            return false;
          }
          window.addEventListener('dragenter', function(e){
            if (!isFileDrag(e)) return;
            e.preventDefault();
            depth++;
            overlay.style.display = 'flex';
          });
          window.addEventListener('dragover', function(e){
            if (!isFileDrag(e)) return;
            e.preventDefault();
          });
          window.addEventListener('dragleave', function(e){
            if (!isFileDrag(e)) return;
            depth = Math.max(0, depth - 1);
            if (depth === 0) overlay.style.display = 'none';
          });
          window.addEventListener('drop', async function(e){
            if (!isFileDrag(e)) return;
            e.preventDefault();
            depth = 0;
            overlay.style.display = 'none';
            var files = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
            if (!files.length) return;
            var conceptId = parseInt(sel.value, 10);
            if (!conceptId) { alert('Pick a concept first'); return; }
            await uploadFiles(files, conceptId);
            location.reload();
          });
          async function uploadFiles(files, conceptId){
            progress.style.display = 'block';
            var done = 0, failed = 0;
            function render(){
              progress.innerHTML = '<div style="font-weight:700;margin-bottom:4px;">Uploading ' + done + '/' + files.length + '</div>' +
                (failed ? '<div style="color:#FFB400;font-size:12px;">' + failed + ' failed</div>' : '') +
                (current ? '<div style="font-size:12px;color:#bbb;margin-top:4px;">'+current.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</div>' : '');
            }
            var current = '';
            for (var i = 0; i < files.length; i++) {
              var f = files[i];
              current = f.name;
              render();
              try {
                var kind = f.type.startsWith('video/') ? 'video' : 'image';
                var fd = new FormData(); fd.append('image', f);
                var up = await fetch('/upload', { method:'POST', body: fd });
                var upj = await up.json();
                if (!up.ok || !upj.url) throw new Error(upj.error || 'Upload failed');
                var save = await fetch('/admin/concepts/save-to-gallery', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ concept_id: conceptId, url: upj.url, kind: kind }) });
                var sj = await save.json();
                if (!save.ok) throw new Error(sj.error || 'Save failed');
                done++;
              } catch (e) {
                failed++;
                console.warn('[drop-upload]', f.name, e.message);
              }
              render();
            }
            current = '';
            progress.innerHTML = '<div style="font-weight:700;">Done · ' + done + '/' + files.length + (failed ? ' (' + failed + ' failed)' : '') + '</div>';
          }
        })();
      </script>`;

    res.send(conceptAdminPage('Gallery', body));
  } catch (err) {
    console.error('[gallery] list error:', err.message);
    res.status(500).send('Failed to load gallery: ' + escapeHtml(err.message));
  }
});

app.get('/admin/gallery/new', requireRole('admin'), async (req, res) => {
  try {
    const concepts = (await pool.query(`SELECT id, name FROM concepts ORDER BY name ASC`)).rows;
    const preselect = req.query.concept ? parseInt(req.query.concept, 10) : null;
    const conceptOpts = concepts.map((c) =>
      `<option value="${c.id}"${preselect === c.id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`
    ).join('');
    const kindOpts = CONCEPT_MEDIA_KINDS.map((k) => `<option value="${k}">${k}</option>`).join('');

    const body = `
      <div class="top"><h1>Add gallery item</h1><a href="/admin/gallery">&larr; Back to gallery</a></div>
      ${req.query.error ? `<div class="flash err">${escapeHtml(req.query.error)}</div>` : ''}
      <form method="POST" action="/admin/gallery/new" enctype="multipart/form-data">
        <div class="row">
          <div class="field"><label>Concept *</label><select name="concept_id" required>${conceptOpts}</select>
            <span class="muted">Every gallery item must belong to a concept.</span></div>
          <div class="field"><label>Kind *</label><select name="kind" required>${kindOpts}</select></div>
          <div class="field" style="display:flex;align-items:center;"><label style="font-weight:normal;display:flex;align-items:center;gap:6px;"><input type="checkbox" name="is_primary"> Mark as primary for this concept</label></div>
        </div>
        <div class="field"><label>Item filters</label><input type="text" name="filter_category" placeholder="Comma-separated, e.g. pet, royal">
          <span class="muted">Item-level filters in addition to the concept's filters. Use to tag this specific item (e.g. "pet" when the underlying photo is of a dog, even though the concept "Royal Portrait" also takes people).</span></div>
        <div class="field"><label>Upload file</label><input type="file" name="media" accept="image/*,video/*"></div>
        <div class="field"><label>— or paste a URL</label><input type="url" name="url_override" placeholder="https://..."></div>
        <div class="field"><label>Source photo URL (optional)</label><input type="url" name="source_url" placeholder="https://... — the original photo this was generated from">
          <span class="muted">If set, the landing-page rolling demo shows this as the "Before" photo when this concept is on screen. Lets the demo cycle through different originals (dog, person, etc.) instead of one fixed photo.</span></div>
        <button type="submit" class="btn">Add to gallery</button>
      </form>`;
    res.send(conceptAdminPage('Add gallery item', body));
  } catch (err) {
    console.error('[gallery] new load error:', err.message);
    res.status(500).send('Failed: ' + escapeHtml(err.message));
  }
});

app.post('/admin/gallery/new', requireRole('admin'), upload.single('media'), async (req, res) => {
  const back = '/admin/gallery/new';
  try {
    const conceptId = parseInt(req.body.concept_id, 10);
    if (!conceptId) return res.redirect(`${back}?error=` + encodeURIComponent('Pick a concept'));
    const kind = (req.body.kind || '').trim();
    if (!CONCEPT_MEDIA_KINDS.includes(kind)) return res.redirect(`${back}?error=` + encodeURIComponent('Invalid kind'));
    const isPrimary = req.body.is_primary === 'on' || req.body.is_primary === 'true';
    const filterCategory = (req.body.filter_category || '').trim() || null;
    const sourceUrl = (req.body.source_url || '').trim() || null;
    const urlOverride = (req.body.url_override || '').trim();

    let url = urlOverride;
    if (req.file && req.file.buffer) {
      const resourceType = kind === 'video' ? 'video' : 'image';
      const result = await uploadStream(req.file.buffer, {
        kind: 'gallery',
        contentType: req.file.mimetype,
        originalName: req.file.originalname,
        resource_type: resourceType,
      });
      url = result.secure_url;
    }
    if (!url) return res.redirect(`${back}?error=` + encodeURIComponent('Provide a file or a URL'));

    const maxRes = await pool.query(
      `SELECT COALESCE(MAX(sort_order), 0) AS m FROM concept_media WHERE concept_id = $1`,
      [conceptId]
    );
    const sortOrder = (maxRes.rows[0].m || 0) + 1;

    if (isPrimary) {
      await pool.query(`UPDATE concept_media SET is_primary = FALSE WHERE concept_id = $1`, [conceptId]);
    }
    await pool.query(
      `INSERT INTO concept_media (concept_id, kind, url, sort_order, is_primary, filter_category, source_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [conceptId, kind, url, sortOrder, isPrimary, filterCategory, sourceUrl]
    );
    res.redirect(`/admin/gallery?saved_media=1&concept=${conceptId}`);
  } catch (err) {
    console.error('[gallery] add error:', err.message);
    res.redirect(`${back}?error=` + encodeURIComponent('Add failed: ' + err.message));
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

// FX rates refresh — fires once at boot and daily at 04:00 UTC.
// Implementation in fx_cron.js. Pricing engine (pricing.js) reads from fx_rates.
scheduleFxRefresh(cron);

initDb()
  .then(() => seedGallery())
  .then(() => emailEngine.ensureSeeds())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
