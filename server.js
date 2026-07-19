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
const { uploadStream, uploadBuffer, downloadAndStore, deleteFromR2 } = require('./storage');
const { google } = require('googleapis');
const gelato = require('./gelato');
const generation = require('./generation');
const storyEngine = require('./story_engine');
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

    // Funnel: credit the purchase to the originating clip/platform (from checkout metadata).
    try {
      const attrRef = (session.metadata && session.metadata.attr_ref) || null;
      const attrSrc = (session.metadata && session.metadata.attr_src) || null;
      await pool.query(
        'INSERT INTO funnel_events (kind, ref, src, email, order_id) VALUES ($1,$2,$3,$4,$5)',
        ['purchase', attrRef || null, attrSrc || null, email || null, orderId || null]
      );
    } catch (err) {
      console.error('[funnel] purchase event:', err.message);
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

  // Click attribution from social links: /?ref=<clip ref_tag>&src=<yt|tt|ig|fb>
  const TAG_RE = /^[a-zA-Z0-9_-]{1,40}$/;
  const visitRef = TAG_RE.test(String(req.query.ref || '')) ? String(req.query.ref) : null;
  const visitSrc = TAG_RE.test(String(req.query.src || '')) ? String(req.query.src).toLowerCase() : null;

  // Remember attribution for 30 days so previews/purchases can be credited
  // to the clip/platform that brought this visitor (last touch wins).
  if (visitRef || visitSrc) {
    const cookieOpts = { maxAge: 30 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' };
    if (visitRef) res.cookie('ts_ref', visitRef, cookieOpts);
    if (visitSrc) res.cookie('ts_src', visitSrc, cookieOpts);
  }

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
              country, region, city, lat, lng, user_id, request_id, ref, src, asn_org)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [ip, method, reqPath, statusCode, userAgent, referrer,
           geo.country, geo.region, geo.city, geo.lat, geo.lng, userId, requestId,
           visitRef, visitSrc, geo.asn_org || null]
        );
      } catch (err) {
        console.error('[visits] insert error:', err.message);
      }
    })();
  });

  next();
});

// ── Flagged-IP blocking ─────────────────────────────────────────────────────
// Any IP with a flagged visit row is refused service: ~3s fake "loading" delay,
// then an empty page. Exemptions: IPs labeled 'me', and admin/auth/login/webhook
// paths (so you can never lock yourself out). Attempts are still logged in
// /admin/visits because this runs AFTER the visitor-logging middleware.
let _blockedIps = new Set();
let _blockedRefreshedAt = 0;
async function refreshBlockedIps() {
  _blockedRefreshedAt = Date.now();
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT v.ip FROM visits v
      WHERE v.flagged = TRUE
        AND NOT EXISTS (SELECT 1 FROM ip_labels l WHERE l.ip = v.ip AND LOWER(TRIM(l.label)) = 'me')
    `);
    _blockedIps = new Set(rows.map(r => r.ip));
  } catch (e) { console.error('[block] refresh:', e.message); }
}
setTimeout(refreshBlockedIps, 5000); // initial load after boot

app.use((req, res, next) => {
  const p = req.path;
  if (p.startsWith('/admin') || p.startsWith('/auth') || p === '/login' || p === '/webhook' || p === '/healthz') return next();
  if (Date.now() - _blockedRefreshedAt > 60 * 1000) refreshBlockedIps(); // refresh in background
  if (_blockedIps.has(visitorIp(req) || '')) {
    setTimeout(() => {
      try {
        res.status(403).type('html').send('<!doctype html><html><head><title>Loading…</title><style>body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.s{width:40px;height:40px;border:4px solid #eee;border-top-color:#999;border-radius:50%;animation:r 1s linear infinite}@keyframes r{to{transform:rotate(360deg)}}</style></head><body><div class="s"></div></body></html>');
      } catch (e) { /* client gone */ }
    }, 3000);
    return;
  }
  next();
});

// Lightweight health check (also warms the DB pool when pinged externally)
app.get('/healthz', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false }); }
});

// Short typeable attribution links: /yt -> /?src=yt, /yt38 -> /?src=yt&ref=c38
// Usable in end cards, spoken CTAs, and pinned comments (where links aren't clickable).
app.get(/^\/(yt|tt|ig|fb)(\d+)?$/, async (req, res) => {
  const src = req.params[0];
  const clipId = req.params[1];
  let ref = null;
  if (clipId) {
    ref = 'c' + clipId;
    try {
      const { rows } = await pool.query('SELECT ref_tag FROM social_clips WHERE id = $1', [parseInt(clipId)]);
      if (rows.length && rows[0].ref_tag) ref = rows[0].ref_tag;
    } catch { /* fall back to c<id> */ }
  }
  res.redirect(302, '/?src=' + src + (ref ? '&ref=' + encodeURIComponent(ref) : ''));
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

app.get('/', async (req, res) => {
  const file = cachedHomepageMode === 'loveogram'
    ? 'turtleandsun-landing.html'
    : 'calendar-waitlist.html';
  res.sendFile(path.join(__dirname, file));
});
app.get('/faq', (req, res) => res.sendFile(path.join(__dirname, 'faq.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'pricing.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));
app.get('/refund', (req, res) => res.sendFile(path.join(__dirname, 'refund.html')));
app.get('/calendar', (req, res) => res.sendFile(path.join(__dirname, 'calendar-waitlist.html')));

// ── Auth ──────────────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/auth/request-link', async (req, res) => {
  const { email, redirect: redir } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  const normalised = email.toLowerCase().trim();
  try {
    const token = await createMagicLink(normalised);
    const origin = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const safeRedir = (redir && redir.startsWith('/') && !redir.startsWith('//')) ? redir : '';
    const link = `${origin}/auth/verify?token=${token}` + (safeRedir ? `&redirect=${encodeURIComponent(safeRedir)}` : '');
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

app.get('/auth/verify', (req, res) => {
  const { token, redirect: redir } = req.query;
  if (!token) return res.redirect('/login?error=missing');
  // Show a button page — do NOT consume the token here.
  // Email security scanners (Gmail, Outlook Safe Links, etc.) pre-fetch GET
  // links and would burn the one-time token before the user ever clicks it.
  const redirAttr = redir ? ` value="${redir.replace(/"/g, '&quot;')}"` : '';
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Log in — Turtle and Sun</title>
<meta name="robots" content="noindex">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Arial',sans-serif;background:linear-gradient(175deg,#FFF5A0 0%,#FFE800 20%,#FFD000 40%,#FFC000 60%,#FFAA00 80%,#FF9500 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
.card{background:#fff;border-radius:16px;padding:40px 36px;max-width:420px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.1);text-align:center;}
h1{font-size:22px;font-weight:800;color:#1C0A00;margin-bottom:12px;}
p{font-size:14px;color:rgba(60,20,0,0.65);margin-bottom:28px;line-height:1.5;}
.btn{display:inline-block;padding:14px 36px;background:#3A6B20;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:700;cursor:pointer;transition:background 0.18s;}
.btn:hover{background:#1C0A00;}
</style>
</head>
<body>
<div class="card">
  <h1>Ready to log in?</h1>
  <p>Click the button below to complete your login to Turtle and Sun.</p>
  <form method="POST" action="/auth/verify">
    <input type="hidden" name="token" value="${token.replace(/"/g, '&quot;')}">
    <input type="hidden" name="redirect"${redirAttr}>
    <button class="btn" type="submit">Log me in</button>
  </form>
</div>
</body>
</html>`);
});

app.post('/auth/verify', async (req, res) => {
  const token = req.body.token;
  const redir = req.body.redirect;
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
    // If a redirect was requested (e.g. /print/calendar), honour it;
    // otherwise go to /admin or /account.
    let dest = (redir && redir.startsWith('/') && !redir.startsWith('//')) ? redir
              : (adminCheck.rows.length ? '/admin' : '/account');
    res.redirect(dest);
  } catch (err) {
    console.error('Verify error:', err.message);
    res.redirect('/login?error=server');
  }
});

// ── Dev mode (Stripe bypass for testing) ─────────────────────────────────────
// Cached so synchronous template helpers (conceptAdminPage) can read it without
// awaiting the DB on every render. Loaded at startup + refreshed after toggle.
let cachedDevMode = false;
let cachedHomepageMode = 'calendar'; // 'calendar' | 'loveogram'
async function loadDevMode() {
  try {
    const hmR = await pool.query(`SELECT value FROM system_settings WHERE key = 'homepage_mode'`);
    if (hmR.rows[0]) cachedHomepageMode = hmR.rows[0].value;
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

app.post('/admin/homepage/toggle', requireRole('admin'), async (req, res) => {
  const return_to = req.body?.return_to || '/admin';
  cachedHomepageMode = cachedHomepageMode === 'calendar' ? 'loveogram' : 'calendar';
  try {
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('homepage_mode', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [cachedHomepageMode]
    );
  } catch(e) { console.error('[homepage toggle]', e); }
  res.redirect(return_to);
});

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


// ── User settings (holiday country) ─────────────────────────────────────────
app.get('/api/user/settings', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const result = await require('./db').pool.query(
    'SELECT holiday_country FROM users WHERE id=$1', [user.id]
  );
  res.json({ holiday_country: result.rows[0]?.holiday_country || null });
});

app.put('/api/user/settings', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const { holiday_country } = req.body || {};
  await require('./db').pool.query(
    'UPDATE users SET holiday_country=$1 WHERE id=$2',
    [holiday_country || null, user.id]
  );
  res.json({ ok: true });
});

// ── Holiday cache (DB-backed, 30-day refresh) ────────────────────────────────
const HOLIDAY_TTL_DAYS = 30;
const _memHolidays = {}; // in-process cache to skip DB on repeated requests

app.get('/api/holidays', async (req, res) => {
  const { year, country } = req.query;
  if (!year || !country) return res.status(400).json({ error: 'year and country required' });
  const key = `${year}-${country}`;
  if (_memHolidays[key]) return res.json(_memHolidays[key]);

  const { pool } = require('./db');
  // Check DB cache
  const cached = await pool.query(
    `SELECT holidays, fetched_at FROM holiday_cache WHERE country_code=$1 AND year=$2`,
    [country, parseInt(year)]
  );
  if (cached.rows.length) {
    const ageMs = Date.now() - new Date(cached.rows[0].fetched_at).getTime();
    if (ageMs < HOLIDAY_TTL_DAYS * 86400000) {
      _memHolidays[key] = cached.rows[0].holidays;
      return res.json(cached.rows[0].holidays);
    }
  }

  // Fetch from Nager.Date and upsert into DB
  try {
    const r = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`);
    if (!r.ok) {
      // Return stale DB data if available rather than failing
      if (cached.rows.length) return res.json(cached.rows[0].holidays);
      return res.status(502).json({ error: 'Holiday API error' });
    }
    const data = await r.json();
    await pool.query(
      `INSERT INTO holiday_cache (country_code, year, holidays, fetched_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (country_code, year) DO UPDATE SET holidays=$3, fetched_at=NOW()`,
      [country, parseInt(year), JSON.stringify(data)]
    );
    _memHolidays[key] = data;
    res.json(data);
  } catch (e) {
    if (cached.rows.length) return res.json(cached.rows[0].holidays);
    res.status(502).json({ error: 'Holiday API unreachable' });
  }
});

app.get('/api/holidays/countries', async (req, res) => {
  if (_memHolidays['__countries']) return res.json(_memHolidays['__countries']);

  const { pool } = require('./db');
  const cached = await pool.query(`SELECT countries, fetched_at FROM holiday_countries_cache WHERE id=1`);
  if (cached.rows.length) {
    const ageMs = Date.now() - new Date(cached.rows[0].fetched_at).getTime();
    if (ageMs < HOLIDAY_TTL_DAYS * 86400000) {
      _memHolidays['__countries'] = cached.rows[0].countries;
      return res.json(cached.rows[0].countries);
    }
  }

  try {
    const r = await fetch('https://date.nager.at/api/v3/AvailableCountries');
    if (!r.ok) {
      if (cached.rows.length) return res.json(cached.rows[0].countries);
      return res.status(502).json({ error: 'Holiday API error' });
    }
    const data = await r.json();
    await pool.query(
      `INSERT INTO holiday_countries_cache (id, countries, fetched_at)
       VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET countries=$1, fetched_at=NOW()`,
      [JSON.stringify(data)]
    );
    _memHolidays['__countries'] = data;
    res.json(data);
  } catch (e) {
    if (cached.rows.length) return res.json(cached.rows[0].countries);
    res.status(502).json({ error: 'Holiday API unreachable' });
  }
});

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
      const job_title = c.organizations?.[0]?.title || null;
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
        `INSERT INTO contacts (user_id, google_id, name, email, phone, company, job_title, street, street_2, city, region, country, postal_code, birthday)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (user_id, google_id) DO UPDATE
           SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone,
               company = EXCLUDED.company, job_title = EXCLUDED.job_title,
               street = EXCLUDED.street, street_2 = EXCLUDED.street_2,
               city = EXCLUDED.city, region = EXCLUDED.region, country = EXCLUDED.country,
               postal_code = EXCLUDED.postal_code, birthday = EXCLUDED.birthday`,
        [user.id, googleId, name, email, phone, company, job_title, street, street_2, city, region, country, postal_code, birthday]
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
      card('Waitlist', 'Email signups for calendar print launch.', '/admin/waitlist') +
      card('Visits & visitors map', 'Traffic log, geo map, and IP labels.', '/admin/visits') +
      card('Generation review', 'Quality-check every AI output — flag bad ones, trigger regeneration.', '/admin/generations') +
      card('Asset storage', 'See every file — R2, Cloudinary, fal.ai. Migrate anything not on R2.', '/admin/assets')
    )}

    ${section('\u{1F3A8} Content',
      card('Video stories', 'The video engine: generate stories, review, make Kling videos, assemble with end-card, insights.', '/admin/video-stories') +
      card('Studio', 'Concepts with triplet grids — drop a photo to make a new triplet.', '/admin/studio') +
      card('Produce', 'Filter triplets by dimension, make clips (Style A/B), track render status.', '/admin/social-clips') +
      card('Tracker', 'Track published videos: platform metadata, view stats, YouTube auto-fetch.', '/admin/social-tracker') +
      card('Concepts library', 'Manage style concepts and prompts.', '/admin/concepts') +
      card('Gallery', 'Manage public gallery items (images, videos, cards, books).', '/admin/gallery') +
      card('Reviews', 'Moderate customer reviews; approve to publish on the landing.', '/admin/reviews')
    )}

    ${section('\u{1F4B0} Pricing',
      card('Currencies & FX', 'Live FX rates, supported currencies, manual refresh.', '/admin/currencies')
    )}

    ${section('\u{1F4C6} Occasions & campaigns',
      card('Gifting occasions', 'National occasions, live dates, markets — the reminder list for what to run.', '/admin/occasions')
    )}

    <h2 class="admin-section">\u{1F527} Developing <span class="admin-section-sub">— work in progress + dev tools, never visible to customers</span></h2>
    <div class="admin-grid">
      ${card('Email engine', 'Lifecycle email: templates, sequences, enrollments. Work in progress.', '/admin/email')}
      <form method="POST" action="/admin/homepage/toggle" style="margin:0;">
        <input type="hidden" name="return_to" value="/admin">
        <button type="submit" class="admin-card" style="background:#fff;border:2px solid #FFE800;text-align:left;cursor:pointer;width:100%;font-family:inherit;">
          <div class="admin-card-title">Homepage: <strong style="color:#1C0A00;">${cachedHomepageMode === 'calendar' ? '📅 Calendar waitlist' : '🖼️ Loveogram'}</strong></div>
          <div class="admin-card-desc">Currently showing the ${cachedHomepageMode === 'calendar' ? 'calendar waitlist page' : 'Loveogram landing page'} at /. Click to switch.</div>
        </button>
      </form>
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
// Waitlist — capture emails before calendar print service launches (2026-06-19)
// ---------------------------------------------------------------------------
app.post('/api/waitlist', async (req, res) => {
  const { email, src, ref } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  try {
    const ip = visitorIp(req) || 'unknown';
    const geo = await geoLookup(ip).catch(() => ({}));
    // Generate discount code: PRINT25-XXXXXX
    const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
    const discount_code = 'PRINT25-' + rand;

    const result = await pool.query(
      `INSERT INTO waitlist (email, src, ref, referrer, user_agent, country, city, ip, discount_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (email) DO UPDATE SET src=EXCLUDED.src, ref=EXCLUDED.ref
       RETURNING discount_code, (xmax=0) AS is_new`,
      [email,
       src || req.query.src || req.cookies?.ts_src || null,
       ref || req.query.ref || req.cookies?.ts_ref || null,
       req.headers.referer || null, req.headers['user-agent'] || null,
       geo.country || null, geo.city || null, ip, discount_code]
    );
    const row = result.rows[0];
    const code = row.discount_code;
    const isNew = row.is_new;

    if (isNew) {
      // Send confirmation email via Resend
      await resend.emails.send({
        from: 'Turtle and Sun <hello@turtleandsun.com>',
        to: email,
        subject: 'You\'re on the list — 25% off when we launch 🗓️',
        html: `
          <div style="font-family:'DM Sans',Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#FFF5A0;border-radius:16px;">
            <h1 style="font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:28px;font-weight:800;color:#1C0A00;margin:0 0 12px;">You're on the list! 🎉</h1>
            <p style="font-size:16px;color:#1C0A00;line-height:1.5;margin:0 0 20px;">
              We're putting the finishing touches on our <strong>calendar print service</strong> — 
              beautifully designed family calendars you can print at home or order delivered.
            </p>
            <p style="font-size:16px;color:#1C0A00;line-height:1.5;margin:0 0 24px;">
              As one of our early supporters, you get <strong>25% off</strong> your first order. 
              Save this email — your discount code is below.
            </p>
            <div style="background:#1C0A00;color:#FFE800;font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:22px;font-weight:800;letter-spacing:0.1em;padding:16px 24px;border-radius:10px;text-align:center;margin:0 0 24px;">
              ${code}
            </div>
            <p style="font-size:14px;color:rgba(28,10,0,0.6);margin:0;">
              We'll email you as soon as the service goes live. 
              Questions? Reply to this email anytime.
            </p>
            <p style="font-size:14px;color:rgba(28,10,0,0.6);margin:24px 0 0;">
              — The Turtle and Sun team
            </p>
          </div>
        `,
      }).catch(err => console.error('[waitlist] Resend error:', err));
    }

    res.json({ ok: true, code, is_new: isNew });
  } catch (err) {
    console.error('[waitlist] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/admin/waitlist', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, discount_code, country, city, src, ref, created_at
     FROM waitlist ORDER BY created_at DESC LIMIT 500`
  );
  const rows_html = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.email)}</td>
      <td><code>${escapeHtml(r.discount_code || '')}</code></td>
      <td>${escapeHtml(r.country || '')}</td>
      <td>${escapeHtml(r.city || '')}</td>
      <td>${escapeHtml(r.src || '')}</td>
      <td>${escapeHtml(r.ref || '')}</td>
      <td style="white-space:nowrap;font-size:12px;">${new Date(r.created_at).toISOString().slice(0,16).replace('T',' ')}</td>
    </tr>`).join('');
  const body = `
    <h1>Waitlist (${rows.length})</h1>
    <style>
      table{border-collapse:collapse;width:100%;font-size:13px;}
      th,td{padding:8px 12px;border:1px solid #eee;text-align:left;}
      th{background:#f5f5f5;font-weight:600;}
      tr:hover td{background:#fffde7;}
    </style>
    <table>
      <thead><tr>
        <th>Email</th><th>Discount code</th><th>Country</th><th>City</th>
        <th>src</th><th>ref</th><th>Signed up</th>
      </tr></thead>
      <tbody>${rows_html || '<tr><td colspan="7" style="color:#999;text-align:center;">No signups yet</td></tr>'}</tbody>
    </table>`;
  res.send(conceptAdminPage('Waitlist', body));
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

// ASN orgs that are hosting/cloud providers — JS-executing crawlers from
// these networks must not count as "humans". (GeoLite2-ASN org strings.)
const DATACENTER_ASN_RE = 'amazon|^aws|ec2|^google$|google llc|google-cloud|microsoft|azure|digitalocean|hetzner|^ovh|alibaba|tencent|oracle|linode|vultr|choopa|m247|datacamp|leaseweb|contabo|fastly|cloudflare|akamai|hostinger|ionos|scaleway|upcloud|kamatera|softlayer|huawei'
  // Social platforms' own networks — their link-checkers spoof real browser
  // UAs (verified: Meta fetches with fake Chrome/iPhone agents), so they can
  // only be excluded by ASN. No customer browses from Facebook's servers.
  + '|facebook|meta platforms|twitter|x corp|snap inc|linkedin|bytedance|pinterest';

const BOT_UA_RE = 'bot|crawler|spider|scrape|headless|uptime|monitor|python-requests|curl|wget'
  + '|facebookexternalhit|meta-externalagent|externalhit|bytespider|bytedance|tiktok'
  + '|snapchat|pinterest|telegram|whatsapp|discord|slack|skypeuripreview|vkshare|preview|embedly|quora link'
  + '|google-safety|google-inspectiontool|feedfetcher';

// A visit that counts as a REAL link click (funnel numbers): browser-like UA,
// not from a datacenter network, not flagged, not from an IP labeled 'me'.
// Link-preview crawlers from YouTube/TikTok/Meta fetch every posted link —
// without this filter the funnel counts them as customers.
const HUMAN_CLICK_WHERE = `
  COALESCE(v.user_agent,'') !~* '${BOT_UA_RE}'
  AND COALESCE(v.asn_org,'') !~* '${DATACENTER_ASN_RE}'
  AND v.flagged = FALSE
  AND NOT EXISTS (SELECT 1 FROM ip_labels il WHERE il.ip = v.ip AND il.label ILIKE 'me')`;

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
              v.referrer, v.country, v.region, v.city, v.lat, v.lng, v.user_id, v.request_id, v.flagged, v.engaged, v.scroll_pct, v.dwell_ms, v.ref, v.src, v.asn_org,
              u.email AS email, l.label AS label
       FROM visits v
       LEFT JOIN users u ON v.user_id = u.id
       LEFT JOIN ip_labels l ON v.ip = l.ip
       ${whereSql}
       ORDER BY v.created_at DESC
       LIMIT $${params.length}`,
      params
    );

    const [totals, humansToday, topCountry, topPath, salesByEmailRes, salesTotalRes] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total, COUNT(DISTINCT ip)::int AS unique_ips
         FROM visits WHERE created_at >= ${UTC_DAY_START}`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS humans FROM (
           SELECT v.ip FROM visits v
           LEFT JOIN ip_labels il ON il.ip = v.ip
           WHERE v.created_at >= ${UTC_DAY_START}
           GROUP BY v.ip
           HAVING BOOL_OR(v.engaged)
              AND NOT BOOL_OR(COALESCE(v.user_agent,'') ~* 'bot|crawler|spider|scrape|headless|uptime|monitor|python-requests|curl|wget')
              AND NOT BOOL_OR(COALESCE(v.asn_org,'') ~* '${DATACENTER_ASN_RE}')
              AND NOT BOOL_OR(COALESCE(il.label,'') ILIKE 'me')
         ) h`
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
        humans_today: humansToday.rows[0].humans,
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
  res.redirect('/account/studio'); // contacts page retired 2026-07-12 — Studio covers it
});

app.get('/account/network', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'network.html'));
});

app.get('/account/studio', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'studio-groups.html'));
});

// Public self-service fill-in page (no auth — gated by the share token instead)
app.get('/join/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'join.html'));
});

// Public group website (no auth — gated by the site token instead)
app.get('/site/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'group-site.html'));
});

// Internal staff board (no auth — gated by its own token; full contact details)
app.get('/board/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'group-board.html'));
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

app.get('/print/calendar', async (req, res) => {
  const user = await getSessionUser(req).catch(() => null);
  if (!user) return res.redirect('/login?redirect=' + encodeURIComponent('/print/calendar' + (req.url.replace(/^\/print\/calendar/, '') || '')));
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

// Update a group — rename and/or move it under a new parent (drag-and-drop re-parent).
// Send parent_group_id: null for top-level, or a group id to nest under it.
app.put('/api/groups/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const g = await pool.query(`SELECT id, name FROM groups WHERE id=$1 AND user_id=$2`, [id, req.user.id]);
    if (!g.rows.length) return res.status(404).json({ error: 'Group not found' });

    const fields = [];
    const vals = [];
    if (typeof req.body.name === 'string' && req.body.name.trim()) {
      vals.push(req.body.name.trim()); fields.push(`name = $${vals.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'parent_group_id')) {
      const pid = req.body.parent_group_id || null;
      if (pid) {
        if (String(pid) === String(id)) return res.status(400).json({ error: 'A group cannot be its own parent.' });
        const parent = await pool.query(`SELECT id, name, parent_group_id FROM groups WHERE id=$1 AND user_id=$2`, [pid, req.user.id]);
        if (!parent.rows.length) return res.status(404).json({ error: 'Parent group not found' });
        if (parent.rows[0].name === 'Family') return res.status(400).json({ error: 'Family cannot have subgroups.' });
        // Cycle guard: walk up from the new parent — if we reach this group, the move would loop.
        let cur = parent.rows[0];
        while (cur && cur.parent_group_id) {
          if (String(cur.parent_group_id) === String(id)) return res.status(400).json({ error: 'Cannot move a group into one of its own subgroups.' });
          const up = await pool.query(`SELECT id, parent_group_id FROM groups WHERE id=$1 AND user_id=$2`, [cur.parent_group_id, req.user.id]);
          cur = up.rows[0];
        }
      }
      vals.push(pid); fields.push(`parent_group_id = $${vals.length}`);
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

    vals.push(id, req.user.id);
    const result = await pool.query(
      `UPDATE groups SET ${fields.join(', ')} WHERE id = $${vals.length - 1} AND user_id = $${vals.length}
       RETURNING id, name, parent_group_id`, vals);
    res.json(result.rows[0]);
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

// ── Turtle Studio: group members, dated memberships & self-service links ───────

// All members of a group (including its direct subgroups), with membership
// dates, status, self_managed flag, photo, location, and the other groups each
// member also belongs to ("även i"). Read-only; nothing here mutates data.
app.get('/api/groups/:id/members', requireAuth, async (req, res) => {
  try {
    const groupId = parseInt(req.params.id, 10);
    const owner = req.user.id;

    const grp = await pool.query(
      `SELECT id, name, parent_group_id FROM groups WHERE id = $1 AND user_id = $2`,
      [groupId, owner]
    );
    if (!grp.rows.length) return res.status(404).json({ error: 'Group not found' });

    const subgroups = await pool.query(
      `SELECT id, name FROM groups WHERE parent_group_id = $1 AND user_id = $2 ORDER BY name`,
      [groupId, owner]
    );
    const treeIds = [groupId, ...subgroups.rows.map(s => s.id)];

    const members = await pool.query(
      `SELECT m.id AS membership_id, m.contact_id, m.group_id,
              m.from_date, m.to_date, m.status, m.self_managed,
              g.name AS group_name, g.parent_group_id,
              c.name, c.email, c.phone, c.photo_url, c.birthday,
              c.city, c.country, c.latitude, c.longitude
       FROM contact_group_memberships m
       JOIN contacts c ON c.id = m.contact_id
       JOIN groups g   ON g.id = m.group_id
       WHERE m.user_id = $1 AND m.group_id = ANY($2)
       ORDER BY c.name NULLS LAST`,
      [owner, treeIds]
    );

    const contactIds = [...new Set(members.rows.map(r => r.contact_id))];
    let alsoIn = {};
    if (contactIds.length) {
      const other = await pool.query(
        `SELECT m.contact_id, g.id, g.name
         FROM contact_group_memberships m
         JOIN groups g ON g.id = m.group_id
         WHERE m.user_id = $1 AND m.contact_id = ANY($2) AND NOT (m.group_id = ANY($3))`,
        [owner, contactIds, treeIds]
      );
      for (const r of other.rows) {
        (alsoIn[r.contact_id] = alsoIn[r.contact_id] || []).push({ id: r.id, name: r.name });
      }
    }

    const out = members.rows.map(r => ({
      membership_id: r.membership_id,
      contact_id: r.contact_id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      photo_url: r.photo_url,
      birthday: r.birthday,
      city: r.city,
      country: r.country,
      latitude: r.latitude,
      longitude: r.longitude,
      // subgroup = the membership's group when it is a child of the selected group;
      // null means the contact is a direct member of the selected (parent) group.
      subgroup_id: r.parent_group_id === groupId ? r.group_id : null,
      subgroup_name: r.parent_group_id === groupId ? r.group_name : null,
      from_date: r.from_date,
      to_date: r.to_date,
      status: r.status,
      self_managed: r.self_managed,
      also_in: alsoIn[r.contact_id] || [],
    }));

    res.json({ group: grp.rows[0], subgroups: subgroups.rows, members: out });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create or update a single dated membership (does not disturb other rows).
app.put('/api/memberships', requireAuth, async (req, res) => {
  const { contact_id, group_id, from_date, to_date, status, self_managed } = req.body;
  if (!contact_id || !group_id) return res.status(400).json({ error: 'contact_id and group_id required' });
  const allowed = ['invited', 'active', 'ended'];
  const st = allowed.includes(status) ? status : 'active';
  try {
    // Ownership checks — both the contact and the group must belong to the user.
    const own = await pool.query(
      `SELECT (SELECT 1 FROM contacts WHERE id = $1 AND user_id = $3) AS c,
              (SELECT 1 FROM groups   WHERE id = $2 AND user_id = $3) AS g`,
      [contact_id, group_id, req.user.id]
    );
    if (!own.rows[0].c || !own.rows[0].g) return res.status(404).json({ error: 'Contact or group not found' });

    const result = await pool.query(
      `INSERT INTO contact_group_memberships
         (user_id, contact_id, group_id, from_date, to_date, status, self_managed)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, contact_id, group_id)
       DO UPDATE SET from_date = EXCLUDED.from_date, to_date = EXCLUDED.to_date,
                     status = EXCLUDED.status, self_managed = EXCLUDED.self_managed
       RETURNING id`,
      [req.user.id, contact_id, group_id, from_date || null, to_date || null, st, !!self_managed]
    );
    res.json({ id: result.rows[0].id, ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Remove one membership (contact stays in the pool and in other groups).
app.delete('/api/memberships', requireAuth, async (req, res) => {
  const contact_id = req.query.contact_id;
  const group_id = req.query.group_id;
  if (!contact_id || !group_id) return res.status(400).json({ error: 'contact_id and group_id required' });
  try {
    await pool.query(
      `DELETE FROM contact_group_memberships WHERE user_id = $1 AND contact_id = $2 AND group_id = $3`,
      [req.user.id, contact_id, group_id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Self-service fill-in links ─────────────────────────────────────────────────

// Get the active share link for a group (if any).
app.get('/api/groups/:id/share-link', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT token, active, created_at, expires_at FROM group_share_links
       WHERE group_id = $1 AND user_id = $2 AND active = TRUE
       ORDER BY created_at DESC LIMIT 1`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.json({ token: null });
    const row = result.rows[0];
    res.json({ ...row, url: `${req.protocol}://${req.get('host')}/join/${row.token}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create (or reuse) a share link for a group.
app.post('/api/groups/:id/share-link', requireAuth, async (req, res) => {
  try {
    const grp = await pool.query(`SELECT id FROM groups WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    if (!grp.rows.length) return res.status(404).json({ error: 'Group not found' });

    const existing = await pool.query(
      `SELECT token FROM group_share_links WHERE group_id = $1 AND user_id = $2 AND active = TRUE ORDER BY created_at DESC LIMIT 1`,
      [req.params.id, req.user.id]
    );
    let token = existing.rows[0]?.token;
    if (!token) {
      token = require('crypto').randomBytes(24).toString('hex');
      await pool.query(
        `INSERT INTO group_share_links (user_id, group_id, token) VALUES ($1, $2, $3)`,
        [req.user.id, req.params.id, token]
      );
    }
    res.json({ token, url: `${req.protocol}://${req.get('host')}/join/${token}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Deactivate a group's share link.
app.delete('/api/groups/:id/share-link', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE group_share_links SET active = FALSE WHERE group_id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Public self-service endpoints (no auth — the token IS the credential) ──────

async function resolveShareToken(token) {
  const result = await pool.query(
    `SELECT s.group_id, s.user_id, g.name AS group_name
     FROM group_share_links s
     JOIN groups g ON g.id = s.group_id
     WHERE s.token = $1 AND s.active = TRUE
       AND (s.expires_at IS NULL OR s.expires_at > NOW())`,
    [token]
  );
  return result.rows[0] || null;
}

// What the member sees when they open the link: just the group name.
app.get('/api/join/:token', async (req, res) => {
  try {
    const link = await resolveShareToken(req.params.token);
    if (!link) return res.status(404).json({ error: 'This link is no longer active.' });
    res.json({ group_name: link.group_name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Member submits their own details → creates a contact in the owner's pool and a
// self_managed membership in the group. Limited to safe, member-owned fields.
app.post('/api/join/:token', async (req, res) => {
  try {
    const link = await resolveShareToken(req.params.token);
    if (!link) return res.status(404).json({ error: 'This link is no longer active.' });

    const { name, email, phone, city, country, birthday } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

    const contact = await pool.query(
      `INSERT INTO contacts (user_id, name, email, phone, city, country, birthday, is_placeholder)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE) RETURNING id`,
      [link.user_id, name.trim(), email || null, phone || null, city || null, country || null, birthday || null]
    );
    await pool.query(
      `INSERT INTO contact_group_memberships
         (user_id, contact_id, group_id, from_date, status, self_managed)
       VALUES ($1, $2, $3, CURRENT_DATE, 'active', TRUE)
       ON CONFLICT (user_id, contact_id, group_id)
       DO UPDATE SET self_managed = TRUE, status = 'active'`,
      [link.user_id, contact.rows[0].id, link.group_id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Demo content (admin only) ─────────────────────────────────────────────────
// Open in the browser while logged in as admin:
//   /api/admin/seed-demo-posts            → 50 posts for your own account, tag "Family"
//   /api/admin/seed-demo-posts?email=x&tag=Y&count=N  → override any of them
app.get('/api/admin/seed-demo-posts', requireAuth, async (req, res) => {
  try {
    const adm = await pool.query(
      "SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin'", [req.user.id]
    );
    if (!adm.rows.length) return res.status(403).json({ error: 'Admin only' });

    const me = await pool.query(`SELECT email FROM users WHERE id = $1`, [req.user.id]);
    const email = req.query.email || me.rows[0].email;
    const tag = req.query.tag || 'Family';
    const count = Math.min(parseInt(req.query.count || '50', 10) || 50, 50);

    const { seedDemoPosts } = require('./seed-demo-posts');
    const out = await seedDemoPosts(pool, { email, tag, count });
    res.json({ ok: true, ...out, note: 'Posts are tagged "demo" — rerunning replaces them.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Open in the browser while logged in as admin:
//   /api/admin/seed-demo-customers                     → 100 companies into "Kunder"
//   /api/admin/seed-demo-customers?group=X&count=N&email=Y
app.get('/api/admin/seed-demo-customers', requireAuth, async (req, res) => {
  try {
    const adm = await pool.query(
      "SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin'", [req.user.id]
    );
    if (!adm.rows.length) return res.status(403).json({ error: 'Admin only' });

    const me = await pool.query(`SELECT email FROM users WHERE id = $1`, [req.user.id]);
    const email = req.query.email || me.rows[0].email;
    const group = req.query.group || 'Kunder';
    const count = Math.min(parseInt(req.query.count || '100', 10) || 100, 200);

    const { seedDemoCustomers } = require('./seed-demo-customers');
    const out = await seedDemoCustomers(pool, { email, group, count });
    res.json({ ok: true, ...out, note: 'Rerunning replaces the demo customers. Publish the staff board for this group in the Web tab.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Import a scraped Facebook dataset (Apify JSON placed in ./demo-data) as blog
// posts. Photos are re-hosted to Cloudinary (FB URLs expire). Dedupes on the FB
// post id, so re-running is safe. Open in the browser while logged in as admin:
//   /api/admin/import-facebook?file=qcc-facebook&tag=QCC
app.get('/api/admin/import-facebook', requireAuth, async (req, res) => {
  try {
    const adm = await pool.query(
      "SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin'", [req.user.id]
    );
    if (!adm.rows.length) return res.status(403).json({ error: 'Admin only' });

    const file = String(req.query.file || 'qcc-facebook').replace(/[^a-z0-9_-]/gi, '');
    const tag = req.query.tag || 'QCC';
    const fp = path.join(__dirname, 'demo-data', file + '.json');
    if (!require('fs').existsSync(fp)) return res.status(404).json({ error: `demo-data/${file}.json not found` });
    const items = JSON.parse(require('fs').readFileSync(fp, 'utf8'));

    const { uploadStream } = require('./cloudinary');
    let inserted = 0, skipped = 0, photosDone = 0, photosFailed = 0;

    for (const p of items) {
      if (p.error || !p.postId) { skipped++; continue; }
      const text = (p.text || '').trim();
      const mediaUris = (p.media || [])
        .map(m => m.photo_image && m.photo_image.uri)
        .filter(Boolean)
        .slice(0, 4);
      if (!text && !mediaUris.length) { skipped++; continue; }

      const sourceId = 'fb:' + p.postId;
      const dupe = await pool.query(
        `SELECT 1 FROM blog_posts WHERE user_id = $1 AND source_id = $2`, [req.user.id, sourceId]
      );
      if (dupe.rows.length) { skipped++; continue; }

      const photos = [];
      for (const uri of mediaUris) {
        try {
          const r = await fetch(uri);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const buf = Buffer.from(await r.arrayBuffer());
          const up = await uploadStream(buf, { folder: 'turtleandsun/fb-import' });
          photos.push(up.secure_url);
          photosDone++;
        } catch (e) { photosFailed++; }
      }

      const post_date = p.time ? String(p.time).slice(0, 10) : new Date().toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO blog_posts (user_id, title, body, post_date, tags, photos, source_id)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
        [req.user.id, null, text || null, post_date,
         JSON.stringify([tag, 'fb-import']), JSON.stringify(photos), sourceId]
      );
      inserted++;
    }

    res.json({ ok: true, inserted, skipped, photosDone, photosFailed, tag,
      note: `Posts are tagged "${tag}" + "fb-import". A group named "${tag}" shows them on its site; delete them all via the timeline or: tags @> ["fb-import"].` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Import a contact list (JSON in ./demo-data) into a group — e.g. a company's
// team harvested from their website. Dedupes via google_id marker; re-run safe.
//   /api/admin/import-contacts?file=qcc-team
app.get('/api/admin/import-contacts', requireAuth, async (req, res) => {
  try {
    const adm = await pool.query(
      "SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin'", [req.user.id]
    );
    if (!adm.rows.length) return res.status(403).json({ error: 'Admin only' });

    const file = String(req.query.file || '').replace(/[^a-z0-9_-]/gi, '');
    const fp = path.join(__dirname, 'demo-data', file + '.json');
    if (!file || !require('fs').existsSync(fp)) return res.status(404).json({ error: `demo-data/${file}.json not found` });
    const data = JSON.parse(require('fs').readFileSync(fp, 'utf8'));
    const groupName = req.query.group || data.group || 'Imported';

    let grp = await pool.query(`SELECT id FROM groups WHERE user_id = $1 AND LOWER(name) = LOWER($2)`, [req.user.id, groupName]);
    let groupId = grp.rows[0]?.id;
    if (!groupId) {
      const ins = await pool.query(`INSERT INTO groups (user_id, name) VALUES ($1, $2) RETURNING id`, [req.user.id, groupName]);
      groupId = ins.rows[0].id;
    }

    const { uploadStream } = require('./cloudinary');
    let inserted = 0, updated = 0, photosDone = 0;
    let i = 0;
    for (const c of (data.contacts || [])) {
      i++;
      if (!c.name) continue;
      const marker = 'import-' + file + '-' + i;

      // Photo: download from the source site, re-host on Cloudinary.
      let photoUrl = null;
      if (c.photo) {
        try {
          const r = await fetch(c.photo);
          if (r.ok) {
            const up = await uploadStream(Buffer.from(await r.arrayBuffer()), { folder: 'turtleandsun/site-import' });
            photoUrl = up.secure_url; photosDone++;
          }
        } catch (e) { /* no photo is honest */ }
      }

      const row = await pool.query(
        `INSERT INTO contacts (user_id, google_id, name, email, phone, company, job_title, city, country, about, photo_url, is_placeholder)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Sverige',$9,$10,FALSE)
         ON CONFLICT (user_id, google_id) DO UPDATE
           SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone,
               company = EXCLUDED.company, job_title = EXCLUDED.job_title, about = EXCLUDED.about,
               photo_url = COALESCE(EXCLUDED.photo_url, contacts.photo_url)
         RETURNING (xmax = 0) AS is_new, id`,
        [req.user.id, marker, c.name, c.email || null, c.phone || null,
         c.company || data.company || null, c.job_title || null, c.city || data.city || null, c.about || null, photoUrl]
      );
      row.rows[0].is_new ? inserted++ : updated++;
      await pool.query(
        `INSERT INTO contact_group_memberships (user_id, contact_id, group_id, from_date, status)
         VALUES ($1,$2,$3,CURRENT_DATE,'active')
         ON CONFLICT (user_id, contact_id, group_id) DO NOTHING`,
        [req.user.id, row.rows[0].id, groupId]
      );
    }

    res.json({ ok: true, inserted, updated, group: groupName });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Crawl a website via Apify's Website Content Crawler and import the people
// found on it (name + email + phone + photo) into a group.
//   /api/admin/crawl-import?token=APIFY_TOKEN&url=https://www.qcc.se&group=QCC2&mode=strict
// mode=strict: every value must exist verbatim in the page, else the row/field
// is dropped (no photo = no photo, no title ever). mode=loose: keeps partial
// rows and guesses photo association. Dedupe key: google_id 'crawl:<group>:<email>'.
app.get('/api/admin/crawl-import', requireAuth, async (req, res) => {
  try {
    const adm = await pool.query(
      "SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin'", [req.user.id]
    );
    if (!adm.rows.length) return res.status(403).json({ error: 'Admin only' });

    const apifyToken = req.query.token;
    const siteUrl2 = req.query.url;
    const groupName = req.query.group || 'Crawl';
    const mode = req.query.mode === 'loose' ? 'loose' : 'strict';
    if (!apifyToken || !siteUrl2) return res.status(400).json({ error: 'token and url are required' });

    let pages;
    if (req.query.engine === 'direct') {
      // Server-rendered sites: fetch the page ourselves — full raw HTML, no
      // crawler middleman, no cookie-overlay truncation.
      const r = await fetch(siteUrl2, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TurtleAndSun/1.0)' } });
      if (!r.ok) return res.status(502).json({ error: 'Fetch failed: HTTP ' + r.status });
      const html = await r.text();
      pages = [{ url: siteUrl2, html, text: html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ') }];
    } else {
      const runRes = await fetch(
        'https://api.apify.com/v2/acts/apify~website-content-crawler/run-sync-get-dataset-items?token=' + encodeURIComponent(apifyToken),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            startUrls: [{ url: siteUrl2 }],
            maxCrawlPages: 3,
            maxCrawlDepth: 0,
            crawlerType: 'playwright:firefox',
            removeCookieWarnings: true,
            maxScrollHeightPixels: 50000,
            htmlTransformer: 'none',
            saveHtml: true,
          }),
        }
      );
      if (!runRes.ok) {
        const t = await runRes.text();
        return res.status(502).json({ error: 'Apify run failed: HTTP ' + runRes.status, detail: t.slice(0, 300) });
      }
      pages = await runRes.json();
      if (!Array.isArray(pages) || !pages.length) return res.status(502).json({ error: 'Crawler returned no pages' });
    }

    // Group: find or create.
    let grp = await pool.query(`SELECT id FROM groups WHERE user_id = $1 AND LOWER(name) = LOWER($2)`, [req.user.id, groupName]);
    let groupId = grp.rows[0]?.id;
    if (!groupId) {
      const ins = await pool.query(`INSERT INTO groups (user_id, name) VALUES ($1, $2) RETURNING id`, [req.user.id, groupName]);
      groupId = ins.rows[0].id;
    }

    const { uploadStream } = require('./cloudinary');
    const seen = new Set();
    let inserted = 0, dropped = 0, photosDone = 0;
    const report = [];

    const diagnostics = pages.map(p => {
      const h = p.html || '';
      const stripped = h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const telAt = stripped.search(/Tel/i);
      return {
        url: p.url, keys: Object.keys(p),
        textLen: (p.text || '').length, htmlLen: h.length, mdLen: (p.markdown || '').length,
        cfemailAttrs: (h.match(/data-cfemail/g) || []).length,
        emailProtectionLinks: (h.match(/email-protection/g) || []).length,
        atSigns: (h.match(/@/g) || []).length,
        telSnippet: telAt >= 0 ? stripped.slice(Math.max(0, telAt - 150), telAt + 100) : null,
      };
    });

    // Cloudflare email protection: addresses are XOR-encoded in data-cfemail
    // attributes and normally decoded by the visitor's browser. Same math here.
    const cfDecode = hex => {
      const k = parseInt(hex.slice(0, 2), 16); let out = '';
      for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k);
      return out;
    };

    for (const page of pages) {
      // Swap protected anchors for their decoded address IN PLACE, so the
      // email keeps its position next to the person's name and phone.
      const html = (page.html || '')
        .replace(/<a[^>]*data-cfemail="([0-9a-fA-F]+)"[^>]*>[\s\S]*?<\/a>/g, (m, h) => ' ' + cfDecode(h) + ' ')
        .replace(/<span[^>]*data-cfemail="([0-9a-fA-F]+)"[^>]*>[\s\S]*?<\/span>/g, (m, h) => ' ' + cfDecode(h) + ' ');
      // Search everything the crawler gave us — text, markdown AND raw html.
      const text = ((page.text || '') + ' ' + (page.markdown || '') + ' ' + html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
      const emails = [...new Set((text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g) || []))];

      for (const email of emails) {
        if (seen.has(email)) continue;
        seen.add(email);
        if (/^(info|kontakt|office|hello|mail)@/i.test(email)) continue;

        const at = text.indexOf(email);
        const before = text.slice(Math.max(0, at - 300), at);
        const after = text.slice(at, at + 300);

        // Name: the last capitalized 2–3 word sequence before the email — must
        // exist verbatim in the page (it comes from the page, so it does).
        const nameMatches = before.match(/[A-ZÅÄÖÉ][a-zà-öåäöé]+(?: [A-ZÅÄÖÉ][a-zà-öåäöé]+){1,2}/g) || [];
        let name = nameMatches.length ? nameMatches[nameMatches.length - 1] : null;
        if (!name && mode === 'loose') {
          name = email.split('@')[0].split('.').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        }
        if (!name) { dropped++; report.push({ email, dropped: 'no name found' }); continue; }

        // Phone: strict needs a "Tel"-prefixed number near the email; loose takes any.
        const phoneStrict = after.match(/Tel[.:]?\s*([0-9][0-9 \-]{6,})/i) || before.match(/Tel[.:]?\s*([0-9][0-9 \-]{6,})/i);
        const phoneLoose = after.match(/([0-9]{2,4}[ \-][0-9]{2,4}[ \-][0-9 \-]{2,})/);
        const phone = phoneStrict ? phoneStrict[1].trim() : (mode === 'loose' && phoneLoose ? phoneLoose[1].trim() : null);

        // Photo: an <img> shortly before the email in the raw HTML.
        let photoUrl = null;
        const hAt = html.indexOf(email);
        if (hAt > 0) {
          const win = html.slice(Math.max(0, hAt - (mode === 'loose' ? 5000 : 1500)), hAt);
          const imgs = [...win.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => m[1])
            .filter(u => !/logo|icon|\.svg/i.test(u));
          if (imgs.length) {
            try {
              const abs = new URL(imgs[imgs.length - 1], page.url || siteUrl2).href;
              const r = await fetch(abs);
              if (r.ok) {
                const up = await uploadStream(Buffer.from(await r.arrayBuffer()), { folder: 'turtleandsun/crawl-import' });
                photoUrl = up.secure_url; photosDone++;
              }
            } catch (e) { /* no photo is honest */ }
          }
        }

        const marker = 'crawl:' + groupName + ':' + email.toLowerCase();
        const row = await pool.query(
          `INSERT INTO contacts (user_id, google_id, name, email, phone, photo_url, is_placeholder)
           VALUES ($1,$2,$3,$4,$5,$6,FALSE)
           ON CONFLICT (user_id, google_id) DO UPDATE
             SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone,
                 photo_url = COALESCE(EXCLUDED.photo_url, contacts.photo_url)
           RETURNING id`,
          [req.user.id, marker, name, email, phone, photoUrl]
        );
        await pool.query(
          `INSERT INTO contact_group_memberships (user_id, contact_id, group_id, from_date, status)
           VALUES ($1,$2,$3,CURRENT_DATE,'active')
           ON CONFLICT (user_id, contact_id, group_id) DO NOTHING`,
          [req.user.id, row.rows[0].id, groupId]
        );
        inserted++;
        report.push({ name, email, phone: phone || null, photo: !!photoUrl });
      }
    }

    res.json({ ok: true, v: 4, mode, group: groupName, pagesCrawled: pages.length, inserted, dropped, photosDone, report, diagnostics });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Remove everything a crawl import created (contacts marked with the group's prefix).
//   /api/admin/remove-crawl?group=QCC2
app.get('/api/admin/remove-crawl', requireAuth, async (req, res) => {
  try {
    const adm = await pool.query(
      "SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin'", [req.user.id]
    );
    if (!adm.rows.length) return res.status(403).json({ error: 'Admin only' });
    const groupName = req.query.group;
    if (!groupName) return res.status(400).json({ error: 'group is required' });

    const old = await pool.query(
      `SELECT id FROM contacts WHERE user_id = $1 AND google_id LIKE $2`,
      [req.user.id, 'crawl:' + groupName + ':%']
    );
    const ids = old.rows.map(r => r.id);
    if (ids.length) {
      await pool.query(`DELETE FROM contact_group_memberships WHERE user_id = $1 AND contact_id = ANY($2)`, [req.user.id, ids]);
      await pool.query(`DELETE FROM occasions WHERE user_id = $1 AND contact_id = ANY($2)`, [req.user.id, ids]);
      await pool.query(`DELETE FROM contact_relationships WHERE user_id = $1 AND (contact_a_id = ANY($2) OR contact_b_id = ANY($2))`, [req.user.id, ids]);
      await pool.query(`DELETE FROM contacts WHERE user_id = $1 AND id = ANY($2)`, [req.user.id, ids]);
    }
    res.json({ ok: true, removed: ids.length, note: 'The group itself can be deleted in the sidebar (✕).' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Move every member of one group into another (memberships only — the contacts
// themselves are untouched). Dedupe-safe: already-members are skipped.
//   /api/admin/move-group-members?from=QCC2&to=QCC
app.get('/api/admin/move-group-members', requireAuth, async (req, res) => {
  try {
    const adm = await pool.query(
      "SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin'", [req.user.id]
    );
    if (!adm.rows.length) return res.status(403).json({ error: 'Admin only' });
    const fromName = req.query.from, toName = req.query.to;
    if (!fromName || !toName) return res.status(400).json({ error: 'from and to are required' });
    if (fromName.toLowerCase() === toName.toLowerCase()) return res.status(400).json({ error: 'from and to are the same group' });

    const g = async name => {
      const r = await pool.query(`SELECT id FROM groups WHERE user_id = $1 AND LOWER(name) = LOWER($2)`, [req.user.id, name]);
      return r.rows[0]?.id;
    };
    const fromId = await g(fromName), toId = await g(toName);
    if (!fromId) return res.status(404).json({ error: `Group "${fromName}" not found` });
    if (!toId) return res.status(404).json({ error: `Group "${toName}" not found` });

    // Copy memberships into the target (keeping dates/status), skip existing…
    const copied = await pool.query(
      `INSERT INTO contact_group_memberships (user_id, contact_id, group_id, from_date, to_date, status)
       SELECT user_id, contact_id, $3, from_date, to_date, status
       FROM contact_group_memberships WHERE user_id = $1 AND group_id = $2
       ON CONFLICT (user_id, contact_id, group_id) DO NOTHING
       RETURNING contact_id`,
      [req.user.id, fromId, toId]
    );
    // …then empty the source group.
    const removed = await pool.query(
      `DELETE FROM contact_group_memberships WHERE user_id = $1 AND group_id = $2 RETURNING contact_id`,
      [req.user.id, fromId]
    );
    res.json({
      ok: true, v: 1, from: fromName, to: toName,
      moved: copied.rows.length,
      alreadyInTarget: removed.rows.length - copied.rows.length,
      note: `"${fromName}" is now empty — delete it in the sidebar (✕) when you're happy.`,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Remove everything a file import created (mirror of remove-crawl for the
// import-contacts markers).  /api/admin/remove-import?file=qcc-team
app.get('/api/admin/remove-import', requireAuth, async (req, res) => {
  try {
    const adm = await pool.query(
      "SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin'", [req.user.id]
    );
    if (!adm.rows.length) return res.status(403).json({ error: 'Admin only' });
    const file = String(req.query.file || '').replace(/[^a-z0-9_-]/gi, '');
    if (!file) return res.status(400).json({ error: 'file is required' });

    const old = await pool.query(
      `SELECT id, name FROM contacts WHERE user_id = $1 AND google_id LIKE $2`,
      [req.user.id, 'import-' + file + '-%']
    );
    const ids = old.rows.map(r => r.id);
    if (ids.length) {
      await pool.query(`DELETE FROM contact_group_memberships WHERE user_id = $1 AND contact_id = ANY($2)`, [req.user.id, ids]);
      await pool.query(`DELETE FROM occasions WHERE user_id = $1 AND contact_id = ANY($2)`, [req.user.id, ids]);
      await pool.query(`DELETE FROM contact_relationships WHERE user_id = $1 AND (contact_a_id = ANY($2) OR contact_b_id = ANY($2))`, [req.user.id, ids]);
      await pool.query(`DELETE FROM contacts WHERE user_id = $1 AND id = ANY($2)`, [req.user.id, ids]);
    }
    res.json({ ok: true, v: 1, removed: ids.length, names: old.rows.map(r => r.name), note: 'Empty groups can be deleted in the sidebar (✕).' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Read-only truth: every import/crawl marker family with its contact count, and
// every group with its member count. Run this BEFORE deleting anything.
//   /api/admin/import-report
app.get('/api/admin/import-report', requireAuth, async (req, res) => {
  try {
    const adm = await pool.query(
      "SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin'", [req.user.id]
    );
    if (!adm.rows.length) return res.status(403).json({ error: 'Admin only' });

    const markers = await pool.query(
      `SELECT CASE WHEN google_id LIKE 'crawl:%' THEN 'crawl:' || SPLIT_PART(google_id, ':', 2)
                   ELSE REGEXP_REPLACE(google_id, '-[0-9]+$', '') END AS family,
              COUNT(*)::int AS contacts,
              ARRAY_AGG(name ORDER BY name) AS names
       FROM contacts
       WHERE user_id = $1 AND (google_id LIKE 'import-%' OR google_id LIKE 'crawl:%')
       GROUP BY 1 ORDER BY 1`,
      [req.user.id]
    );
    const groups = await pool.query(
      `SELECT g.name, COUNT(m.contact_id)::int AS members
       FROM groups g LEFT JOIN contact_group_memberships m ON m.group_id = g.id AND m.user_id = g.user_id
       WHERE g.user_id = $1 GROUP BY g.id, g.name ORDER BY g.name`,
      [req.user.id]
    );
    res.json({ ok: true, v: 1, importFamilies: markers.rows, groups: groups.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Compositions ("everything is a card") ─────────────────────────────────────
// A composition = template + ordered card references. Cards resolve LIVE at read
// time (mirror principle): a contact-card always shows current data. Printing
// freezes it on paper — no stored copies anywhere.

app.get('/api/compositions', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.template, c.params, c.created_at, COUNT(i.id)::int AS item_count
       FROM compositions c LEFT JOIN composition_items i ON i.composition_id = c.id
       WHERE c.user_id = $1 GROUP BY c.id ORDER BY c.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/compositions', requireAuth, async (req, res) => {
  const { name, template } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO compositions (user_id, name, template) VALUES ($1, $2, $3) RETURNING *`,
      [req.user.id, name.trim(), template === 'yearbook' ? 'yearbook' : 'brochure']
    );
    res.json({ ok: true, composition: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Resolved read: items come back with live content attached.
app.get('/api/compositions/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    const comp = await pool.query(
      `SELECT id, name, template, params FROM compositions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!comp.rows.length) return res.status(404).json({ error: 'Not found' });
    const items = await pool.query(
      `SELECT id, ref_type, ref_id, position, overrides FROM composition_items
       WHERE composition_id = $1 AND user_id = $2 ORDER BY position, id`,
      [req.params.id, req.user.id]
    );
    const out = [];
    for (const it of items.rows) {
      let content = null;
      if (it.ref_type === 'post') {
        const r = await pool.query(
          `SELECT title, body, post_date, tags, photos, size, author FROM blog_posts WHERE id = $1 AND user_id = $2`,
          [it.ref_id, req.user.id]);
        content = r.rows[0] || null;
      } else if (it.ref_type === 'contact') {
        const r = await pool.query(
          `SELECT name, job_title, company, email, phone, photo_url, city FROM contacts WHERE id = $1 AND user_id = $2`,
          [it.ref_id, req.user.id]);
        content = r.rows[0] || null;
      } else if (it.ref_type === 'media') {
        const r = await pool.query(
          `SELECT title, url, tags, kind FROM media_cards WHERE id = $1 AND user_id = $2`,
          [it.ref_id, req.user.id]);
        content = r.rows[0] || null;
      }
      if (content) out.push({ ...it, content });
    }
    res.json({ ...comp.rows[0], items: out });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Replace items (ordered array) and/or params/name.
app.put('/api/compositions/:id(\\d+)', requireAuth, async (req, res) => {
  const { name, params, items } = req.body || {};
  try {
    const comp = await pool.query(
      `SELECT id FROM compositions WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    if (!comp.rows.length) return res.status(404).json({ error: 'Not found' });
    if (name || params) {
      await pool.query(
        `UPDATE compositions SET name = COALESCE($1, name), params = COALESCE($2, params) WHERE id = $3`,
        [name ? name.trim() : null, params ? JSON.stringify(params) : null, req.params.id]);
    }
    if (Array.isArray(items)) {
      await pool.query(`DELETE FROM composition_items WHERE composition_id = $1 AND user_id = $2`,
        [req.params.id, req.user.id]);
      let pos = 0;
      for (const it of items) {
        if (!it || !['post','contact','media'].includes(it.ref_type) || !it.ref_id) continue;
        await pool.query(
          `INSERT INTO composition_items (user_id, composition_id, ref_type, ref_id, position, overrides)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.user.id, req.params.id, it.ref_type, +it.ref_id, pos++, JSON.stringify(it.overrides || {})]);
      }
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/compositions/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM compositions WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Print view (brochure template) — same auth pattern as /print/calendar.
app.get('/print/brochure', async (req, res) => {
  const user = await getSessionUser(req).catch(() => null);
  if (!user) return res.redirect('/login?redirect=' + encodeURIComponent('/print/brochure' + (req.url.replace(/^\/print\/brochure/, '') || '')));
  res.sendFile(path.join(__dirname, 'print-brochure.html'));
});

// ── Group websites (the Web tab) ──────────────────────────────────────────────

// kind: 'public' = customer website (/site/…), 'internal' = staff board (/board/…)
function siteKind(v) { return v === 'internal' ? 'internal' : 'public'; }
function siteUrl(req, kind, token) {
  return `${req.protocol}://${req.get('host')}/${kind === 'internal' ? 'board' : 'site'}/${token}`;
}

// Current site status for a group (?kind=public|internal).
app.get('/api/groups/:id/site', requireAuth, async (req, res) => {
  try {
    const kind = siteKind(req.query.kind);
    const result = await pool.query(
      `SELECT token, active, tagline, created_at FROM group_sites
       WHERE group_id = $1 AND user_id = $2 AND active = TRUE AND kind = $3
       ORDER BY created_at DESC LIMIT 1`,
      [req.params.id, req.user.id, kind]
    );
    if (!result.rows.length) return res.json({ token: null });
    const row = result.rows[0];
    res.json({ ...row, url: siteUrl(req, kind, row.token) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Publish (create or reuse) the website / staff board for a group.
app.post('/api/groups/:id/site', requireAuth, async (req, res) => {
  try {
    const grp = await pool.query(`SELECT id FROM groups WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    if (!grp.rows.length) return res.status(404).json({ error: 'Group not found' });

    const kind = siteKind((req.body && req.body.kind) || req.query.kind);
    const tagline = (req.body && typeof req.body.tagline === 'string') ? req.body.tagline.slice(0, 200) : null;
    const existing = await pool.query(
      `SELECT token FROM group_sites WHERE group_id = $1 AND user_id = $2 AND active = TRUE AND kind = $3
       ORDER BY created_at DESC LIMIT 1`,
      [req.params.id, req.user.id, kind]
    );
    let token = existing.rows[0]?.token;
    if (!token) {
      token = require('crypto').randomBytes(24).toString('hex');
      await pool.query(
        `INSERT INTO group_sites (user_id, group_id, token, tagline, kind) VALUES ($1, $2, $3, $4, $5)`,
        [req.user.id, req.params.id, token, tagline, kind]
      );
    } else if (tagline !== null) {
      await pool.query(
        `UPDATE group_sites SET tagline = $1 WHERE token = $2`, [tagline, token]
      );
    }
    res.json({ token, url: siteUrl(req, kind, token) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Unpublish a group's website or staff board.
app.delete('/api/groups/:id/site', requireAuth, async (req, res) => {
  try {
    const kind = siteKind(req.query.kind);
    await pool.query(
      `UPDATE group_sites SET active = FALSE WHERE group_id = $1 AND user_id = $2 AND kind = $3`,
      [req.params.id, req.user.id, kind]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Public site data (no auth — the token is the credential). Public-safe fields
// only: names, photos, cities and map pins — never email, phone or full birthdays.
app.get('/api/site/:token', async (req, res) => {
  try {
    const site = await pool.query(
      `SELECT s.group_id, s.user_id, s.tagline, g.name AS group_name
       FROM group_sites s JOIN groups g ON g.id = s.group_id
       WHERE s.token = $1 AND s.active = TRUE AND s.kind = 'public'`,
      [req.params.token]
    );
    if (!site.rows.length) return res.status(404).json({ error: 'This site is not published.' });
    const { group_id, user_id, tagline, group_name } = site.rows[0];

    const subgroups = await pool.query(
      `SELECT id, name FROM groups WHERE parent_group_id = $1 AND user_id = $2`,
      [group_id, user_id]
    );
    const treeIds = [group_id, ...subgroups.rows.map(s => s.id)];

    const members = await pool.query(
      `SELECT DISTINCT ON (c.id)
              c.id, c.name, c.photo_url, c.birthday, c.city, c.country,
              c.email, c.phone, c.job_title, c.company,
              c.latitude, c.longitude,
              CASE WHEN g.parent_group_id = $3 THEN g.name ELSE NULL END AS subgroup_name
       FROM contact_group_memberships m
       JOIN contacts c ON c.id = m.contact_id
       JOIN groups g   ON g.id = m.group_id
       WHERE m.user_id = $1 AND m.group_id = ANY($2)
         AND (m.to_date IS NULL OR m.to_date >= CURRENT_DATE)
       ORDER BY c.id`,
      [user_id, treeIds, group_id]
    );

    const contactIds = members.rows.map(r => r.id);
    let occasions = [];
    if (contactIds.length) {
      const occ = await pool.query(
        `SELECT o.name, o.start_date, o.frequency, c.name AS contact_name
         FROM occasions o JOIN contacts c ON c.id = o.contact_id
         WHERE o.user_id = $1 AND o.contact_id = ANY($2)`,
        [user_id, contactIds]
      );
      occasions = occ.rows;
    }

    const posts = await pool.query(
      `SELECT title, body, post_date, photos, size, author FROM blog_posts
       WHERE user_id = $1 AND EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(tags) t WHERE LOWER(t) = LOWER($2)
       )
       ORDER BY post_date DESC, id DESC LIMIT 200`,
      [user_id, group_name]
    );

    res.json({
      group_name,
      tagline,
      members: members.rows.map(r => ({
        name: r.name, photo_url: r.photo_url, city: r.city, country: r.country,
        email: r.email, phone: r.phone, job_title: r.job_title, company: r.company,
        latitude: r.latitude, longitude: r.longitude,
        subgroup_name: r.subgroup_name,
        birthday: r.birthday ? String(r.birthday).replace(/^\d{4}-/, '') : null,
      })),
      occasions,
      posts: posts.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Calendar groups ───────────────────────────────────────────────────────────
// Named lists of dates, independent of contacts. Copied-per-account templates:
// each firm tweaks its own copy.

const CALENDAR_TEMPLATES = {
  skattedatum: {
    name: 'Skattedatum',
    entries: [
      { name: 'Momsdeklaration (kvartal)', date: '2026-02-12', frequency: 'yearly', big: true },
      { name: 'Arbetsgivardeklaration', date: '2026-01-17', frequency: 'yearly', big: false },
      { name: 'Inkomstdeklaration 1 – sista dag', date: '2026-05-02', frequency: 'yearly', big: true },
      { name: 'Preliminärskatt betalning', date: '2026-01-12', frequency: 'yearly', big: false },
      { name: 'Årsredovisning till Bolagsverket (bokslut 31 dec)', date: '2026-07-31', frequency: 'yearly', big: true },
      { name: 'Inkomstdeklaration 2 (AB, bokslut 31 dec)', date: '2026-07-01', frequency: 'yearly', big: true },
      { name: 'Kontrolluppgifter – sista dag', date: '2026-01-31', frequency: 'yearly', big: false },
      { name: 'Kvarskatt – sista betalningsdag', date: '2026-11-12', frequency: 'yearly', big: false },
    ],
  },
};

app.get('/api/calendars', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.source_key, COUNT(e.id)::int AS entry_count
       FROM calendars c LEFT JOIN calendar_entries e ON e.calendar_id = c.id
       WHERE c.user_id = $1 GROUP BY c.id ORDER BY c.name`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/calendars', requireAuth, async (req, res) => {
  try {
    const template = req.body && req.body.template ? CALENDAR_TEMPLATES[req.body.template] : null;
    const name = ((req.body && req.body.name) || (template && template.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const cal = await pool.query(
      `INSERT INTO calendars (user_id, name, source_key) VALUES ($1, $2, $3) RETURNING *`,
      [req.user.id, name, req.body && req.body.template || null]
    );
    if (template) {
      for (const e of template.entries) {
        await pool.query(
          `INSERT INTO calendar_entries (user_id, calendar_id, name, date, frequency, big)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.user.id, cal.rows[0].id, e.name, e.date, e.frequency, !!e.big]
        );
      }
    }
    res.json({ ok: true, calendar: cal.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/calendars/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM calendars WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/calendars/:id(\\d+)/entries', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, date, frequency, notes, big, author FROM calendar_entries
       WHERE calendar_id = $1 AND user_id = $2 ORDER BY date`,
      [req.params.id, req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/calendars/:id(\\d+)/entries', requireAuth, async (req, res) => {
  const { name, date, frequency, notes, big } = req.body || {};
  if (!name || !date) return res.status(400).json({ error: 'Name and date are required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO calendar_entries (user_id, calendar_id, name, date, frequency, notes, big)
       SELECT $1, c.id, $3, $4, $5, $6, $7 FROM calendars c WHERE c.id = $2 AND c.user_id = $1
       RETURNING *`,
      [req.user.id, req.params.id, name.trim(), date, frequency === 'once' ? 'once' : 'yearly', notes || null, !!big]
    );
    if (!rows.length) return res.status(404).json({ error: 'Calendar not found' });
    res.json({ ok: true, entry: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/calendar-entries/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM calendar_entries WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Attach / detach calendars on a group (feeds that group's board).
app.get('/api/groups/:id/calendars', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT calendar_id FROM group_calendars WHERE group_id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json(rows.map(r => r.calendar_id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/groups/:id/calendars/:calId(\\d+)', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO group_calendars (user_id, group_id, calendar_id)
       SELECT $1, $2, c.id FROM calendars c WHERE c.id = $3 AND c.user_id = $1
       ON CONFLICT (group_id, calendar_id) DO NOTHING`,
      [req.user.id, req.params.id, req.params.calId]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/groups/:id/calendars/:calId(\\d+)', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM group_calendars WHERE group_id = $1 AND calendar_id = $2 AND user_id = $3`,
      [req.params.id, req.params.calId, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── "Tar hand om" — responsible-person edges (generic typed relations) ────────
// The pair is seeded once per user into the typed-relation system; the labels
// are ordinary relationship_types, so they can be renamed like any other.
async function ensureHandlerTypes(userId) {
  // Renames any previously seeded Swedish pair, then looks up / seeds English.
  await pool.query(
    `UPDATE relationship_types rt SET name = 'Responsible for'
     FROM groups g WHERE g.id = rt.group_id AND g.user_id = $1 AND rt.name = 'Tar hand om'`, [userId]);
  await pool.query(
    `UPDATE relationship_types rt SET name = 'In the care of'
     FROM groups g WHERE g.id = rt.group_id AND g.user_id = $1 AND rt.name = 'Tas om hand av'`, [userId]);
  const found = await pool.query(
    `SELECT rt.id, rt.name FROM relationship_types rt
     JOIN groups g ON g.id = rt.group_id
     WHERE g.user_id = $1 AND rt.name IN ('Responsible for','In the care of')`,
    [userId]
  );
  let a = found.rows.find(r => r.name === 'Responsible for')?.id;
  let b = found.rows.find(r => r.name === 'In the care of')?.id;
  if (a && b) return { a, b };
  const g = await pool.query(
    `SELECT id FROM groups WHERE user_id = $1 ORDER BY (name = 'Family') DESC, id LIMIT 1`,
    [userId]
  );
  if (!g.rows.length) throw new Error('No group to anchor relationship types');
  const gid = g.rows[0].id;
  if (!a) a = (await pool.query(`INSERT INTO relationship_types (group_id, name) VALUES ($1, 'Responsible for') RETURNING id`, [gid])).rows[0].id;
  if (!b) b = (await pool.query(`INSERT INTO relationship_types (group_id, name) VALUES ($1, 'In the care of') RETURNING id`, [gid])).rows[0].id;
  await pool.query(`UPDATE relationship_types SET mirror_id = $1 WHERE id = $2`, [b, a]);
  await pool.query(`UPDATE relationship_types SET mirror_id = $1 WHERE id = $2`, [a, b]);
  return { a, b };
}

// All handler edges for a group's members: [{customer_id, handler_id, handler_name}]
app.get('/api/groups/:id/handlers', requireAuth, async (req, res) => {
  try {
    const { a } = await ensureHandlerTypes(req.user.id);
    const subgroups = await pool.query(
      `SELECT id FROM groups WHERE parent_group_id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    const treeIds = [parseInt(req.params.id, 10), ...subgroups.rows.map(s => s.id)];
    const { rows } = await pool.query(
      `SELECT DISTINCT cr.contact_b_id AS customer_id, cr.contact_a_id AS handler_id, c.name AS handler_name
       FROM contact_relationships cr
       JOIN contacts c ON c.id = cr.contact_a_id
       WHERE cr.user_id = $1 AND cr.relationship_type_id = $2
         AND cr.contact_b_id IN (
           SELECT contact_id FROM contact_group_memberships WHERE user_id = $1 AND group_id = ANY($3)
         )
       ORDER BY c.name`,
      [req.user.id, a, treeIds]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Set (or clear) THE responsible person for a customer — one per customer:
// setting always replaces any previous edges; handler_id null clears.
app.post('/api/handlers', requireAuth, async (req, res) => {
  const { handler_id, customer_id } = req.body || {};
  if (!customer_id) return res.status(400).json({ error: 'customer_id is required' });
  try {
    const { a, b } = await ensureHandlerTypes(req.user.id);
    await pool.query(
      `DELETE FROM contact_relationships WHERE user_id = $1 AND relationship_type_id = $2 AND contact_b_id = $3`,
      [req.user.id, a, customer_id]
    );
    await pool.query(
      `DELETE FROM contact_relationships WHERE user_id = $1 AND relationship_type_id = $2 AND contact_a_id = $3`,
      [req.user.id, b, customer_id]
    );
    if (handler_id) {
      await pool.query(
        `INSERT INTO contact_relationships (user_id, contact_a_id, contact_b_id, relationship_type_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [req.user.id, handler_id, customer_id, a]
      );
      await pool.query(
        `INSERT INTO contact_relationships (user_id, contact_a_id, contact_b_id, relationship_type_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [req.user.id, customer_id, handler_id, b]
      );
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/handlers/:handlerId(\\d+)/:customerId(\\d+)', requireAuth, async (req, res) => {
  try {
    const { a, b } = await ensureHandlerTypes(req.user.id);
    await pool.query(
      `DELETE FROM contact_relationships WHERE user_id = $1 AND relationship_type_id = $2
       AND contact_a_id = $3 AND contact_b_id = $4`,
      [req.user.id, a, req.params.handlerId, req.params.customerId]
    );
    await pool.query(
      `DELETE FROM contact_relationships WHERE user_id = $1 AND relationship_type_id = $2
       AND contact_a_id = $3 AND contact_b_id = $4`,
      [req.user.id, b, req.params.customerId, req.params.handlerId]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Staff board data (no auth — internal token is the credential). Full details:
// this feeds the employee-facing board, so email/phone/birthdays are included.
app.get('/api/board/:token', async (req, res) => {
  try {
    const site = await pool.query(
      `SELECT s.group_id, s.user_id, s.tagline, g.name AS group_name
       FROM group_sites s JOIN groups g ON g.id = s.group_id
       WHERE s.token = $1 AND s.active = TRUE AND s.kind = 'internal'`,
      [req.params.token]
    );
    if (!site.rows.length) return res.status(404).json({ error: 'This board is not published.' });
    const { group_id, user_id, tagline, group_name } = site.rows[0];

    const subgroups = await pool.query(
      `SELECT id, name FROM groups WHERE parent_group_id = $1 AND user_id = $2`,
      [group_id, user_id]
    );
    const treeIds = [group_id, ...subgroups.rows.map(s => s.id)];

    const members = await pool.query(
      `SELECT DISTINCT ON (c.id)
              c.id, c.name, c.photo_url, c.birthday, c.city, c.country,
              c.email, c.phone, c.job_title, c.company,
              m.from_date,
              CASE WHEN g.parent_group_id = $3 THEN g.name ELSE NULL END AS subgroup_name
       FROM contact_group_memberships m
       JOIN contacts c ON c.id = m.contact_id
       JOIN groups g   ON g.id = m.group_id
       WHERE m.user_id = $1 AND m.group_id = ANY($2)
         AND (m.to_date IS NULL OR m.to_date >= CURRENT_DATE)
       ORDER BY c.id`,
      [user_id, treeIds, group_id]
    );

    const contactIds = members.rows.map(r => r.id);
    let occasions = [];
    if (contactIds.length) {
      const occ = await pool.query(
        `SELECT o.name, o.start_date, o.frequency, o.notes, o.contact_id, c.name AS contact_name
         FROM occasions o JOIN contacts c ON c.id = o.contact_id
         WHERE o.user_id = $1 AND o.contact_id = ANY($2)`,
        [user_id, contactIds]
      );
      occasions = occ.rows;
    }

    const cals = await pool.query(
      `SELECT e.id, e.name, e.date, e.frequency, e.notes, e.big, e.author, c.name AS calendar_name
       FROM group_calendars gc
       JOIN calendars c ON c.id = gc.calendar_id
       JOIN calendar_entries e ON e.calendar_id = c.id
       WHERE gc.group_id = $1 AND gc.user_id = $2`,
      [group_id, user_id]
    );

    // Who takes care of whom (for the cards + the per-handler filter).
    let handlerRows = [];
    if (contactIds.length) {
      const { a } = await ensureHandlerTypes(user_id);
      const h = await pool.query(
        `SELECT DISTINCT cr.contact_b_id AS customer_id, c.name AS handler_name
         FROM contact_relationships cr JOIN contacts c ON c.id = cr.contact_a_id
         WHERE cr.user_id = $1 AND cr.relationship_type_id = $2 AND cr.contact_b_id = ANY($3)
         ORDER BY c.name`,
        [user_id, a, contactIds]
      );
      handlerRows = h.rows;
    }
    const handlersBy = {};
    handlerRows.forEach(r => (handlersBy[r.customer_id] = handlersBy[r.customer_id] || []).push(r.handler_name));
    const membersOut = members.rows.map(r => ({ ...r, handlers: handlersBy[r.id] || [] }));

    res.json({ group_name, tagline, members: membersOut, occasions, calendar_entries: cals.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Staff remark written from the board itself (token is the credential).
// Lands in an auto-created "Anteckningar" calendar attached to the group.
app.post('/api/board/:token/note', async (req, res) => {
  try {
    const site = await pool.query(
      `SELECT s.group_id, s.user_id, g.name AS group_name
       FROM group_sites s JOIN groups g ON g.id = s.group_id
       WHERE s.token = $1 AND s.active = TRUE AND s.kind = 'internal'`,
      [req.params.token]
    );
    if (!site.rows.length) return res.status(404).json({ error: 'This board is not published.' });
    const { group_id, user_id } = site.rows[0];

    const { date, text, author, big } = req.body || {};
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'A date is required' });
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'A text is required' });

    const key = 'board-notes-' + group_id;
    let cal = await pool.query(
      `SELECT id FROM calendars WHERE user_id = $1 AND source_key = $2`, [user_id, key]
    );
    let calId = cal.rows[0]?.id;
    if (!calId) {
      const ins = await pool.query(
        `INSERT INTO calendars (user_id, name, source_key) VALUES ($1, $2, $3) RETURNING id`,
        [user_id, 'Notes', key]
      );
      calId = ins.rows[0].id;
      await pool.query(
        `INSERT INTO group_calendars (user_id, group_id, calendar_id) VALUES ($1,$2,$3)
         ON CONFLICT (group_id, calendar_id) DO NOTHING`,
        [user_id, group_id, calId]
      );
    }
    const { rows } = await pool.query(
      `INSERT INTO calendar_entries (user_id, calendar_id, name, date, frequency, big, author)
       VALUES ($1,$2,$3,$4,'once',$5,$6) RETURNING *`,
      [user_id, calId, String(text).trim().slice(0, 200), date, !!big, (author || '').trim().slice(0, 60) || null]
    );
    res.json({ ok: true, entry: rows[0] });
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

app.put('/api/occasions/:id', requireAuth, async (req, res) => {
  const { name, start_date, frequency, notes } = req.body;
  try {
    const result = await pool.query(
      `UPDATE occasions SET name=$1, start_date=$2, frequency=$3, notes=$4 WHERE id=$5 AND user_id=$6 RETURNING id`,
      [name, start_date, frequency, notes || null, req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/occasions/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM occasions WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Timeline blog posts (Studio) ──────────────────────────────────────────────
app.get('/api/blog-posts', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, body, post_date, tags, photos, size, author, created_at
       FROM blog_posts WHERE user_id = $1 ORDER BY post_date DESC, id DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function postSize(v) {
  const n = parseInt(v, 10);
  return (n >= 1 && n <= 10) ? n : null;
}

app.post('/api/blog-posts', requireAuth, async (req, res) => {
  const { title, body, post_date, tags, photos, size, author } = req.body || {};
  try {
    const { rows } = await pool.query(
      `INSERT INTO blog_posts (user_id, title, body, post_date, tags, photos, size, author)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, title || null, body || null, post_date || new Date().toISOString().slice(0,10),
       JSON.stringify(Array.isArray(tags)?tags:[]), JSON.stringify(Array.isArray(photos)?photos:[]),
       postSize(size), (author || '').trim() || null]
    );
    res.json({ ok: true, post: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/blog-posts/:id(\\d+)', requireAuth, async (req, res) => {
  const { title, body, post_date, tags, photos, size, author } = req.body || {};
  try {
    const { rows } = await pool.query(
      `UPDATE blog_posts SET title=$1, body=$2, post_date=$3, tags=$4, photos=$5, size=$6, author=$7
       WHERE id=$8 AND user_id=$9 RETURNING *`,
      [title || null, body || null, post_date || new Date().toISOString().slice(0,10),
       JSON.stringify(Array.isArray(tags)?tags:[]), JSON.stringify(Array.isArray(photos)?photos:[]),
       postSize(size), (author || '').trim() || null,
       req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, post: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/blog-posts/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM blog_posts WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Media cards (SVG logos / decoration) ──────────────────────────────────
// "Everything is a card." An SVG is stored once, tagged, and reused as a
// mirror card in any composition. Two safety layers: (1) sanitize on upload —
// strip scripts, event handlers, foreignObject, javascript: URIs and DOCTYPE;
// (2) always render via <img>, which never executes script in an embedded SVG.
function sanitizeSvg(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/^﻿/, '').trim();
  if (!/<svg[\s>]/i.test(s)) return null;                 // must actually be SVG
  s = s.replace(/<!DOCTYPE[^>]*>/gi, '');                 // no DOCTYPE (XXE)
  s = s.replace(/<!ENTITY[\s\S]*?>/gi, '');               // no entity definitions
  s = s.replace(/^[\s\S]*?(?=<svg[\s>])/i, '');           // drop XML decl / DOCTYPE remnants before root
  s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, '');    // no scripts
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, ''); // no embedded HTML
  s = s.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');         // no on* handlers ("...")
  s = s.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');         // no on* handlers ('...')
  s = s.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');         // no on* handlers (bare)
  s = s.replace(/(href|xlink:href|src)\s*=\s*"\s*javascript:[^"]*"/gi, '$1="#"');
  s = s.replace(/(href|xlink:href|src)\s*=\s*'\s*javascript:[^']*'/gi, "$1='#'");
  s = s.replace(/javascript:/gi, '');                     // belt-and-suspenders
  return s.trim();
}

app.get('/api/media-cards', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, kind, url, tags, created_at
       FROM media_cards WHERE user_id = $1 ORDER BY created_at DESC, id DESC`,
      [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Accepts: multipart file (SVG or raster image) OR JSON { url } — the url
// branch serves drags from web pages; the server fetches and re-hosts.
// SVG is always sanitized; rasters upload as-is.
app.post('/api/media-cards', requireAuth, upload.single('file'), async (req, res) => {
  try {
    let buf = null, ct = null, origName = 'file';
    if (req.file) {
      origName = req.file.originalname || 'file';
      const isSvg = /svg/i.test(req.file.mimetype || '') || /\.svg$/i.test(origName);
      if (isSvg) {
        const clean = sanitizeSvg(req.file.buffer.toString('utf8'));
        if (!clean) return res.status(400).json({ error: 'Not a valid SVG file' });
        buf = Buffer.from(clean, 'utf8'); ct = 'image/svg+xml';
      } else if (/^image\//i.test(req.file.mimetype || '')) {
        buf = req.file.buffer; ct = req.file.mimetype;
      } else return res.status(400).json({ error: 'Only SVG or image files' });
    } else if (req.body && req.body.url && /^https?:\/\//i.test(req.body.url)) {
      const srcUrl = String(req.body.url).trim();
      const r = await fetch(srcUrl);
      if (!r.ok) return res.status(400).json({ error: 'Could not fetch the image: HTTP ' + r.status });
      ct = (r.headers.get('content-type') || '').split(';')[0].trim();
      const ab = Buffer.from(await r.arrayBuffer());
      if (ab.length > 15 * 1024 * 1024) return res.status(400).json({ error: 'Too large (max 15 MB)' });
      if (/svg/i.test(ct) || /\.svg(\?|$)/i.test(srcUrl)) {
        const clean = sanitizeSvg(ab.toString('utf8'));
        if (!clean) return res.status(400).json({ error: 'Not a valid SVG' });
        buf = Buffer.from(clean, 'utf8'); ct = 'image/svg+xml';
      } else if (/^image\//i.test(ct)) { buf = ab; }
      else return res.status(400).json({ error: 'That link is not an image (' + (ct || 'unknown type') + ')' });
      origName = (decodeURIComponent(srcUrl.split('/').pop() || 'image').split('?')[0]) || 'image';
    } else return res.status(400).json({ error: 'No file or url provided' });

    const { url } = await uploadBuffer({
      buffer: buf, contentType: ct, kind: 'media_card', originalName: origName,
    });
    let tags = [];
    try { tags = JSON.parse(req.body.tags || '[]'); } catch (_) { tags = []; }
    if (!Array.isArray(tags)) tags = [];
    tags = tags.map(t => String(t).trim()).filter(Boolean).slice(0, 20);
    const title = (req.body.title || origName || '').replace(/\.(svg|png|jpe?g|webp|gif|avif)$/i, '').trim() || null;
    const kind = ct === 'image/svg+xml' ? 'svg' : 'image';
    const { rows } = await pool.query(
      `INSERT INTO media_cards (user_id, title, kind, url, tags)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, title, kind, url, tags, created_at`,
      [req.user.id, title, kind, url, JSON.stringify(tags)]);
    res.json({ ok: true, card: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Upload failed', details: err.message }); }
});

app.delete('/api/media-cards/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    // Remove the card and any composition items that reference it.
    await pool.query(
      `DELETE FROM composition_items WHERE ref_type = 'media' AND ref_id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]);
    await pool.query(`DELETE FROM media_cards WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]);
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
      `SELECT id, name, email, birthday, city, died_on, is_pet, is_me, latitude, longitude, photo_url FROM contacts WHERE user_id = $1`,
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
      `SELECT id, google_id, name, email, phone, company, job_title, street, street_2, city, region, country, postal_code, birthday, is_placeholder, died_on, is_pet, is_me, photo_url, about
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
      `SELECT id, google_id, name, email, phone, company, job_title, street, street_2, city, region, country, postal_code, birthday, is_placeholder, died_on, is_pet, is_me, photo_url, about
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
  const { name, email, phone, company, job_title, street, street_2, city, region, country, postal_code, birthday, died_on, is_pet, about, photo_url } = req.body;
  // photo_url / job_title only change when the key is present in the body (older callers don't send them)
  const hasPhoto = Object.prototype.hasOwnProperty.call(req.body, 'photo_url');
  const hasTitle = Object.prototype.hasOwnProperty.call(req.body, 'job_title');
  try {
    await pool.query(
      `UPDATE contacts SET name=$1, email=$2, phone=$3, company=$4, street=$5, street_2=$6, city=$7, region=$8, country=$9, postal_code=$10, birthday=$11, died_on=$12, is_pet=$13, about=$14,
         photo_url = CASE WHEN $15::boolean THEN $16 ELSE photo_url END,
         job_title = CASE WHEN $17::boolean THEN $18 ELSE job_title END
       WHERE id=$19 AND user_id=$20`,
      [name, email, phone, company, street, street_2, city, region, country, postal_code, birthday || null, died_on || null, !!is_pet, about || null, hasPhoto, photo_url || null, hasTitle, job_title || null, req.params.id, req.user.id]
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

// ── Family tree links (Studio) ────────────────────────────────────────────────
app.get('/api/family-links', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, parent_id, child_id, role FROM family_links WHERE user_id = $1`, [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/family-links', requireAuth, async (req, res) => {
  const { parent_id, child_id, role } = req.body || {};
  if (!parent_id || !child_id || !['father','mother','pet'].includes(role))
    return res.status(400).json({ error: 'parent_id, child_id and role (father|mother|pet) required' });
  if (+parent_id === +child_id) return res.status(400).json({ error: 'A person cannot be their own parent' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO family_links (user_id, parent_id, child_id, role)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, parent_id, child_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING *`,
      [req.user.id, parent_id, child_id, role]);
    res.json({ ok: true, link: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/family-links/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM family_links WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
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
  // Optional engagement metrics from the landing-page beacon
  const scroll = parseInt(req.body && req.body.scroll_pct);
  const dwell  = parseInt(req.body && req.body.dwell_ms);
  if (Number.isFinite(scroll) || Number.isFinite(dwell)) {
    const ip = visitorIp(req) || 'unknown';
    pool.query(
      `UPDATE visits SET
         scroll_pct = GREATEST(COALESCE(scroll_pct, 0), $2),
         dwell_ms   = GREATEST(COALESCE(dwell_ms, 0), $3)
       WHERE ip = $1 AND created_at > NOW() - INTERVAL '30 minutes'`,
      [ip, Number.isFinite(scroll) ? Math.min(scroll, 100) : 0, Number.isFinite(dwell) ? Math.min(dwell, 3600000) : 0]
    ).catch((e) => console.error('[engage] metrics:', e.message));
  }
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
      attr_ref: req.cookies?.ts_ref || '',
      attr_src: req.cookies?.ts_src || '',
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

  // Funnel: credit this preview to the clip/platform that brought the visitor.
  pool.query(
    'INSERT INTO funnel_events (kind, ref, src, email) VALUES ($1,$2,$3,$4)',
    ['preview', req.cookies?.ts_ref || null, req.cookies?.ts_src || null, email]
  ).catch((e) => console.error('[funnel] preview event:', e.message));

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
    let previewUrl = result.url;
    try {
      const r2prev = await downloadAndStore({ remoteUrl: result.url, kind: 'order' });
      previewUrl = r2prev.url;
    } catch(e) { console.warn('[preview] R2 store failed, using fal URL:', e.message); }
    await generation.logGenerationFinish(logged.id, {
      outputUrl: previewUrl,
      falOutputUrl: result.url,
    });
    res.json({ url: previewUrl });
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
    let videoUrl = await generateVideo(image_url);
    console.log('Video generated:', videoUrl);
    try {
      const r2v = await downloadAndStore({ remoteUrl: videoUrl, kind: 'order', orderId: order_id || null });
      videoUrl = r2v.url;
    } catch(e) { console.warn('[gen-video] R2 store failed:', e.message); }

    if (order_id) {
      await pool.query('UPDATE orders SET result_video_url=$1, output_video_asset_url=$1 WHERE id=$2', [videoUrl, order_id]);
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
      `SELECT DISTINCT c.id, c.slug, c.name, c.description, c.filter_category, c.subject, c.occasion, c.action, c.sort_order
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

    // Dimension chips: distinct values across active concepts that have media
    const dimsRes = await pool.query(
      `SELECT DISTINCT COALESCE(cm.subject, c.subject) AS subject, c.occasion, c.action
       FROM concepts c
       JOIN concept_media cm ON cm.concept_id = c.id
       WHERE c.active = TRUE AND cm.active = TRUE`
    );
    const dims = { subjects: new Set(), occasions: new Set(), actions: new Set() };
    dimsRes.rows.forEach((r) => {
      if (r.subject)  dims.subjects.add(r.subject);
      if (r.occasion) dims.occasions.add(r.occasion);
      if (r.action)   dims.actions.add(r.action);
    });
    const dimensions = {
      subjects:  Array.from(dims.subjects).sort(),
      occasions: Array.from(dims.occasions).sort(),
      actions:   Array.from(dims.actions).sort(),
    };

    const kindsRes = await pool.query(
      `SELECT DISTINCT cm.kind
       FROM concept_media cm
       JOIN concepts c ON c.id = cm.concept_id
       WHERE cm.active = TRUE AND c.active = TRUE`
    );
    const kinds = kindsRes.rows.map((r) => r.kind).sort();
    res.json({ filters, concepts, kinds, dimensions });
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
              price_tier, input_type, subject, occasion, action
       FROM concepts
       WHERE active = TRUE
       ORDER BY occasion ASC, sort_order ASC, id ASC
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

// ====================================================================
// Studio (Stage 3 pipeline redesign) — concepts with triplet card grids.
// "+ New triplet": drop a photo -> run the concept's image + video prompts
// via fal -> media rows + triplet appear as a card. Generation runs in the
// background; progress is tracked in-process and polled by the page.
// ====================================================================
app.get('/admin/studio', requireRole('admin'), (req, res) => {
  res.sendFile(require('path').join(__dirname, 'admin-studio.html'));
});

// In-process job tracker for "+ New triplet" generation.
// tripletId -> { stage: 'image'|'video'|'done'|'error', error?, concept_id }
const studioJobs = {};

app.get('/admin/api/studio/jobs', requireRole('admin'), (req, res) => res.json(studioJobs));

// One payload: all concepts + their triplets (with per-media subject/active)
app.get('/admin/api/studio/concepts', requireRole('admin'), async (req, res) => {
  try {
    const { rows: concepts } = await pool.query(`
      SELECT id, slug, name, subject, occasion, action, active,
             (image_prompt IS NOT NULL AND image_prompt <> '') AS has_image_prompt,
             (video_prompt IS NOT NULL AND video_prompt <> '') AS has_video_prompt
      FROM concepts ORDER BY active DESC, sort_order ASC, name ASC`);
    const { rows: triplets } = await pool.query(`
      SELECT t.id, t.concept_id, t.triplet_number, t.active, t.in_rolling_demo, t.in_gallery,
             bm.id AS before_id, bm.url AS before_url, bm.subject AS before_subject, bm.active AS before_active,
             im.id AS image_id,  im.url AS image_url,  im.subject AS image_subject,  im.active AS image_active,
             vm.id AS video_id,  vm.url AS video_url,  vm.subject AS video_subject,  vm.active AS video_active
      FROM concept_triplets t
      LEFT JOIN concept_media bm ON bm.id = t.before_media_id
      LEFT JOIN concept_media im ON im.id = t.image_media_id
      LEFT JOIN concept_media vm ON vm.id = t.video_media_id
      ORDER BY t.concept_id ASC, t.sort_order ASC, t.triplet_number ASC`);
    res.json({ concepts, triplets, jobs: studioJobs });
  } catch (e) {
    console.error('[studio/concepts]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Lightweight media patch — only subject and/or active, nothing else touched.
app.post('/admin/api/studio/media/:id(\\d+)', requireRole('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const hasSubject = req.body.subject !== undefined;
    const subject = hasSubject
      ? (String(req.body.subject || '').trim().toLowerCase().replace(/\s+/g, '-') || null)
      : null;
    const active = (typeof req.body.active === 'boolean') ? req.body.active : null;
    const { rows } = await pool.query(`
      UPDATE concept_media SET
        subject = CASE WHEN $2::boolean THEN $3 ELSE subject END,
        active  = COALESCE($4, active)
      WHERE id = $1
      RETURNING id, subject, active`,
      [id, hasSubject, subject, active]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, ...rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// "+ New triplet": photo upload -> before media + triplet now, generation async
app.post('/admin/api/studio/concepts/:id(\\d+)/new-triplet', requireRole('admin'), upload.single('photo'), async (req, res) => {
  const conceptId = parseInt(req.params.id);
  try {
    const { rows } = await pool.query('SELECT * FROM concepts WHERE id = $1', [conceptId]);
    if (!rows.length) return res.status(404).json({ error: 'Concept not found' });
    const concept = rows[0];
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'photo file is required' });
    if (!concept.image_prompt || !String(concept.image_prompt).trim())
      return res.status(400).json({ error: 'Concept has no image prompt' });

    // 1) Store the before photo + media row (subject inherits from concept unless given)
    const up = await uploadStream(req.file.buffer, {
      kind: 'concept_media', contentType: req.file.mimetype, originalName: req.file.originalname,
    });
    const beforeUrl = up.secure_url;
    const subj = (String(req.body.subject || '').trim() || concept.subject || '')
      .toLowerCase().replace(/\s+/g, '-') || null;
    const { rows: [bm] } = await pool.query(
      `INSERT INTO concept_media (concept_id, kind, url, caption, sort_order, subject)
       VALUES ($1, 'image', $2, 'before', 0, $3) RETURNING id`,
      [conceptId, beforeUrl, subj]);

    // 2) Triplet row immediately (next free number) — card shows up at once
    const existing = await pool.query(
      `SELECT triplet_number FROM concept_triplets WHERE concept_id = $1`, [conceptId]);
    const taken = new Set(existing.rows.map(r => r.triplet_number));
    let n = 1; while (taken.has(n)) n++;
    const { rows: [t] } = await pool.query(
      `INSERT INTO concept_triplets (concept_id, triplet_number, before_media_id, active)
       VALUES ($1, $2, $3, TRUE) RETURNING id`,
      [conceptId, n, bm.id]);

    studioJobs[t.id] = { stage: 'image', concept_id: conceptId, started_at: new Date().toISOString() };
    res.json({ ok: true, triplet_id: t.id, triplet_number: n });

    // 3) Background: concept image prompt -> after image, then video prompt -> after video
    (async () => {
      try {
        const imagePrompt = applyUserInput(concept.image_prompt, concept, null);
        const genI = await generation.generateImage({
          modelId: (concept.fal_image_model || '').trim() || 'fal-ai/kling-image/o1',
          prompt: imagePrompt, photoUrl: beforeUrl, orientation: null, inputExtras: null,
        });
        const r2i = await downloadAndStore({ remoteUrl: genI.url, kind: 'concept_media' });
        const { rows: [im] } = await pool.query(
          `INSERT INTO concept_media (concept_id, kind, url, sort_order, subject)
           VALUES ($1, 'image', $2, 0, $3) RETURNING id`,
          [conceptId, r2i.url, subj]);
        await pool.query(`UPDATE concept_triplets SET image_media_id = $2 WHERE id = $1`, [t.id, im.id]);

        if (concept.video_prompt && String(concept.video_prompt).trim()) {
          studioJobs[t.id].stage = 'video';
          const videoPrompt = applyUserInput(concept.video_prompt, concept, null);
          const genV = await generation.generateVideo({
            modelId: (concept.fal_video_model || '').trim() || 'fal-ai/kling-video/v3/pro/image-to-video',
            prompt: videoPrompt, photoUrl: r2i.url, orientation: null, inputExtras: null,
          });
          const r2v = await downloadAndStore({ remoteUrl: genV.url, kind: 'concept_media' });
          const { rows: [vm] } = await pool.query(
            `INSERT INTO concept_media (concept_id, kind, url, sort_order, subject)
             VALUES ($1, 'video', $2, 0, $3) RETURNING id`,
            [conceptId, r2v.url, subj]);
          await pool.query(`UPDATE concept_triplets SET video_media_id = $2 WHERE id = $1`, [t.id, vm.id]);
        }
        studioJobs[t.id].stage = 'done';
      } catch (e) {
        console.error('[studio new-triplet] generation:', e.message);
        studioJobs[t.id] = Object.assign({}, studioJobs[t.id], { stage: 'error', error: e.message });
      }
    })();
  } catch (e) {
    console.error('[studio new-triplet]', e.message);
    res.status(500).json({ error: e.message });
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
  const { category, kind, subject, occasion, action } = req.query;
  try {
    const params = [];
    let where = `WHERE cm.active = TRUE AND c.active = TRUE`;
    for (const [col, val] of [['occasion', occasion], ['action', action]]) {
      if (val && val !== 'all') {
        params.push(String(val).toLowerCase());
        where += ` AND c.${col} = $${params.length}`;
      }
    }
    if (subject && subject !== 'all') {
      params.push(String(subject).toLowerCase());
      // Subject lives on the example media (one concept shows many species);
      // falls back to the concept's subject when the item has none.
      where += ` AND COALESCE(cm.subject, c.subject) = $${params.length}`;
    }
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
              c.description AS concept_description, c.filter_category, COALESCE(cm.subject, c.subject) AS subject, c.occasion, c.action
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
      try {
        const r2t = await downloadAndStore({ remoteUrl: videoUrl, kind: 'order', orderId });
        videoUrl = r2t.url;
      } catch(e) { console.warn('[asset] R2 talking video store failed:', e.message); }
      if (orderId) {
        await pool.query('UPDATE orders SET result_video_url=$1, output_video_asset_url=$1 WHERE id=$2', [videoUrl, orderId]);
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

// Asset storage browser — shows every file with R2 / Cloudinary / fal.ai badge
app.get('/admin/assets', requireRole('admin'), (req, res) => {
  res.sendFile(require('path').join(__dirname, 'admin-assets.html'));
});

// ─── Social clip maker ────────────────────────────────────────────────────────

app.get('/admin/social-clips', requireRole('admin'), (req, res) => {
  res.sendFile(require('path').join(__dirname, 'admin-social-clips.html'));
});

app.get('/admin/api/social-clips/ffmpeg-check', requireRole('admin'), (req, res) => {
  const { execSync } = require('child_process');
  const fs2 = require('fs');
  let which = null, exists = false, version = null, nixSearch = null;
  try { which = execSync('which ffmpeg 2>/dev/null').toString().trim(); } catch {}
  try { nixSearch = execSync('find /nix -name ffmpeg -type f 2>/dev/null | head -3').toString().trim(); } catch {}
  const candidates = [
    process.env.FFMPEG_PATH, which, '/tmp/ffmpeg',
    '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg',
    nixSearch ? nixSearch.split('\n')[0] : null,
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs2.existsSync(p)) { exists = true; which = p; break; }
  }
  try { version = execSync(`${which || 'ffmpeg'} -version 2>&1`).toString().split('\n')[0]; } catch(e) { version = e.message; }
  res.json({ which, exists, version, nixSearch, platform: process.platform, arch: process.arch });
});

app.get('/admin/api/social-clips/triplets', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id, t.concept_id, t.triplet_number, c.name AS concept_name,
             bm.url AS before_url, im.url AS image_url, vm.url AS video_url,
             COALESCE(bm.subject, im.subject, c.subject) AS subject,
             c.occasion, c.action,
             (SELECT COUNT(*)::int FROM social_clips sc WHERE sc.triplet_id = t.id) AS clip_count
      FROM concept_triplets t
      LEFT JOIN concepts c ON c.id = t.concept_id
      LEFT JOIN concept_media bm ON bm.id = t.before_media_id AND bm.active = TRUE
      LEFT JOIN concept_media im ON im.id = t.image_media_id  AND im.active = TRUE
      LEFT JOIN concept_media vm ON vm.id = t.video_media_id  AND vm.active = TRUE
      WHERE t.active = TRUE
      ORDER BY c.name ASC, t.sort_order ASC, t.triplet_number ASC
    `);
    res.json(rows);
  } catch (e) {
    console.error('[social-clips/triplets]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// Social Clips — library CRUD + generation + publish stubs
// =====================================================================

// Serve the detail page
app.get('/admin/social-clips/:id(\\d+)', requireRole('admin'), (req, res) => {
  res.sendFile(require('path').join(__dirname, 'admin-social-clip-detail.html'));
});

// List all clips (with concept name, status, output URL)
app.get('/admin/api/social-clips', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT sc.*, c.name AS concept_name_live
      FROM social_clips sc
      LEFT JOIN concepts c ON c.id = sc.concept_id
      ORDER BY sc.created_at DESC
      LIMIT 200
    `);
    res.json(rows);
  } catch (e) {
    console.error('[social-clips/list]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Queue one or more triplets — creates pending social_clip rows
app.post('/admin/api/social-clips/queue', requireRole('admin'), async (req, res) => {
  const { triplet_ids, clip_style } = req.body; // array of triplet IDs + optional style (1=A, 3=B)
  const styleVal = (clip_style === 3 || clip_style === 1 || clip_style === 4) ? clip_style : 1;
  if (!Array.isArray(triplet_ids) || triplet_ids.length === 0)
    return res.status(400).json({ error: 'triplet_ids must be a non-empty array' });
  try {
    const { rows: triplets } = await pool.query(`
      SELECT t.id, t.concept_id, c.name AS concept_name,
             bm.url AS before_url, vm.url AS video_url,
             im.url AS image_url,
             COALESCE(bm.subject, im.subject, c.subject) AS inh_subject,
             c.occasion AS inh_occasion, c.action AS inh_action, c.mood AS inh_mood
      FROM concept_triplets t
      JOIN concepts c ON c.id = t.concept_id
      LEFT JOIN concept_media bm ON bm.id = t.before_media_id AND bm.active = TRUE
      LEFT JOIN concept_media vm ON vm.id = t.video_media_id  AND vm.active = TRUE
      LEFT JOIN concept_media im ON im.id = t.image_media_id  AND im.active = TRUE
      WHERE t.id = ANY($1::int[])
    `, [triplet_ids]);
    const created = [];
    for (const t of triplets) {
      // Dimensions auto-inherit from concept/triplet media — prefilled but
      // editable on the clip detail page (Stage 1 pipeline redesign).
      const { rows: [row] } = await pool.query(`
        INSERT INTO social_clips (triplet_id, concept_id, concept_name, before_url, after_video_url, after_image_url,
                                  subject, occasion, action, mood, clip_style)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
      `, [t.id, t.concept_id, t.concept_name, t.before_url, t.video_url, t.image_url,
          t.inh_subject || null, t.inh_occasion || null, t.inh_action || null, t.inh_mood || null, styleVal]);
      // Auto-assign click-attribution ref tag (c<id>) so tagged links work from day one
      await pool.query(`UPDATE social_clips SET ref_tag = 'c' || id WHERE id = $1 AND ref_tag IS NULL`, [row.id]);
      created.push(row.id);
    }
    res.json({ created });
  } catch (e) {
    console.error('[social-clips/queue]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Upload a new panel image — stores in R2 (persistent across deploys) and
// also writes a local fallback copy for zero-latency generation on the same dyno.
app.post('/admin/api/social-clips/panel-image', requireRole('admin'),
  express.raw({ type: ['image/png','image/jpeg','image/webp','image/gif'], limit: '15mb' }),
  async (req, res) => {
    try {
      const { uploadBuffer } = require('./storage');
      const ct = req.headers['content-type'] || 'image/png';
      const r2 = await uploadBuffer({ buffer: req.body, contentType: ct, kind: 'social-clip-panel' });
      // Also cache locally so generation on the same dyno avoids an extra download
      const fs2 = require('fs');
      const dir = path.join(__dirname, 'public');
      if (!fs2.existsSync(dir)) fs2.mkdirSync(dir, { recursive: true });
      try { fs2.writeFileSync(path.join(dir, 'tns_end_card_panel.png'), req.body); } catch(_) {}
      res.json({ ok: true, url: r2.url });
    } catch(e) {
      console.error('[panel-image upload]', e.message);
      res.status(500).json({ error: e.message });
    }
  }
);

// Most recently used panel URL — lets a new clip inherit the last panel used.
app.get('/admin/api/social-clips/panel-url', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT panel_url FROM social_clips WHERE panel_url IS NOT NULL ORDER BY updated_at DESC LIMIT 1`
    );
    res.json({ url: rows.length ? rows[0].panel_url : null });
  } catch(e) { res.json({ url: null }); }
});

// Get a single clip
app.get('/admin/api/social-clips/:id(\\d+)', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT sc.*, c.subject AS concept_subject, c.occasion AS concept_occasion, c.action AS concept_action
      FROM social_clips sc LEFT JOIN concepts c ON c.id = sc.concept_id
      WHERE sc.id = $1`, [parseInt(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update clip settings
app.put('/admin/api/social-clips/:id(\\d+)/settings', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  const {
    video_overlay_text, before_y_offset, after_y_offset, panel_url, end_card_duration_s, before_pct,
    clip_style, show_before_s, rise_duration_s, rise_pause_s, style_c_intro_url,
    subject, subject_name, occasion, mood, action, custom_tags, ref_tag,
    tiktok_caption, tiktok_hashtags, tiktok_post_url, tiktok_posted_at,
    instagram_caption, instagram_hashtags, instagram_alt_text, instagram_post_url, instagram_posted_at,
    yt_title, yt_description, yt_keyword_tags, yt_video_id, yt_post_url, yt_posted_at,
    fb_caption, fb_post_url, fb_posted_at,
  } = req.body;
  try {
    const { rows } = await pool.query(`
      UPDATE social_clips SET
        video_overlay_text    = $2,
        before_y_offset       = COALESCE($3, before_y_offset),
        after_y_offset        = COALESCE($4, after_y_offset),
        panel_url             = $5,
        end_card_duration_s   = COALESCE($6, end_card_duration_s),
        before_pct            = COALESCE($7, before_pct),
        clip_style            = COALESCE($8, clip_style),
        show_before_s         = COALESCE($9, show_before_s),
        rise_duration_s       = COALESCE($10, rise_duration_s),
        rise_pause_s          = COALESCE($11, rise_pause_s),
        subject               = $12,
        subject_name          = $13,
        occasion              = $14,
        mood                  = $15,
        custom_tags           = COALESCE($16::TEXT[], ARRAY[]::TEXT[]),
        ref_tag               = $17,
        tiktok_caption        = $18,
        tiktok_hashtags       = $19,
        tiktok_post_url       = $20,
        tiktok_posted_at      = $21,
        instagram_caption     = $22,
        instagram_hashtags    = $23,
        instagram_alt_text    = $24,
        instagram_post_url    = $25,
        instagram_posted_at   = $26,
        yt_title              = $27,
        yt_description        = $28,
        yt_keyword_tags       = $29,
        yt_video_id           = $30,
        yt_post_url           = $31,
        yt_posted_at          = $32,
        fb_caption            = $33,
        fb_post_url           = $34,
        fb_posted_at          = $35,
        action                = $36,
        style_c_intro_url     = $37,
        updated_at            = now()
      WHERE id = $1
      RETURNING *
    `, [id,
        video_overlay_text ?? null,
        before_y_offset ?? null,
        after_y_offset ?? null,
        panel_url ?? null,
        end_card_duration_s ?? null,
        before_pct ?? null,
        clip_style ?? null,
        show_before_s ?? null,
        rise_duration_s ?? null,
        rise_pause_s ?? null,
        subject ?? null,
        subject_name ?? null,
        occasion ?? null,
        mood ?? null,
        (Array.isArray(custom_tags) ? custom_tags : []),
        ref_tag ?? null,
        tiktok_caption ?? null,
        tiktok_hashtags ?? null,
        tiktok_post_url ?? null,
        tiktok_posted_at ?? null,
        instagram_caption ?? null,
        instagram_hashtags ?? null,
        instagram_alt_text ?? null,
        instagram_post_url ?? null,
        instagram_posted_at ?? null,
        yt_title ?? null,
        yt_description ?? null,
        yt_keyword_tags ?? null,
        yt_video_id ?? null,
        yt_post_url ?? null,
        yt_posted_at ?? null,
        fb_caption ?? null,
        fb_post_url ?? null,
        fb_posted_at ?? null,
        action ?? null,
        style_c_intro_url ?? null,
    ]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});




// ── Generate platform content (titles, captions, hashtags) ─────────────────
// Dimension-driven composer (Stage 1 pipeline redesign): every caption is
// assembled as {name/subject} {action-phrase} {occasion-line}. The action
// phrase comes from the clip's `action` dimension (inherited from the
// concept on queue, editable in the tag panel).
const ACTION_PHRASES = {
  // action → { past: fragment after the subject, gerund: titles/alt, noun: product term }
  'royal-portrait': { past: 'got the royal portrait treatment 👑', gerund: 'becoming royalty',        noun: 'royal portrait' },
  'talking':        { past: 'has something to say 🗣️',             gerund: 'speaking their mind',     noun: 'talking portrait' },
  'singing':        { past: 'broke into song 🎤',                  gerund: 'singing their heart out', noun: 'singing portrait' },
};
function actionPhrase(clip, concept) {
  const a = ACTION_PHRASES[clip.action];
  if (a) return a;
  return { past: `got turned into a ${concept} 👑`, gerund: `becoming a ${concept}`, noun: concept };
}

function buildPlatformContent(clip) {
  const subject  = clip.subject || 'pet';
  const concept  = clip.concept_name || clip.concept || 'Loveogram';
  const occasion = clip.occasion;
  const mood     = clip.mood || '';
  const action   = actionPhrase(clip, concept);
  const pronoun  = (subject === 'human' || subject === 'family') ? 'them' : ('your ' + subject);
  const subjectLabel = subject.charAt(0).toUpperCase() + subject.slice(1);

  // Mood sets tone + opening hook
  const moodMap = {
    'funny':     { emoji: '\u{1F602}', hook1: 'POV: your {subject} just went viral',   cta: 'Wait for it…'              },
    'heartfelt': { emoji: '\u{1F97A}', hook1: 'This one is going to make you cry',      cta: 'Wait for the after…'       },
    'dramatic':  { emoji: '\u{1F451}', hook1: 'Nothing prepared us for the after',       cta: 'The transformation is real.'    },
    'cute':      { emoji: '\u{1F970}', hook1: 'The cutest thing you’ll see today',  cta: 'Wait for the after… \u{1F60D}' },
    'elegant':   { emoji: '✨',    hook1: 'Timeless. Stunning. Unforgettable.',       cta: 'Wait for the after…'       },
  };
  const m        = moodMap[mood] || { emoji: '\u{1F60D}', hook1: subjectLabel + ' ' + action.past, cta: 'Wait for the after… \u{1F60D}' };
  const moodEmoji = m.emoji;
  const hook1     = m.hook1.replace('{subject}', subject);
  const cta       = m.cta;
  const mainLine  = subjectLabel + ' ' + action.past + ' ' + moodEmoji;

  // Occasion call-to-action lines
  const occasionLine = {
    'birthday':    '\u{1F382} The perfect birthday gift — they’ll never forget it.',
    'fathers-day': '\u{1F381} Dad’s going to love this. Perfect Father’s Day gift.',
    'mothers-day': '\u{1F338} The best Mother’s Day gift. She’ll cry happy tears.',
    'christmas':   '\u{1F384} The perfect Christmas gift — order before it sells out.',
  }[occasion] || '';

  // Subject hashtag pools
  const subjectTags = {
    'dog':    '#dogsoftiktok #dogmom #doglover #doglovers #dogsofinstagram',
    'cat':    '#catsoftiktok #catmom #catlover #catlovers #catsofinstagram',
    'human':  '#portrait #personalgift #uniquegift #customportrait',
    'family': '#familylove #familyphoto #familygift #familyportrait',
  }[subject] || '#petlovers #pets';

  const occasionTags = {
    'birthday':    '#birthdaygift #birthdayideas #giftideas #uniquegiftideas',
    'fathers-day': '#fathersday #fathersdaygift #giftfordad #fathersdayideas',
    'mothers-day': '#mothersday #mothersdaygift #giftformom #mothersdayideas',
    'christmas':   '#christmasgift #christmasideas #christmaspresent',
  }[occasion] || '';

  const moodTags = {
    'funny':     '#funnyanimals #funnypets #lol #funny',
    'heartfelt': '#heartfelt #emotional #touching #tears',
    'dramatic':  '#dramatic #royaltreatment #wow',
    'cute':      '#cute #adorable #cutepets #aww',
    'elegant':   '#elegant #artistic #beautiful #art',
  }[mood] || '';

  // Custom tags: stored as array, convert to hashtags
  const customTags = (clip.custom_tags || [])
    .map(t => t.trim()).filter(Boolean)
    .map(t => t.startsWith('#') ? t : '#' + t.replace(/\s+/g, ''))
    .join(' ');

  const conceptTag = '#' + concept.toLowerCase().replace(/[^a-z0-9]/g, '');

  // TikTok
  const ttCaption  = `${hook1}\n\n${mainLine}\n\n${occasionLine ? occasionLine + '\n\n' : ''}Create yours: turtleandsun.com/tt${clip.id}`;
  const ttHashtags = [conceptTag, subjectTags, '#beforeandafter #petportrait #loveogram #turtleandsun #fyp', occasionTags, moodTags, customTags].filter(Boolean).join(' ');

  // Instagram
  const igCaption  = `${hook1}\n\n${mainLine}\n\nTransformed into a stunning ${action.noun} by Turtle and Sun — the photo you could never take.\n\n${occasionLine ? occasionLine + '\n\n' : ''}Create yours at turtleandsun.com \u{1F422}  From 99 kr / ~$9`;
  const igHashtags = ['#petportrait', conceptTag, subjectTags, '#beforeandafter #loveogram #turtleandsun #aiart #petgift', occasionTags, moodTags, customTags].filter(Boolean).join(' ');
  const igAlt      = `${subjectLabel} ${action.gerund} — before and after showing the original photo and the AI-generated ${action.noun}`;

  // YouTube
  const occasionSuffix = occasion && occasion !== 'general' ? ' | ' + occasion.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '';
  const ytTitle    = `${subjectLabel} ${action.past} | Before & After${occasionSuffix}`;
  const ytDesc     = `${hook1}\n\n${mainLine}\n\nThis is a Loveogram — an AI-generated portrait that transforms your ${subject === 'human' || subject === 'family' ? 'photo' : subject + ' photo'} into a stunning ${action.noun}.\n\nCreate yours at turtleandsun.com\nFrom 99 kr / ~$9 USD\n\n${occasionLine ? occasionLine + '\n\n' : ''}The photo you could never take.\n5% of every order goes to the Turtleandsun Connection Fund \u{1F422}\n\n#Shorts ${conceptTag} #loveogram #turtleandsun`;
  const ytKw       = [subject + ' portrait', concept.toLowerCase(), (clip.action || 'royal-portrait').replace(/-/g, ' '), mood ? mood + ' ' + subject : '', 'pet transformation', 'before and after', 'AI pet art', subject + ' makeover', 'pet gift', 'loveogram', 'turtle and sun', subject + ' art', occasion && occasion !== 'general' ? occasion.replace(/-/g, ' ') + ' gift' : '', 'AI art'].filter(Boolean).join(', ');

  // Facebook
  const fbCaption  = `${hook1}\n\n${mainLine}\n\nWe transformed ${pronoun} into a ${action.noun} — ${cta.toLowerCase().replace(/…$/, '')}\n\n${occasionLine ? occasionLine + '\n\n' : ''}Create your own Loveogram at turtleandsun.com — from 99 kr.`;

  return { tiktok_caption: ttCaption, tiktok_hashtags: ttHashtags, instagram_caption: igCaption, instagram_hashtags: igHashtags, instagram_alt_text: igAlt, yt_title: ytTitle, yt_description: ytDesc, yt_keyword_tags: ytKw, fb_caption: fbCaption };
}

app.post('/admin/api/social-clips/:id(\\d+)/generate-content', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT sc.*, c.name AS concept_name
      FROM social_clips sc LEFT JOIN concepts c ON c.id = sc.concept_id
      WHERE sc.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const clip = rows[0];
    if (clip.style === 'video-engine') {
      return res.status(400).json({
        error: 'This clip comes from the Video Engine — its texts are LLM-written from the story. Use the 📝 Posting texts button on https://turtleandsun.com/admin/video-stories instead (the template here would overwrite them with Loveogram wording).',
      });
    }
    const generated = buildPlatformContent(clip);
    // Save generated fields
    await pool.query(`
      UPDATE social_clips SET
        tiktok_caption=$2, tiktok_hashtags=$3,
        instagram_caption=$4, instagram_hashtags=$5, instagram_alt_text=$6,
        yt_title=$7, yt_description=$8, yt_keyword_tags=$9,
        fb_caption=$10, updated_at=NOW()
      WHERE id=$1`,
      [req.params.id,
       generated.tiktok_caption, generated.tiktok_hashtags,
       generated.instagram_caption, generated.instagram_hashtags, generated.instagram_alt_text,
       generated.yt_title, generated.yt_description, generated.yt_keyword_tags,
       generated.fb_caption]
    );
    res.json({ ok: true, ...generated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── YouTube OAuth + Upload ──────────────────────────────────────────────────

function ytOAuthUrl(state) {
  const params = new URLSearchParams({
    client_id:     process.env.YOUTUBE_CLIENT_ID,
    redirect_uri:  process.env.APP_BASE_URL
                     ? process.env.APP_BASE_URL.replace(/\/$/, '') + '/admin/youtube/callback'
                     : 'https://turtleandsun.com/admin/youtube/callback',
    response_type: 'code',
    scope:         'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl',
    access_type:   'offline',
    prompt:        'consent',
    state:         state || '',
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

app.get('/admin/youtube/connect', requireRole('admin'), (req, res) => {
  if (!process.env.YOUTUBE_CLIENT_ID) return res.status(400).send('YOUTUBE_CLIENT_ID not set in Railway env');
  res.redirect(ytOAuthUrl('admin'));
});

app.get('/admin/youtube/callback', requireRole('admin'), async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/admin/social-clips?yt_error=' + encodeURIComponent(error || 'no_code'));
  try {
    const https4 = require('https');
    const baseUrl = process.env.APP_BASE_URL
      ? process.env.APP_BASE_URL.replace(/\/$/, '')
      : 'https://turtleandsun.com';
    const tokenBody = new URLSearchParams({
      code,
      client_id:     process.env.YOUTUBE_CLIENT_ID,
      client_secret: process.env.YOUTUBE_CLIENT_SECRET,
      redirect_uri:  baseUrl + '/admin/youtube/callback',
      grant_type:    'authorization_code',
    }).toString();

    const tokens = await new Promise((resolve, reject) => {
      const req2 = https4.request({
        hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(tokenBody) }
      }, r => {
        let body = ''; r.on('data', c => body += c); r.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      });
      req2.on('error', reject); req2.write(tokenBody); req2.end();
    });

    if (!tokens.refresh_token) {
      return res.redirect('/admin/social-clips?yt_error=' + encodeURIComponent('No refresh token — revoke access at myaccount.google.com/permissions and try again'));
    }

    // Get channel info
    const chRes = await new Promise((resolve, reject) => {
      https4.get(
        `https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&key=${process.env.YOUTUBE_API_KEY}`,
        { headers: { Authorization: 'Bearer ' + tokens.access_token } },
        r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { reject(e); } }); }
      ).on('error', reject);
    });
    const ch = (chRes.items || [])[0];

    await pool.query(`
      INSERT INTO platform_tokens (platform, access_token, refresh_token, token_expiry, channel_id, channel_title, updated_at)
      VALUES ('youtube', $1, $2, $3, $4, $5, NOW())
      ON CONFLICT (platform) DO UPDATE SET
        access_token=$1, refresh_token=$2, token_expiry=$3, channel_id=$4, channel_title=$5, updated_at=NOW()`,
      [tokens.access_token, tokens.refresh_token,
       new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
       ch ? ch.id : null, ch ? ch.snippet.title : null]
    );

    res.redirect('/admin/social-clips?yt_connected=1');
  } catch(e) {
    console.error('[yt-oauth] callback error:', e.message);
    res.redirect('/admin/social-clips?yt_error=' + encodeURIComponent(e.message));
  }
});

// 5-minute in-memory cache for platform status checks. These hit external
// APIs (Instagram was measured at 14.6s) and were choking page loads.
const _statusCache = {};
function statusCacheMw(key) {
  return (req, res, next) => {
    if (req.query.fresh === '1') { delete _statusCache[key]; }
    const hit = _statusCache[key];
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return res.json(hit.body);
    const orig = res.json.bind(res);
    res.json = (b) => { if (res.statusCode < 400) _statusCache[key] = { at: Date.now(), body: b }; return orig(b); };
    next();
  };
}

app.get('/admin/api/youtube/status', requireRole('admin'), statusCacheMw('youtube'), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT channel_id, channel_title, updated_at FROM platform_tokens WHERE platform='youtube'`);
    if (!rows.length) return res.json({ connected: false });
    res.json({ connected: true, channel_id: rows[0].channel_id, channel_title: rows[0].channel_title, updated_at: rows[0].updated_at });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get a fresh YouTube access token using stored refresh token
async function getYouTubeAccessToken() {
  const { rows } = await pool.query(`SELECT refresh_token, access_token, token_expiry FROM platform_tokens WHERE platform='youtube'`);
  if (!rows.length) throw new Error('YouTube not connected — visit /admin/youtube/connect first');
  const row = rows[0];
  if (row.token_expiry && new Date(row.token_expiry) > new Date(Date.now() + 60000)) {
    return row.access_token; // still valid
  }
  // Refresh it
  const https4 = require('https');
  const body = new URLSearchParams({
    client_id:     process.env.YOUTUBE_CLIENT_ID,
    client_secret: process.env.YOUTUBE_CLIENT_SECRET,
    refresh_token: row.refresh_token,
    grant_type:    'refresh_token',
  }).toString();
  const tokens = await new Promise((resolve, reject) => {
    const req2 = https4.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { reject(e); } });
    });
    req2.on('error', reject); req2.write(body); req2.end();
  });
  if (!tokens.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(tokens));
  await pool.query(
    `UPDATE platform_tokens SET access_token=$1, token_expiry=$2, updated_at=NOW() WHERE platform='youtube'`,
    [tokens.access_token, new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()]
  );
  return tokens.access_token;
}

// ── TikTok OAuth + Upload ──────────────────────────────────────────────────

// TikTok app review rejected the admin-gated redirect URI (reviewers must be
// able to reach it). The callback is now public at /auth/tiktok/callback and
// protected by a single-use state token minted when the admin starts the flow.
const tiktokOAuthStates = new Map(); // state -> expiry (ms)

function tiktokOAuthUrl() {
  const base = (process.env.APP_BASE_URL || 'https://turtleandsun.com').replace(/\/$/, '');
  const state = require('crypto').randomBytes(16).toString('hex');
  tiktokOAuthStates.set(state, Date.now() + 10 * 60 * 1000);
  for (const [s, exp] of tiktokOAuthStates) if (exp < Date.now()) tiktokOAuthStates.delete(s); // prune
  const params = new URLSearchParams({
    client_key:    process.env.TIKTOK_CLIENT_KEY,
    scope:         'video.upload,user.info.basic,video.list',
    response_type: 'code',
    redirect_uri:  base + '/auth/tiktok/callback',
    state,
  });
  return 'https://www.tiktok.com/v2/auth/authorize/?' + params.toString();
}

app.get('/admin/tiktok/connect', requireRole('admin'), (req, res) => {
  if (!process.env.TIKTOK_CLIENT_KEY) return res.status(400).send('TIKTOK_CLIENT_KEY not set in Railway env');
  res.redirect(tiktokOAuthUrl());
});

app.get('/auth/tiktok/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const stateExp = tiktokOAuthStates.get(state);
  if (state) tiktokOAuthStates.delete(state); // single use
  if (!stateExp || stateExp < Date.now())
    return res.redirect('/admin/social-tracker?tt_error=' + encodeURIComponent('Invalid or expired state — start again from Connect TikTok'));
  if (error || !code) return res.redirect('/admin/social-tracker?tt_error=' + encodeURIComponent(error || 'no_code'));
  const https5 = require('https');
  const base   = (process.env.APP_BASE_URL || 'https://turtleandsun.com').replace(/\/$/, '');
  try {
    // Exchange code for tokens
    const tokenBody = new URLSearchParams({
      client_key:    process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      code,
      grant_type:    'authorization_code',
      redirect_uri:  base + '/auth/tiktok/callback',
    }).toString();

    const tokData = await new Promise((resolve, reject) => {
      const r = https5.request({
        hostname: 'open.tiktokapis.com',
        path: '/v2/oauth/token/',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(tokenBody) },
      }, res2 => {
        let d = '';
        res2.on('data', c => d += c);
        res2.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      r.on('error', reject);
      r.write(tokenBody);
      r.end();
    });

    if (tokData.error) throw new Error(tokData.error_description || tokData.error);
    const { access_token, refresh_token, expires_in, refresh_expires_in, open_id } = tokData.data || tokData;
    if (!access_token) throw new Error('No access_token in TikTok response: ' + JSON.stringify(tokData));

    // Fetch display name
    let display_name = open_id || 'TikTok user';
    try {
      const uInfo = await new Promise((resolve, reject) => {
        const r = https5.request({
          hostname: 'open.tiktokapis.com',
          path: '/v2/user/info/?fields=display_name,username',
          method: 'GET',
          headers: { 'Authorization': 'Bearer ' + access_token },
        }, res2 => {
          let d = '';
          res2.on('data', c => d += c);
          res2.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        });
        r.on('error', reject);
        r.end();
      });
      const u = (uInfo.data || {}).user || {};
      display_name = u.display_name || u.username || display_name;
    } catch(e) { console.warn('[tiktok-callback] user info fetch failed:', e.message); }

    const expiry = new Date(Date.now() + (expires_in || 86400) * 1000).toISOString();

    await pool.query(`
      INSERT INTO platform_tokens (platform, access_token, refresh_token, token_expiry, channel_id, channel_title, updated_at)
      VALUES ('tiktok', $1, $2, $3, $4, $5, NOW())
      ON CONFLICT (platform) DO UPDATE SET
        access_token=$1, refresh_token=$2, token_expiry=$3, channel_id=$4, channel_title=$5, updated_at=NOW()`,
      [access_token, refresh_token, expiry, open_id, display_name]);

    console.log('[tiktok-oauth] connected:', display_name, open_id);
    res.redirect('/admin/social-tracker?tt_connected=1');
  } catch(e) {
    console.error('[tiktok-oauth] callback error:', e.message);
    res.redirect('/admin/social-tracker?tt_error=' + encodeURIComponent(e.message));
  }
});

app.get('/admin/api/tiktok/status', requireRole('admin'), statusCacheMw('tiktok'), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT channel_id, channel_title, updated_at FROM platform_tokens WHERE platform='tiktok'`);
    if (!rows.length) return res.json({ connected: false });
    res.json({ connected: true, open_id: rows[0].channel_id, display_name: rows[0].channel_title, updated_at: rows[0].updated_at });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function getTikTokAccessToken() {
  const https5 = require('https');
  const { rows } = await pool.query(`SELECT refresh_token, access_token, token_expiry FROM platform_tokens WHERE platform='tiktok'`);
  if (!rows.length) throw new Error('TikTok not connected — visit /admin/tiktok/connect first');
  const row = rows[0];
  // Return cached token if still valid (>60s remaining)
  if (row.token_expiry && new Date(row.token_expiry) > new Date(Date.now() + 60000)) {
    return row.access_token;
  }
  // Refresh
  const body = new URLSearchParams({
    client_key:    process.env.TIKTOK_CLIENT_KEY,
    client_secret: process.env.TIKTOK_CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: row.refresh_token,
  }).toString();
  const tokens = await new Promise((resolve, reject) => {
    const r = https5.request({
      hostname: 'open.tiktokapis.com',
      path: '/v2/oauth/token/',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res2 => {
      let d = '';
      res2.on('data', c => d += c);
      res2.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
  const td = tokens.data || tokens;
  if (!td.access_token) throw new Error('TikTok token refresh failed: ' + JSON.stringify(tokens));
  await pool.query(
    `UPDATE platform_tokens SET access_token=$1, token_expiry=$2, updated_at=NOW() WHERE platform='tiktok'`,
    [td.access_token, new Date(Date.now() + (td.expires_in || 86400) * 1000).toISOString()]
  );
  return td.access_token;
}

// POST /admin/api/tracker/clips/:id/upload-tiktok
// Sends the clip video to TikTok using PULL_FROM_URL (TikTok fetches from R2).
// Privacy SELF_ONLY → lands in creator inbox as draft; Ivo publishes from TikTok Studio.
app.post('/admin/api/tracker/clips/:id/upload-tiktok', requireRole('admin'), async (req, res) => {
  const https5 = require('https');
  const id = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(
      `SELECT sc.*, c.name AS concept FROM social_clips sc LEFT JOIN concepts c ON c.id=sc.concept_id WHERE sc.id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Clip not found' });
    const clip = rows[0];
    if (!clip.output_url) return res.status(400).json({ error: 'Clip not generated yet' });

    const accessToken = await getTikTokAccessToken();

    // Build title: caption + hashtags (max 2200 chars for TikTok)
    const caption   = clip.tiktok_caption   || clip.concept || 'Loveogram by Turtle and Sun';
    const hashtags  = clip.tiktok_hashtags  || '';
    const title     = (caption + (hashtags ? '\n\n' + hashtags : '')).slice(0, 2200);

    const payload = JSON.stringify({
      post_info: {
        title,
        privacy_level:              'SELF_ONLY',
        disable_duet:               false,
        disable_comment:            false,
        disable_stitch:             false,
        video_cover_timestamp_ms:   1000,
      },
      source_info: {
        source:    'PULL_FROM_URL',
        video_url: clip.output_url,
      },
    });

    const ttRes = await new Promise((resolve, reject) => {
      const r = https5.request({
        hostname: 'open.tiktokapis.com',
        path: '/v2/post/publish/inbox/video/init/',
        method: 'POST',
        headers: {
          'Authorization':  'Bearer ' + accessToken,
          'Content-Type':   'application/json; charset=UTF-8',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, res2 => {
        let d = '';
        res2.on('data', c => d += c);
        res2.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      r.on('error', reject);
      r.write(payload);
      r.end();
    });

    if (ttRes.error && ttRes.error.code !== 'ok') {
      throw new Error(ttRes.error.message || JSON.stringify(ttRes));
    }

    const publish_id = (ttRes.data || {}).publish_id;
    if (!publish_id) throw new Error('No publish_id returned: ' + JSON.stringify(ttRes));

    // Store publish_id as tiktok_video_id so we can track status
    await pool.query(
      `UPDATE social_clips SET tiktok_video_id=$2, tiktok_posted_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [id, publish_id]);

    console.log('[upload-tiktok] clip', id, 'publish_id', publish_id);
    res.json({ ok: true, publish_id });
  } catch(e) {
    console.error('[upload-tiktok]', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ─── Instagram OAuth (Facebook Login — uses META_APP_ID via facebook.com/dialog/oauth) ─────────
// In-memory store for last OAuth debug info (developer use only)
let _igLastDebug = {};
app.get('/admin/api/instagram/debug-last', requireRole('admin'), (req, res) => res.json(_igLastDebug));

// Switched from api.instagram.com (broken "Invalid platform app") to Facebook Login.
// ── Instagram pillarbox cover generator ──────────────────────────────────────
// Generates a square 720×720 JPEG with white bars on left/right from a 9:16 video
// so Instagram grid thumbnails show the full frame instead of an auto-cropped square.
const _igCovers = new Map(); // uuid → Buffer, auto-expires after 10 min

function generateIgCover(videoUrl) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const { randomUUID } = require('crypto');
    const uuid = randomUUID();
    // pad to square (pillarbox white), then scale to 720×720 for a compact JPEG
    const ff = spawn('ffmpeg', [
      '-i', videoUrl,
      '-vframes', '1',
      '-vf', 'pad=ih:ih:(ih-iw)/2:0:white,scale=720:720',
      '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1'
    ]);
    const chunks = [];
    ff.stdout.on('data', d => chunks.push(d));
    ff.stderr.on('data', () => {}); // discard
    ff.on('close', code => {
      if (code !== 0 || chunks.length === 0) return reject(new Error('ffmpeg cover failed (code ' + code + ')'));
      const buf = Buffer.concat(chunks);
      _igCovers.set(uuid, buf);
      setTimeout(() => _igCovers.delete(uuid), 10 * 60 * 1000); // clean up after 10 min
      resolve(uuid);
    });
    ff.on('error', reject);
  });
}

// Public (no auth) endpoint so Meta can fetch the cover during container creation
app.get('/ig-cover/:uuid', (req, res) => {
  const buf = _igCovers.get(req.params.uuid);
  if (!buf) return res.status(404).end();
  res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'no-store').send(buf);
});

// Env vars: META_APP_ID, META_APP_SECRET (already in Railway)

function instagramOAuthUrl() {
  const base = (process.env.APP_BASE_URL || 'https://turtleandsun.com').replace(/\/$/, '');
  const params = new URLSearchParams({
    client_id:     process.env.META_APP_ID,
    redirect_uri:  base + '/admin/instagram/callback',
    scope:         'pages_show_list,pages_read_engagement,pages_manage_posts,read_insights,business_management,instagram_basic,instagram_content_publish,instagram_manage_insights',
    response_type: 'code',
    // auth_type: 'rerequest', // removed - causes Meta to re-request old deprecated permissions
    state:         'admin',
  });
  return 'https://www.facebook.com/dialog/oauth?' + params.toString();
}

app.get('/admin/instagram/connect', requireRole('admin'), (req, res) => {
  if (!process.env.META_APP_ID) return res.status(400).send('META_APP_ID not set in Railway env');
  res.redirect(instagramOAuthUrl());
});

app.get('/admin/instagram/callback', requireRole('admin'), async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/admin/social-tracker?ig_error=' + encodeURIComponent(error || 'no_code'));
  const base = (process.env.APP_BASE_URL || 'https://turtleandsun.com').replace(/\/$/, '');
  try {
    // 1. Exchange code for Facebook User Access Token
    const tokenUrl = 'https://graph.facebook.com/oauth/access_token?' + new URLSearchParams({
      client_id:     process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      redirect_uri:  base + '/admin/instagram/callback',
      code,
    });
    const tokenResp = await fetch(tokenUrl);
    const tokenData = await tokenResp.json();
    if (tokenData.error) throw new Error(tokenData.error.message || JSON.stringify(tokenData.error));
    const shortToken = tokenData.access_token;

    // 2. Exchange for long-lived User token (~60 days)
    const llUrl = 'https://graph.facebook.com/oauth/access_token?' + new URLSearchParams({
      grant_type:        'fb_exchange_token',
      client_id:         process.env.META_APP_ID,
      client_secret:     process.env.META_APP_SECRET,
      fb_exchange_token: shortToken,
    });
    const llResp = await fetch(llUrl);
    const llData = await llResp.json();
    if (llData.error) throw new Error(llData.error.message || JSON.stringify(llData.error));
    const longToken = llData.access_token;
    const expiresIn = llData.expires_in || (60 * 24 * 3600);
    const expiry    = new Date(Date.now() + expiresIn * 1000).toISOString();

    // 3. Find Instagram Business Account via Facebook Pages
    let igUserId = null;
    let igUsername = null;
    let facebookPageId = null;
    let pageToken = null;
    // Debug: who is the token for?
    const meResp = await fetch(`https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${longToken}`);
    const meData = await meResp.json();
    console.log('[ig-debug] me:', JSON.stringify(meData));
    // Debug: check page accounts with instagram field inline
    const pagesResp = await fetch(`https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${longToken}`);
    const pagesData = await pagesResp.json();
    console.log('[ig-debug] pagesData:', JSON.stringify(pagesData));
    _igLastDebug = { step: 'after_me_accounts', meData, pagesData };

    // Fallback: if page is in Business Portfolio, /me/accounts returns empty.
    // Try fetching the known page directly by ID using the user token.
    if (!pagesData.data || pagesData.data.length === 0) {
      const knownPageId = '1127984543734705';
      const directResp = await fetch(`https://graph.facebook.com/v21.0/${knownPageId}?fields=id,name,access_token,instagram_business_account&access_token=${longToken}`);
      const directData = await directResp.json();
      console.log('[ig-debug] direct page fetch:', JSON.stringify(directData));
      if (directData.id && !directData.error) {
        pagesData.data = [directData];
      }
    }

    for (const page of (pagesData.data || [])) {
      // Use page.access_token if available, else fall back to user token
      const pageAccessToken = page.access_token || longToken;
      const igResp = await fetch(`https://graph.facebook.com/v21.0/${page.id}?fields=instagram_business_account,connected_instagram_account&access_token=${pageAccessToken}`);
      const igData = await igResp.json();
      console.log('[ig-debug] igData for page', page.id, ':', JSON.stringify(igData));
      // instagram_business_account = Business account; connected_instagram_account = Creator account
      const igAccount = igData.instagram_business_account || igData.connected_instagram_account;
      if (igAccount && igAccount.id) {
        igUserId       = igAccount.id;
        facebookPageId = page.id;
        pageToken = page.access_token || longToken;
        try {
          const profResp = await fetch(`https://graph.facebook.com/v21.0/${igUserId}?fields=username&access_token=${pageToken}`);
          const profData = await profResp.json();
          igUsername = profData.username || igUserId;
        } catch(e) { igUsername = igUserId; }
        break;
      }
    }
    // Final fallback: try the known @turtleandsun.comm IG user ID directly.
    // This works once the account is in the same Meta Accounts Center as the
    // authorised Facebook user (even before the Page platform-link is confirmed).
    if (!igUserId) {
      const knownIgId = '17841424587372941';
      try {
        const igFallbackResp = await fetch(`https://graph.facebook.com/v21.0/${knownIgId}?fields=id,username&access_token=${longToken}`);
        const igFallbackData = await igFallbackResp.json();
        console.log('[ig-debug] direct IG fallback:', JSON.stringify(igFallbackData));
        if (igFallbackData.id && !igFallbackData.error) {
          igUserId       = igFallbackData.id;
          igUsername     = igFallbackData.username || igFallbackData.id;
          pageToken      = longToken; // use long-lived user token directly
          facebookPageId = facebookPageId || '1127984543734705';
        }
      } catch(e) { /* non-fatal */ }
    }
    if (!igUserId) {
      _igLastDebug = { meData, pagesData, igDataSamples: 'check Railway logs', note: 'all paths failed' };
      throw new Error('No Instagram Business account found linked to a Facebook Page. Ensure @turtleandsun is a Business/Creator account connected to a Facebook Page.');
    }

    // access_token = page token (used for API calls); refresh_token = long-lived user token (for future re-auth)
    await pool.query(`
      INSERT INTO platform_tokens (platform, access_token, refresh_token, token_expiry, channel_id, channel_title, updated_at)
      VALUES ('instagram', $1, $2, $3, $4, $5, NOW())
      ON CONFLICT (platform) DO UPDATE SET
        access_token=$1, refresh_token=$2, token_expiry=$3, channel_id=$4, channel_title=$5, updated_at=NOW()`,
      [pageToken, longToken, expiry, igUserId, igUsername]);

    // Also store Facebook page token so upload-facebook can use the same connection
    const fbPageId = facebookPageId || '1127984543734705';
    await pool.query(`
      INSERT INTO platform_tokens (platform, access_token, refresh_token, token_expiry, channel_id, channel_title, updated_at)
      VALUES ('facebook', $1, $2, $3, $4, 'Turtle and Sun', NOW())
      ON CONFLICT (platform) DO UPDATE SET
        access_token=$1, refresh_token=$2, token_expiry=$3, channel_id=$4, channel_title='Turtle and Sun', updated_at=NOW()`,
      [pageToken, longToken, expiry, fbPageId]);

    console.log('[instagram-oauth] connected via Facebook Login:', igUsername, igUserId);
    res.redirect('/admin/social-tracker?ig_connected=1');
  } catch(e) {
    console.error('[instagram-oauth] callback error:', e.message);
    res.redirect('/admin/social-tracker?ig_error=' + encodeURIComponent(e.message));
  }
});

app.get('/admin/api/instagram/status', requireRole('admin'), statusCacheMw('instagram'), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT channel_id, channel_title, updated_at, token_expiry FROM platform_tokens WHERE platform='instagram'`);
    if (!rows.length) return res.json({ connected: false });
    const row     = rows[0];
    const expired = row.token_expiry && new Date(row.token_expiry) < new Date();
    const daysLeft = row.token_expiry
      ? Math.max(0, Math.round((new Date(row.token_expiry) - Date.now()) / 86400000))
      : null;
    res.json({ connected: !expired, ig_user_id: row.channel_id, username: row.channel_title, updated_at: row.updated_at, expires_at: row.token_expiry, days_left: daysLeft });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function getInstagramToken() {
  const { rows } = await pool.query(`SELECT access_token, refresh_token, token_expiry, channel_id FROM platform_tokens WHERE platform='instagram'`);
  if (!rows.length) throw new Error('Instagram not connected — visit /admin/instagram/connect first');
  const row = rows[0];
  if (row.token_expiry && new Date(row.token_expiry) < new Date()) throw new Error('Instagram token expired — reconnect at /admin/instagram/connect');
  return { token: row.access_token, pageToken: row.refresh_token, igUserId: row.channel_id };
}

// POST /admin/api/tracker/clips/:id/upload-instagram
// Creates a Reels container on Meta, polls until processed, then publishes.
// Goes live immediately on Instagram (no "inbox" draft mode like TikTok).
app.post('/admin/api/tracker/clips/:id/upload-instagram', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(
      `SELECT sc.*, c.name AS concept FROM social_clips sc LEFT JOIN concepts c ON c.id=sc.concept_id WHERE sc.id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Clip not found' });
    const clip = rows[0];
    if (!clip.output_url) return res.status(400).json({ error: 'Clip not generated yet' });

    const { token, pageToken, igUserId } = await getInstagramToken();
    // Use page token for publishing (required for Business account content publishing)
    const publishToken = pageToken || token;
    const caption = [clip.instagram_caption, clip.instagram_hashtags].filter(Boolean).join('\n\n') || 'Loveogram by Turtle and Sun 🐢☀️';

    // Step 1: Create Reels container (uses graph.facebook.com via Facebook Login OAuth)
    const scheduledTime = req.body && req.body.scheduled_publish_time ? parseInt(req.body.scheduled_publish_time) : null;
    const containerParams = { media_type: 'REELS', video_url: clip.output_url, caption, access_token: publishToken };
    if (scheduledTime) { containerParams.published = 'false'; containerParams.scheduled_publish_time = String(scheduledTime); }
    // Generate pillarboxed cover so grid thumbnail shows full 9:16 frame with white bars
    try {
      const base = (process.env.APP_BASE_URL || 'https://turtleandsun.com').replace(/\/$/, '');
      const coverUuid = await generateIgCover(clip.output_url);
      containerParams.cover_url = base + '/ig-cover/' + coverUuid;
      console.log('[upload-instagram] cover_url:', containerParams.cover_url);
    } catch(e) {
      console.warn('[upload-instagram] cover generation skipped:', e.message);
    }
    const createResp = await fetch(`https://graph.facebook.com/v21.0/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(containerParams),
    });
    const containerData = await createResp.json();
    if (containerData.error) throw new Error(containerData.error.message);
    const containerId = containerData.id;
    console.log('[upload-instagram] container created:', containerId);

    // Step 2: Poll until FINISHED (max ~3 min, 18 × 10s)
    let statusCode = 'IN_PROGRESS';
    for (let i = 0; i < 18 && statusCode !== 'FINISHED'; i++) {
      await new Promise(r => setTimeout(r, 10000));
      const statusResp = await fetch(`https://graph.facebook.com/v21.0/${containerId}?fields=status_code&access_token=${publishToken}`);
      const statusData = await statusResp.json();
      statusCode = statusData.status_code || 'IN_PROGRESS';
      console.log('[upload-instagram] status poll', i + 1, statusCode);
      if (statusCode === 'ERROR') throw new Error('Instagram video processing failed — check video format (MP4, H.264, AAC, 9:16)');
    }
    if (statusCode !== 'FINISHED') throw new Error('Instagram upload timed out — video still processing. Try again in a few minutes.');

    // Step 3: Publish (or schedule)
    const publishParams = { creation_id: containerId, access_token: publishToken };
    const publishResp = await fetch(`https://graph.facebook.com/v21.0/${igUserId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(publishParams),
    });
    const publishData = await publishResp.json();
    if (publishData.error) throw new Error(publishData.error.message);
    const mediaId = publishData.id;

    // Get permalink
    let permalink = null;
    try {
      const plResp = await fetch(`https://graph.facebook.com/v21.0/${mediaId}?fields=permalink&access_token=${publishToken}`);
      const plData = await plResp.json();
      permalink = plData.permalink || null;
    } catch(e) { /* non-fatal */ }

    // Save posted_at, url, media_id AND write back the actual caption/hashtags so the modal reflects reality
    const sentCaption = clip.instagram_caption || null;
    const sentHashtags = clip.instagram_hashtags || null;
    await pool.query(
      `UPDATE social_clips SET instagram_posted_at=NOW(), instagram_post_url=$1, instagram_media_id=$3,
       instagram_caption=COALESCE($4, instagram_caption), instagram_hashtags=COALESCE($5, instagram_hashtags) WHERE id=$2`,
      [permalink, id, mediaId, sentCaption, sentHashtags]);

    console.log('[upload-instagram] clip', id, 'published, media_id', mediaId);
    res.json({ ok: true, media_id: mediaId, permalink, scheduled: !!scheduledTime });
  } catch(e) {
    console.error('[upload-instagram]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Facebook video posting (reuses Meta page token from Instagram OAuth) ──────

async function getFacebookToken() {
  const { rows } = await pool.query(`SELECT access_token, channel_id, token_expiry FROM platform_tokens WHERE platform='facebook'`);
  if (!rows.length) throw new Error('Facebook not connected — reconnect Instagram at /admin/instagram/connect first');
  const row = rows[0];
  if (row.token_expiry && new Date(row.token_expiry) < new Date()) throw new Error('Facebook token expired — reconnect at /admin/instagram/connect');
  return { token: row.access_token, pageId: row.channel_id || '1127984543734705' };
}

app.get('/admin/api/facebook/status', requireRole('admin'), statusCacheMw('facebook'), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT channel_id, channel_title, updated_at, token_expiry FROM platform_tokens WHERE platform='facebook'`);
    if (!rows.length) return res.json({ connected: false });
    const row     = rows[0];
    const expired = row.token_expiry && new Date(row.token_expiry) < new Date();
    const daysLeft = row.token_expiry
      ? Math.max(0, Math.round((new Date(row.token_expiry) - Date.now()) / 86400000))
      : null;
    res.json({ connected: !expired, page_id: row.channel_id, page_name: row.channel_title, updated_at: row.updated_at, expires_at: row.token_expiry, days_left: daysLeft });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /admin/api/tracker/clips/:id/upload-facebook
// Posts clip as a video to the Turtle and Sun Facebook Page (file_url approach).
app.post('/admin/api/tracker/clips/:id/upload-facebook', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(
      `SELECT sc.*, COALESCE(c.name, sc.concept_name, '') AS concept FROM social_clips sc LEFT JOIN concepts c ON c.id=sc.concept_id WHERE sc.id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Clip not found' });
    const clip = rows[0];
    if (!clip.output_url) return res.status(400).json({ error: 'Clip not generated yet' });

    const { token, pageId } = await getFacebookToken();
    const caption = clip.fb_caption || 'Loveogram by Turtle and Sun';

    const videoResp = await fetch(`https://graph.facebook.com/v21.0/${pageId}/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ file_url: clip.output_url, description: caption, title: (clip.concept||'').slice(0,100), access_token: token }),
    });
    const videoData = await videoResp.json();
    if (videoData.error) throw new Error(videoData.error.message);
    const videoId = videoData.id;

    // Get permalink
    let permalink = null;
    try {
      const plResp = await fetch(`https://graph.facebook.com/v21.0/${videoId}?fields=permalink_url&access_token=${token}`);
      const plData = await plResp.json();
      permalink = plData.permalink_url || null;
    } catch(e) { /* non-fatal */ }
    if (!permalink) permalink = 'https://www.facebook.com/' + pageId + '/videos/' + videoId;

    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      'UPDATE social_clips SET fb_posted_at=$2, fb_post_url=$3, facebook_video_id=$4, fb_caption=COALESCE($5, fb_caption), updated_at=NOW() WHERE id=$1',
      [id, today, permalink, videoId, clip.fb_caption || null]);

    console.log('[upload-facebook] clip', id, 'published, video_id', videoId);
    res.json({ ok: true, video_id: videoId, permalink });
  } catch(e) {
    console.error('[upload-facebook]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/api/tracker/clips/:id/fb-live — live Facebook stats for a clip
app.get('/admin/api/tracker/clips/:id/fb-live', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT facebook_video_id, fb_post_url, fb_posted_at FROM social_clips WHERE id=$1', [parseInt(req.params.id)]);
    if (!rows.length || !rows[0].facebook_video_id) return res.status(400).json({ error: 'No Facebook video ID for this clip' });
    const { facebook_video_id: videoId, fb_post_url: knownUrl, fb_posted_at: postedAt } = rows[0];
    const { token, pageId } = await getFacebookToken();

    // Fetch video metadata
    let permalink = knownUrl, description = null, createdTime = postedAt;
    try {
      const detR = await fetch('https://graph.facebook.com/v21.0/' + videoId + '?fields=permalink_url,description,created_time&access_token=' + token);
      const detD = await detR.json();
      if (!detD.error) {
        permalink   = detD.permalink_url || knownUrl;
        description = detD.description   || null;
        createdTime = detD.created_time   || postedAt;
      }
    } catch(e) { /* non-fatal */ }

    // Fetch video insights
    let views = 0, likes = 0, comments = 0;
    try {
      const insR = await fetch('https://graph.facebook.com/v21.0/' + videoId + '/video_insights?metric=blue_reels_play_count,fb_reels_total_plays,post_video_likes_by_reaction_type,post_video_comments&period=lifetime&access_token=' + token);
      const insD = await insR.json();
      if (!insD.error && insD.data) {
        const byName = {};
        for (const m of insD.data) byName[m.name] = m.values && m.values[0] ? m.values[0].value : 0;
        views = byName.blue_reels_play_count || byName.fb_reels_total_plays || 0;
        if (typeof views === 'object') views = Object.values(views).reduce((a, b) => a + b, 0);
        const reactions = byName.post_video_likes_by_reaction_type;
        if (reactions && typeof reactions === 'object') likes = Object.values(reactions).reduce((a, b) => a + b, 0);
        if (typeof byName.post_video_comments === 'number') comments = byName.post_video_comments;
      }
    } catch(e) { /* non-fatal */ }

    res.json({
      video_id:    videoId,
      permalink:   permalink || ('https://www.facebook.com/' + pageId + '/videos/' + videoId),
      description: description,
      posted_at:   createdTime ? new Date(createdTime).toISOString().slice(0, 10) : null,
      views, likes, comments,
    });
  } catch(e) {
    console.error('[fb-live]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /admin/api/tracker/clips/:id/facebook — clear Facebook tracking (DB only; post stays on FB)
app.delete('/admin/api/tracker/clips/:id/facebook', requireRole('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await pool.query(
      `UPDATE social_clips SET fb_posted_at=NULL, fb_post_url=NULL, facebook_video_id=NULL WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /admin/api/tracker/clips/:id/instagram — clear Instagram tracking (DB only; post stays on IG)
app.delete('/admin/api/tracker/clips/:id/instagram', requireRole('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await pool.query(
      `UPDATE social_clips SET instagram_posted_at=NULL, instagram_post_url=NULL, instagram_media_id=NULL WHERE id=$1`,
      [id]);
    res.json({ ok: true });
  } catch(e) {
    console.error('[delete-instagram]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/api/tracker/clips/:id/ig-live — fetch live stats from Instagram Graph API
app.get('/admin/api/tracker/clips/:id/ig-live', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT instagram_media_id, instagram_post_url, instagram_posted_at FROM social_clips WHERE id=$1`,
      [parseInt(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { instagram_media_id: mediaId, instagram_post_url: postUrl, instagram_posted_at: postedAt } = rows[0];
    if (!mediaId) return res.json({ mediaId: null, postUrl, postedAt });

    const { token } = await getInstagramToken();
    const { token: igToken, pageToken: igPageToken } = await getInstagramToken();
    const igTok = igToken || igPageToken;
    const basicR = await fetch(`https://graph.facebook.com/v21.0/${mediaId}?fields=like_count,comments_count,permalink,timestamp,media_type&access_token=${igTok}`);
    const basicD = await basicR.json();
    if (basicD.error) return res.json({ mediaId, postUrl, postedAt, apiError: basicD.error.message });
    let plays = null, reach = null;
    try {
      const insR = await fetch(`https://graph.facebook.com/v21.0/${mediaId}/insights?metric=plays,reach&access_token=${igTok}`);
      const insD = await insR.json();
      if (!insD.error && insD.data) {
        const byName = {};
        insD.data.forEach(m => { byName[m.name] = m.values && m.values[0] ? m.values[0].value : (m.value || 0); });
        plays = byName.plays ?? null; reach = byName.reach ?? null;
      }
    } catch(e) { /* insights not available in dev mode */ }
    res.json({ mediaId, postUrl, postedAt, plays, reach, likes: basicD.like_count, comments: basicD.comments_count, permalink: basicD.permalink||postUrl, timestamp: basicD.timestamp });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Publish a social clip to YouTube
app.post('/admin/api/social-clips/:id(\\d+)/publish-youtube', requireRole('admin'), async (req, res) => {
  const fs4  = require('fs');
  const os4  = require('os');
  const path4 = require('path');
  try {
    const publish_at = req.body && req.body.publish_at ? req.body.publish_at : null;
    // Load clip
    const { rows } = await pool.query(`SELECT * FROM social_clips WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Clip not found' });
    const clip = rows[0];
    if (!clip.output_url) return res.status(400).json({ error: 'Clip not generated yet — generate it first' });
    if (!clip.yt_title) return res.status(400).json({ error: 'YouTube title is required — fill it in the YouTube tab first' });

    const accessToken = await getYouTubeAccessToken();

    // Download the video
    const tmpDir = fs4.mkdtempSync(path4.join(os4.tmpdir(), 'tns-yt-'));
    const videoPath = path4.join(tmpDir, 'clip.mp4');
    try {
      const https4 = require('https');
      const http4  = require('http');
      const urlM   = require('url');
      const parsed4 = urlM.parse(clip.output_url);
      const lib4 = parsed4.protocol === 'https:' ? https4 : http4;
      await new Promise((resolve, reject) => {
        const ws = fs4.createWriteStream(videoPath);
        lib4.get(clip.output_url, r => { r.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); }).on('error', reject);
      });

      const videoBytes = fs4.readFileSync(videoPath);
      const fileSize   = videoBytes.length;

      // Step 1: initiate resumable upload
      const meta = JSON.stringify({
        snippet: {
          title:       clip.yt_title,
          description: clip.yt_description || '',
          tags:        clip.yt_keyword_tags ? clip.yt_keyword_tags.split(',').map(s=>s.trim()).filter(Boolean) : [],
          categoryId:  '22', // People & Blogs
        },
        status: { privacyStatus: publish_at ? 'private' : 'public', publishAt: publish_at || undefined, selfDeclaredMadeForKids: false },
      });

      const uploadUrl = await new Promise((resolve, reject) => {
        const initReq = require('https').request({
          hostname: 'www.googleapis.com',
          path:     '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
          method:   'POST',
          headers: {
            Authorization:           'Bearer ' + accessToken,
            'Content-Type':          'application/json',
            'Content-Length':        Buffer.byteLength(meta),
            'X-Upload-Content-Type': 'video/mp4',
            'X-Upload-Content-Length': fileSize,
          }
        }, r => {
          if (r.statusCode !== 200) {
            let b = ''; r.on('data', c => b += c); r.on('end', () => reject(new Error('Init failed ' + r.statusCode + ': ' + b)));
          } else {
            resolve(r.headers.location);
          }
        });
        initReq.on('error', reject); initReq.write(meta); initReq.end();
      });

      // Step 2: upload the video bytes
      const ytResponse = await new Promise((resolve, reject) => {
        const upUrl = new URL(uploadUrl);
        const upReq = require('https').request({
          hostname: upUrl.hostname,
          path:     upUrl.pathname + upUrl.search,
          method:   'PUT',
          headers: {
            'Content-Type':   'video/mp4',
            'Content-Length': fileSize,
          }
        }, r => {
          let b = ''; r.on('data', c => b += c);
          r.on('end', () => {
            try {
              const d = JSON.parse(b);
              if (r.statusCode === 200 || r.statusCode === 201) resolve(d);
              else reject(new Error('Upload failed ' + r.statusCode + ': ' + b.slice(0,400)));
            } catch(e) { reject(e); }
          });
        });
        upReq.on('error', reject); upReq.write(videoBytes); upReq.end();
      });

      const videoId  = ytResponse.id;
      const videoUrl = `https://www.youtube.com/shorts/${videoId}`;
      const today    = new Date().toISOString().slice(0,10);

      // Save video ID and URL back to the clip
      await pool.query(
        `UPDATE social_clips SET yt_video_id=$2, yt_post_url=$3, yt_posted_at=$4, published_youtube=TRUE, yt_scheduled_at=$5, updated_at=NOW() WHERE id=$1`,
        [req.params.id, videoId, videoUrl, today, publish_at || null]
      );

      res.json({ ok: true, video_id: videoId, url: videoUrl });
    } finally {
      fs4.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch(e) {
    console.error('[publish-youtube] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── Clip stats (daily views per platform) ──────────────────────────────────────
app.get('/admin/api/social-clips/:id(\d+)/stats', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT platform, stat_date, views, likes, comments, shares, source
       FROM clip_stats WHERE social_clip_id=$1 ORDER BY stat_date DESC, platform`,
      [req.params.id]
    );
    res.json({ rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/api/social-clips/:id(\d+)/stats', requireRole('admin'), async (req, res) => {
  try {
    const { platform, stat_date, views, likes, comments, shares } = req.body;
    if (!platform) return res.status(400).json({ error: 'platform required' });
    await pool.query(`
      INSERT INTO clip_stats (social_clip_id, platform, stat_date, views, likes, comments, shares, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'manual')
      ON CONFLICT (social_clip_id, platform, stat_date) DO UPDATE SET
        views=$4, likes=$5, comments=$6, shares=$7, source='manual'`,
      [req.params.id, platform,
       stat_date || new Date().toISOString().slice(0,10),
       views||0, likes||0, comments||0, shares||0]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/api/social-clips/:id/fetch-youtube-stats', requireRole('admin'), async (req, res) => {
  const YT_KEY = process.env.YOUTUBE_API_KEY;
  if (!YT_KEY) return res.status(400).json({ error: 'YOUTUBE_API_KEY not set in Railway env' });
  try {
    const { rows } = await pool.query(
      `SELECT yt_video_id FROM social_clips WHERE id=$1 AND yt_video_id IS NOT NULL AND yt_video_id <> ''`,
      [req.params.id]
    );
    if (!rows.length) return res.status(400).json({ error: 'No YouTube video ID set for this clip' });
    const vidId = rows[0].yt_video_id;
    const https3 = require('https');
    const url3 = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(vidId)}&key=${YT_KEY}`;
    const data = await new Promise((resolve, reject) => {
      https3.get(url3, r => {
        let body = ''; r.on('data', c => body += c);
        r.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
    const item = (data.items || [])[0];
    if (!item) return res.status(404).json({ error: 'Video not found on YouTube' });
    const s = item.statistics || {};
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(`
      INSERT INTO clip_stats (social_clip_id, platform, stat_date, views, likes, comments, shares, source)
      VALUES ($1,'youtube',$2,$3,$4,$5,0,'api')
      ON CONFLICT (social_clip_id, platform, stat_date) DO UPDATE SET
        views=$3, likes=$4, comments=$5, source='api'`,
      [req.params.id, today, parseInt(s.viewCount)||0, parseInt(s.likeCount)||0, parseInt(s.commentCount)||0]
    );
    res.json({ ok: true, views: parseInt(s.viewCount)||0, likes: parseInt(s.likeCount)||0, comments: parseInt(s.commentCount)||0 });
  } catch(e) {
    console.error('[yt-stats] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Delete a clip
app.delete('/admin/api/social-clips/:id(\\d+)', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  const force = req.query.force === '1';
  try {
    const { rows } = await pool.query(
      `SELECT tiktok_posted_at, instagram_posted_at, yt_posted_at, fb_posted_at FROM social_clips WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (!force) {
      const r = rows[0];
      const published = [
        r.tiktok_posted_at    && 'TikTok',
        r.instagram_posted_at && 'Instagram',
        r.yt_posted_at        && 'YouTube',
        r.fb_posted_at        && 'Facebook',
      ].filter(Boolean);
      if (published.length)
        return res.status(409).json({ published });
    }
    await pool.query(`DELETE FROM social_clips WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate (or re-generate) a clip — reads settings from DB
app.post('/admin/api/social-clips/:id(\\d+)/generate', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { execFile } = require('child_process');
  const os    = require('os');
  const pathM = require('path');

  let clip;
  try {
    const { rows } = await pool.query(`SELECT * FROM social_clips WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    clip = rows[0];
  } catch (e) { return res.status(500).json({ error: e.message }); }

  if (!clip.before_url || !clip.after_video_url)
    return res.status(400).json({ error: 'Missing before_url or after_video_url on this clip' });

  if (parseInt(clip.clip_style) === 4 && !clip.style_c_intro_url)
    return res.status(400).json({ error: 'Style C: drag a video from Asset Storage before generating' });

  // Mark processing immediately
  await pool.query(`UPDATE social_clips SET status='processing', error_msg=NULL, updated_at=now() WHERE id=$1`, [id]);
  res.json({ ok: true, message: 'Generation started — poll /admin/api/social-clips/' + id + ' for status' });

  // Run generation in background
  (async () => {
    const tmpDir      = require('fs').mkdtempSync(pathM.join(os.tmpdir(), 'tns-clip-'));
    const videoFile   = pathM.join(tmpDir, 'after.mp4');
    const endCardFile = pathM.join(tmpDir, 'end_card.jpg');
    const beforeFile  = pathM.join(tmpDir, 'before.jpg');
    const panelFile   = pathM.join(tmpDir, 'panel.png');
    const outFile     = pathM.join(tmpDir, 'clip.mp4');
    try {
      const _https = require('https');
      const _http  = require('http');
      const fs2 = require('fs');

      async function dlBuffer(url) {
        return new Promise((resolve, reject) => {
          const lib = url.startsWith('https') ? _https : _http;
          const chunks = [];
          lib.get(url, res2 => {
            if (res2.statusCode >= 300 && res2.headers.location)
              return dlBuffer(res2.headers.location).then(resolve).catch(reject);
            res2.on('data', c => chunks.push(c));
            res2.on('end', () => resolve(Buffer.concat(chunks)));
          }).on('error', reject);
        });
      }
      async function dlFile(url, dest) { fs2.writeFileSync(dest, await dlBuffer(url)); }

      // ── 1. Build composite end card (before + panel + after) ──
      const sharp = require('sharp');
      const W = 1080, H = 1920;

      // Load panel from clip.panel_url or fall back to local file or dark bar
      let panelBuf, panelH;
      const panelSrc = clip.panel_url || null;
      const panelLocalPath = pathM.join(__dirname, 'public', 'tns_end_card_panel.png');
      try {
        const rawPanel = panelSrc ? await dlBuffer(panelSrc) : (fs2.existsSync(panelLocalPath) ? fs2.readFileSync(panelLocalPath) : null);
        if (rawPanel) {
          const pm = await sharp(rawPanel).metadata();
          panelH = Math.round(W * pm.height / pm.width);
          panelBuf = await sharp(rawPanel).resize(W, panelH, { fit: 'cover' }).png().toBuffer();
        } else {
          throw new Error('no panel source');
        }
      } catch(pe) {
        panelH = 380;
        panelBuf = await sharp({ create: { width: W, height: panelH, channels: 3, background: { r: 28, g: 42, b: 20 } } }).png().toBuffer();
        console.warn('[social-clip] panel load failed, using dark fallback:', pe.message);
      }
      const _beforePct = parseFloat(clip.before_pct) || 40;
      const beforeH = Math.max(100, Math.round(H * _beforePct / 100));
      const afterH  = Math.max(100, H - panelH - beforeH);
      const photoH  = beforeH; // kept for cropPhoto compat below

      // Label SVG helper — green pill matching landing page .ts-label style
      // atBottom: true → place pill near bottom of frame (for AFTER label on full-frame video)
      function makeLabel(text, w, h, atBottom) {
        const chars = text.length;
        const pw = chars * 23 + 80; // approx pill width
        const px = w - 28 - pw;
        const ry = atBottom ? h - 100 : 24;
        const ty = atBottom ? h - 50  : 74;
        return Buffer.from(
          `<svg width='${w}' height='${h}'>` +
          `<rect x='${px}' y='${ry}' width='${pw}' height='76' rx='38' fill='#3A6B20'/>` +
          `<text x='${px + pw/2}' y='${ty}' text-anchor='middle' font-family='Arial' font-weight='bold' font-size='36' fill='white' letter-spacing='4'>${text}</text>` +
          `</svg>`
        );
      }

      // Crop helper — scale with headroom then extract at y-offset
      async function cropPhoto(buf, yOff, cropH) {
        const meta = await sharp(buf).metadata();
        const minH = cropH + 400;
        const scaleToW = Math.round(meta.height * W / meta.width);
        let scaled = scaleToW >= minH
          ? await sharp(buf).resize({ width: W }).toBuffer()
          : await sharp(buf).resize({ height: minH }).toBuffer();
        const sm = await sharp(scaled).metadata();
        const maxY = Math.max(0, sm.height - cropH);
        const top  = Math.max(0, Math.min(maxY, yOff || 0));
        const left = Math.max(0, Math.floor((sm.width - W) / 2));
        return sharp(scaled).extract({ left, top, width: W, height: cropH }).jpeg({ quality: 92 }).toBuffer();
      }

      // ── 2. Download the after video ──
      await dlFile(clip.after_video_url, videoFile);

      // ── 3. Ensure FFmpeg is available ──
      const ffmpegBin = process.env.FFMPEG_PATH || '/tmp/ffmpeg';
      if (!fs2.existsSync(ffmpegBin)) {
        await new Promise((resolve) => {
          require('child_process').execFile(
            process.execPath, [pathM.join(__dirname, 'scripts/download-ffmpeg.js')],
            { timeout: 180000 }, () => resolve()
          );
        });
      }
      if (!fs2.existsSync(ffmpegBin)) throw new Error('FFmpeg unavailable');

      // ── Shared: overlay text helper ──
      const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
      const rawOverlay = (clip.video_overlay_text || '').trim();
      function wrapText(txt, max) {
        const words = txt.split(' '), lines = [];
        let line = '';
        for (const w of words) {
          if (line && (line + ' ' + w).length > max) { lines.push(line); line = w; }
          else { line = line ? line + ' ' + w : w; }
        }
        if (line) lines.push(line);
        return lines.join('\n');
      }
      const wrappedOverlay = rawOverlay ? wrapText(rawOverlay, 24) : '';
      const overlayEsc = wrappedOverlay
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\' ")
        .replace(/:/g, '\\:')
        .replace(/\n/g, '\\n');
      const drawTextFilter = overlayEsc
        ? `,drawtext=fontfile=${font}:text='${overlayEsc}':fontsize=52:fontcolor=white:x=(w-text_w)/2:y=80:shadowcolor=black@0.85:shadowx=3:shadowy=3:line_spacing=8`
        : '';
      // Variant 2: overlay text sits below the AFTER label (y=24+76+20=120)
      const drawTextFilterV2 = overlayEsc
        ? `,drawtext=fontfile=${font}:text='${overlayEsc}':fontsize=52:fontcolor=white:x=(w-text_w)/2:y=120:shadowcolor=black@0.85:shadowx=3:shadowy=3:line_spacing=8`
        : '';

      // clip_style DB values: 1 = Style A (static end card), 3 = Style B (composite → rise & wipe)
      const clipStyle = parseInt(clip.clip_style) || 1;
      console.log('[social-clip] id=%d clip_style=%s → clipStyle=%d intro_url=%s', id, clip.clip_style, clipStyle, clip.style_c_intro_url || 'none');

      if (clipStyle === 3) {
        // ── Style 3: Composite → Rise & Wipe ──────────────────────────────
        // Phase 1: composite layout (before top / panel middle / video bottom)
        //          plays for end_card_duration_s seconds using configured before_pct.
        // Phase 2: panel rises from beforeH→0, video follows, fills full screen.
        // Same alphamerge+overlay mechanism as style 2, panel just starts at beforeH.

        const beforeCropped3 = await cropPhoto(await dlBuffer(clip.before_url), clip.before_y_offset, beforeH);
        const beforePadded3  = await sharp({ create: { width: W, height: H, channels: 3, background: { r:0,g:0,b:0 } } })
          .composite([{ input: beforeCropped3, top: 0, left: 0 }])
          .jpeg({ quality: 92 }).toBuffer();
        const beforeWithLabel3 = await sharp(beforePadded3)
          .composite([{ input: makeLabel('BEFORE', W, H), blend: 'over' }])
          .jpeg({ quality: 92 }).toBuffer();
        fs2.writeFileSync(beforeFile, beforeWithLabel3);
        fs2.writeFileSync(panelFile, panelBuf);

        const afterLabelFile3 = pathM.join(tmpDir, 'after_label.png');
        fs2.writeFileSync(afterLabelFile3,
          await sharp({ create: { width: W, height: H, channels: 4, background: { r:0,g:0,b:0,alpha:0 } } })
            .composite([{ input: makeLabel('AFTER', W, H), blend: 'over' }]).png().toBuffer()
        );

        const compShowD = Math.max(0.5, parseFloat(clip.end_card_duration_s) || 4);
        const riseD3    = Math.max(0.1, parseFloat(clip.rise_duration_s)     || 1.0);
        const speed3    = beforeH / riseD3;   // panel travels beforeH px (not H)

        // Panel y: holds at beforeH for compShowD, then rises straight off screen — no pause.
        const panelY3 = `if(lt(t,${compShowD}),${beforeH},${beforeH}-(t-${compShowD})*${speed3})`;

        const maskY3  = `max(0,${panelY3})`;
        const videoY3 = `max(0,${panelY3}+${panelH})`;

        // As video rises from composite slot to full screen, animate the y-offset
        // back to zero so the video fills edge-to-edge with no black gap.
        // In composite: effective offset = afterYOff3 (shows correct portion).
        // Full screen:  effective offset = 0 (video fills from top).
        const afterYOff3 = Math.max(0, Math.min(parseInt(clip.after_y_offset) || 0, H - 10));
        const compositeVideoY = beforeH + panelH; // videoY3 value at composite position
        const videoOverlayY3 = afterYOff3 > 0
          ? `${videoY3}*(1-${(afterYOff3 / compositeVideoY).toFixed(6)})`
          : videoY3;

        // AFTER label is overlaid on the CANVAS at videoY3 (not on the video itself),
        // so it always sits exactly at the top of the after/video section regardless
        // of any after_y_offset shift applied to the video content.
        const filter3 = [
          `color=black:s=${W}x${H}:r=30,fps=30[vc3];`,
          `[0:v]fps=30[vr3];`,
          `[vc3][vr3]overlay=0:'${videoOverlayY3}'[vb3];`,
          `[1:v]fps=30,scale=${W}:${H}[vbr3];`,
          `color=white:s=${W}x${H}:r=30,fps=30[cw3];`,
          `color=black:s=${W}x${H}:r=30,fps=30[cb3];`,
          `[cw3][cb3]overlay=0:'${maskY3}'[mk3];`,
          `[vbr3][mk3]alphamerge[vbf3];`,
          `[2:v]fps=30,scale=${W}:${panelH}[vp3];`,
          `[vb3][vbf3]overlay=0:0[v13];`,
          `[v13][vp3]overlay=0:'${panelY3}'[v23];`,
          `[3:v]fps=30,scale=${W}:${H}[vl3];`,
          `[v23][vl3]overlay=0:'${videoY3}'[vout]`,
        ].join('');

        await new Promise((resolve, reject) => {
          execFile(ffmpegBin, [
            '-y', '-loglevel', 'error',
            '-i', videoFile,
            '-loop', '1', '-t', '999', '-framerate', '30', '-i', beforeFile,
            '-loop', '1', '-t', '999', '-framerate', '30', '-i', panelFile,
            '-loop', '1', '-t', '999', '-framerate', '30', '-i', afterLabelFile3,
            '-filter_complex', filter3,
            '-map', '[vout]', '-map', '0:a?',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k', '-shortest',
            '-movflags', '+faststart',
            outFile,
          ], { timeout: 180000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error('FFmpeg v3: ' + (stderr || err.message).slice(0, 1200)));
            resolve();
          });
        });

      } else if (clipStyle === 4) {
        // ── Style C: after treatment video + user-supplied MP4 ──────────
        if (!clip.style_c_intro_url)
          throw new Error('Style C: style_c_intro_url is not set on this clip');
        const suppliedFile = pathM.join(tmpDir, 'supplied.mp4');
        fs2.writeFileSync(suppliedFile, await dlBuffer(clip.style_c_intro_url));

        // Probe each clip for audio (ffmpeg -i exits with error but prints stream info to stderr)
        const hasAudioSC = (fp) => new Promise(res => {
          execFile(ffmpegBin, ['-i', fp], { timeout: 10000 }, (_e, _o, se) =>
            res((se || '').includes('Audio:'))
          );
        });
        const [v0Audio, v1Audio] = await Promise.all([hasAudioSC(videoFile), hasAudioSC(suppliedFile)]);
        console.log('[social-clip] Style C audio: after=%s supplied=%s', v0Audio, v1Audio);

        const scaleV0 = '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1[v0]';
        const scaleV1 = '[1:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1[v1]';
        const aFmt0   = '[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a0]';
        const aFmt1   = '[1:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a1]';
        let scaleFilter, mapArgs;
        if (v0Audio && v1Audio) {
          scaleFilter = scaleV0+';'+scaleV1+';'+aFmt0+';'+aFmt1+';[v0][a0][v1][a1]concat=n=2:v=1:a=1[vout][aout]';
          mapArgs = ['-map', '[vout]', '-map', '[aout]'];
        } else if (v0Audio) {
          scaleFilter = scaleV0+';'+scaleV1+';[v0][v1]concat=n=2:v=1:a=0[vout]';
          mapArgs = ['-map', '[vout]', '-map', '0:a'];
        } else if (v1Audio) {
          scaleFilter = scaleV0+';'+scaleV1+';[v0][v1]concat=n=2:v=1:a=0[vout]';
          mapArgs = ['-map', '[vout]', '-map', '1:a'];
        } else {
          scaleFilter = scaleV0+';'+scaleV1+';[v0][v1]concat=n=2:v=1:a=0[vout]';
          mapArgs = ['-map', '[vout]'];
        }

        await new Promise((resolve, reject) => {
          execFile(ffmpegBin, [
            '-y', '-loglevel', 'error',
            '-i', videoFile, '-i', suppliedFile,
            '-filter_complex', scaleFilter,
            ...mapArgs,
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            outFile,
          ], { timeout: 180000 }, (err, _o, se) => {
            if (err) return reject(new Error('FFmpeg Style C: ' + (se || err.message).slice(0, 1200)));
            resolve();
          });
        });


      } else {
        // ── Variant 1: static end card concat (original) ──────────────────

        // Before photo (with BEFORE label)
        const beforeCropped = await cropPhoto(await dlBuffer(clip.before_url), clip.before_y_offset, beforeH);
        const beforeFinal = await sharp(beforeCropped)
          .composite([{ input: makeLabel('BEFORE', W, beforeH), blend: 'over' }])
          .jpeg({ quality: 92 }).toBuffer();

        // After portrait (with AFTER label)
        let afterFinal;
        if (clip.after_image_url) {
          const afterCropped = await cropPhoto(await dlBuffer(clip.after_image_url), clip.after_y_offset, afterH);
          afterFinal = await sharp(afterCropped)
            .composite([{ input: makeLabel('AFTER', W, afterH), blend: 'over' }])
            .jpeg({ quality: 92 }).toBuffer();
        } else {
          afterFinal = await sharp({ create: { width: W, height: photoH, channels: 3, background: { r: 20, g: 20, b: 20 } } }).jpeg().toBuffer();
        }

        const composite = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } })
          .composite([
            { input: beforeFinal, top: 0,               left: 0 },
            { input: panelBuf,    top: beforeH,          left: 0 },
            { input: afterFinal,  top: beforeH + panelH, left: 0 },
          ]).jpeg({ quality: 90 }).toBuffer();
        fs2.writeFileSync(endCardFile, composite);

        const endDur = parseFloat(clip.end_card_duration_s) || 4;
        const filter1 = [
          `[0:v]fps=30,scale=1080:1920[vafter];`,
          `[1:v]scale=1080:1920,fps=30,`,
          `fade=t=in:st=0:d=0.3[vendcard];`,
          `[vafter][vendcard]concat=n=2:v=1:a=0[vout]`,
        ].join('');

        await new Promise((resolve, reject) => {
          execFile(ffmpegBin, [
            '-y', '-loglevel', 'error',
            '-i', videoFile,
            '-loop', '1', '-t', String(endDur + 1), '-framerate', '30', '-i', endCardFile,
            '-filter_complex', filter1,
            '-map', '[vout]', '-map', '0:a?',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k', '-shortest',
            '-movflags', '+faststart',
            outFile,
          ], { timeout: 180000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error('FFmpeg: ' + (stderr || err.message).slice(0, 1200)));
            resolve();
          });
        });
      } // end style branch

      // Upload clip + end card to R2 — filename starts with the clip ref
      // (e.g. c38_royal-portrait_dog.mp4) so downloads identify themselves.
      const { uploadBuffer } = require('./storage');
      const clipRef   = clip.ref_tag || ('c' + id);
      const refBase   = [clipRef, clip.action || clip.concept_name, clip.subject].filter(Boolean).join('_');
      const clipBuf = fs2.readFileSync(outFile);
      const r2 = await uploadBuffer({ buffer: clipBuf, contentType: 'video/mp4', kind: 'social-clip', baseName: refBase });
      let endCardR2Url = null;
      try {
        const ecBuf = fs2.existsSync(endCardFile) ? fs2.readFileSync(endCardFile) : null;
        if (ecBuf) {
          const ecR2 = await uploadBuffer({ buffer: ecBuf, contentType: 'image/jpeg', kind: 'social-clip-endcard', baseName: refBase + '_endcard' });
          endCardR2Url = ecR2.url;
        }
      } catch(e2) { console.warn('[social-clip] end card R2 upload failed:', e2.message); }

      await pool.query(
        `UPDATE social_clips SET status='done', output_url=$2, end_card_url=$3, updated_at=now() WHERE id=$1`,
        [id, r2.url, endCardR2Url]
      );
    } catch (e) {
      console.error('[social-clip generate]', e.message);
      await pool.query(`UPDATE social_clips SET status='error', error_msg=$2, updated_at=now() WHERE id=$1`, [id, e.message]);
    } finally {
      require('fs').rmSync(tmpDir, { recursive: true, force: true });
    }
  })();
});

// Publish stub — records intent; actual API calls TBD when channel tokens are configured
app.post('/admin/api/social-clips/:id(\\d+)/publish', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { channels } = req.body; // ['tiktok','instagram','youtube']
  if (!Array.isArray(channels) || channels.length === 0)
    return res.status(400).json({ error: 'channels must be a non-empty array' });
  try {
    const { rows } = await pool.query(`SELECT * FROM social_clips WHERE id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (!rows[0].output_url) return res.status(400).json({ error: 'Clip not generated yet' });
    // TODO: wire up real TikTok / Instagram / YouTube upload APIs
    // For now, mark the columns so the UI shows intent
    const updates = [];
    if (channels.includes('tiktok'))    updates.push(`published_tiktok=TRUE`);
    if (channels.includes('instagram')) updates.push(`published_instagram=TRUE`);
    if (channels.includes('youtube'))   updates.push(`published_youtube=TRUE`);
    if (updates.length) {
      await pool.query(`UPDATE social_clips SET ${updates.join(',')}, updated_at=now() WHERE id=$1`, [id]);
    }
    res.json({ ok: true, note: 'Channel upload APIs not yet wired — marked as published locally.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/api/assets', requireRole('admin'), async (req, res) => {
  try {
    const { table, search, storage, shown_in, limit = 500 } = req.query;
    const lim = Math.min(parseInt(limit) || 500, 2000);
    let rows = [];

    // Build set of concept_media IDs that appear in triplets
    const tripletMediaIds = new Set();
    const tripletRows = await pool.query(
      `SELECT before_media_id, image_media_id, video_media_id FROM concept_triplets WHERE active = TRUE`
    );
    for (const t of tripletRows.rows) {
      if (t.before_media_id) tripletMediaIds.add(t.before_media_id);
      if (t.image_media_id)  tripletMediaIds.add(t.image_media_id);
      if (t.video_media_id)  tripletMediaIds.add(t.video_media_id);
    }

    // Orders — output image
    if (table === 'orders_output' || !table) {
      const r = await pool.query(
        `SELECT id, email, product, status, result_url, output_asset_url, created_at
         FROM orders WHERE result_url IS NOT NULL
         ORDER BY created_at DESC LIMIT $1`, [lim]);
      const mapped = r.rows.map(x => ({
        _type: 'orders_output',
        url: x.output_asset_url || x.result_url,
        owner: x.email,
        name: `${x.product || 'Order'} #${x.id}`,
        shown_in: ['customer_account'],
        meta: { order_id: x.id, product: x.product, status: x.status, date: x.created_at }
      }));
      if (table === 'orders_output') return res.json({ rows: mapped });
      rows = rows.concat(mapped);
    }

    // Orders — output video
    if (table === 'orders_video' || !table) {
      const r = await pool.query(
        `SELECT id, email, product, status, result_video_url, output_video_asset_url, created_at
         FROM orders WHERE result_video_url IS NOT NULL
         ORDER BY created_at DESC LIMIT $1`, [lim]);
      const mapped = r.rows.map(x => ({
        _type: 'orders_video',
        url: x.output_video_asset_url || x.result_video_url,
        owner: x.email,
        name: `${x.product || 'Order'} #${x.id} (video)`,
        shown_in: ['customer_account'],
        meta: { order_id: x.id, product: x.product, status: x.status, date: x.created_at }
      }));
      if (table === 'orders_video') return res.json({ rows: mapped });
      rows = rows.concat(mapped);
    }

    // Orders — input photo (customer uploaded)
    if (table === 'orders_input' || !table) {
      const r = await pool.query(
        `SELECT id, email, input_asset_url, created_at
         FROM orders WHERE input_asset_url IS NOT NULL
         ORDER BY created_at DESC LIMIT $1`, [lim]);
      const mapped = r.rows.map(x => ({
        _type: 'orders_input',
        url: x.input_asset_url,
        owner: x.email,
        name: `Upload for Order #${x.id}`,
        shown_in: [],
        meta: { order_id: x.id, date: x.created_at }
      }));
      if (table === 'orders_input') return res.json({ rows: mapped });
      rows = rows.concat(mapped);
    }

    // Generations
    if (table === 'generations' || !table) {
      const r = await pool.query(
        `SELECT g.id, g.source_type, g.output_url, g.created_at,
                c.name AS concept_name, o.email
         FROM generations g
         LEFT JOIN concepts c ON c.id = g.concept_id
         LEFT JOIN orders o ON o.id = g.order_id
         WHERE g.output_url IS NOT NULL
         ORDER BY g.created_at DESC LIMIT $1`, [lim]);
      const mapped = r.rows.map(x => ({
        _type: 'generations',
        url: x.output_url,
        owner: x.email || x.source_type || 'admin',
        name: `${x.concept_name || 'Generation'} #${x.id}`,
        shown_in: x.source_type === 'customer_order' ? ['customer_account'] : [],
        meta: { gen_id: x.id, source_type: x.source_type, date: x.created_at }
      }));
      if (table === 'generations') return res.json({ rows: mapped });
      rows = rows.concat(mapped);
    }

    // Concept media (gallery)
    if (table === 'concept_media' || !table) {
      const r = await pool.query(
        `SELECT cm.id, cm.concept_id, cm.kind, cm.url, cm.is_primary, cm.active,
                c.name AS concept_name, c.active AS concept_active
         FROM concept_media cm
         LEFT JOIN concepts c ON c.id = cm.concept_id
         WHERE cm.url IS NOT NULL AND cm.active = TRUE
         ORDER BY cm.id DESC LIMIT $1`, [lim]);
      const mapped = r.rows.map(x => {
        const shownIn = [];
        if (x.concept_active) shownIn.push('front_gallery');
        if (tripletMediaIds.has(x.id)) shownIn.push('triplet');
        return {
          _type: 'concept_media',
          url: x.url,
          owner: 'admin',
          name: `${x.concept_name || 'Concept'} — ${x.kind || 'media'} #${x.id}`,
          shown_in: shownIn,
          meta: { media_id: x.id, concept_id: x.concept_id, kind: x.kind, is_primary: x.is_primary }
        };
      });
      if (table === 'concept_media') return res.json({ rows: mapped });
      rows = rows.concat(mapped);
    }

    // Apply filters
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(r => (r.owner||'').toLowerCase().includes(q) || (r.name||'').toLowerCase().includes(q));
    }
    if (storage) {
      rows = rows.filter(r => {
        const u = r.url || '';
        if (storage === 'r2') return !u.includes('cloudinary') && !u.includes('fal.') && !u.includes('fal.run');
        if (storage === 'cloudinary') return u.includes('cloudinary');
        if (storage === 'fal') return u.includes('fal.') || u.includes('fal.run');
        return true;
      });
    }
    if (shown_in) {
      rows = rows.filter(r => (r.shown_in||[]).includes(shown_in));
    }

    res.json({ rows });
  } catch (e) {
    console.error('[admin/assets]', e.message);
    res.status(500).json({ error: e.message });
  }
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
             COALESCE(CASE WHEN g.output_url NOT ILIKE '%fal%' THEN g.output_url END, g.fal_output_url) AS thumb_url,
             g.fal_output_url, g.output_url, g.error_message,
             g.created_at, g.completed_at,
             EXTRACT(EPOCH FROM (g.completed_at - g.created_at))::int AS secs,
             c.name AS concept_name,
             o.email, o.product, o.id AS order_id,
             o.output_asset_url, o.output_video_asset_url,
             COALESCE(o.input_asset_url, g.input_payload->>'photoUrl') AS input_photo_url,
             g.tiktok_thumbnail_url
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



// ── TikTok Thumbnail Generator ─────────────────────────────────────────────
// Extract a frame from the order's output video, overlay the concept name +
// logo, and save a 1080×1920 JPEG to R2. Stored on generations.tiktok_thumbnail_url.
app.post('/admin/api/generations/:id/tiktok-thumbnail', requireRole('admin'), async (req, res) => {
  const os2    = require('os');
  const pathM2 = require('path');
  const fs3    = require('fs');
  const { execFile: execFile2 } = require('child_process');
  const sharp2 = require('sharp');
  const { uploadBuffer: uploadBuf2 } = require('./storage');

  try {
    const { rows } = await pool.query(`
      SELECT g.id, g.output_url, g.fal_output_url, g.tiktok_thumbnail_url,
             c.name AS concept_name,
             o.output_video_asset_url
      FROM generations g
      LEFT JOIN concepts c ON c.id = g.concept_id
      LEFT JOIN orders o ON o.id = g.order_id
      WHERE g.id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const gen = rows[0];

    // Determine video source URL
    const isVidUrl = u => u && /\.(mp4|webm|mov)(\?|$)/i.test(u);
    const videoUrl = gen.output_video_asset_url
      || (isVidUrl(gen.output_url)     ? gen.output_url     : null)
      || (isVidUrl(gen.fal_output_url) ? gen.fal_output_url : null);
    if (!videoUrl) return res.status(400).json({ error: 'No video output found for this generation' });

    const tmpDir    = fs3.mkdtempSync(pathM2.join(os2.tmpdir(), 'tns-thumb-'));
    const videoFile = pathM2.join(tmpDir, 'video.mp4');
    const frameFile = pathM2.join(tmpDir, 'frame.jpg');

    try {
      // Download video to tmp
      const https2  = require('https');
      const http2   = require('http');
      const urlMod2 = require('url');
      const parsed2 = urlMod2.parse(videoUrl);
      const lib2    = parsed2.protocol === 'https:' ? https2 : http2;
      await new Promise((resolve, reject) => {
        const ws = fs3.createWriteStream(videoFile);
        lib2.get(videoUrl, r2 => { r2.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); })
            .on('error', reject);
      });

      // Extract frame at 1.5s
      const ffmpegBin2 = process.env.FFMPEG_PATH || '/tmp/ffmpeg';
      if (!fs3.existsSync(ffmpegBin2)) {
        await new Promise((resolve) => {
          require('child_process').execFile(
            process.execPath, [pathM2.join(__dirname, 'scripts/download-ffmpeg.js')],
            { timeout: 180000 }, () => resolve()
          );
        });
      }
      if (!fs3.existsSync(ffmpegBin2)) throw new Error('FFmpeg unavailable — check FFMPEG_PATH');
      await new Promise((resolve, reject) => {
        execFile2(ffmpegBin2, [
          '-ss', '00:00:01.5',
          '-i', videoFile,
          '-vframes', '1',
          '-q:v', '2',
          '-y', frameFile,
        ], { timeout: 30000 }, (err, _out, stderr) => {
          if (err) reject(new Error('ffmpeg frame: ' + (stderr || err.message).slice(0, 400)));
          else resolve();
        });
      });

      // Composite: frame → logo (bottom-left above bar) + concept name bar (bottom)
      const W = 1080, H = 1920;
      const barH = 180;
      const conceptName = (gen.concept_name || 'Loveogram')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const barSvg = Buffer.from(
        `<svg width="${W}" height="${barH}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="${W}" height="${barH}" fill="#1C2A14" opacity="0.88"/>` +
        `<text x="${W / 2}" y="${Math.round(barH * 0.60)}" font-family="Georgia,serif" font-size="60" font-weight="bold" fill="#FFE800" text-anchor="middle">${conceptName}</text>` +
        `<text x="${W / 2}" y="${Math.round(barH * 0.85)}" font-family="sans-serif" font-size="28" fill="#FBF6EC" text-anchor="middle" opacity="0.75">turtleandsun.com</text>` +
        `</svg>`
      );

      const composites = [{ input: barSvg, top: H - barH, left: 0 }];

      const logoPath = pathM2.join(__dirname, 'public', 'logo.png');
      if (fs3.existsSync(logoPath)) {
        const logoW   = 220;
        const logoBuf = await sharp2(logoPath).resize(logoW).toBuffer();
        const logoMeta = await sharp2(logoBuf).metadata();
        const logoH   = logoMeta.height || 85;
        const logoPad = 28;
        composites.push({ input: logoBuf, top: H - barH - logoH - logoPad, left: logoPad });
      }

      const outBuf = await sharp2(frameFile)
        .resize(W, H, { fit: 'cover', position: 'centre' })
        .composite(composites)
        .jpeg({ quality: 92 })
        .toBuffer();

      // Upload to R2
      const { url } = await uploadBuf2({
        buffer: outBuf,
        contentType: 'image/jpeg',
        kind: 'tiktok-thumbnail',
        originalName: `tiktok-thumb-${gen.id}.jpg`,
      });

      // Persist URL
      await pool.query('UPDATE generations SET tiktok_thumbnail_url=$2 WHERE id=$1', [gen.id, url]);

      res.json({ ok: true, url });
    } finally {
      fs3.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('[tiktok-thumb] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Delete an asset: removes from R2 and clears the DB reference.
// Orders output/video are protected — cannot be deleted.
// Body: { type, id }
// type: 'concept_media' | 'orders_input' | 'generations'
app.delete('/admin/api/assets/:type/:id', requireRole('admin'), async (req, res) => {
  const { type, id } = req.params;
  const numId = parseInt(id);
  if (!numId) return res.status(400).json({ error: 'Invalid id' });

  try {
    if (type === 'concept_media') {
      const r = await pool.query('SELECT url FROM concept_media WHERE id=$1', [numId]);
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      const url = r.rows[0].url;
      await pool.query('DELETE FROM concept_media WHERE id=$1', [numId]);
      if (url && url.includes(process.env.R2_PUBLIC_URL || 'r2')) {
        await deleteFromR2(url).catch(e => console.warn('[delete] R2 concept_media', e.message));
      }
      return res.json({ ok: true });
    }

    if (type === 'orders_input') {
      const r = await pool.query('SELECT input_asset_url FROM orders WHERE id=$1', [numId]);
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      const url = r.rows[0].input_asset_url;
      await pool.query('UPDATE orders SET input_asset_url=NULL WHERE id=$1', [numId]);
      if (url) await deleteFromR2(url).catch(e => console.warn('[delete] R2 orders_input', e.message));
      return res.json({ ok: true });
    }

    if (type === 'generations') {
      const r = await pool.query('SELECT output_url FROM generations WHERE id=$1', [numId]);
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      const url = r.rows[0].output_url;
      await pool.query('DELETE FROM generations WHERE id=$1', [numId]);
      if (url) await deleteFromR2(url).catch(e => console.warn('[delete] R2 generation', e.message));
      return res.json({ ok: true });
    }

    // orders_output and orders_video are protected
    return res.status(403).json({ error: 'Customer Loveograms cannot be deleted.' });
  } catch (e) {
    console.error('[admin/assets delete]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Admin backfill: migrate all fal.ai/Kling URLs to R2
// GET /admin/api/backfill-assets?dry=1  -- preview counts only
// POST /admin/api/backfill-assets       -- run the migration
app.get('/admin/api/backfill-assets', requireRole('admin'), async (req, res) => {
  try {
    const falPattern = '%fal%';
    const externalPattern = '%cloudinary%';
    const anyExt = '%';
    const [orders_img, orders_vid, gens, media, uploads] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM orders WHERE (result_url ILIKE $1 OR result_url ILIKE $2) AND (output_asset_url IS NULL OR output_asset_url ILIKE $1 OR output_asset_url ILIKE $2)`, [falPattern, externalPattern]),
      pool.query(`SELECT COUNT(*) FROM orders WHERE (result_video_url ILIKE $1 OR result_video_url ILIKE $2) AND (output_video_asset_url IS NULL OR output_video_asset_url ILIKE $1 OR output_video_asset_url ILIKE $2)`, [falPattern, externalPattern]),
      pool.query(`SELECT COUNT(*) FROM generations WHERE fal_output_url IS NOT NULL AND (output_url IS NULL OR output_url ILIKE $1 OR output_url ILIKE $2)`, [falPattern, externalPattern]),
      pool.query(`SELECT COUNT(*) FROM concept_media WHERE (url ILIKE $1 OR url ILIKE $2) AND active = TRUE`, [falPattern, externalPattern]),
      pool.query(`SELECT COUNT(*) FROM orders WHERE input_asset_url ILIKE $1`, [externalPattern]),
    ]);
    res.json({
      orders_images_pending: parseInt(orders_img.rows[0].count),
      orders_videos_pending: parseInt(orders_vid.rows[0].count),
      generations_pending: parseInt(gens.rows[0].count),
      concept_media_pending: parseInt(media.rows[0].count),
      source_photos_on_cloudinary: parseInt(uploads.rows[0].count),
      message: 'POST to this endpoint to run the backfill'
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/api/backfill-assets', requireRole('admin'), async (req, res) => {
  res.json({ ok: true, message: 'Backfill started in background — check server logs' });
  // Run async
  (async () => {
    let done = 0, failed = 0;
    const falPattern = '%fal%';

    // 1. Order images
    const { rows: imgRows } = await pool.query(
      `SELECT id, result_url FROM orders WHERE result_url ILIKE $1 AND (output_asset_url IS NULL OR output_asset_url ILIKE $1) LIMIT 200`,
      [falPattern]
    );
    for (const o of imgRows) {
      try {
        const r2 = await downloadAndStore({ remoteUrl: o.result_url, kind: 'order', orderId: o.id });
        await pool.query('UPDATE orders SET output_asset_url=$1, asset_status=$2 WHERE id=$3', [r2.url, 'stored', o.id]);
        done++;
        console.log('[backfill] order image', o.id, '->', r2.url);
      } catch(e) { failed++; console.warn('[backfill] order image', o.id, 'failed:', e.message); }
    }

    // 2. Order videos
    const { rows: vidRows } = await pool.query(
      `SELECT id, result_video_url FROM orders WHERE result_video_url ILIKE $1 AND (output_video_asset_url IS NULL OR output_video_asset_url ILIKE $1) LIMIT 200`,
      [falPattern]
    );
    for (const o of vidRows) {
      try {
        const r2 = await downloadAndStore({ remoteUrl: o.result_video_url, kind: 'order', orderId: o.id });
        await pool.query('UPDATE orders SET output_video_asset_url=$1, asset_status=$2 WHERE id=$3', [r2.url, 'stored', o.id]);
        done++;
        console.log('[backfill] order video', o.id, '->', r2.url);
      } catch(e) { failed++; console.warn('[backfill] order video', o.id, 'failed:', e.message); }
    }

    // 3. Generations
    const { rows: genRows } = await pool.query(
      `SELECT id, fal_output_url FROM generations WHERE fal_output_url IS NOT NULL AND (output_url IS NULL OR output_url ILIKE $1) LIMIT 500`,
      [falPattern]
    );
    for (const g of genRows) {
      try {
        const r2 = await downloadAndStore({ remoteUrl: g.fal_output_url, kind: 'order' });
        await pool.query('UPDATE generations SET output_url=$1 WHERE id=$2', [r2.url, g.id]);
        done++;
        console.log('[backfill] generation', g.id, '->', r2.url);
      } catch(e) { failed++; console.warn('[backfill] generation', g.id, 'failed:', e.message); }
    }

    // 4. Concept media (gallery showcase images)
    const { rows: mediaRows } = await pool.query(
      `SELECT id, url, kind FROM concept_media WHERE (url ILIKE $1 OR url ILIKE $2) AND active = TRUE LIMIT 200`,
      [falPattern, '%cloudinary%']
    );
    for (const m of mediaRows) {
      try {
        const isVid = m.kind === 'video' || /\.(mp4|webm|mov)($|\?)/.test(m.url);
        const r2 = await downloadAndStore({ remoteUrl: m.url, kind: 'concept_media' });
        await pool.query('UPDATE concept_media SET url=$1 WHERE id=$2', [r2.url, m.id]);
        done++;
        console.log('[backfill] concept_media', m.id, '->', r2.url);
      } catch(e) { failed++; console.warn('[backfill] concept_media', m.id, 'failed:', e.message); }
    }

    console.log(`[backfill] complete: ${done} migrated, ${failed} failed`);
  })().catch(e => console.error('[backfill] fatal:', e.message));
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
<script src="/nav.js?v=20260611b"></script>
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

app.get('/admin/concepts', requireRole('admin'), (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-concepts.html'));
});

app.get('/admin/api/concepts/list', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, slug, name, filter_category, subject, occasion, action, mood,
              description, active, sort_order
       FROM concepts ORDER BY sort_order ASC, id ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[concepts] list error:', err.message);
    res.status(500).json({ error: 'Failed' });
  }
});

// Lightweight endpoint the form iframe navigates to after a successful save
app.get('/admin/concept-saved', requireRole('admin'), (req, res) => {
  res.send('<script>window.parent.postMessage({type:"concept-saved"},location.origin);<\/script>');
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
        <div class="field"><label>Subject *</label><input type="text" name="subject" list="dl-subject" value="${v('subject') || 'pet'}" required>
          <datalist id="dl-subject"><option value="pet"><option value="dog"><option value="cat"><option value="human"><option value="family"><option value="other"></datalist>
          <span class="muted">Who is in the photo.</span></div>
        <div class="field"><label>Occasion *</label><input type="text" name="occasion" list="dl-occasion" value="${v('occasion') || 'general'}" required>
          <datalist id="dl-occasion"><option value="general"><option value="birthday"><option value="fathers-day"><option value="mothers-day"><option value="name-day"><option value="christmas"><option value="valentines"><option value="easter"><option value="graduation"><option value="memorial"></datalist>
          <span class="muted">Why you'd send it.</span></div>
        <div class="field"><label>Action *</label><input type="text" name="action" list="dl-action" value="${v('action') || 'royal-portrait'}" required>
          <datalist id="dl-action"><option value="royal-portrait"><option value="talking"><option value="singing"><option value="gift-giving"><option value="dancing"></datalist>
          <span class="muted">What happens in the result. These three drive the landing filters, the picker, and the demo.</span></div>
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
  res.sendFile(path.join(__dirname, 'admin-concept-form.html'));
});

app.get('/admin/concepts/edit/:id', requireRole('admin'), (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-concept-form.html'));
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
    const normDim = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '-');
    const dimSubject  = normDim(req.body.subject)  || 'pet';
    const dimOccasion = normDim(req.body.occasion) || 'general';
    const dimAction   = normDim(req.body.action)   || 'royal-portrait';
    const dimMood     = normDim(req.body.mood)     || 'heartfelt';
    // filter_category is derived — single source of truth is the three dimensions
    const filterCategory = [dimSubject, dimOccasion, dimAction].join(', ');
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

    // Auto-generate name and slug from dimensions if not supplied by the new form
    const effectiveName = name || [dimSubject, dimOccasion, dimAction].join(' · ');
    const slugBase = (dimSubject + '-' + dimOccasion + '-' + dimAction)
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const effectiveSlug = slug ||
      (editId ? slugBase + '-' + String(editId) : slugBase + '-' + String(Date.now()));
    if (!filterCategory) return fail('Subject, occasion, and action are required.');
    if (!imagePrompt && !videoPrompt) return fail('Prompt is required.');

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

    const dup = await pool.query('SELECT id FROM concepts WHERE slug = $1 AND id <> $2', [effectiveSlug, editId || 0]);
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
           subject = $27, occasion = $28, action = $29, mood = $30,
           updated_at = NOW()
         WHERE id = $26`,
        [effectiveSlug, effectiveName, filterCategory, inputType, beforeUrl, afterUrl, videoUrl,
         imagePrompt, videoPrompt, falImage, falVideo, socialCaption, active, sortOrder,
         userInputEnabled, userInputLabel, userInputPlaceholder, userInputVariable, userInputMaxLength,
         imageInputExtras, videoInputExtras, description,
         priceTier, unitPriceSekMinor, pricingRules,
         editId, dimSubject, dimOccasion, dimAction, dimMood]
      );
    } else {
      await pool.query(
        `INSERT INTO concepts
           (slug, name, filter_category, input_type, before_image_url, after_image_url, example_video_url,
            image_prompt, video_prompt, fal_image_model, fal_video_model, social_caption, active, sort_order,
            user_input_enabled, user_input_label, user_input_placeholder, user_input_variable, user_input_max_length,
            image_input_extras, video_input_extras, description,
            price_tier, unit_price_sek_minor, pricing_rules,
            subject, occasion, action, mood)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`,
        [effectiveSlug, effectiveName, filterCategory, inputType, beforeUrl, afterUrl, videoUrl,
         imagePrompt, videoPrompt, falImage, falVideo, socialCaption, active, sortOrder,
         userInputEnabled, userInputLabel, userInputPlaceholder, userInputVariable, userInputMaxLength,
         imageInputExtras, videoInputExtras, description,
         priceTier, unitPriceSekMinor, pricingRules,
         dimSubject, dimOccasion, dimAction, dimMood]
      );
    }
    res.redirect('/admin/concept-saved');
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
// Concept form meta — model registry for the new concept admin form
// ---------------------------------------------------------------------------
app.get('/admin/api/concepts/form-meta', requireRole('admin'), async (req, res) => {
  try {
    const models = {};
    Object.entries(generation.MODELS).forEach(([id, m]) => {
      models[id] = { kind: m.kind, label: m.label, description: m.description || '', fields: m.fields || [] };
    });
    const [subj, occ, act, moo] = await Promise.all([
      pool.query('SELECT DISTINCT subject  FROM concepts WHERE subject  IS NOT NULL ORDER BY subject'),
      pool.query('SELECT DISTINCT occasion FROM concepts WHERE occasion IS NOT NULL ORDER BY occasion'),
      pool.query('SELECT DISTINCT action   FROM concepts WHERE action   IS NOT NULL ORDER BY action'),
      pool.query('SELECT DISTINCT mood     FROM concepts WHERE mood     IS NOT NULL ORDER BY mood'),
    ]);
    res.json({
      models,
      subjects:  subj.rows.map(r => r.subject),
      occasions: occ.rows.map(r => r.occasion),
      actions:   act.rows.map(r => r.action),
      moods:     moo.rows.map(r => r.mood),
    });
  } catch (err) {
    console.error('[form-meta] error:', err.message);
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/admin/api/concepts/:id(\\d+)/json', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM concepts WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[concepts/json] error:', err.message);
    res.status(500).json({ error: 'Failed' });
  }
});

// ---------------------------------------------------------------------------
// Samples API — concept triplets management from admin-concepts grid
// ---------------------------------------------------------------------------
app.get('/admin/api/concepts/:id/samples', requireRole('admin'), async (req, res) => {
  try {
    const conceptId = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      `SELECT t.id, t.triplet_number, t.sort_order, t.active,
              t.in_rolling_demo, t.in_gallery, t.caption,
              bm.url AS before_url, bm.id AS before_media_id,
              im.url AS image_url,  im.id AS image_media_id,
              vm.url AS video_url,  vm.id AS video_media_id,
              (SELECT COUNT(*)::int FROM social_clips sc WHERE sc.triplet_id = t.id) AS clip_count,
              (SELECT sc2.id FROM social_clips sc2 WHERE sc2.triplet_id = t.id ORDER BY sc2.created_at DESC LIMIT 1) AS clip_id
       FROM concept_triplets t
       LEFT JOIN concept_media bm ON bm.id = t.before_media_id
       LEFT JOIN concept_media im ON im.id = t.image_media_id
       LEFT JOIN concept_media vm ON vm.id = t.video_media_id
       WHERE t.concept_id = $1
       ORDER BY t.sort_order ASC, t.triplet_number ASC`,
      [conceptId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[samples] list error:', err.message);
    res.status(500).json({ error: 'Failed' });
  }
});

// Add a sample triplet. Accepts either media IDs (from drag-and-drop) or URLs.
// Body: { before_media_id, after_media_id, after_type } OR { before_url, after_url, after_type }
app.post('/admin/api/concepts/:id/samples/add', requireRole('admin'), async (req, res) => {
  try {
    const conceptId = parseInt(req.params.id, 10);
    if (!conceptId) return res.status(400).json({ error: 'Bad concept id' });
    const caption   = (req.body.caption || '').trim() || null;

    let beforeMediaId = req.body.before_media_id ? parseInt(req.body.before_media_id, 10) : null;
    let afterMediaId  = req.body.after_media_id  ? parseInt(req.body.after_media_id,  10) : null;
    const afterType   = req.body.after_type === 'video' ? 'video' : 'image';

    // Fallback: create media records from URLs if IDs not provided
    if (!beforeMediaId) {
      const beforeUrl = (req.body.before_url || '').trim();
      if (!beforeUrl) return res.status(400).json({ error: 'before_media_id or before_url required' });
      const bm = await pool.query(
        `INSERT INTO concept_media (concept_id, kind, url, sort_order) VALUES ($1, 'image', $2, 0) RETURNING id`,
        [conceptId, beforeUrl]
      );
      beforeMediaId = bm.rows[0].id;
    }
    if (!afterMediaId) {
      const afterUrl = (req.body.after_url || '').trim();
      if (!afterUrl) return res.status(400).json({ error: 'after_media_id or after_url required' });
      const am = await pool.query(
        `INSERT INTO concept_media (concept_id, kind, url, sort_order) VALUES ($1, $2, $3, 0) RETURNING id`,
        [conceptId, afterType, afterUrl]
      );
      afterMediaId = am.rows[0].id;
    }

    const existing = await pool.query(
      `SELECT triplet_number FROM concept_triplets WHERE concept_id = $1 ORDER BY triplet_number ASC`,
      [conceptId]
    );
    const taken = new Set(existing.rows.map(r => r.triplet_number));
    let n = 1;
    while (taken.has(n)) n++;

    const imageMediaId = afterType === 'image' ? afterMediaId : null;
    const videoMediaId = afterType === 'video' ? afterMediaId : null;

    await pool.query(
      `INSERT INTO concept_triplets
         (concept_id, triplet_number, sort_order, before_media_id, image_media_id, video_media_id, caption)
       VALUES ($1, $2, 0, $3, $4, $5, $6)`,
      [conceptId, n, beforeMediaId, imageMediaId, videoMediaId, caption]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[samples] add error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete a sample triplet.
app.post('/admin/api/concepts/:id/samples/:sampleId/delete', requireRole('admin'), async (req, res) => {
  try {
    const sampleId = parseInt(req.params.sampleId, 10);
    await pool.query(`DELETE FROM concept_triplets WHERE id = $1`, [sampleId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[samples] delete error:', err.message);
    res.status(500).json({ error: err.message });
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
              cm.active, cm.filter_category, cm.subject, cm.source_url, c.name AS concept_name, c.subject AS concept_subject
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
          <label title="SUBJECT — what species/who is in THIS example (dog, cat, human, parrot…). Drives the Subject filter on the landing gallery. Leave empty to inherit the concept's subject.">Subject <input type="text" name="subject" value="${escapeHtml(m.subject || '')}" placeholder="inherit (${escapeHtml(m.concept_subject || 'pet')})"></label>
          <label title="FILTERS — legacy comma-separated tags (kept for back-compat).">Filters <input type="text" name="filter_category" value="${escapeHtml(m.filter_category || '')}" placeholder="e.g. pet, royal"></label>
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
    const mediaSubject = req.body.subject == null ? null : (String(req.body.subject).trim().toLowerCase().replace(/\s+/g, '-') || null);
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
         source_url = $7,
         subject = $10
       WHERE id = $8`,
      [caption, kind, sortOrder, isPrimary, active, filterCategory, sourceUrl, mediaId, conceptId, mediaSubject]
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

// General download proxy for customer assets — serves R2 files with
// Content-Disposition: attachment so Chrome enterprise policies don't block them.
// Only allows URLs from our own R2 bucket.
// Save an uploaded photo to the account archive without creating a Loveogram
app.post('/api/account/archive-photo', requireAuth, async (req, res) => {
  try {
    const { url, filename } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    await pool.query(
      `INSERT INTO orders (email, product, status, input_asset_url, output_asset_url, asset_status, amount)
       VALUES ($1, 'archive', 'archive', $2, $2, 'stored', 0)`,
      [req.user.email, url]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/account/order/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query('DELETE FROM orders WHERE id=$1 AND email=$2', [id, req.user.email]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/download', requireAuth, async (req, res) => {
  const url = String(req.query.url || '');
  const filename = String(req.query.filename || 'loveogram');
  const R2_PUBLIC = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
  // Security: only proxy trusted asset domains
  const trusted = !url ? false : (
    (R2_PUBLIC && url.startsWith(R2_PUBLIC)) ||
    url.includes('.r2.dev/') ||
    url.includes('cloudinary.com') ||
    url.includes('fal.media') ||
    url.includes('fal.run') ||
    url.includes('v3.fal.media') ||
    url.includes('storage.googleapis.com')
  );
  if (!trusted) return res.status(403).send('Forbidden');
  try {
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(502).send('Upstream error');
    const ext = url.split('?')[0].split('.').pop().toLowerCase();
    const mime = ext === 'mp4' ? 'video/mp4' : ext === 'webm' ? 'video/webm' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g,'')}"`);
    if (upstream.headers.get('content-length')) res.setHeader('Content-Length', upstream.headers.get('content-length'));
    const reader = upstream.body.getReader();
    res.on('close', () => { try { reader.cancel(); } catch(e){} });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch(e) { res.status(500).send('Download failed: ' + e.message); }
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

// ============================================================

// POST /admin/api/tracker/clips/:id/save-youtube-meta
app.post('/admin/api/tracker/clips/:id/save-youtube-meta', requireRole('admin'), async (req, res) => {
  try {
    const { yt_title, yt_description, yt_keyword_tags } = req.body;
    await pool.query(
      'UPDATE social_clips SET yt_title=$2, yt_description=$3, yt_keyword_tags=$4, updated_at=NOW() WHERE id=$1',
      [req.params.id, yt_title||null, yt_description||null, yt_keyword_tags||null]
    );
    res.json({ ok: true });
  } catch(e) {
    console.error('[save-youtube-meta]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/api/tracker/clips/:id/sync-youtube
app.post('/admin/api/tracker/clips/:id/sync-youtube', requireRole('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { posted_at, post_url, yt_video_id, yt_title, yt_description, yt_keyword_tags } = req.body;
    if (!yt_video_id) return res.status(400).json({ error: 'No YouTube video ID set' });
    // Save to DB
    await pool.query(
      'UPDATE social_clips SET yt_posted_at=$2, yt_post_url=$3, yt_title=$4, yt_description=$5, yt_keyword_tags=$6, yt_video_id=$7, updated_at=NOW() WHERE id=$1',
      [id, posted_at||null, post_url||null, yt_title||null, yt_description||null, yt_keyword_tags||null, yt_video_id]
    );
    // Push to YouTube Data API v3 videos.update
    const token = await getYouTubeAccessToken();
    const https5 = require('https');
    const tags = yt_keyword_tags ? yt_keyword_tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    const ytBody = JSON.stringify({ id: yt_video_id, snippet: { title: yt_title||'', description: yt_description||'', tags, categoryId: '22' } });
    const ytRes = await new Promise((resolve, reject) => {
      const req2 = https5.request({
        hostname: 'www.googleapis.com', path: '/youtube/v3/videos?part=snippet', method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ytBody) }
      }, r => {
        let b = ''; r.on('data', c => b += c);
        r.on('end', () => { try { resolve({ status: r.statusCode, body: JSON.parse(b) }); } catch(e) { reject(e); } });
      });
      req2.on('error', reject); req2.write(ytBody); req2.end();
    });
    if (ytRes.status !== 200) {
      const msg = (ytRes.body.error && ytRes.body.error.message) || JSON.stringify(ytRes.body);
      return res.status(502).json({ error: 'YouTube API error: ' + msg });
    }
    res.json({ ok: true, title: ytRes.body.snippet && ytRes.body.snippet.title });
  } catch (e) {
    console.error('[sync-youtube]', e.message);
    res.status(500).json({ error: e.message });
  }
});
// GET /admin/api/tracker/clips/:id/youtube-live -- fetch live snippet from YouTube API
app.get('/admin/api/tracker/clips/:id/youtube-live', requireRole('admin'), async (req, res) => {
  try {
    const YT_KEY = process.env.YOUTUBE_API_KEY;
    if (!YT_KEY) return res.status(400).json({ error: 'YOUTUBE_API_KEY not set' });
    const { rows } = await pool.query('SELECT yt_video_id FROM social_clips WHERE id=$1', [parseInt(req.params.id)]);
    if (!rows.length || !rows[0].yt_video_id) return res.status(400).json({ error: 'No YouTube video ID for this clip' });
    const vidId = rows[0].yt_video_id;
    const https6 = require('https');
    const url6 = 'https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=' + encodeURIComponent(vidId) + '&key=' + YT_KEY;
    const data = await new Promise((resolve, reject) => {
      https6.get(url6, r => {
        let b = ''; r.on('data', c => b += c);
        r.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
    const item = (data.items || [])[0];
    if (!item) return res.status(404).json({ error: 'Video not found on YouTube' });
    const sn = item.snippet || {};
    // Also sync publishedAt to our DB
    if (sn.publishedAt || sn.title) {
      await pool.query(
        'UPDATE social_clips SET yt_posted_at=$2, yt_title=$3, yt_description=$4, yt_keyword_tags=$5, updated_at=NOW() WHERE id=$1',
        [parseInt(req.params.id), sn.publishedAt ? sn.publishedAt.slice(0,10) : null,
         sn.title || null, sn.description || null, (sn.tags||[]).join(', ') || null]
      );
    }
    const st = item.statistics || {};
    res.json({
      video_id:     vidId,
      title:        sn.title || '',
      description:  sn.description || '',
      tags:         (sn.tags || []).join(', '),
      published_at: sn.publishedAt ? sn.publishedAt.slice(0,10) : null,
      url:          'https://www.youtube.com/shorts/' + vidId,
      thumbnail:    sn.thumbnails && sn.thumbnails.default && sn.thumbnails.default.url,
      views:        parseInt(st.viewCount)   || 0,
      likes:        parseInt(st.likeCount)   || 0,
      comments:     parseInt(st.commentCount)|| 0,
    });
  } catch(e) {
    console.error('[youtube-live]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/api/tracker/sync-dates
app.post('/admin/api/tracker/sync-dates', requireRole('admin'), async (req, res) => {
  try {
    const YT_KEY = process.env.YOUTUBE_API_KEY;
    if (!YT_KEY) return res.status(400).json({ error: 'YOUTUBE_API_KEY not set' });
    const { rows } = await pool.query("SELECT id, yt_video_id FROM social_clips WHERE yt_video_id IS NOT NULL AND yt_video_id <> ''");
    if (!rows.length) return res.json({ updated: 0 });
    const https7 = require('https');
    let updated = 0;
    for (let i = 0; i < rows.length; i += 50) {
      const batch = rows.slice(i, i + 50);
      const ids = batch.map(r => encodeURIComponent(r.yt_video_id)).join(',');
      const url7 = 'https://www.googleapis.com/youtube/v3/videos?part=snippet&id=' + ids + '&key=' + YT_KEY;
      const data = await new Promise((resolve, reject) => {
        https7.get(url7, r => { let b=''; r.on('data',c=>b+=c); r.on('end',()=>{ try{resolve(JSON.parse(b));}catch(e){reject(e);} }); }).on('error',reject);
      });
      const byId = {};
      for (const item of (data.items||[])) byId[item.id] = item.snippet && item.snippet.publishedAt ? item.snippet.publishedAt.slice(0,10) : null;
      for (const clip of batch) {
        const pub = byId[clip.yt_video_id];
        if (!pub) continue;
        await pool.query('UPDATE social_clips SET yt_posted_at=$2, updated_at=NOW() WHERE id=$1', [clip.id, pub]);
        updated++;
      }
    }
    res.json({ ok: true, updated });
  } catch(e) {
    console.error('[sync-dates]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Social Tracker API -- /admin/api/tracker/*
// Backed by social_clips + clip_stats (merged 2026-06-05).
// ============================================================

// GET /admin/api/tracker/clips -- list all clips with latest stats
app.get('/admin/api/tracker/clips', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        sc.id,
        COALESCE(sc.concept_name, c.name, '') AS concept,
        sc.ref_tag, sc.subject, sc.subject_name, sc.occasion,
        sc.style, sc.mood, sc.notes,
        COALESCE(sc.custom_tags, '{}') AS custom_tags,
        sc.output_url,
        sc.yt_video_id,
        sc.yt_title,
        sc.yt_description,
        sc.yt_keyword_tags,
        sc.yt_post_url,
        sc.yt_posted_at,
        sc.facebook_video_id,
        sc.fb_post_url,
        sc.fb_caption,
        sc.tiktok_posted_at,
        sc.tiktok_post_url,
        sc.instagram_posted_at,
        sc.fb_posted_at,
        sc.yt_scheduled_at,
        sc.tiktok_planned_at, sc.instagram_planned_at, sc.yt_planned_at, sc.fb_planned_at,
        sc.created_at,
        (sc.tiktok_posted_at IS NOT NULL OR sc.published_tiktok)      AS tiktok_posted,
        (sc.instagram_posted_at IS NOT NULL OR sc.published_instagram) AS instagram_posted,
        (sc.yt_posted_at IS NOT NULL OR sc.published_youtube)          AS youtube_posted,
        (sc.fb_posted_at IS NOT NULL OR sc.published_facebook)         AS facebook_posted,
        COALESCE(tt.views, sc.tiktok_views, 0)    AS tiktok_views,
        COALESCE(ig.views, sc.instagram_views, 0) AS instagram_views,
        COALESCE(yt.views, sc.youtube_views, 0)   AS youtube_views,
        COALESCE(fb.views, sc.facebook_views, 0)  AS facebook_views,
        COALESCE(tt.likes, 0) AS tiktok_likes,
        COALESCE(ig.likes, 0) AS instagram_likes,
        COALESCE(yt.likes, 0) AS youtube_likes,
        COALESCE(fb.likes, 0) AS facebook_likes
      FROM social_clips sc
      LEFT JOIN concepts c ON c.id = sc.concept_id
      LEFT JOIN LATERAL (
        SELECT views, likes FROM clip_stats WHERE social_clip_id=sc.id AND platform='tiktok'
        ORDER BY stat_date DESC LIMIT 1
      ) tt ON TRUE
      LEFT JOIN LATERAL (
        SELECT views, likes FROM clip_stats WHERE social_clip_id=sc.id AND platform='instagram'
        ORDER BY stat_date DESC LIMIT 1
      ) ig ON TRUE
      LEFT JOIN LATERAL (
        SELECT views, likes FROM clip_stats WHERE social_clip_id=sc.id AND platform='youtube'
        ORDER BY stat_date DESC LIMIT 1
      ) yt ON TRUE
      LEFT JOIN LATERAL (
        SELECT views, likes FROM clip_stats WHERE social_clip_id=sc.id AND platform='facebook'
        ORDER BY stat_date DESC LIMIT 1
      ) fb ON TRUE
      ORDER BY sc.created_at DESC
      LIMIT 500
    `);
    res.json({ rows });
  } catch (e) {
    console.error('[tracker/clips/list]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// TikTok follower count (scraped by the Chrome extension from the profile
// page) -> channel_daily_stats, same table the YouTube channel cron feeds.
app.post('/admin/api/tracker/tiktok-followers', requireRole('admin'), async (req, res) => {
  try {
    const followers = parseInt(req.body?.followers, 10);
    if (!Number.isFinite(followers) || followers < 0) {
      return res.status(400).json({ error: 'followers must be a non-negative number' });
    }
    // Within one day, keep the highest reading — protects the real number
    // from a flaky zero scrape. Genuine declines still show across days.
    await pool.query(`
      INSERT INTO channel_daily_stats (platform, stat_date, subscribers)
      VALUES ('tiktok', CURRENT_DATE, $1)
      ON CONFLICT (platform, stat_date)
      DO UPDATE SET subscribers = GREATEST(channel_daily_stats.subscribers, EXCLUDED.subscribers)`,
      [followers]);
    res.json({ ok: true, followers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Diagnostic: the raw identity of every visit currently counted as a funnel
// click — so suspicious survivors can be inspected instead of guessed at.
app.get('/admin/api/tracker/ref-visits', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT v.created_at, v.ref, v.src, v.ip, v.country, v.city,
             v.user_agent, v.asn_org, v.engaged, v.dwell_ms, v.path
      FROM visits v
      WHERE v.ref IS NOT NULL
        AND ${HUMAN_CLICK_WHERE}
      ORDER BY v.created_at DESC
      LIMIT 100`);
    res.json({ count: rows.length, visits: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /admin/api/tracker/clicks -- click counts per clip (loaded async by the UI)
app.get('/admin/api/tracker/clicks', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT sc.id,
             COUNT(v.*)::int AS clicks,
             COUNT(*) FILTER (WHERE v.src = 'yt')::int AS clicks_youtube,
             COUNT(*) FILTER (WHERE v.src = 'tt')::int AS clicks_tiktok,
             COUNT(*) FILTER (WHERE v.src = 'ig')::int AS clicks_instagram,
             COUNT(*) FILTER (WHERE v.src = 'fb')::int AS clicks_facebook
      FROM social_clips sc
      JOIN visits v ON v.ref = sc.ref_tag
      WHERE sc.ref_tag IS NOT NULL
        AND ${HUMAN_CLICK_WHERE}
      GROUP BY sc.id
    `);
    const { rows: fe } = await pool.query(`
      SELECT sc.id,
             COUNT(*) FILTER (WHERE f.kind = 'preview')::int  AS previews,
             COUNT(*) FILTER (WHERE f.kind = 'purchase')::int AS purchases
      FROM social_clips sc
      JOIN funnel_events f ON f.ref = sc.ref_tag
      WHERE sc.ref_tag IS NOT NULL
      GROUP BY sc.id
    `);
    const feMap = {};
    fe.forEach(r => feMap[r.id] = r);
    rows.forEach(r => { const m = feMap[r.id]; r.previews = m ? m.previews : 0; r.purchases = m ? m.purchases : 0; });
    // Clips with funnel events but no visits yet
    fe.forEach(r => { if (!rows.find(x => x.id === r.id)) rows.push({ id: r.id, clicks: 0, clicks_youtube: 0, clicks_tiktok: 0, clicks_instagram: 0, clicks_facebook: 0, previews: r.previews, purchases: r.purchases }); });
    res.json({ rows });
  } catch (e) {
    console.error('[tracker/clicks]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/api/funnel/reset -- wipe tagged visits + funnel events (clears test data)
app.post('/admin/api/funnel/reset', requireRole('admin'), async (req, res) => {
  try {
    const v = await pool.query('DELETE FROM visits WHERE ref IS NOT NULL OR src IS NOT NULL');
    const f = await pool.query('DELETE FROM funnel_events');
    res.json({ ok: true, visits_deleted: v.rowCount, funnel_events_deleted: f.rowCount });
  } catch (e) {
    console.error('[funnel/reset]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/api/tracker/clips/:id/visits-daily -- one clip's visits per day per platform
app.get('/admin/api/tracker/clips/:id(\\d+)/visits-daily', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT v.created_at::date::text AS stat_date,
             CASE v.src WHEN 'yt' THEN 'youtube' WHEN 'tt' THEN 'tiktok'
                        WHEN 'ig' THEN 'instagram' WHEN 'fb' THEN 'facebook' ELSE 'other' END AS platform,
             COUNT(*)::int AS visits
      FROM visits v
      JOIN social_clips sc ON v.ref = sc.ref_tag
      WHERE sc.id = $1 AND v.src IS NOT NULL
      GROUP BY 1, 2
      ORDER BY 1
    `, [parseInt(req.params.id)]);
    res.json({ rows });
  } catch (e) {
    console.error('[tracker/visits-daily]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/api/tracker/clicks-daily -- clicks per day per platform (summary chart)
app.get('/admin/api/tracker/clicks-daily', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT created_at::date::text AS stat_date,
             CASE src WHEN 'yt' THEN 'youtube' WHEN 'tt' THEN 'tiktok'
                      WHEN 'ig' THEN 'instagram' WHEN 'fb' THEN 'facebook' END AS platform,
             COUNT(*)::int AS clicks
      FROM visits
      WHERE src IN ('yt','tt','ig','fb')
      GROUP BY 1, 2
      ORDER BY 1
    `);
    res.json({ rows });
  } catch (e) {
    console.error('[tracker/clicks-daily]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/api/tracker/clips -- create a new tracker clip (no triplet required)
app.post('/admin/api/tracker/clips', requireRole('admin'), async (req, res) => {
  try {
    const { concept, ref_tag, subject, subject_name, occasion, style, mood, custom_tags, notes } = req.body;
    if (!concept || !String(concept).trim()) return res.status(400).json({ error: 'concept is required' });
    if (!ref_tag  || !String(ref_tag).trim())  return res.status(400).json({ error: 'ref_tag is required' });
    const { rows } = await pool.query(
      `INSERT INTO social_clips
        (concept_name, ref_tag, subject, subject_name, occasion, style, mood, custom_tags, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'done')
       RETURNING id, concept_name AS concept, ref_tag, created_at`,
      [
        concept.trim(), ref_tag.trim(),
        subject || null, subject_name || null, occasion || null,
        style || null, mood || null,
        Array.isArray(custom_tags) ? custom_tags : [],
        notes || null,
      ]
    );
    res.json({ clip: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A clip with that ref_tag already exists' });
    console.error('[tracker/clips/create]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT /admin/api/tracker/clips/:id -- update metadata
app.put('/admin/api/tracker/clips/:id', requireRole('admin'), async (req, res) => {
  try {
    const { concept, ref_tag, subject, subject_name, occasion, style, mood, custom_tags, notes } = req.body;
    await pool.query(
      `UPDATE social_clips SET
        concept_name = COALESCE($2, concept_name),
        ref_tag      = COALESCE($3, ref_tag),
        subject      = $4,
        subject_name = $5,
        occasion     = $6,
        style        = $7,
        mood         = $8,
        custom_tags  = COALESCE($9, custom_tags),
        notes        = $10,
        updated_at   = NOW()
       WHERE id = $1`,
      [
        parseInt(req.params.id),
        concept || null, ref_tag || null,
        subject || null, subject_name || null, occasion || null,
        style || null, mood || null,
        Array.isArray(custom_tags) ? custom_tags : null,
        notes || null,
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /admin/api/tracker/clips/:id
// GET /admin/api/tracker/stats-grid?platform=youtube&month=2026-06
// Per-clip, per-day view snapshots for one platform/month + the last
// snapshot before the month (baseline for day-1 daily deltas).
app.get('/admin/api/tracker/stats-grid', requireRole('admin'), async (req, res) => {
  const platform = ['tiktok','instagram','youtube','facebook'].includes(String(req.query.platform)) ? req.query.platform : 'youtube';
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : new Date().toISOString().slice(0, 7);
  try {
    const start = month + '-01';
    const { rows: stats } = await pool.query(
      `SELECT social_clip_id AS clip_id, stat_date::text AS date, views, likes, comments, shares, source
       FROM clip_stats
       WHERE platform = $1 AND stat_date >= $2::date AND stat_date < ($2::date + interval '1 month')
       ORDER BY social_clip_id, stat_date`, [platform, start]);
    const { rows: baselines } = await pool.query(
      `SELECT DISTINCT ON (social_clip_id) social_clip_id AS clip_id, views, likes, comments
       FROM clip_stats WHERE platform = $1 AND stat_date < $2::date
       ORDER BY social_clip_id, stat_date DESC`, [platform, start]);
    // Site clicks attributed to each clip's ref tag (?ref=c<id>), per day —
    // these are events, not cumulative snapshots.
    const { rows: clicks } = await pool.query(
      `SELECT sc.id AS clip_id, v.created_at::date::text AS date, COUNT(*)::int AS n
       FROM visits v JOIN social_clips sc ON sc.ref_tag = v.ref
       WHERE v.ref IS NOT NULL AND v.created_at >= $1::date AND v.created_at < ($1::date + interval '1 month')
       GROUP BY sc.id, v.created_at::date`, [start]);
    const { rows: clips } = await pool.query(
      `SELECT id, COALESCE(concept_name, '') AS concept, ref_tag FROM social_clips ORDER BY id`);
    // Channel subscribers per day (from the daily channel snapshot) + the
    // last value before the month as baseline for day-1 deltas.
    const { rows: subs } = await pool.query(
      `SELECT stat_date::text AS date, subscribers FROM channel_daily_stats
       WHERE platform = $1 AND stat_date >= $2::date AND stat_date < ($2::date + interval '1 month')
       ORDER BY stat_date`, [platform, start]);
    const { rows: subsBaseRows } = await pool.query(
      `SELECT subscribers FROM channel_daily_stats
       WHERE platform = $1 AND stat_date < $2::date ORDER BY stat_date DESC LIMIT 1`, [platform, start]);
    res.json({ platform, month, stats, baselines, clicks, clips, subs, subs_baseline: subsBaseRows.length ? subsBaseRows[0].subscribers : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /admin/api/tracker/stats-cell — remove one bad snapshot row
// Body: { clip_id, platform, date }  (used from the views grid to clean
// up corrupt entries, e.g. manual daily-views typed in as totals)
app.delete('/admin/api/tracker/stats-cell', requireRole('admin'), async (req, res) => {
  const { clip_id, platform, date } = req.body || {};
  if (!parseInt(clip_id) || !['tiktok','instagram','youtube','facebook'].includes(String(platform)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date)))
    return res.status(400).json({ error: 'clip_id, platform, date required' });
  try {
    const r = await pool.query(
      `DELETE FROM clip_stats WHERE social_clip_id=$1 AND platform=$2 AND stat_date=$3::date`,
      [parseInt(clip_id), platform, date]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /admin/api/tracker/clips/:id/plan — set/clear per-platform planned publish dates
// Body: { plan: { tiktok: 'YYYY-MM-DD'|null, instagram: ..., youtube: ..., facebook: ... } }
app.post('/admin/api/tracker/clips/:id(\\d+)/plan', requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  const cols = { tiktok: 'tiktok_planned_at', instagram: 'instagram_planned_at', youtube: 'yt_planned_at', facebook: 'fb_planned_at' };
  try {
    const plan = req.body.plan || {};
    for (const [plat, col] of Object.entries(cols)) {
      if (plan[plat] === undefined) continue;
      const v = plan[plat] && /^\d{4}-\d{2}-\d{2}$/.test(String(plan[plat])) ? plan[plat] : null;
      await pool.query(`UPDATE social_clips SET ${col} = $2, updated_at = NOW() WHERE id = $1`, [id, v]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/api/tracker/clips/:id', requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM social_clips WHERE id = $1', [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/api/tracker/clips/:id/posts -- platform post objects from social_clips columns
app.get('/admin/api/tracker/clips/:id/posts', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tiktok_posted_at, tiktok_post_url, tiktok_caption, tiktok_hashtags,
              instagram_posted_at, instagram_post_url, instagram_caption, instagram_hashtags, instagram_alt_text, instagram_media_id,
              yt_posted_at, yt_post_url, yt_title, yt_description, yt_keyword_tags, yt_video_id,
              fb_posted_at, fb_post_url, fb_caption
       FROM social_clips WHERE id = $1`,
      [parseInt(req.params.id)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const sc = rows[0];
    const posts = [];
    if (sc.tiktok_posted_at || sc.tiktok_post_url || sc.tiktok_caption) {
      posts.push({ platform: 'tiktok', posted_at: sc.tiktok_posted_at, post_url: sc.tiktok_post_url, caption: sc.tiktok_caption, hashtags: sc.tiktok_hashtags });
    }
    if (sc.instagram_posted_at || sc.instagram_post_url || sc.instagram_caption || sc.instagram_media_id) {
      let igPostUrl = sc.instagram_post_url;
      // Auto-fetch permalink if we have a media_id but no URL yet
      if (sc.instagram_media_id && !igPostUrl) {
        try {
          const { token, pageToken } = await getInstagramToken().catch(() => ({}));
          const tok = pageToken || token;
          if (tok) {
            const plR = await fetch(`https://graph.facebook.com/v21.0/${sc.instagram_media_id}?fields=permalink&access_token=${tok}`);
            const plD = await plR.json();
            if (plD.permalink) {
              igPostUrl = plD.permalink;
              await pool.query(`UPDATE social_clips SET instagram_post_url=$1 WHERE id=$2`, [igPostUrl, parseInt(req.params.id)]);
            }
          }
        } catch(e) { /* non-fatal */ }
      }
      posts.push({ platform: 'instagram', posted_at: sc.instagram_posted_at, post_url: igPostUrl, caption: sc.instagram_caption, hashtags: sc.instagram_hashtags, alt_text: sc.instagram_alt_text, media_id: sc.instagram_media_id });
    }
    if (sc.yt_posted_at || sc.yt_post_url || sc.yt_title) {
      posts.push({ platform: 'youtube', posted_at: sc.yt_posted_at, post_url: sc.yt_post_url, yt_title: sc.yt_title, yt_description: sc.yt_description, yt_keyword_tags: sc.yt_keyword_tags, yt_video_id: sc.yt_video_id });
    }
    if (sc.fb_posted_at || sc.fb_post_url || sc.fb_caption) {
      posts.push({ platform: 'facebook', posted_at: sc.fb_posted_at, post_url: sc.fb_post_url, fb_caption: sc.fb_caption });
    }
    res.json({ rows: posts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/api/tracker/clips/:id/posts -- upsert platform post data onto social_clips
app.post('/admin/api/tracker/clips/:id/posts', requireRole('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { platform, posted_at, post_url, caption, hashtags, alt_text,
            yt_video_id, yt_title, yt_description, yt_keyword_tags, fb_caption } = req.body;
    if (!platform) return res.status(400).json({ error: 'platform required' });
    let sql, params;
    if (platform === 'tiktok') {
      const ttVidMatch = (post_url||'').match(/\/video\/(\d+)/);
      const ttVidId = ttVidMatch ? ttVidMatch[1] : null;
      sql = 'UPDATE social_clips SET tiktok_posted_at=$2, tiktok_post_url=$3, tiktok_caption=$4, tiktok_hashtags=$5, tiktok_video_id=COALESCE($6, tiktok_video_id), updated_at=NOW() WHERE id=$1';
      params = [id, posted_at||null, post_url||null, caption||null, hashtags||null, ttVidId];
    } else if (platform === 'instagram') {
      sql = 'UPDATE social_clips SET instagram_posted_at=$2, instagram_post_url=$3, instagram_caption=$4, instagram_hashtags=$5, instagram_alt_text=$6, updated_at=NOW() WHERE id=$1';
      params = [id, posted_at||null, post_url||null, caption||null, hashtags||null, alt_text||null];
    } else if (platform === 'youtube') {
      sql = 'UPDATE social_clips SET yt_posted_at=$2, yt_post_url=$3, yt_title=$4, yt_description=$5, yt_keyword_tags=$6, yt_video_id=$7, updated_at=NOW() WHERE id=$1';
      params = [id, posted_at||null, post_url||null, yt_title||null, yt_description||null, yt_keyword_tags||null, yt_video_id||null];
    } else if (platform === 'facebook') {
      sql = 'UPDATE social_clips SET fb_posted_at=$2, fb_post_url=$3, fb_caption=$4, updated_at=NOW() WHERE id=$1';
      params = [id, posted_at||null, post_url||null, fb_caption||null];
    } else {
      return res.status(400).json({ error: 'Unknown platform' });
    }
    await pool.query(sql, params);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/api/tracker/clips/:id/stats
app.get('/admin/api/tracker/clips/:id/stats', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT platform, stat_date::text, views, likes, comments, shares, source FROM clip_stats WHERE social_clip_id=$1 ORDER BY stat_date DESC, platform',
      [parseInt(req.params.id)]
    );
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/api/tracker/clips/:id/stats -- manual stat log
app.post('/admin/api/tracker/clips/:id/stats', requireRole('admin'), async (req, res) => {
  try {
    const { platform, stat_date, views, likes, comments, shares } = req.body;
    if (!platform) return res.status(400).json({ error: 'platform required' });
    await pool.query(
      `INSERT INTO clip_stats (social_clip_id, platform, stat_date, views, likes, comments, shares, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual')
       ON CONFLICT (social_clip_id, platform, stat_date) DO UPDATE SET
         views=$4, likes=$5, comments=$6, shares=$7, source='manual'`,
      [parseInt(req.params.id), platform,
       stat_date || new Date().toISOString().slice(0, 10),
       views||0, likes||0, comments||0, shares||0]
    );
    const viewCol = { tiktok: 'tiktok_views', instagram: 'instagram_views', youtube: 'youtube_views', facebook: 'facebook_views' }[platform];
    if (viewCol) await pool.query('UPDATE social_clips SET ' + viewCol + '=$2, updated_at=NOW() WHERE id=$1', [parseInt(req.params.id), views||0]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// Shared helper: fetch Instagram stats for all clips with instagram_media_id
async function fetchInstagramStatsBatch() {
  const { rows } = await pool.query(
    "SELECT id, instagram_media_id FROM social_clips WHERE instagram_media_id IS NOT NULL AND instagram_media_id <> ''"
  );
  if (!rows.length) return { updated: 0 };
  const { token, pageToken } = await getInstagramToken();
  const tok = pageToken || token;
  const today = new Date().toISOString().slice(0, 10);
  let updated = 0;
  for (const clip of rows) {
    try {
      // Basic fields — video_views works for Reels/Video without insights permission
      const basicR = await fetch(`https://graph.facebook.com/v21.0/${clip.instagram_media_id}?fields=id,like_count,comments_count,media_type&access_token=${tok}`);
      const basicD = await basicR.json();
      if (basicD.error) { console.warn('[ig-stats]', clip.id, basicD.error.message); continue; }
      const likes    = basicD.like_count    || 0;
      const comments = basicD.comments_count || 0;
      console.log('[ig-stats] clip', clip.id, 'media_type:', basicD.media_type, 'like_count:', basicD.like_count, 'comments:', basicD.comments_count);
      let views = 0; // Will be set by insights (plays/reach) if instagram_manage_insights is granted
      // Try insights for plays/reach (requires instagram_manage_insights)
      try {
        const insR = await fetch(`https://graph.facebook.com/v21.0/${clip.instagram_media_id}/insights?metric=views,reach&access_token=${tok}`);
        const insD = await insR.json();
        if (!insD.error && insD.data) {
          const byName = {};
          insD.data.forEach(m => { byName[m.name] = m.values && m.values[0] ? m.values[0].value : (m.value || 0); });
          const insViews = byName.views || byName.reach || 0;
          console.log('[ig-stats] clip', clip.id, 'insights plays:', byName.plays, 'reach:', byName.reach);
          if (insViews > views) views = insViews;
        } else if (insD.error) {
          console.warn('[ig-stats] insights error clip', clip.id, insD.error.message);
        }
      } catch(e) { console.warn('[ig-stats] insights exception clip', clip.id, e.message); }
      await pool.query(
        `INSERT INTO clip_stats (social_clip_id, platform, stat_date, views, likes, comments, shares, source)
         VALUES ($1,'instagram',$2,$3,$4,$5,0,'api')
         ON CONFLICT (social_clip_id, platform, stat_date) DO UPDATE SET
           views=$3, likes=$4, comments=$5, source='api'`,
        [clip.id, today, views, likes, comments]
      );
      // Only update instagram_views if we got a real value (don't zero out existing data)
      if (views > 0) {
        await pool.query(
          'UPDATE social_clips SET instagram_views=$2, stats_refreshed_at=NOW(), updated_at=NOW() WHERE id=$1',
          [clip.id, views]
        );
      } else {
        await pool.query(
          'UPDATE social_clips SET stats_refreshed_at=NOW(), updated_at=NOW() WHERE id=$1',
          [clip.id]
        );
      }
      updated++;
    } catch(e) { console.warn('[ig-stats] clip', clip.id, e.message); }
  }
  return { updated };
}

// POST /admin/api/tracker/fetch-instagram-stats
app.post('/admin/api/tracker/fetch-instagram-stats', requireRole('admin'), async (req, res) => {
  try {
    const result = await fetchInstagramStatsBatch();
    res.json({ ok: true, updated: result.updated });
  } catch(e) {
    console.error('[tracker/fetch-instagram-stats]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Shared helper called by HTTP route and daily cron
async function fetchYouTubeStatsBatch() {
  const YT_KEY = process.env.YOUTUBE_API_KEY;
  if (!YT_KEY) throw new Error('YOUTUBE_API_KEY not set');
  const { rows } = await pool.query(
    "SELECT id, yt_video_id FROM social_clips WHERE yt_video_id IS NOT NULL AND yt_video_id <> ''"
  );
  if (!rows.length) return { updated: 0 };
  const https3 = require('https');
  let updated = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const ids   = batch.map(r => encodeURIComponent(r.yt_video_id)).join(',');
    const ytUrl = 'https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=' + ids + '&key=' + YT_KEY;
    const data  = await new Promise((resolve, reject) => {
      https3.get(ytUrl, r => {
        let body = ''; r.on('data', c => body += c);
        r.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
    const byId = {};
    for (const item of (data.items || [])) { byId[item.id] = item.statistics || {}; byId[item.id]._publishedAt = item.snippet && item.snippet.publishedAt ? item.snippet.publishedAt.slice(0,10) : null; }
    for (const clip of batch) {
      const s = byId[clip.yt_video_id];
      if (!s) continue;
      const views    = parseInt(s.viewCount)||0;
      const likes    = parseInt(s.likeCount)||0;
      const comments = parseInt(s.commentCount)||0;
      await pool.query(
        `INSERT INTO clip_stats (social_clip_id, platform, stat_date, views, likes, comments, shares, source)
         VALUES ($1,'youtube',$2,$3,$4,$5,0,'api')
         ON CONFLICT (social_clip_id, platform, stat_date) DO UPDATE SET
           views=$3, likes=$4, comments=$5, source='api'`,
        [clip.id, today, views, likes, comments]
      );
      await pool.query('UPDATE social_clips SET youtube_views=$2, stats_refreshed_at=NOW(), updated_at=NOW() WHERE id=$1', [clip.id, views]);
      const pub = byId[clip.yt_video_id] && byId[clip.yt_video_id]._publishedAt;
      if (pub) await pool.query('UPDATE social_clips SET yt_posted_at=$2 WHERE id=$1 AND yt_posted_at IS NULL', [clip.id, pub]);
      updated++;
    }
  }
  return { updated };
}

// POST /admin/api/tracker/fetch-facebook-stats -- batch Facebook stats for all clips with facebook_video_id
async function fetchFacebookStatsBatch() {
  const { rows } = await pool.query(
    `SELECT id, facebook_video_id FROM social_clips WHERE facebook_video_id IS NOT NULL AND facebook_video_id <> '' ORDER BY id DESC LIMIT 50`
  );
  if (!rows.length) return { updated: 0 };
  const { token } = await getFacebookToken();
  let updated = 0;
  for (const clip of rows) {
    try {
      // Try Reels metrics first (FB converts short vertical videos to Reels)
      let views = 0, likes = 0, comments = 0, shares = 0;
      const reelsR = await fetch(`https://graph.facebook.com/v21.0/${clip.facebook_video_id}/video_insights?metric=blue_reels_play_count,fb_reels_total_plays,post_video_likes_by_reaction_type,post_video_social_actions&period=lifetime&access_token=${token}`);
      const reelsD = await reelsR.json();
      console.log('[fb-stats] clip', clip.id, 'reels metrics:', JSON.stringify(reelsD));
      if (!reelsD.error && reelsD.data && reelsD.data.length) {
        const byName = {};
        reelsD.data.forEach(m => {
          const val = m.values && m.values.length ? m.values[0].value : (m.value || 0);
          byName[m.name] = typeof val === 'object' ? Object.values(val).reduce((a,b)=>a+b,0) : (val || 0);
        });
        views    = byName.blue_reels_play_count || byName.fb_reels_total_plays || 0;
        likes    = byName.post_video_likes_by_reaction_type || byName.post_reactions_by_type_total || 0;
        const social = reelsD.data.find(m => m.name === 'post_video_social_actions');
        if (social && social.values && social.values[0] && typeof social.values[0].value === 'object') {
          comments = social.values[0].value.comment || 0;
          shares   = social.values[0].value.share || 0;
        }
      }
      // Fallback: regular video metrics (total_video_views) if not a Reel
      if (!views) {
        const vidR = await fetch(`https://graph.facebook.com/v21.0/${clip.facebook_video_id}/video_insights?metric=total_video_views,total_video_reactions_by_type_total&period=lifetime&access_token=${token}`);
        const vidD = await vidR.json();
        console.log('[fb-stats] clip', clip.id, 'video metrics:', JSON.stringify(vidD));
        if (!vidD.error && vidD.data) {
          const byName = {};
          vidD.data.forEach(m => {
            const val = m.values && m.values.length ? m.values[0].value : (m.value || 0);
            byName[m.name] = typeof val === 'object' ? Object.values(val).reduce((a,b)=>a+b,0) : (val || 0);
          });
          views = byName.total_video_views || 0;
          if (!likes) likes = byName.total_video_reactions_by_type_total || 0;
        }
      }
      console.log('[fb-stats] clip', clip.id, 'final: views='+views+' likes='+likes+' comments='+comments+' shares='+shares);
      await pool.query(
        `UPDATE social_clips SET facebook_views=$2, updated_at=NOW() WHERE id=$1`,
        [clip.id, views]
      );
      await pool.query(
        `INSERT INTO clip_stats (social_clip_id, platform, stat_date, views, likes, comments, shares, source)
         VALUES ($1, 'facebook', CURRENT_DATE, $2, $3, $4, $5, 'api')
         ON CONFLICT (social_clip_id, platform, stat_date)
         DO UPDATE SET views=$2, likes=$3, comments=$4, shares=$5, source='api'`,
        [clip.id, views, likes, comments, shares]
      );
      updated++;
    } catch(e) { console.warn('[fb-stats] clip', clip.id, e.message); }
  }
  return { updated };
}

app.post('/admin/api/tracker/fetch-facebook-stats', requireRole('admin'), async (req, res) => {
  try {
    const result = await fetchFacebookStatsBatch();
    res.json({ ok: true, updated: result.updated });
  } catch(e) {
    console.error('[tracker/fetch-facebook-stats]', e.message);
    res.status(500).json({ error: e.message });
  }
});


// POST /admin/api/tracker/fetch-youtube-stats -- batch YT stats for all clips with yt_video_id
app.post('/admin/api/tracker/fetch-youtube-stats', requireRole('admin'), async (req, res) => {
  try {
    const result = await fetchYouTubeStatsBatch();
    res.json({ ok: true, updated: result.updated });
  } catch (e) {
    console.error('[tracker/fetch-youtube-stats]', e.message);
    res.status(500).json({ error: e.message });
  }
});


// POST /admin/api/tracker/fetch-tiktok-stats -- batch TikTok stats via Video Query API
async function fetchTikTokStatsBatch() {
  // Get clips with video_id, or extract it from post_url on the fly
  const { rows: rawRows } = await pool.query(
    `SELECT id, tiktok_video_id, tiktok_post_url FROM social_clips
     WHERE (tiktok_video_id IS NOT NULL AND tiktok_video_id <> '')
        OR (tiktok_post_url IS NOT NULL AND tiktok_post_url LIKE '%/video/%')
     ORDER BY id DESC LIMIT 50`
  );
  // Ensure video_id is set (extract from URL if missing)
  for (const r of rawRows) {
    if (!r.tiktok_video_id && r.tiktok_post_url) {
      const m = r.tiktok_post_url.match(/\/video\/(\d+)/);
      if (m) {
        r.tiktok_video_id = m[1];
        await pool.query(`UPDATE social_clips SET tiktok_video_id=$2, updated_at=NOW() WHERE id=$1`, [r.id, m[1]]);
      }
    }
  }
  const rows = rawRows.filter(r => r.tiktok_video_id);
  if (!rows.length) return { updated: 0 };

  // Refresh token
  const ttRow = await pool.query("SELECT access_token, refresh_token, token_expiry FROM platform_tokens WHERE platform='tiktok'");
  if (!ttRow.rows.length) throw new Error('TikTok not connected');
  let { access_token, refresh_token, token_expiry } = ttRow.rows[0];
  if (!access_token) throw new Error('TikTok access token missing');

  // Refresh if expired
  if (token_expiry && new Date(token_expiry) < new Date()) {
    const rr = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY, client_secret: process.env.TIKTOK_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token })
    });
    const rd = await rr.json();
    if (rd.access_token) {
      access_token = rd.access_token;
      await pool.query(
        `UPDATE platform_tokens SET access_token=$1, token_expiry=$2, updated_at=NOW() WHERE platform='tiktok'`,
        [rd.access_token, new Date(Date.now() + (rd.expires_in||86400)*1000)]
      );
    } else {
      // Don't limp on with a dead token — say why the refresh failed.
      throw new Error('TikTok token refresh failed: ' +
        (rd.error_description || rd.error || JSON.stringify(rd).slice(0, 200)) +
        ' — reconnect at https://turtleandsun.com/admin/tiktok/connect');
    }
  }

  const videoIds = rows.map(r => r.tiktok_video_id);
  const qr = await fetch('https://open.tiktokapis.com/v2/video/query/?fields=id,play_count,like_count,comment_count,share_count', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filters: { video_ids: videoIds } })
  });
  const qd = await qr.json();
  console.log('[tiktok-stats] query response:', JSON.stringify(qd).slice(0, 300));

  // Surface API refusals instead of silently reporting "0 updated" —
  // e.g. scope_not_authorized while the developer app awaits approval.
  if (qd.error && qd.error.code && qd.error.code !== 'ok') {
    throw new Error(`TikTok API refused: ${qd.error.code} — ${qd.error.message || ''}`.trim() +
      ' (stats via API require the approved developer app; enter TikTok views manually until then)');
  }

  const videos = qd.data?.videos || [];
  let updated = 0;
  for (const v of videos) {
    const clip = rows.find(r => r.tiktok_video_id === v.id);
    if (!clip) continue;
    const views    = v.play_count    || 0;
    const likes    = v.like_count    || 0;
    const comments = v.comment_count || 0;
    const shares   = v.share_count   || 0;
    await pool.query(
      `INSERT INTO clip_stats (social_clip_id, platform, stat_date, views, likes, comments, shares, source)
       VALUES ($1, 'tiktok', CURRENT_DATE, $2, $3, $4, $5, 'api')
       ON CONFLICT (social_clip_id, platform, stat_date)
       DO UPDATE SET views=$2, likes=$3, comments=$4, shares=$5, source='api'`,
      [clip.id, views, likes, comments, shares]
    );
    updated++;
  }
  return { updated };
}

app.post('/admin/api/tracker/fetch-tiktok-stats', requireRole('admin'), async (req, res) => {
  try {
    const result = await fetchTikTokStatsBatch();
    res.json({ ok: true, updated: result.updated });
  } catch (e) {
    console.error('[tracker/fetch-tiktok-stats]', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── Channel daily stats snapshot ─────────────────────────────────────────────
async function fetchChannelDailyStats(overrideDate) {
  const today = overrideDate || new Date().toISOString().slice(0, 10);
  const platforms = ['youtube', 'instagram', 'facebook', 'tiktok'];
  for (const platform of platforms) {
    try {
      let subscribers = 0;
      if (platform === 'youtube') {
        const ytRow = await pool.query("SELECT channel_id FROM platform_tokens WHERE platform='youtube'");
        if (ytRow.rows.length && ytRow.rows[0].channel_id) {
          const ytKey = process.env.YOUTUBE_API_KEY;
          const r = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${encodeURIComponent(ytRow.rows[0].channel_id)}&key=${ytKey}`);
          const d = await r.json();
          const s = d.items && d.items[0] && d.items[0].statistics;
          if (s) subscribers = parseInt(s.subscriberCount) || 0;
        }
      } else if (platform === 'instagram') {
        try {
          const { token, igUserId } = await getInstagramToken();
          const r = await fetch(`https://graph.facebook.com/v21.0/${igUserId}?fields=followers_count&access_token=${token}`);
          const d = await r.json();
          if (!d.error) subscribers = d.followers_count || 0;
        } catch(e) { /* not connected */ }
      } else if (platform === 'facebook') {
        try {
          const { token, pageId } = await getFacebookToken();
          const r = await fetch(`https://graph.facebook.com/v21.0/${pageId}?fields=fan_count,followers_count&access_token=${token}`);
          const d = await r.json();
          if (!d.error) subscribers = d.followers_count || d.fan_count || 0;
        } catch(e) { /* not connected */ }
      } else if (platform === 'tiktok') {
        // The API only reports follower_count with the user.info.stats scope
        // (which we don't have) — never coerce its empty answer to 0. When
        // the API knows nothing, carry the last stored snapshot forward
        // (the Chrome-extension scrape maintains it).
        let got = null;
        const ttRow = await pool.query("SELECT access_token FROM platform_tokens WHERE platform='tiktok'");
        if (ttRow.rows.length && ttRow.rows[0].access_token) {
          try {
            const r = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=follower_count', {
              headers: { 'Authorization': 'Bearer ' + ttRow.rows[0].access_token }
            });
            const d = await r.json();
            if (typeof d.data?.user?.follower_count === 'number') got = d.data.user.follower_count;
          } catch (e) { /* fall through to snapshot */ }
        }
        if (got === null) {
          const prev = await pool.query(
            `SELECT subscribers FROM channel_daily_stats
             WHERE platform = 'tiktok' ORDER BY stat_date DESC, subscribers DESC LIMIT 1`);
          got = prev.rows.length ? prev.rows[0].subscribers : 0;
        }
        subscribers = got;
      }
      const sRow = await pool.query(
        `SELECT COALESCE(SUM(v.views), 0) AS tv, COALESCE(SUM(v.likes), 0) AS tl
         FROM (
           SELECT DISTINCT ON (social_clip_id) views, likes
           FROM clip_stats WHERE platform=$1
           ORDER BY social_clip_id, stat_date DESC
         ) v`,
        [platform]
      );
      const total_views = parseInt(sRow.rows[0].tv) || 0;
      const total_likes = parseInt(sRow.rows[0].tl) || 0;
      await pool.query(
        `INSERT INTO channel_daily_stats (platform, stat_date, subscribers, total_views, total_likes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (platform, stat_date) DO UPDATE SET
           subscribers = EXCLUDED.subscribers,
           total_views = EXCLUDED.total_views,
           total_likes = EXCLUDED.total_likes`,
        [platform, today, subscribers, total_views, total_likes]
      );
      console.log(`[channel-daily-stats] ${platform}: subs=${subscribers} views=${total_views} likes=${total_likes}`);
    } catch(e) {
      console.warn(`[channel-daily-stats] ${platform}:`, e.message);
    }
  }
}

// GET /admin/api/tracker/channel-daily-stats — time-series for summary chart
app.get('/admin/api/tracker/channel-daily-stats', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT platform, stat_date::text, subscribers, total_views, total_likes
       FROM channel_daily_stats ORDER BY stat_date ASC, platform`
    );
    res.json(rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/api/tracker/run-channel-stats?date=YYYY-MM-DD — manual trigger
app.post('/admin/api/tracker/run-channel-stats', requireRole('admin'), async (req, res) => {
  const date = (req.query.date || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.date : null;
  try {
    await fetchChannelDailyStats(date || undefined);
    res.json({ ok: true, date: date || new Date().toISOString().slice(0, 10) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/api/tracker/channel-followers -- subscriber/follower counts for all connected channels
app.get('/admin/api/tracker/channel-followers', requireRole('admin'), async (req, res) => {
  const result = {};
  // YouTube
  try {
    const ytRow = await pool.query("SELECT channel_id FROM platform_tokens WHERE platform='youtube'");
    if (ytRow.rows.length && ytRow.rows[0].channel_id) {
      const ytKey = process.env.YOUTUBE_API_KEY;
      const r = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${encodeURIComponent(ytRow.rows[0].channel_id)}&key=${ytKey}`);
      const d = await r.json();
      const s = d.items && d.items[0] && d.items[0].statistics;
      if (s) result.youtube = parseInt(s.subscriberCount) || 0;
    }
  } catch(e) { console.warn('[channel-followers] youtube:', e.message); }
  // Instagram
  try {
    const { token, igUserId } = await getInstagramToken();
    const r = await fetch(`https://graph.facebook.com/v21.0/${igUserId}?fields=followers_count&access_token=${token}`);
    const d = await r.json();
    if (!d.error) result.instagram = d.followers_count || 0;
  } catch(e) { console.warn('[channel-followers] instagram:', e.message); }
  // Facebook
  try {
    const { token, pageId } = await getFacebookToken();
    const r = await fetch(`https://graph.facebook.com/v21.0/${pageId}?fields=fan_count,followers_count&access_token=${token}`);
    const d = await r.json();
    if (!d.error) result.facebook = d.followers_count || d.fan_count || 0;
  } catch(e) { console.warn('[channel-followers] facebook:', e.message); }
  // TikTok
  try {
    const ttRow = await pool.query("SELECT access_token FROM platform_tokens WHERE platform='tiktok'");
    if (ttRow.rows.length && ttRow.rows[0].access_token) {
      const r = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=follower_count', {
        headers: { 'Authorization': 'Bearer ' + ttRow.rows[0].access_token }
      });
      const d = await r.json();
      // Only trust an actual number — with the basic scope the API answers
      // with an empty user object, which must NOT become a phantom zero.
      if (typeof d.data?.user?.follower_count === 'number') {
        result.tiktok = d.data.user.follower_count;
      }
    }
  } catch(e) { console.warn('[channel-followers] tiktok:', e.message); }
  // Fallback: the API needs the user.info.stats scope we don't have — use the
  // latest snapshot scraped by the Chrome extension into channel_daily_stats.
  if (result.tiktok == null) {
    try {
      const { rows } = await pool.query(
        `SELECT subscribers FROM channel_daily_stats
         WHERE platform = 'tiktok' ORDER BY stat_date DESC LIMIT 1`);
      if (rows.length) result.tiktok = rows[0].subscribers;
    } catch (e) { console.warn('[channel-followers] tiktok fallback:', e.message); }
  }
  res.json(result);
});

// Serve admin-social-tracker.html
app.get('/admin/social-tracker', requireRole('admin'), (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-social-tracker.html'));
});

// ═══════════════════════════════════════════════════════════════════════════
// Video Engine — story generator + review queue (spec 2026-07-04, component 1)
// Libraries: story_elements (component 2), cta_cards (component 3),
// story_situations. LLM via fal openrouter/router (see story_engine.js).
// ═══════════════════════════════════════════════════════════════════════════

app.get('/admin/video-stories', requireRole('admin'), (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-video-stories.html'));
});

async function getStoryLlmModel() {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM system_settings WHERE key = 'story_llm_model'`
    );
    return rows[0]?.value || storyEngine.DEFAULT_MODEL;
  } catch { return storyEngine.DEFAULT_MODEL; }
}

// The show's tone bible — editable text, stored in system_settings.
async function getStoryTone() {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM system_settings WHERE key = 'story_tone'`);
    return (rows[0]?.value || '').trim() || storyEngine.DEFAULT_STORY_TONE;
  } catch { return storyEngine.DEFAULT_STORY_TONE; }
}

app.get('/admin/api/story-tone', requireRole('admin'), async (req, res) => {
  res.json({ tone: await getStoryTone(), is_default: (await getStoryTone()) === storyEngine.DEFAULT_STORY_TONE });
});

app.post('/admin/api/story-tone', requireRole('admin'), async (req, res) => {
  try {
    const tone = String(req.body?.tone || '').trim();
    if (!tone) {
      // Empty = reset to the built-in default.
      await pool.query(`DELETE FROM system_settings WHERE key = 'story_tone'`);
    } else {
      await pool.query(`
        INSERT INTO system_settings (key, value) VALUES ('story_tone', $1)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [tone]);
    }
    res.json({ ok: true, tone: await getStoryTone() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List stories (review queue). ?status=pending_review|accepted|rejected
app.get('/admin/api/stories', requireRole('admin'), async (req, res) => {
  try {
    const status = req.query.status || null;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const params = [];
    let where = '';
    if (status) { params.push(status); where = `WHERE vs.status = $1`; }
    params.push(limit, offset);
    const { rows } = await pool.query(`
      SELECT vs.*, cc.label AS cta_label, cc.offer_key AS cta_offer_key,
             sc.ref_tag,
             sc.published_tiktok, sc.published_instagram, sc.published_youtube, sc.published_facebook,
             COALESCE(sc.tiktok_views,0)+COALESCE(sc.instagram_views,0)
               +COALESCE(sc.youtube_views,0)+COALESCE(sc.facebook_views,0) AS total_views,
             CASE WHEN sc.ref_tag IS NOT NULL
               THEN (SELECT COUNT(*)::int FROM visits v WHERE v.ref = sc.ref_tag AND ${HUMAN_CLICK_WHERE}) ELSE 0 END AS link_clicks,
             CASE WHEN sc.ref_tag IS NOT NULL
               THEN (SELECT COUNT(*)::int FROM waitlist w WHERE w.ref = sc.ref_tag) ELSE 0 END AS emails,
             COUNT(*) OVER() AS total_count
      FROM video_stories vs
      LEFT JOIN cta_cards cc ON cc.id = vs.cta_card_id
      LEFT JOIN social_clips sc ON sc.id = vs.social_clip_id
      ${where}
      ORDER BY vs.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const total = rows.length ? parseInt(rows[0].total_count, 10) : 0;
    res.json({ stories: rows.map(({ total_count, ...r }) => r), total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Shared generation core: picks situation/CTA/elements, calls the LLM.
async function generateStoryRecord({ situationId, ctaCardId, generator, elementIds }) {
  // 1. Situation: requested or random active.
  let situation = null;
  if (situationId) {
    const { rows } = await pool.query(`SELECT * FROM story_situations WHERE id = $1`, [situationId]);
    situation = rows[0] || null;
  }
  if (!situation) {
    const { rows } = await pool.query(
      `SELECT * FROM story_situations WHERE active = TRUE ORDER BY random() LIMIT 1`);
    situation = rows[0] || null;
  }

  // 2. CTA card: requested or random active (may be null while library is empty).
  let ctaCard = null;
  if (ctaCardId) {
    const { rows } = await pool.query(`SELECT * FROM cta_cards WHERE id = $1`, [ctaCardId]);
    ctaCard = rows[0] || null;
  }
  if (!ctaCard) {
    const { rows } = await pool.query(
      `SELECT * FROM cta_cards WHERE active = TRUE ORDER BY random() LIMIT 1`);
    ctaCard = rows[0] || null;
  }

  // 3. Elements. Explicit selection from the queue toolbar wins; otherwise
  //    auto: every active product element (the calendar must look the same
  //    everywhere = recognition) + up to 2 random other active elements.
  let elements;
  if (Array.isArray(elementIds) && elementIds.length) {
    const { rows } = await pool.query(
      `SELECT * FROM story_elements WHERE id = ANY($1::int[]) ORDER BY sort_order, id`,
      [elementIds.map(Number).filter(Number.isFinite)]);
    elements = rows;
  } else {
    const { rows: productEls } = await pool.query(
      `SELECT * FROM story_elements WHERE active = TRUE AND kind = 'product' ORDER BY sort_order`);
    const { rows: otherEls } = await pool.query(
      `SELECT * FROM story_elements WHERE active = TRUE AND kind <> 'product' ORDER BY random() LIMIT 2`);
    elements = [...productEls, ...otherEls];
  }

  // 4. LLM call.
  const model = await getStoryLlmModel();
  const toneText = await getStoryTone();
  const gen = generator === 'flow' || generator === 'gemini' ? generator : 'kling';
  const { story, costUsd } = await storyEngine.generateStory({
    toneText,
    situationText: situation?.text,
    elements: elements.map(e => ({
      name: e.name, kind: e.kind, description: e.description, personality: e.personality,
    })),
    ctaCard: ctaCard ? { label: ctaCard.label, cta_text: ctaCard.cta_text } : null,
    generator: gen,
    model,
  });

  // 5. Persist.
  const { rows: inserted } = await pool.query(`
    INSERT INTO video_stories (
      status, hook_text, story_type, mood,
      situation_id, situation_text, scenes,
      element_ids, elements_snapshot, cta_card_id,
      generator, llm_model, llm_cost_usd, llm_notes
    ) VALUES (
      'pending_review', $1, $2, $3,
      $4, $5, $6::jsonb,
      $7, $8::jsonb, $9,
      $10, $11, $12, $13
    ) RETURNING *`,
    [
      story.hook, story.story_type, story.mood || null,
      situation?.id || null, situation?.text || null, JSON.stringify(story.scenes),
      elements.map(e => e.id),
      JSON.stringify(elements.map(e => ({
        id: e.id, name: e.name, kind: e.kind,
        description: e.description, personality: e.personality,
        reference_image_urls: e.reference_image_urls,
      }))),
      ctaCard?.id || null,
      gen, model, costUsd, story.notes || null,
    ]);

  if (situation) {
    await pool.query(`UPDATE story_situations SET times_used = times_used + 1 WHERE id = $1`, [situation.id]);
  }
  if (ctaCard) {
    await pool.query(`UPDATE cta_cards SET times_used = times_used + 1 WHERE id = $1`, [ctaCard.id]);
  }
  return inserted[0];
}

// Manual story: the admin writes the prompt directly — no LLM, no situation.
// Created as 'accepted' (it IS the admin's own words) so 🎬 works immediately.
app.post('/admin/api/stories/manual', requireRole('admin'), async (req, res) => {
  try {
    const { hook_text, prompt, duration_s, element_ids, generator, cta_card_id } = req.body || {};
    if (!prompt || String(prompt).trim().length < 20) {
      return res.status(400).json({ error: 'Write a scene prompt of at least 20 characters.' });
    }
    const gen = ['kling', 'flow', 'gemini'].includes(generator) ? generator : 'kling';
    const dur = Math.min(Math.max(parseInt(duration_s, 10) || 6, 2), 15);
    let elements = [];
    if (Array.isArray(element_ids) && element_ids.length) {
      const { rows } = await pool.query(
        `SELECT * FROM story_elements WHERE id = ANY($1::int[]) ORDER BY sort_order, id`,
        [element_ids.map(Number).filter(Number.isFinite)]);
      elements = rows;
    }
    let ctaCard = null;
    if (cta_card_id) {
      const r = await pool.query(`SELECT * FROM cta_cards WHERE id = $1`, [cta_card_id]);
      ctaCard = r.rows[0] || null;
    }
    if (!ctaCard) {
      const r = await pool.query(`SELECT * FROM cta_cards WHERE active = TRUE ORDER BY random() LIMIT 1`);
      ctaCard = r.rows[0] || null;
    }
    const { rows: ins } = await pool.query(`
      INSERT INTO video_stories (
        status, hook_text, story_type, situation_text, scenes,
        element_ids, elements_snapshot, cta_card_id, generator, llm_model
      ) VALUES ('accepted', $1, 'manual', NULL, $2::jsonb, $3, $4::jsonb, $5, $6, 'manual')
      RETURNING *`,
      [hook_text || null,
       JSON.stringify([{ duration_s: dur, video_prompt: String(prompt).trim() }]),
       elements.map(e => e.id),
       JSON.stringify(elements.map(e => ({
         id: e.id, name: e.name, kind: e.kind,
         description: e.description, personality: e.personality,
         reference_image_urls: e.reference_image_urls,
       }))),
       ctaCard?.id || null, gen]);
    res.json({ ok: true, story: ins[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Clip intake (spec component 5): upload a manually generated part-1 clip
// (Google Flow / Gemini download) — stored in R2, story behaves as if Kling
// had made it: assembly, texts, tracker all work the same.
app.post('/admin/api/stories/:id(\\d+)/upload-video', requireRole('admin'), upload.single('file'), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id FROM video_stories WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const mt = req.file.mimetype || '';
    if (!mt.startsWith('video/')) {
      return res.status(400).json({ error: `Only video files are accepted (got ${mt || 'unknown'})` });
    }
    if (req.file.size > 500 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 500 MB)' });
    }
    const { uploadBuffer } = require('./storage');
    const r2 = await uploadBuffer({
      buffer: req.file.buffer, contentType: mt,
      kind: 'video-story-part1', baseName: 'story' + req.params.id + '_manual',
    });
    const dur = parseInt(req.query.duration_s, 10) || null;
    await pool.query(`
      UPDATE video_stories SET
        video_status = 'done', video_url = $2, video_fal_url = NULL,
        video_model = 'manual-upload', video_duration_s = $3, video_cost_usd = NULL,
        video_error = NULL, video_completed_at = NOW(), updated_at = NOW()
      WHERE id = $1`, [req.params.id, r2.url, dur]);
    res.json({ ok: true, url: r2.url });
    // The Flow/Gemini pipeline parks at 'waiting_clip' — the upload wakes it.
    try {
      const { rows: st } = await pool.query(
        `SELECT pipeline_status FROM video_stories WHERE id = $1`, [req.params.id]);
      if (st[0]?.pipeline_status === 'waiting_clip') {
        runStoryPipeline(req.params.id).catch(e => console.error('[pipeline] crashed:', e.message));
      }
    } catch { /* manual flow unaffected */ }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Frames: reviewable start/end pictures + reusable library ────────────────

function gatherElementRefs(els) {
  const isImg = (u) => !/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(String(u || ''));
  const refs = [];
  for (const kind of ['pet', 'product', 'person', 'location', 'prop']) {
    for (const el of (Array.isArray(els) ? els : []).filter(e => e.kind === kind)) {
      for (const u of (el.reference_image_urls || []).filter(isImg)) {
        refs.push({ url: u, name: el.name });
      }
    }
  }
  return refs;
}

// Compose a start or end frame for a story ($0.028). Shared by the manual
// 🖼 button and the auto-production pipeline.
async function generateFrameForStory(storyId, role, promptOverride) {
  const { rows } = await pool.query(`SELECT * FROM video_stories WHERE id = $1`, [storyId]);
  if (!rows.length) throw new Error('Story not found');
  const s = rows[0];
  const scenes = Array.isArray(s.scenes) ? s.scenes : [];
  let framePrompt = String(promptOverride || '').trim();
  if (!framePrompt) {
    framePrompt = (role === 'start'
      ? scenes[0]?.video_prompt
      : scenes[scenes.length - 1]?.video_prompt) || s.hook_text || '';
  }
  // Use the elements' CURRENT photos — the story's snapshot may predate them.
  let frameEls = s.elements_snapshot;
  if (Array.isArray(s.element_ids) && s.element_ids.length) {
    const { rows: freshEls } = await pool.query(
      `SELECT * FROM story_elements WHERE id = ANY($1::int[])`, [s.element_ids]);
    if (freshEls.length) frameEls = freshEls;
  }
  const refs = gatherElementRefs(frameEls);
  const out = await storyEngine.composeStartFrame({
    scenePrompt: framePrompt,
    referenceImageUrls: refs.map(r => r.url),
    elementNames: refs.map(r => r.name),
    role: role === 'end' ? 'closing' : 'opening',
  });
  const col = role === 'end' ? 'end_frame_url' : 'start_frame_url';
  await pool.query(`
    UPDATE video_stories SET ${col} = $2,
      llm_cost_usd = COALESCE(llm_cost_usd, 0) + $3, updated_at = NOW()
    WHERE id = $1`, [storyId, out.url, out.costUsd]);
  return out;
}

app.post('/admin/api/stories/:id(\\d+)/generate-frame', requireRole('admin'), async (req, res) => {
  try {
    const role = req.body?.role === 'end' ? 'end' : 'start';
    const out = await generateFrameForStory(req.params.id, role, req.body?.prompt);
    res.json({ ok: true, url: out.url, role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload an own picture as a story's start/end frame.
app.post('/admin/api/stories/:id(\\d+)/upload-frame', requireRole('admin'), upload.single('file'), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id FROM video_stories WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const mt = req.file.mimetype || '';
    if (!mt.startsWith('image/')) return res.status(400).json({ error: `Only pictures (got ${mt || 'unknown'})` });
    const role = req.query.role === 'end' ? 'end' : 'start';
    const { uploadBuffer } = require('./storage');
    const r2 = await uploadBuffer({
      buffer: req.file.buffer, contentType: mt,
      kind: 'video-story-frame', baseName: 'story' + req.params.id + '_' + role + 'frame',
    });
    const col = role === 'end' ? 'end_frame_url' : 'start_frame_url';
    await pool.query(`UPDATE video_stories SET ${col} = $2, updated_at = NOW() WHERE id = $1`,
      [req.params.id, r2.url]);
    res.json({ ok: true, url: r2.url, role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Set a frame from the library (frame_id) or clear it (url: null).
app.post('/admin/api/stories/:id(\\d+)/set-frame', requireRole('admin'), async (req, res) => {
  try {
    const role = req.body?.role === 'end' ? 'end' : 'start';
    const col = role === 'end' ? 'end_frame_url' : 'start_frame_url';
    let url = null;
    if (req.body?.frame_id) {
      const { rows } = await pool.query(`SELECT * FROM story_frames WHERE id = $1`, [req.body.frame_id]);
      if (!rows.length) return res.status(404).json({ error: 'Library frame not found' });
      url = rows[0].image_url;
      await pool.query(`UPDATE story_frames SET times_used = times_used + 1 WHERE id = $1`, [req.body.frame_id]);
    } else if (typeof req.body?.url === 'string' && req.body.url) {
      url = req.body.url;
    }
    const { rows } = await pool.query(
      `UPDATE video_stories SET ${col} = $2, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [req.params.id, url]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, url, role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Frame library CRUD.
app.get('/admin/api/story-frames', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM story_frames ORDER BY active DESC, id DESC`);
    res.json({ frames: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/api/story-frames', requireRole('admin'), async (req, res) => {
  try {
    const { label, kind, image_url, prompt, source } = req.body || {};
    if (!label || !image_url) return res.status(400).json({ error: 'label and image_url required' });
    const { rows } = await pool.query(`
      INSERT INTO story_frames (label, kind, image_url, prompt, source)
      VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [label, ['start', 'end', 'any'].includes(kind) ? kind : 'any',
       image_url, prompt || null,
       ['composed', 'uploaded', 'story'].includes(source) ? source : 'uploaded']);
    res.json({ ok: true, frame: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/admin/api/story-frames/:id(\\d+)', requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const sets = [];
    const vals = [req.params.id];
    for (const f of ['label', 'kind', 'active']) {
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        vals.push(body[f]);
        sets.push(`${f} = $${vals.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    const { rows } = await pool.query(
      `UPDATE story_frames SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, frame: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/api/story-frames/:id(\\d+)', requireRole('admin'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM story_frames WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/api/story-frames/upload', requireRole('admin'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const mt = req.file.mimetype || '';
    if (!mt.startsWith('image/')) return res.status(400).json({ error: `Only pictures (got ${mt || 'unknown'})` });
    const { uploadBuffer } = require('./storage');
    const baseName = 'frame_' + String(req.file.originalname || 'frame')
      .replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
    const r2 = await uploadBuffer({ buffer: req.file.buffer, contentType: mt, kind: 'frame-library', baseName });
    res.json({ ok: true, url: r2.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Generate 1-5 new stories into the queue.
app.post('/admin/api/stories/generate', requireRole('admin'), async (req, res) => {
  try {
    const { situation_id, cta_card_id, generator, element_ids } = req.body || {};
    const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 1, 1), 5);
    const created = [];
    const failures = [];
    for (let i = 0; i < count; i++) {
      try {
        created.push(await generateStoryRecord({
          situationId: situation_id || null,
          ctaCardId: cta_card_id || null,
          generator,
          elementIds: Array.isArray(element_ids) ? element_ids : null,
        }));
      } catch (err) { failures.push(err.message); }
    }
    if (!created.length) {
      return res.status(500).json({ error: failures.join(' | ') || 'generation failed' });
    }
    res.json({ ok: true, created, failures });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Regenerate: same situation + CTA + elements, fresh story, same row.
app.post('/admin/api/stories/:id(\\d+)/regenerate', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM video_stories WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const old = rows[0];
    let ctaCard = null;
    if (old.cta_card_id) {
      const r = await pool.query(`SELECT * FROM cta_cards WHERE id = $1`, [old.cta_card_id]);
      ctaCard = r.rows[0] || null;
    }
    const elements = Array.isArray(old.elements_snapshot) ? old.elements_snapshot : [];
    const model = await getStoryLlmModel();
    const toneText = await getStoryTone();
    const { story, costUsd } = await storyEngine.generateStory({
      toneText,
      situationText: old.situation_text,
      elements,
      ctaCard: ctaCard ? { label: ctaCard.label, cta_text: ctaCard.cta_text } : null,
      generator: old.generator,
      model,
    });
    const { rows: updated } = await pool.query(`
      UPDATE video_stories SET
        hook_text = $2, story_type = $3, mood = $4, scenes = $5::jsonb,
        llm_model = $6, llm_cost_usd = COALESCE(llm_cost_usd, 0) + $7,
        llm_notes = $8, status = 'pending_review', review_note = NULL,
        reviewed_at = NULL, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
      [old.id, story.hook, story.story_type, story.mood || null,
       JSON.stringify(story.scenes), model, costUsd, story.notes || null]);
    res.json({ ok: true, story: updated[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/api/stories/:id(\\d+)/accept', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      UPDATE video_stories SET status = 'accepted', reviewed_at = NOW(), updated_at = NOW()
      WHERE id = $1 RETURNING *`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, story: rows[0] });
    // Accept = start production (when the vs_auto default is on).
    try {
      const settings = await getVideoSettings();
      if (settings.vs_auto === 'on') {
        runStoryPipeline(rows[0].id).catch(e => console.error('[pipeline] crashed:', e.message));
      }
    } catch { /* manual mode still works */ }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/api/stories/:id(\\d+)/reject', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      UPDATE video_stories SET status = 'rejected', review_note = $2,
        reviewed_at = NOW(), updated_at = NOW()
      WHERE id = $1 RETURNING *`, [req.params.id, req.body?.note || null]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, story: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const STORY_TEXT_FIELDS = [
  'yt_title', 'yt_description', 'yt_keyword_tags',
  'tiktok_caption', 'tiktok_hashtags',
  'instagram_caption', 'instagram_hashtags', 'instagram_alt_text',
  'fb_caption',
];

app.put('/admin/api/stories/:id(\\d+)', requireRole('admin'), async (req, res) => {
  try {
    // Field-presence semantics (like the CTA grid): only keys present in the
    // body are updated. Editable: hook, scenes, and all posting texts.
    const body = req.body || {};
    const allowed = ['hook_text', ...STORY_TEXT_FIELDS];
    const sets = [];
    const vals = [req.params.id];
    for (const f of allowed) {
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        vals.push(body[f]);
        sets.push(`${f} = $${vals.length}`);
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'scenes') && Array.isArray(body.scenes)) {
      vals.push(JSON.stringify(body.scenes));
      sets.push(`scenes = $${vals.length}::jsonb`);
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    sets.push('updated_at = NOW()');
    const { rows } = await pool.query(
      `UPDATE video_stories SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const story = rows[0];

    // Already in the tracker? Keep the tracker record in sync so the upload
    // dialogs always show the edited texts.
    if (story.social_clip_id) {
      const clipSets = [];
      const clipVals = [story.social_clip_id];
      for (const f of STORY_TEXT_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(body, f)) {
          clipVals.push(body[f]);
          clipSets.push(`${f} = $${clipVals.length}`);
        }
      }
      if (Object.prototype.hasOwnProperty.call(body, 'hook_text')) {
        clipVals.push(body.hook_text);
        clipSets.push(`video_overlay_text = $${clipVals.length}`);
      }
      if (clipSets.length) {
        clipSets.push('updated_at = NOW()');
        await pool.query(
          `UPDATE social_clips SET ${clipSets.join(', ')} WHERE id = $1`, clipVals);
      }
    }
    res.json({ ok: true, story });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Deletes the whole story record. If it has a tracker row, that goes too
// (with the same posted-guard as the tracker's own delete: 409 unless force).
app.delete('/admin/api/stories/:id(\\d+)', requireRole('admin'), async (req, res) => {
  try {
    const force = req.query.force === '1';
    const { rows } = await pool.query(
      `SELECT social_clip_id FROM video_stories WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const clipId = rows[0].social_clip_id;
    if (clipId) {
      const { rows: cr } = await pool.query(
        `SELECT tiktok_posted_at, instagram_posted_at, yt_posted_at, fb_posted_at
         FROM social_clips WHERE id = $1`, [clipId]);
      if (cr.length && !force) {
        const published = [
          cr[0].tiktok_posted_at && 'TikTok',
          cr[0].instagram_posted_at && 'Instagram',
          cr[0].yt_posted_at && 'YouTube',
          cr[0].fb_posted_at && 'Facebook',
        ].filter(Boolean);
        if (published.length) return res.status(409).json({ published });
      }
      await pool.query(`DELETE FROM social_clips WHERE id = $1`, [clipId]);
    }
    await pool.query(`DELETE FROM video_stories WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Deletes only the assembled final video — story, part-1 video and texts stay.
// Refused while a tracker row exists (it references the final file).
app.post('/admin/api/stories/:id(\\d+)/delete-final', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT social_clip_id FROM video_stories WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].social_clip_id) {
      return res.status(400).json({ error: 'This final video is registered in the Tracker. Press 🗑 Remove from Tracker first, then delete the assembly — keeps tracking data consistent.' });
    }
    await pool.query(`
      UPDATE video_stories SET final_status = 'none', final_url = NULL, final_error = NULL,
        final_duration_s = NULL, final_completed_at = NULL, updated_at = NOW()
      WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Part-1 video generation (accepted story -> Kling t2v via fal) ───────────
// Kling takes minutes, so we answer immediately and run the job in the
// background; the row's video_status drives the queue UI (polled client-side).

// Start-frame preparation (spec open item: "test Standard first with
// start-frame images"). Picks the best element reference photo (pet first,
// then product), cover-crops it to 1080x1920 (i2v inherits the image's aspect
// ratio) and stores the crop in R2. Returns null when no usable photo exists.
async function prepareStoryStartFrame(story) {
  const els = Array.isArray(story.elements_snapshot) ? story.elements_snapshot : [];
  const isImg = (u) => !/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(String(u || ''));
  // Gather reference photos in priority order (pet first, then product, …),
  // keeping the element name next to each photo for the composition prompt.
  const refs = [];
  for (const kind of ['pet', 'product', 'person', 'location', 'prop']) {
    for (const el of els.filter(e => e.kind === kind)) {
      for (const u of (el.reference_image_urls || []).filter(isImg)) {
        refs.push({ url: u, name: el.name });
      }
    }
  }
  if (!refs.length) return null;

  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const scenePrompt = scenes[0]?.video_prompt || story.hook_text || '';

  // Preferred: AI-composed opening frame (native 9:16, subjects rendered INTO
  // the scene — no cropping, identity preserved). $0.028.
  try {
    const composed = await storyEngine.composeStartFrame({
      scenePrompt,
      referenceImageUrls: refs.map(r => r.url),
      elementNames: refs.map(r => r.name),
    });
    return { url: composed.url, costUsd: composed.costUsd, method: 'composed' };
  } catch (err) {
    console.warn('[video-story] start-frame composition failed, falling back to crop:', err.message);
  }

  // Fallback: plain 9:16 cover-crop of the best photo.
  try {
    const buf = await new Promise((resolve, reject) => {
      const get = (url, hops) => {
        if (hops > 4) return reject(new Error('too many redirects'));
        const lib = url.startsWith('https') ? require('https') : require('http');
        lib.get(url, r => {
          if (r.statusCode >= 300 && r.headers.location) return get(r.headers.location, hops + 1);
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
      };
      get(refs[0].url, 0);
    });
    const sharp = require('sharp');
    const cropped = await sharp(buf).resize(1080, 1920, { fit: 'cover' }).jpeg({ quality: 90 }).toBuffer();
    const { uploadBuffer } = require('./storage');
    const r2 = await uploadBuffer({
      buffer: cropped, contentType: 'image/jpeg',
      kind: 'video-story-startframe', baseName: 'story' + story.id + '_start',
    });
    return { url: r2.url, costUsd: 0, method: 'cropped' };
  } catch (err) {
    console.warn('[video-story] start-frame crop fallback failed too:', err.message);
    return null;
  }
}

// Kling v3 elements payload: every story element that has reference photos
// becomes a {frontal_image_url, reference_image_urls} entry (max 4 elements,
// 3 photos each), plus the @ElementN tag line the prompts must carry.
function buildStoryElementsPayload(els) {
  const isImg = (u) => !/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(String(u || ''));
  const withRefs = (Array.isArray(els) ? els : [])
    .filter(e => (e.reference_image_urls || []).some(isImg))
    .slice(0, 4);
  const payload = withRefs.map(e => {
    const imgs = e.reference_image_urls.filter(isImg);
    // fal requires BOTH frontal_image_url AND a non-empty reference_image_urls
    // per element — with a single photo, it serves as both.
    return {
      frontal_image_url: imgs[0],
      reference_image_urls: imgs.length > 1 ? imgs.slice(1, 4) : [imgs[0]],
    };
  });
  const tags = withRefs.map((e, i) => `@Element${i + 1} (${e.name})`).join(', ');
  return { payload, tags };
}

async function runStoryVideoJob(story, { tier, generateAudio, startFrame }) {
  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  let genLog = { id: null };
  try {
    // Refresh element data — photos are often added after the story was made.
    if (Array.isArray(story.element_ids) && story.element_ids.length) {
      try {
        const { rows: freshEls } = await pool.query(
          `SELECT * FROM story_elements WHERE id = ANY($1::int[])`, [story.element_ids]);
        if (freshEls.length) story = { ...story, elements_snapshot: freshEls };
      } catch { /* snapshot stays */ }
    }
    // Start frame: element photo anchors frame 1 = visual consistency across
    // videos. 'off' skips it; any preparation failure falls back to pure t2v.
    let startImageUrl = null;
    let startCostUsd = 0;
    let startMethod = null;
    // Reviewed/approved frame on the story wins; otherwise auto-compose.
    if (story.start_frame_url) {
      startImageUrl = story.start_frame_url;
      startMethod = 'approved';
    } else if (startFrame !== 'off') {
      try {
        const sf = await prepareStoryStartFrame(story);
        if (sf) { startImageUrl = sf.url; startCostUsd = sf.costUsd || 0; startMethod = sf.method; }
      } catch (err) {
        console.warn('[video-story] start-frame prep failed, using text-to-video:', err.message);
      }
    }
    const endImageUrl = startImageUrl ? (story.end_frame_url || null) : null;
    // Elements mode: subjects placed INTO the scene for the whole video.
    // Prompts get the @ElementN mapping appended so Kling knows who is who.
    let useScenes = scenes;
    let elementsPayload = null;
    if (startFrame === 'elements' && startImageUrl) {
      const built = buildStoryElementsPayload(story.elements_snapshot);
      if (built.payload.length) {
        elementsPayload = built.payload;
        useScenes = scenes.map(s => ({
          ...s,
          video_prompt: s.video_prompt +
            ` — featuring ${built.tags}, exactly as they look in the reference images.`,
        }));
      }
    }
    const tierDef = storyEngine.VIDEO_MODELS[tier] || storyEngine.VIDEO_MODELS.standard;
    const modelId = startImageUrl ? tierDef.i2v.id : tierDef.id;
    genLog = await generation.logGenerationStart({
      modelId,
      inputPayload: {
        story_id: story.id, tier, generate_audio: generateAudio,
        start_image_url: startImageUrl, start_frame_method: startMethod,
        end_image_url: endImageUrl,
        elements_count: elementsPayload ? elementsPayload.length : 0,
      },
      sourceType: 'video_story',
    });
    const out = await storyEngine.generateStoryVideo({
      scenes: useScenes, tier, generateAudio, startImageUrl, endImageUrl, elements: elementsPayload,
    });
    out.estCostUsd = (out.estCostUsd || 0) + startCostUsd;
    // fal output URLs can expire — copy to R2 immediately (same pattern as orders).
    let finalUrl = out.url;
    try {
      const stored = await downloadAndStore({ remoteUrl: out.url, kind: 'video-story' });
      if (stored?.url) finalUrl = stored.url;
    } catch (err) {
      console.warn('[video-story] R2 copy failed, keeping fal URL:', err.message);
    }
    await pool.query(`
      UPDATE video_stories SET
        video_status = 'done', video_url = $2, video_fal_url = $3, video_model = $4,
        video_duration_s = $5, video_cost_usd = $6, video_completed_at = NOW(),
        generation_id = $7, updated_at = NOW()
      WHERE id = $1`,
      [story.id, finalUrl, out.url, out.modelId, out.totalS, out.estCostUsd, genLog.id]);
    await generation.logGenerationFinish(genLog.id, {
      outputUrl: finalUrl, falOutputUrl: out.url, costUsd: out.estCostUsd,
    });
  } catch (err) {
    console.error('[video-story] generation failed for story', story.id, ':', err.message);
    await pool.query(`
      UPDATE video_stories SET video_status = 'error', video_error = $2, updated_at = NOW()
      WHERE id = $1`,
      [story.id, String(err.message || '').slice(0, 2000)]).catch(() => {});
    await generation.logGenerationFailure(genLog.id, err.message);
  }
}

// ── Assembly: part-1 clip + CTA end-card -> final publishable video ─────────
// ffmpeg: normalize both parts to 1080x1920/30fps/aac, burn the hook text on
// part 1 and the CTA text on the end-card, concat, upload to R2.
// End-card can be a video OR a still image (image is looped for its duration).

async function runStoryAssemblyJob(story, ctaCard) {
  const os = require('os');
  const fs2 = require('fs');
  const pathM = require('path');
  const { execFile } = require('child_process');
  const tmpDir = fs2.mkdtempSync(pathM.join(os.tmpdir(), 'tns-story-'));
  const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

  const ff = (args, timeoutMs = 300000) => new Promise((resolve, reject) => {
    const bin = process.env.FFMPEG_PATH || '/tmp/ffmpeg';
    execFile(bin, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').split('\n').slice(-6).join(' ').slice(0, 500)));
      else resolve();
    });
  });

  const dlFile = async (url, dest) => {
    const buf = await new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? require('https') : require('http');
      const chunks = [];
      lib.get(url, r => {
        if (r.statusCode >= 300 && r.headers.location) {
          return dlFile(r.headers.location, dest).then(() => resolve(null)).catch(reject);
        }
        r.on('data', c => chunks.push(c));
        r.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
    if (buf) fs2.writeFileSync(dest, buf);
  };

  const wrapText = (txt, max) => {
    const words = String(txt).split(' '), lines = [];
    let line = '';
    for (const w of words) {
      if (line && (line + ' ' + w).length > max) { lines.push(line); line = w; }
      else { line = line ? line + ' ' + w : w; }
    }
    if (line) lines.push(line);
    return lines.join('\n');
  };

  // drawtext via textfile (expansion=none) — sidesteps quote/colon escaping.
  const textFilter = (text, file, { size, y }) => {
    fs2.writeFileSync(file, wrapText(text, 20));
    return `,drawtext=fontfile=${FONT}:textfile=${file}:expansion=none:fontsize=${size}` +
      `:fontcolor=white:x=(w-text_w)/2:y=${y}:shadowcolor=black@0.85:shadowx=3:shadowy=3` +
      `:line_spacing=10`;
  };

  const SCALE = 'scale=1080:1920:force_original_aspect_ratio=decrease,' +
    'pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1';
  const VCODEC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];
  const ACODEC = ['-c:a', 'aac', '-ar', '44100', '-ac', '2'];

  // Normalize a video part; retries with a silent audio track if the input has none.
  async function normalizeVideo(inFile, outFile, extraVf) {
    const vf = SCALE + (extraVf || '');
    try {
      await ff(['-y', '-i', inFile, '-vf', vf, '-map', '0:v:0', '-map', '0:a:0',
        ...VCODEC, ...ACODEC, outFile]);
    } catch {
      await ff(['-y', '-i', inFile, '-f', 'lavfi',
        '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100', '-shortest',
        '-vf', vf, '-map', '0:v:0', '-map', '1:a:0', ...VCODEC, ...ACODEC, outFile]);
    }
  }

  try {
    // 1. Part 1
    const part1Raw = pathM.join(tmpDir, 'part1_raw.mp4');
    const part1 = pathM.join(tmpDir, 'part1.mp4');
    await dlFile(story.video_url, part1Raw);
    const hookVf = story.hook_text
      ? textFilter(story.hook_text, pathM.join(tmpDir, 'hook.txt'), { size: 68, y: 150 })
      : '';
    await normalizeVideo(part1Raw, part1, hookVf);

    // 2. End-card (video, or still image looped for duration_s)
    const part2 = pathM.join(tmpDir, 'part2.mp4');
    const ctaVf = ctaCard.cta_text
      ? textFilter(ctaCard.cta_text, pathM.join(tmpDir, 'cta.txt'), { size: 60, y: 'h-h/3' })
      : '';
    const cardDur = Math.min(Math.max(parseFloat(ctaCard.duration_s) || 4, 2), 8);
    // Forgiving input: a picture URL pasted in the video field is treated as a picture.
    const looksLikeImage = (u) => /\.(jpe?g|png|webp|gif)(\?|#|$)/i.test(String(u || ''));
    let cardVideoUrl = ctaCard.video_url || null;
    let cardImageUrl = ctaCard.image_url || null;
    if (cardVideoUrl && looksLikeImage(cardVideoUrl)) {
      cardImageUrl = cardImageUrl || cardVideoUrl;
      cardVideoUrl = null;
    }
    if (cardVideoUrl) {
      const p2raw = pathM.join(tmpDir, 'part2_raw.mp4');
      await dlFile(cardVideoUrl, p2raw);
      await normalizeVideo(p2raw, part2, ctaVf);
    } else {
      const img = pathM.join(tmpDir, 'endcard_img');
      await dlFile(cardImageUrl, img);
      await ff(['-y', '-loop', '1', '-t', String(cardDur), '-i', img,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100', '-shortest',
        '-vf', SCALE + ctaVf, '-map', '0:v:0', '-map', '1:a:0', ...VCODEC, ...ACODEC, part2]);
    }

    // 3. Concat (identical codecs/params -> stream copy)
    const listFile = pathM.join(tmpDir, 'list.txt');
    fs2.writeFileSync(listFile, `file '${part1}'\nfile '${part2}'\n`);
    const outFile = pathM.join(tmpDir, 'final.mp4');
    await ff(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outFile]);

    // 4. Upload to R2
    const { uploadBuffer } = require('./storage');
    const baseName = `story${story.id}_${(story.story_type || 'video').replace(/[^a-z0-9_-]/gi, '')}`;
    const r2 = await uploadBuffer({
      buffer: fs2.readFileSync(outFile), contentType: 'video/mp4',
      kind: 'video-story-final', baseName,
    });

    const totalDur = (story.video_duration_s || 0) + Math.round(cardDur);
    await pool.query(`
      UPDATE video_stories SET final_status = 'done', final_url = $2, final_error = NULL,
        final_duration_s = $3, final_completed_at = NOW(), updated_at = NOW()
      WHERE id = $1`, [story.id, r2.url, totalDur]);

    // Auto-write posting texts on FIRST assembly only (never overwrites
    // edited texts on re-assembly). Best effort — a text failure must not
    // fail the finished video.
    try {
      const { rows: fresh } = await pool.query(`
        SELECT vs.*, ss.text AS sit_text, cc.label AS cta_label, cc.cta_text AS cta_cta_text
        FROM video_stories vs
        LEFT JOIN story_situations ss ON ss.id = vs.situation_id
        LEFT JOIN cta_cards cc ON cc.id = vs.cta_card_id
        WHERE vs.id = $1`, [story.id]);
      const s2 = fresh[0];
      if (s2 && !s2.yt_title) {
        const base = 'https://turtleandsun.com/calendar?ref=vs' + story.id;
        const model = await getStoryLlmModel();
        const { kit, costUsd } = await storyEngine.generatePostingKit({
          story: s2,
          situationText: s2.situation_text || s2.sit_text,
          ctaCard: s2.cta_label ? { label: s2.cta_label, cta_text: s2.cta_cta_text } : null,
          links: { yt: base + '&src=yt', fb: base + '&src=fb' },
          model,
        });
        await pool.query(`
          UPDATE video_stories SET
            yt_title = $2, yt_description = $3, yt_keyword_tags = $4,
            tiktok_caption = $5, tiktok_hashtags = $6,
            instagram_caption = $7, instagram_hashtags = $8, instagram_alt_text = $9,
            fb_caption = $10, llm_cost_usd = COALESCE(llm_cost_usd, 0) + $11, updated_at = NOW()
          WHERE id = $1`,
          [story.id, kit.yt_title, kit.yt_description, kit.yt_keyword_tags,
           kit.tiktok_caption, kit.tiktok_hashtags,
           kit.instagram_caption, kit.instagram_hashtags, kit.instagram_alt_text,
           kit.fb_caption, costUsd]);
      }
    } catch (err) {
      console.warn('[story-assembly] posting texts failed (generate manually with 📝):', err.message);
    }
  } catch (err) {
    console.error('[story-assembly] failed for story', story.id, ':', err.message);
    await pool.query(`
      UPDATE video_stories SET final_status = 'error', final_error = $2, updated_at = NOW()
      WHERE id = $1`, [story.id, String(err.message || '').slice(0, 2000)]).catch(() => {});
  } finally {
    try { fs2.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

app.post('/admin/api/stories/:id(\\d+)/assemble', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM video_stories WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const story = rows[0];
    if (story.video_status !== 'done' || !story.video_url) {
      return res.status(400).json({ error: 'Make the part-1 video first (🎬) — assembly joins it with the end-card.' });
    }
    if (story.final_status === 'assembling') {
      return res.status(409).json({ error: 'Assembly already running for this story.' });
    }

    // CTA card: the story's own, else any active one (saved back onto the story).
    let ctaCard = null;
    if (story.cta_card_id) {
      const r = await pool.query(`SELECT * FROM cta_cards WHERE id = $1`, [story.cta_card_id]);
      ctaCard = r.rows[0] || null;
    }
    if (!ctaCard) {
      const r = await pool.query(`SELECT * FROM cta_cards WHERE active = TRUE ORDER BY random() LIMIT 1`);
      ctaCard = r.rows[0] || null;
      if (ctaCard) {
        await pool.query(`UPDATE video_stories SET cta_card_id = $2 WHERE id = $1`, [story.id, ctaCard.id]);
      }
    }
    if (!ctaCard) {
      return res.status(400).json({ error: 'No CTA end-card exists. Create one in the CTA end-cards tab first.' });
    }
    if (!ctaCard.video_url && !ctaCard.image_url) {
      return res.status(400).json({
        error: `CTA card "${ctaCard.label}" has no video or image URL yet. Paste one on the CTA end-cards tab (a still image works — it gets shown for ${ctaCard.duration_s || 4}s).`,
      });
    }

    // Ensure ffmpeg exists (same lazy-download as social clips).
    const fs2 = require('fs');
    const ffmpegBin = process.env.FFMPEG_PATH || '/tmp/ffmpeg';
    if (!fs2.existsSync(ffmpegBin)) {
      await new Promise((resolve) => {
        require('child_process').execFile(
          process.execPath, [path.join(__dirname, 'scripts/download-ffmpeg.js')],
          { timeout: 180000 }, () => resolve()
        );
      });
    }
    if (!fs2.existsSync(ffmpegBin)) {
      return res.status(500).json({ error: 'FFmpeg unavailable on the server — check FFMPEG_PATH.' });
    }

    await pool.query(`
      UPDATE video_stories SET final_status = 'assembling', final_error = NULL, updated_at = NOW()
      WHERE id = $1`, [story.id]);
    res.json({ ok: true, status: 'assembling' });
    runStoryAssemblyJob(story, ctaCard)
      .catch(err => console.error('[story-assembly] job crashed:', err.message));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/api/stories/:id(\\d+)/generate-video', requireRole('admin'), async (req, res) => {
  try {
    const tier = req.body?.tier === 'pro' ? 'pro' : 'standard';
    const generateAudio = req.body?.generate_audio !== false;
    const { rows } = await pool.query(`SELECT * FROM video_stories WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const story = rows[0];
    if (story.status !== 'accepted') {
      return res.status(400).json({ error: 'Accept the story first — only accepted stories get a video.' });
    }
    if (story.video_status === 'generating') {
      return res.status(409).json({ error: 'A video is already being generated for this story.' });
    }
    await pool.query(`
      UPDATE video_stories SET video_status = 'generating', video_error = NULL,
        video_started_at = NOW(), updated_at = NOW()
      WHERE id = $1`, [story.id]);
    res.json({ ok: true, status: 'generating' });
    const startFrame = ['off', 'auto', 'elements'].includes(req.body?.start_frame)
      ? req.body.start_frame : 'elements';
    runStoryVideoJob(story, { tier, generateAudio, startFrame })
      .catch(err => console.error('[video-story] job crashed:', err.message));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Auto-production pipeline (accept → frame → video → assembly → texts) ───
// Persisted defaults (system_settings, keys vs_*) — set once in the toolbar.

const VS_DEFAULTS = {
  vs_tier: 'standard',       // kling tier for auto runs
  vs_audio: 'on',            // native audio
  vs_consistency: 'elements',// elements | auto | off (start-frame mode)
  vs_auto: 'off',            // accept starts production (opt-in)
  vs_pause_frame: 'yes',     // pause after frame for approval
  story_llm_model: 'google/gemini-2.5-flash', // the writer (openrouter/router model id)
};

async function getVideoSettings() {
  try {
    const { rows } = await pool.query(`SELECT key, value FROM system_settings WHERE key LIKE 'vs_%'`);
    const s = { ...VS_DEFAULTS };
    for (const r of rows) if (r.key in VS_DEFAULTS && r.value) s[r.key] = r.value;
    return s;
  } catch { return { ...VS_DEFAULTS }; }
}

app.get('/admin/api/video-settings', requireRole('admin'), async (req, res) => {
  res.json({ settings: await getVideoSettings() });
});

app.post('/admin/api/video-settings', requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    for (const key of Object.keys(VS_DEFAULTS)) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        await pool.query(`
          INSERT INTO system_settings (key, value) VALUES ($1, $2)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [key, String(body[key])]);
      }
    }
    res.json({ ok: true, settings: await getVideoSettings() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CTA resolution + ffmpeg check + assembly, awaited (pipeline variant of the
// /assemble endpoint — same rules, no HTTP response).
async function assembleForPipeline(story) {
  let ctaCard = null;
  if (story.cta_card_id) {
    const r = await pool.query(`SELECT * FROM cta_cards WHERE id = $1`, [story.cta_card_id]);
    ctaCard = r.rows[0] || null;
  }
  if (!ctaCard) {
    const r = await pool.query(`SELECT * FROM cta_cards WHERE active = TRUE ORDER BY random() LIMIT 1`);
    ctaCard = r.rows[0] || null;
    if (ctaCard) await pool.query(`UPDATE video_stories SET cta_card_id = $2 WHERE id = $1`, [story.id, ctaCard.id]);
  }
  if (!ctaCard) throw new Error('No CTA end-card exists — create one in the CTA end-cards tab.');
  if (!ctaCard.video_url && !ctaCard.image_url) {
    throw new Error(`CTA card "${ctaCard.label}" has no media yet — drop a video or picture on it.`);
  }
  const fs2 = require('fs');
  const ffmpegBin = process.env.FFMPEG_PATH || '/tmp/ffmpeg';
  if (!fs2.existsSync(ffmpegBin)) {
    await new Promise((resolve) => {
      require('child_process').execFile(
        process.execPath, [path.join(__dirname, 'scripts/download-ffmpeg.js')],
        { timeout: 180000 }, () => resolve());
    });
  }
  if (!fs2.existsSync(ffmpegBin)) throw new Error('FFmpeg unavailable on the server.');
  await pool.query(`
    UPDATE video_stories SET final_status = 'assembling', final_error = NULL, updated_at = NOW()
    WHERE id = $1`, [story.id]);
  await runStoryAssemblyJob(story, ctaCard);
}

// The chain itself. Skips finished stages, so it doubles as "resume".
async function runStoryPipeline(storyId) {
  const setPS = (ps) => pool.query(
    `UPDATE video_stories SET pipeline_status = $2, updated_at = NOW() WHERE id = $1`,
    [storyId, ps]).catch(() => {});
  const get = async () => (await pool.query(`SELECT * FROM video_stories WHERE id = $1`, [storyId])).rows[0];
  try {
    let story = await get();
    if (!story || story.status !== 'accepted') return;
    const settings = await getVideoSettings();
    await setPS('running');

    // 1. Start frame (composed; failure is non-fatal — video step falls back).
    if (!story.start_frame_url && settings.vs_consistency !== 'off') {
      try {
        await generateFrameForStory(storyId, 'start', null);
        story = await get();
        if (settings.vs_pause_frame === 'yes' && story.start_frame_url) {
          await setPS('paused_frame');
          return;
        }
      } catch (err) {
        console.warn('[pipeline] frame step failed (continuing):', err.message);
      }
    }

    // 2. Part-1 video.
    story = await get();
    if (story.video_status !== 'done') {
      if (story.generator === 'kling') {
        await pool.query(`
          UPDATE video_stories SET video_status = 'generating', video_error = NULL,
            video_started_at = NOW(), updated_at = NOW() WHERE id = $1`, [storyId]);
        await runStoryVideoJob(story, {
          tier: settings.vs_tier,
          generateAudio: settings.vs_audio !== 'off',
          startFrame: settings.vs_consistency,
        });
        story = await get();
        if (story.video_status !== 'done') { await setPS('error'); return; }
      } else {
        // Flow/Gemini: the human generates the clip — park here. The clip
        // upload endpoint resumes the pipeline automatically.
        await setPS('waiting_clip');
        return;
      }
    }

    // 3. Assembly (+ posting texts, written inside the assembly job).
    story = await get();
    if (story.final_status !== 'done') {
      await assembleForPipeline(story);
      story = await get();
      if (story.final_status !== 'done') { await setPS('error'); return; }
    }
    await setPS('done');
  } catch (err) {
    console.error('[pipeline] story', storyId, ':', err.message);
    await pool.query(`
      UPDATE video_stories SET pipeline_status = 'error', final_error = COALESCE(final_error, $2),
        updated_at = NOW() WHERE id = $1`, [storyId, String(err.message || '').slice(0, 2000)]).catch(() => {});
  }
}

// Resume/retry from any parked or failed state (skips what's already done).
app.post('/admin/api/stories/:id(\\d+)/resume-pipeline', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, status FROM video_stories WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].status !== 'accepted') return res.status(400).json({ error: 'Only accepted stories can be produced.' });
    res.json({ ok: true });
    runStoryPipeline(req.params.id).catch(e => console.error('[pipeline] crashed:', e.message));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Tracker integration (spec component 9) ──────────────────────────────────
// A finished story becomes a social_clips row -> the existing Produce/Tracker
// pages, publish buttons, stats crons and ?ref= click attribution all apply.
// ref_tag 'vs<id>' ties platform stats, link clicks and email signups to the
// story's internal tags. One system, no side spreadsheets.

app.post('/admin/api/stories/:id(\\d+)/create-clip', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT vs.*, ss.occasion AS situation_occasion, cc.offer_key AS cta_offer_key
      FROM video_stories vs
      LEFT JOIN story_situations ss ON ss.id = vs.situation_id
      LEFT JOIN cta_cards cc ON cc.id = vs.cta_card_id
      WHERE vs.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const s = rows[0];
    if (s.social_clip_id) {
      return res.json({ ok: true, social_clip_id: s.social_clip_id, existing: true });
    }
    if (s.final_status !== 'done' || !s.final_url) {
      return res.status(400).json({ error: 'Assemble the final video first — the tracker records the publishable video.' });
    }
    const elements = Array.isArray(s.elements_snapshot) ? s.elements_snapshot : [];
    const tags = [
      s.story_type ? 'type:' + s.story_type : null,
      s.cta_offer_key ? 'cta:' + s.cta_offer_key : null,
      'gen:' + s.generator,
      ...elements.map(e => 'el:' + e.name),
    ].filter(Boolean);
    const petEl = elements.find(e => e.kind === 'pet');
    const { rows: clipRows } = await pool.query(`
      INSERT INTO social_clips (
        concept_name, output_url, status, ref_tag,
        subject, subject_name, occasion, mood, action, style,
        custom_tags, video_overlay_text, notes, end_card_enabled,
        yt_title, yt_description, yt_keyword_tags,
        tiktok_caption, tiktok_hashtags,
        instagram_caption, instagram_hashtags, instagram_alt_text, fb_caption
      ) VALUES ($1, $2, 'done', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, FALSE,
        $13, $14, $15, $16, $17, $18, $19, $20, $21)
      RETURNING id, ref_tag`,
      [
        'Story #' + s.id + ' — ' + String(s.hook_text || '').slice(0, 60),
        s.final_url,
        'vs' + s.id,
        'pet',
        petEl ? petEl.name : null,
        s.situation_occasion || 'general',
        s.mood || null,
        s.story_type || 'story',
        'video-engine',
        tags,
        s.hook_text || null,
        'Video Engine story #' + s.id + ' (hook + end-card already burned in)',
        s.yt_title || null, s.yt_description || null, s.yt_keyword_tags || null,
        s.tiktok_caption || null, s.tiktok_hashtags || null,
        s.instagram_caption || null, s.instagram_hashtags || null,
        s.instagram_alt_text || null, s.fb_caption || null,
      ]);
    await pool.query(`UPDATE video_stories SET social_clip_id = $2, updated_at = NOW() WHERE id = $1`,
      [s.id, clipRows[0].id]);
    res.json({ ok: true, social_clip_id: clipRows[0].id, ref_tag: clipRows[0].ref_tag });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Posting kit (spec component 8): LLM-written per-platform texts, saved onto
// the story's social_clips row so the existing upload dialogs prefill them.
app.post('/admin/api/stories/:id(\\d+)/posting-kit', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT vs.*, ss.text AS sit_text, cc.label AS cta_label, cc.cta_text AS cta_cta_text
      FROM video_stories vs
      LEFT JOIN story_situations ss ON ss.id = vs.situation_id
      LEFT JOIN cta_cards cc ON cc.id = vs.cta_card_id
      WHERE vs.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const s = rows[0];
    // ref_tag is deterministic ('vs<id>'), so texts can be written before the
    // story is in the tracker — the link will be correct either way.
    const base = 'https://turtleandsun.com/calendar?ref=vs' + s.id;
    const links = { yt: base + '&src=yt', fb: base + '&src=fb' };
    const model = await getStoryLlmModel();
    const { kit, costUsd } = await storyEngine.generatePostingKit({
      story: s,
      situationText: s.situation_text || s.sit_text,
      ctaCard: s.cta_label ? { label: s.cta_label, cta_text: s.cta_cta_text } : null,
      links, model,
    });
    await pool.query(`
      UPDATE video_stories SET
        yt_title = $2, yt_description = $3, yt_keyword_tags = $4,
        tiktok_caption = $5, tiktok_hashtags = $6,
        instagram_caption = $7, instagram_hashtags = $8, instagram_alt_text = $9,
        fb_caption = $10, llm_cost_usd = COALESCE(llm_cost_usd, 0) + $11, updated_at = NOW()
      WHERE id = $1`,
      [s.id, kit.yt_title, kit.yt_description, kit.yt_keyword_tags,
       kit.tiktok_caption, kit.tiktok_hashtags,
       kit.instagram_caption, kit.instagram_hashtags, kit.instagram_alt_text,
       kit.fb_caption, costUsd]);
    if (s.social_clip_id) {
      await pool.query(`
        UPDATE social_clips SET
          yt_title = $2, yt_description = $3, yt_keyword_tags = $4,
          tiktok_caption = $5, tiktok_hashtags = $6,
          instagram_caption = $7, instagram_hashtags = $8, instagram_alt_text = $9,
          fb_caption = $10, updated_at = NOW()
        WHERE id = $1`,
        [s.social_clip_id, kit.yt_title, kit.yt_description, kit.yt_keyword_tags,
         kit.tiktok_caption, kit.tiktok_hashtags,
         kit.instagram_caption, kit.instagram_hashtags, kit.instagram_alt_text,
         kit.fb_caption]);
    }
    res.json({ ok: true, kit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Feedback loop (spec component 10): which KIND of video sells?
// Aggregates views / link clicks / email signups per story type, CTA offer,
// and generator — only over stories that made it into the tracker.
app.get('/admin/api/stories/insights', requireRole('admin'), async (req, res) => {
  try {
    const groupings = {
      story_type: `COALESCE(vs.story_type, '(none)')`,
      cta: `COALESCE(cc.label, '(no CTA)')`,
      generator: `vs.generator`,
    };
    const out = {};
    for (const [name, expr] of Object.entries(groupings)) {
      const { rows } = await pool.query(`
        SELECT g.key, COUNT(*)::int AS videos,
               COALESCE(SUM(g.views), 0)::bigint AS views,
               COALESCE(SUM(g.clicks), 0)::int AS clicks,
               COALESCE(SUM(g.emails), 0)::int AS emails
        FROM (
          SELECT ${expr} AS key,
                 COALESCE(sc.tiktok_views,0)+COALESCE(sc.instagram_views,0)
                   +COALESCE(sc.youtube_views,0)+COALESCE(sc.facebook_views,0) AS views,
                 (SELECT COUNT(*) FROM visits v WHERE v.ref = sc.ref_tag AND ${HUMAN_CLICK_WHERE}) AS clicks,
                 (SELECT COUNT(*) FROM waitlist w WHERE w.ref = sc.ref_tag) AS emails
          FROM video_stories vs
          JOIN social_clips sc ON sc.id = vs.social_clip_id
          LEFT JOIN cta_cards cc ON cc.id = vs.cta_card_id
        ) g
        GROUP BY g.key
        ORDER BY views DESC`);
      out[name] = rows;
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Library CRUD: situations / elements / CTA cards ─────────────────────────

// Bulk idea generation: LLM writes N new situations into the library
// (active immediately — the admin edits/deletes in the grid).
app.post('/admin/api/story-situations/generate-ideas', requireRole('admin'), async (req, res) => {
  try {
    const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 10, 1), 20);
    const themeId = parseInt(req.body?.theme_id, 10) || null;
    let themes = [];
    if (themeId) {
      const r = await pool.query(`SELECT name FROM story_themes WHERE id = $1`, [themeId]);
      themes = r.rows.map(x => x.name);
    } else {
      const r = await pool.query(`SELECT name FROM story_themes WHERE active = TRUE ORDER BY id`);
      themes = r.rows.map(x => x.name);
    }
    const { rows: existing } = await pool.query(
      `SELECT text FROM story_situations ORDER BY id DESC LIMIT 60`);
    const model = await getStoryLlmModel();
    const toneText = await getStoryTone();
    const { ideas, costUsd } = await storyEngine.generateSituationIdeas({
      existing: existing.map(r => r.text), count, themes, model, toneText,
    });
    for (const idea of ideas) {
      await pool.query(
        `INSERT INTO story_situations (text, occasion, theme) VALUES ($1, $2, $3)`,
        [idea.text, idea.occasion || 'general', idea.theme || null]);
    }
    res.json({ ok: true, created: ideas.length, cost_usd: costUsd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Theme library CRUD (DB-driven — nothing hardcoded) ──────────────────────
app.get('/admin/api/story-themes', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM story_themes ORDER BY active DESC, id`);
    res.json({ themes: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/api/story-themes', requireRole('admin'), async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const { rows } = await pool.query(
      `INSERT INTO story_themes (name) VALUES ($1) RETURNING *`, [name]);
    res.json({ ok: true, theme: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/admin/api/story-themes/:id(\\d+)', requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const sets = [];
    const vals = [req.params.id];
    for (const f of ['name', 'active']) {
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        vals.push(body[f]);
        sets.push(`${f} = $${vals.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    const { rows } = await pool.query(
      `UPDATE story_themes SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, theme: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/api/story-themes/:id(\\d+)', requireRole('admin'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM story_themes WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/api/story-situations', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM story_situations ORDER BY active DESC, id DESC`);
    res.json({ situations: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/api/story-situations', requireRole('admin'), async (req, res) => {
  try {
    const { text, occasion, theme } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });
    const { rows } = await pool.query(
      `INSERT INTO story_situations (text, occasion, theme) VALUES ($1, $2, $3) RETURNING *`,
      [text, occasion || null, theme || null]);
    res.json({ ok: true, situation: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/admin/api/story-situations/:id(\\d+)', requireRole('admin'), async (req, res) => {
  try {
    // Presence-based update: only keys in the body change; null clears.
    const body = req.body || {};
    const sets = [];
    const vals = [req.params.id];
    for (const f of ['text', 'occasion', 'theme', 'active']) {
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        vals.push(body[f]);
        sets.push(`${f} = $${vals.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    const { rows } = await pool.query(
      `UPDATE story_situations SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, situation: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/api/story-situations/:id(\\d+)', requireRole('admin'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM story_situations WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/api/story-elements', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM story_elements ORDER BY active DESC, sort_order, id`);
    res.json({ elements: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/api/story-elements', requireRole('admin'), async (req, res) => {
  try {
    const { name, kind, description, personality, reference_image_urls } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const { rows } = await pool.query(`
      INSERT INTO story_elements (name, kind, description, personality, reference_image_urls)
      VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, kind || 'pet', description || null, personality || null,
       Array.isArray(reference_image_urls) ? reference_image_urls : []]);
    res.json({ ok: true, element: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/admin/api/story-elements/:id(\\d+)', requireRole('admin'), async (req, res) => {
  try {
    // Presence-based: only keys in the body change; arrays replace wholesale.
    const body = req.body || {};
    const sets = [];
    const vals = [req.params.id];
    for (const f of ['name', 'kind', 'description', 'personality', 'reference_image_urls', 'active']) {
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        vals.push(f === 'reference_image_urls'
          ? (Array.isArray(body[f]) ? body[f] : [])
          : body[f]);
        sets.push(`${f} = $${vals.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    const { rows } = await pool.query(
      `UPDATE story_elements SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, element: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Drag-and-drop upload of a reference image/video for an element -> R2.
app.post('/admin/api/story-elements/upload', requireRole('admin'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const mt = req.file.mimetype || '';
    if (!mt.startsWith('image/') && !mt.startsWith('video/')) {
      return res.status(400).json({ error: `Only image or video files are accepted (got ${mt || 'unknown'})` });
    }
    if (req.file.size > 300 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 300 MB)' });
    }
    const { uploadBuffer } = require('./storage');
    const baseName = 'element_' + String(req.file.originalname || 'ref')
      .replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
    const r2 = await uploadBuffer({ buffer: req.file.buffer, contentType: mt, kind: 'element-ref', baseName });
    res.json({ ok: true, url: r2.url, media_type: mt.startsWith('video/') ? 'video' : 'image' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/api/story-elements/:id(\\d+)', requireRole('admin'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM story_elements WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Drag-and-drop upload for CTA end-card media (image or video) -> R2.
// Returns the permanent URL + detected media type so the grid can slot it
// into image_url or video_url automatically.
app.post('/admin/api/cta-cards/upload', requireRole('admin'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const mt = req.file.mimetype || '';
    const isVideo = mt.startsWith('video/');
    const isImage = mt.startsWith('image/');
    if (!isVideo && !isImage) {
      return res.status(400).json({ error: `Only image or video files are accepted (got ${mt || 'unknown type'})` });
    }
    if (req.file.size > 300 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 300 MB)' });
    }
    const { uploadBuffer } = require('./storage');
    const baseName = 'ctacard_' + String(req.file.originalname || 'media')
      .replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
    const r2 = await uploadBuffer({ buffer: req.file.buffer, contentType: mt, kind: 'cta-card', baseName });
    res.json({ ok: true, url: r2.url, media_type: isVideo ? 'video' : 'image' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/api/cta-cards', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM cta_cards ORDER BY active DESC, id DESC`);
    res.json({ cards: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/api/cta-cards', requireRole('admin'), async (req, res) => {
  try {
    const { offer_key, label, cta_text, video_url, image_url, duration_s, notes } = req.body || {};
    if (!offer_key || !label) return res.status(400).json({ error: 'offer_key and label required' });
    const { rows } = await pool.query(`
      INSERT INTO cta_cards (offer_key, label, cta_text, video_url, image_url, duration_s, notes)
      VALUES ($1, $2, $3, $4, $5, COALESCE($6, 4), $7) RETURNING *`,
      [offer_key, label, cta_text || null, video_url || null, image_url || null,
       duration_s || null, notes || null]);
    res.json({ ok: true, card: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/admin/api/cta-cards/:id(\\d+)', requireRole('admin'), async (req, res) => {
  try {
    // Updates exactly the fields present in the body — sending null CLEARS a
    // field (needed when the grid swaps an image end-card for a video one).
    const body = req.body || {};
    const allowed = ['offer_key', 'label', 'cta_text', 'video_url', 'image_url', 'duration_s', 'notes', 'active'];
    const sets = [];
    const vals = [req.params.id];
    for (const f of allowed) {
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        vals.push(body[f]);
        sets.push(`${f} = $${vals.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    const { rows } = await pool.query(
      `UPDATE cta_cards SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, card: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/api/cta-cards/:id(\\d+)', requireRole('admin'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM cta_cards WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

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

cron.schedule('0 6 * * *', () => sendDailyDigest().catch((err) => console.error('[digest] cron error:', err.message)), { timezone: 'UTC' });

cron.schedule('0 7 * * *', async () => {
  if (!process.env.YOUTUBE_API_KEY) return;
  try {
    const result = await fetchYouTubeStatsBatch();
    console.log('[yt-stats-cron] updated', result.updated, 'clips');
  } catch (err) {
    console.error('[yt-stats-cron]', err.message);
  }
}, { timezone: 'UTC' });

cron.schedule('0 8 * * *', async () => {
  try {
    await getInstagramToken(); // throws if not connected
    const result = await fetchInstagramStatsBatch();
    console.log('[ig-stats-cron] updated', result.updated, 'clips');
  } catch (err) {
    console.error('[ig-stats-cron]', err.message);
  }
}, { timezone: 'UTC' });

cron.schedule('0 9 * * *', async () => {
  try {
    await fetchChannelDailyStats();
    console.log('[channel-daily-cron] snapshot saved');
  } catch (err) {
    console.error('[channel-daily-cron]', err.message);
  }
}, { timezone: 'UTC' });

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
  })
   