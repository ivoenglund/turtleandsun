// ===========================================================================
// Reviews + review-acquisition engine (2026-05-30)
// - Public review submission page + API (rating, text, photo, publish consent)
// - Admin moderation (/admin/reviews)
// - Published-reviews JSON API for the landing testimonials block
// - Single-use 50% discount-code helpers (exported for checkout + webhook)
// - Day-after "leave a review + 50% off" email cron (gated by REVIEW_EMAILS_ENABLED)
//
// Mounted from server.js:
//   const reviews = require('./reviews');
//   reviews.register(app, { requireRole, escapeHtml, conceptAdminPage });
// Schema: migrations/reviews_engine.sql
// ===========================================================================
const crypto = require('crypto');
const { pool } = require('./db');
const { Resend } = require('resend');
const multer = require('multer');
let cron = null; try { cron = require('node-cron'); } catch (e) { /* cron optional */ }
let storage = null; try { storage = require('./storage'); } catch (e) { /* photo upload optional */ }
let requireAuth = function (req,res,next){ return res.redirect('/login'); };
try { requireAuth = require('./auth').requireAuth; } catch (e) { /* auth optional */ }

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.EMAIL_FROM || 'Turtle and Sun <hello@turtleandsun.com>';
const SITE = process.env.PUBLIC_BASE_URL || 'https://turtleandsun.com';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

function rtoken(n = 24) { return crypto.randomBytes(n).toString('base64url'); }
function codeStr() { return 'TS-' + crypto.randomBytes(4).toString('hex').toUpperCase(); }

// ---- Discount-code helpers (exported; used by /create-checkout-session + webhook) ----
async function generateDiscountCode(email, orderId, opts = {}) {
  const percent = opts.percent || 50;
  const coupon = opts.coupon || process.env.STRIPE_REVIEW_COUPON || 'REVIEW50';
  const days = opts.days || 5;
  const code = codeStr();
  const expires = new Date(Date.now() + days * 86400000);
  await pool.query(
    `INSERT INTO discount_codes (code, email, order_id, percent_off, stripe_coupon, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [code, email || null, orderId || null, percent, coupon, expires]
  );
  return { code, expires };
}
async function validateDiscountCode(email, code) {
  if (!code) return { valid: false };
  const { rows } = await pool.query('SELECT * FROM discount_codes WHERE code = $1', [String(code).trim()]);
  if (!rows.length) return { valid: false, reason: 'not_found' };
  const d = rows[0];
  if (d.used) return { valid: false, reason: 'used' };
  if (d.expires_at && new Date(d.expires_at) < new Date()) return { valid: false, reason: 'expired' };
  if (d.email && email && d.email.toLowerCase() !== String(email).toLowerCase()) return { valid: false, reason: 'email_mismatch' };
  return { valid: true, coupon: d.stripe_coupon, percent_off: d.percent_off, id: d.id };
}
async function markDiscountUsed(code, orderId) {
  if (!code) return;
  await pool.query(
    'UPDATE discount_codes SET used = TRUE, used_at = NOW(), used_order_id = $2 WHERE code = $1 AND used = FALSE',
    [String(code).trim(), orderId || null]
  );
}
async function ensureReviewToken(orderId) {
  const { rows } = await pool.query('SELECT review_token FROM orders WHERE id = $1', [orderId]);
  if (rows.length && rows[0].review_token) return rows[0].review_token;
  const t = rtoken();
  await pool.query('UPDATE orders SET review_token = $2 WHERE id = $1', [orderId, t]);
  return t;
}

const PAGE_CSS = `
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'DM Sans',-apple-system,BlinkMacSystemFont,sans-serif;color:#1C0A00;background:linear-gradient(175deg,#FFF5A0 0%,#FFD000 45%,#FF9500 100%);min-height:100vh}
.wrap{max-width:560px;margin:0 auto;padding:40px 20px 80px}
h1{font-family:'Plus Jakarta Sans',sans-serif;font-size:28px;font-weight:800;margin-bottom:8px}
p.sub{color:rgba(28,10,0,0.7);margin-bottom:24px}
.card{background:rgba(255,255,255,0.7);border-radius:16px;padding:24px;backdrop-filter:blur(4px)}
label{display:block;font-family:'Plus Jakarta Sans',sans-serif;font-weight:600;font-size:14px;margin:14px 0 6px}
input[type=text],textarea,input[type=email]{width:100%;padding:11px 13px;border:1.5px solid rgba(0,0,0,0.15);border-radius:9px;font:inherit;background:#fff}
textarea{min-height:90px;resize:vertical}
.stars{display:flex;gap:6px;font-size:30px;cursor:pointer}
.stars span{filter:grayscale(1);opacity:0.5;transition:all .12s}
.stars span.on{filter:none;opacity:1}
.consent{display:flex;gap:9px;align-items:flex-start;margin-top:14px;font-size:13px;color:rgba(28,10,0,0.8)}
.consent input{margin-top:3px}
button{width:100%;margin-top:20px;padding:14px;background:#3A6B20;color:#fff;border:none;border-radius:10px;font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;font-size:15px;cursor:pointer}
button:hover{background:#1C0A00}button:disabled{opacity:.5;cursor:not-allowed}
.thanks{text-align:center;padding:20px 0}.err{color:#a12a1a;font-size:13px;margin-top:8px}
`;

function reviewPage(token, validToken) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Leave a review — Turtle and Sun</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;800&family=DM+Sans:wght@400&display=swap" rel="stylesheet">
<style>${PAGE_CSS}</style></head><body><div class="wrap">
<h1>How was your Loveogram?</h1>
<p class="sub">Your words help other families. It takes a minute — and a photo of your Loveogram makes it shine.</p>
<div class="card" id="card">
  <div id="form">
    <label>Your rating</label>
    <div class="stars" id="stars">${[1,2,3,4,5].map(i=>`<span data-v="${i}">★</span>`).join('')}</div>
    <label>Title</label><input type="text" id="title" maxlength="80" placeholder="A portrait we'll treasure">
    <label>Your review</label><textarea id="body" maxlength="1000" placeholder="Tell us what you loved…"></textarea>
    <label>Your name &amp; town (shown with the review)</label><input type="text" id="display_name" maxlength="60" placeholder="Anna, Stockholm">
    <label>Add a photo of your Loveogram (optional)</label><input type="file" id="photo" accept="image/*">
    <div class="consent"><input type="checkbox" id="consent"><label for="consent" style="margin:0;font-weight:400">I'm happy for Turtle and Sun to publish my review${''} and photo on the website and social media.</label></div>
    <div class="err" id="err"></div>
    <button id="submit"${validToken?'':' disabled'}>${validToken?'Submit review':'This link has expired'}</button>
  </div>
  <div class="thanks" id="thanks" style="display:none">
    <h1>Thank you! 💛</h1><p class="sub">Your review is in — we read every one. We'll publish it shortly.</p>
    <button onclick="location.href='/'">Back to Turtle and Sun</button>
  </div>
</div></div>
<script>
var rating=0;document.querySelectorAll('#stars span').forEach(function(s){s.addEventListener('click',function(){rating=+s.dataset.v;document.querySelectorAll('#stars span').forEach(function(x){x.classList.toggle('on',+x.dataset.v<=rating)})})});
document.getElementById('submit').addEventListener('click',async function(){
  var btn=this,err=document.getElementById('err');err.textContent='';
  if(!rating){err.textContent='Please pick a star rating.';return;}
  var fd=new FormData();
  fd.append('token','${token}');
  fd.append('rating',rating);
  fd.append('title',document.getElementById('title').value);
  fd.append('body',document.getElementById('body').value);
  fd.append('display_name',document.getElementById('display_name').value);
  fd.append('consent',document.getElementById('consent').checked?'1':'0');
  var ph=document.getElementById('photo').files[0];if(ph)fd.append('photo',ph);
  btn.disabled=true;btn.textContent='Sending…';
  try{var r=await fetch('/api/review/submit',{method:'POST',body:fd});var j=await r.json();
    if(!r.ok||!j.ok){throw new Error(j.error||'Something went wrong');}
    document.getElementById('form').style.display='none';document.getElementById('thanks').style.display='block';
  }catch(e){err.textContent=e.message;btn.disabled=false;btn.textContent='Submit review';}
});
</script></body></html>`;
}

function reviewsListPage(cards) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reviews \u2014 Turtle and Sun</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;800&family=DM+Sans:wght@400&display=swap" rel="stylesheet">
<style>${PAGE_CSS}
.wrap{max-width:1040px}
.back{display:inline-block;margin-bottom:14px;color:#3A6B20;text-decoration:none;font-weight:600}
.rvgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.rv{background:rgba(255,255,255,0.7);border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:10px;backdrop-filter:blur(4px)}
.rv img{width:100%;border-radius:10px;object-fit:cover;max-height:220px}
.rv .st{color:#3A6B20;letter-spacing:2px}
.rv blockquote{margin:0;font-size:15px;line-height:1.6;color:rgba(28,10,0,0.85)}
.rv figcaption{font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;font-size:13px;color:rgba(28,10,0,0.6);margin-top:auto}
.empty{text-align:center;color:rgba(28,10,0,0.7);grid-column:1/-1}
</style></head><body><div class="wrap">
<a class="back" href="/">\u2190 Turtle and Sun</a>
<h1>What families say</h1><p class="sub">Real Loveograms, real words.</p>
<div class="rvgrid">${cards}</div>
</div></body></html>`;
}

function register(app, deps) {
  const { requireRole, escapeHtml, conceptAdminPage } = deps;
  const esc = (s) => escapeHtml(s == null ? '' : String(s));

  // ---- PUBLIC: review submission page ----
  app.get('/review', async (req, res) => {
    const t = String(req.query.t || '').trim();
    let valid = false;
    if (t) {
      try { const { rows } = await pool.query('SELECT id FROM orders WHERE review_token = $1', [t]); valid = rows.length > 0; }
      catch (e) { valid = false; }
    }
    res.set('Content-Type', 'text/html; charset=utf-8').send(reviewPage(esc(t), valid));
  });

  // ---- PUBLIC: submit review ----
  app.post('/api/review/submit', upload.single('photo'), async (req, res) => {
    try {
      const t = String(req.body.token || '').trim();
      const { rows } = await pool.query('SELECT id, email FROM orders WHERE review_token = $1', [t]);
      if (!rows.length) return res.status(400).json({ ok: false, error: 'Invalid or expired link.' });
      const order = rows[0];
      const rating = Math.max(1, Math.min(5, parseInt(req.body.rating, 10) || 0));
      if (!rating) return res.status(400).json({ ok: false, error: 'Rating is required.' });
      const consent = req.body.consent === '1' || req.body.consent === 'true' || req.body.consent === 'on';

      let photoUrl = null;
      if (req.file && req.file.buffer && req.file.buffer.length && storage) {
        try {
          const up = await storage.uploadBuffer({ buffer: req.file.buffer, contentType: req.file.mimetype || 'image/jpeg', kind: 'review', originalName: req.file.originalname });
          photoUrl = (up && (up.url || up)) || null;
        } catch (e) { console.error('[reviews] photo upload failed:', e.message); }
      }
      await pool.query(
        `INSERT INTO reviews (order_id, email, rating, title, body, photo_url, consent_publish, display_name, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
        [order.id, order.email || null, rating,
         String(req.body.title || '').slice(0, 120) || null,
         String(req.body.body || '').slice(0, 2000) || null,
         photoUrl, consent, String(req.body.display_name || '').slice(0, 80) || null]
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('[reviews] submit error:', err.message);
      res.status(500).json({ ok: false, error: 'Could not save your review. Please try again.' });
    }
  });

  // ---- PUBLIC: published reviews for the landing testimonials block ----
  app.get('/api/reviews/published', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, display_name, rating, title, body, photo_url
           FROM reviews
          WHERE status = 'approved' AND consent_publish = TRUE
          ORDER BY moderated_at DESC NULLS LAST, created_at DESC
          LIMIT 12`);
      res.set('Cache-Control', 'public, max-age=300').json(rows);
    } catch (err) {
      console.error('[reviews] published error:', err.message);
      res.json([]);
    }
  });

  // ---- ADMIN: moderation ----
  app.get('/admin/reviews', requireRole('admin'), async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM reviews ORDER BY (status=\'pending\') DESC, created_at DESC LIMIT 300');
      let flash = '';
      if (req.query.saved) flash = '<div class="flash ok">Updated.</div>';
      const stBadge = (s) => {
        const m = { pending: ['#FAEEDA', '#854F0B'], approved: ['#EAF3DE', '#3B6D11'], rejected: ['#FCEBEB', '#a12a1a'] };
        const [bg, fg] = m[s] || ['#eee', '#555'];
        return `<span style="background:${bg};color:${fg};font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;">${s}</span>`;
      };
      const stars = (n) => '★★★★★'.slice(0, n) + '<span style="opacity:.3">' + '★★★★★'.slice(n) + '</span>';
      const row = (r) => {
        const photo = r.photo_url ? `<a href="${esc(r.photo_url)}" target="_blank"><img src="${esc(r.photo_url)}" style="width:54px;height:54px;object-fit:cover;border-radius:8px;"></a>` : '<span class="muted">—</span>';
        const actions =
          (r.status !== 'approved' ? `<form class="inline" method="POST" action="/admin/reviews/${r.id}/approve" style="display:inline"><button class="btn small" type="submit">Approve</button></form> ` : '') +
          (r.status !== 'rejected' ? `<form class="inline" method="POST" action="/admin/reviews/${r.id}/reject" style="display:inline"><button class="btn small" type="submit">Reject</button></form>` : '');
        return '<tr>' +
          `<td>${stBadge(r.status)}</td>` +
          `<td style="color:#3A6B20">${stars(r.rating || 0)}</td>` +
          `<td><strong>${esc(r.title || '')}</strong><br>${esc(r.body || '')}</td>` +
          `<td>${esc(r.display_name || '')}<br><span class="muted" style="font-size:11px">${esc(r.email || '')}</span></td>` +
          `<td>${photo}</td>` +
          `<td>${r.consent_publish ? 'yes' : '<span style="color:#a12a1a">NO</span>'}</td>` +
          `<td>${actions}</td>` +
        '</tr>';
      };
      const body = `
        <div class="top"><h1>Reviews</h1><a href="/admin">← Back to admin</a></div>
        ${flash}
        <p class="muted">Approve to publish on the landing page (only reviews with publish consent appear publicly). Pending shown first.</p>
        <table style="margin-top:12px;"><thead><tr><th>Status</th><th>Rating</th><th>Review</th><th>Who</th><th>Photo</th><th>Consent</th><th>Actions</th></tr></thead>
        <tbody>${rows.map(row).join('') || '<tr><td colspan="7" class="muted">No reviews yet.</td></tr>'}</tbody></table>`;
      res.send(conceptAdminPage('Reviews', body));
    } catch (err) {
      console.error('[admin reviews] error:', err.message);
      res.status(500).send('Failed to load reviews: ' + esc(err.message));
    }
  });
  app.post('/admin/reviews/:id/approve', requireRole('admin'), async (req, res) => {
    try { await pool.query("UPDATE reviews SET status='approved', moderated_at=NOW() WHERE id=$1", [parseInt(req.params.id, 10)]); }
    catch (e) { /* ignore */ }
    res.redirect('/admin/reviews?saved=1');
  });
  app.post('/admin/reviews/:id/reject', requireRole('admin'), async (req, res) => {
    try { await pool.query("UPDATE reviews SET status='rejected', moderated_at=NOW() WHERE id=$1", [parseInt(req.params.id, 10)]); }
    catch (e) { /* ignore */ }
    res.redirect('/admin/reviews?saved=1');
  });

  // ---- PUBLIC: reviews listing page ----
  app.get('/reviews', async (req, res) => {
    let cards = '';
    try {
      const { rows } = await pool.query(
        `SELECT display_name, rating, title, body, photo_url FROM reviews
          WHERE status='approved' AND consent_publish=TRUE
          ORDER BY moderated_at DESC NULLS LAST, created_at DESC LIMIT 60`);
      cards = rows.map(function(r){
        var stars='\u2605\u2605\u2605\u2605\u2605'.slice(0,(r.rating||5));
        var photo = r.photo_url ? ('<img src="'+esc(r.photo_url)+'" alt="">') : '';
        var head = r.title ? ('<strong>'+esc(r.title)+'</strong> ') : '';
        return '<figure class="rv">'+photo+'<div class="st">'+stars+'</div><blockquote>'+head+esc(r.body||'')+'</blockquote><figcaption>'+esc(r.display_name||'A happy customer')+'</figcaption></figure>';
      }).join('') || '<p class="empty">No reviews yet \u2014 be the first to make a Loveogram.</p>';
    } catch (e) { cards = '<p class="empty">Reviews are taking a break. Check back soon.</p>'; }
    res.set('Content-Type','text/html; charset=utf-8').send(reviewsListPage(cards));
  });

  // ---- CUSTOMER: leave a review from the account (auto-resolves latest paid order) ----
  app.get('/account/review', requireAuth, async (req, res) => {
    try {
      const email = req.user && req.user.email;
      const { rows } = await pool.query(
        "SELECT id FROM orders WHERE email=$1 AND status='paid' ORDER BY created_at DESC LIMIT 1", [email]);
      if (!rows.length) return res.set('Content-Type','text/html; charset=utf-8').send(reviewPage('', false));
      const token = await ensureReviewToken(rows[0].id);
      res.redirect('/review?t=' + encodeURIComponent(token));
    } catch (e) { res.redirect('/review'); }
  });

  // ---- Day-after review-request email (gated by REVIEW_EMAILS_ENABLED=true) ----
  async function sendReviewRequests() {
    if (process.env.REVIEW_EMAILS_ENABLED !== 'true') return;
    const { rows } = await pool.query(
      `SELECT id, email FROM orders
        WHERE status = 'paid' AND email IS NOT NULL AND email <> ''
          AND review_email_sent_at IS NULL
          AND created_at <= NOW() - INTERVAL '20 hours'
          AND created_at >= NOW() - INTERVAL '7 days'
        ORDER BY id LIMIT 50`);
    for (const o of rows) {
      try {
        const token = await ensureReviewToken(o.id);
        const { code, expires } = await generateDiscountCode(o.email, o.id, { percent: 50, days: 5 });
        const reviewUrl = `${SITE}/review?t=${token}`;
        const exp = expires.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
        await resend.emails.send({
          from: FROM,
          to: o.email,
          subject: 'How’s your Loveogram? (and a thank-you gift inside)',
          html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1C0A00">
            <h2 style="font-family:Arial">We hope you love it 💛</h2>
            <p>Thank you for your Loveogram. We'd love to hear what you think — it genuinely helps other families decide.</p>
            <p style="margin:22px 0"><a href="${reviewUrl}" style="background:#3A6B20;color:#fff;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:bold">Leave a quick review</a></p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
            <p><strong>A thank-you gift:</strong> here's <strong>50% off</strong> your next Loveogram with code <strong style="font-size:18px">${code}</strong> — valid until <strong>${exp}</strong>.</p>
            <p style="margin:18px 0"><a href="${SITE}/?code=${code}" style="background:#FFE800;color:#1C0A00;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:bold">Make another (50% off) →</a></p>
            <p style="color:#888;font-size:12px;margin-top:28px">Turtle and Sun · 3doc AB · Fleminggatan 15, 112 26 Stockholm.<br>
            Don't want emails like this? Reply with "unsubscribe" and we'll stop.</p>
          </div>`,
        });
        await pool.query('UPDATE orders SET review_email_sent_at = NOW() WHERE id = $1', [o.id]);
        console.log('[reviews] review-request email sent for order', o.id);
      } catch (err) {
        console.error('[reviews] review-request send failed for order', o.id, err.message);
      }
    }
  }
  if (cron) {
    // Daily at 09:00 UTC. No-op unless REVIEW_EMAILS_ENABLED=true.
    cron.schedule('0 9 * * *', () => sendReviewRequests().catch((e) => console.error('[reviews] cron error:', e.message)), { timezone: 'UTC' });
  }
}

module.exports = { register, generateDiscountCode, validateDiscountCode, markDiscountUsed, ensureReviewToken };
