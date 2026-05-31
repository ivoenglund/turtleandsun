// ===========================================================================
// Unified lifecycle email engine (2026-05-31)
//   - Editable templates with {{variable}} merge tags
//   - Event-triggered sequences (e.g. first_purchase) + manual enroll
//   - Per-customer enrollments walked by a cron worker (processDue)
//   - One suppression-checked sender with one-click List-Unsubscribe (RFC 8058)
//   - Resend delivery webhook -> email_events (+ auto-suppress on bounce/complaint)
//   - Admin CRUD at /admin/email
//
// Mounted from server.js:
//   const emailEngine = require('./email_engine');
//   emailEngine.register(app, { requireRole, escapeHtml, conceptAdminPage });
//   // in initDb().then(): await emailEngine.ensureSeeds();
//   // on first purchase: emailEngine.onEvent('first_purchase', { email, userId, context });
//
// Master switch: EMAIL_ENGINE_ENABLED must be 'true' for any mail to actually
// send. While off, enrollments still accrue and become due — nothing is sent
// until you flip it (after SPF/DKIM/DMARC verify). Schema: migrations/email_engine.sql
// ===========================================================================
const crypto = require('crypto');
const { pool } = require('./db');
const { Resend } = require('resend');
let cron = null; try { cron = require('node-cron'); } catch (e) { /* cron optional */ }

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.EMAIL_FROM || 'Turtle and Sun <hello@turtleandsun.com>';
const SITE = process.env.PUBLIC_BASE_URL || 'https://turtleandsun.com';
const UNSUB_SECRET = process.env.EMAIL_UNSUB_SECRET || process.env.STRIPE_WEBHOOK_SECRET || 'ts-unsub-fallback-secret';
const UNSUB_MAILBOX = process.env.EMAIL_UNSUB_MAILBOX || 'hello@turtleandsun.com';
const AI_PROMPT = `You are helping me edit an email for Turtle & Sun (turtleandsun.com) — we turn family photos into personalised "Loveogram" art and video gifts. Below (after the marker) is the current email as an HTML body.

How to treat the merge tags: text inside double curly braces is a variable that gets replaced with a real value when the email is sent. Keep every one EXACTLY as written — do not rename, translate, remove, or add spaces inside them:
- {{customer_name}} = the recipient first name. It can be empty, so write so the sentence still reads if it is blank.
- {{site_url}} = https://turtleandsun.com
- {{unsubscribe_url}} = the one-click unsubscribe link. It must stay in the footer.
- {{code}} = a discount code (used on the review / win-back emails).
- {{review_url}} = a link to leave a review.

Rules for the HTML you return:
1. Return the COMPLETE HTML document, from <!doctype html> to </html> — only the HTML, no explanation, no markdown fences. Keep the outer shell unchanged: the cream #FBF6EC page background, a centred container (max-width:560px; margin:0 auto; padding:28px 22px), the bold dark-green (#1C2A14) \"Turtle & Sun\" heading at the top, the dark-green button with yellow (#FFE800) text, and the footer containing {{site_url}} and the {{unsubscribe_url}} link. Unless I say otherwise, only rewrite the wording between the heading and the footer.
2. Email-safe HTML only: inline CSS (no style blocks, no external stylesheets), simple structure, web-safe fonts. Assume Gmail, Apple Mail and Outlook.
3. No JavaScript.
4. Must read well in both light and dark mode — set text colours explicitly, never rely on a white background.
5. Keep the unsubscribe link in the footer.
6. Tone: warm, sincere, family-oriented. British/European English. One clear message and one call-to-action button.
7. Keep all merge tags intact (see above).

When I ask for changes ("make it shorter", "warmer", "add competitor idea X"), apply them and return the full updated HTML body again.`;

function enabled() { return String(process.env.EMAIL_ENGINE_ENABLED || '').toLowerCase() === 'true'; }
function norm(e) { return String(e || '').trim().toLowerCase(); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// ---- Unsubscribe: stateless HMAC token over the (lower-cased) email ----
function unsubToken(email) {
  return crypto.createHmac('sha256', UNSUB_SECRET).update(norm(email)).digest('base64url');
}
function unsubLink(email) {
  return SITE + '/email/unsubscribe?e=' + encodeURIComponent(norm(email)) + '&t=' + unsubToken(email);
}
function verifyUnsub(email, token) {
  try {
    const a = Buffer.from(unsubToken(email));
    const b = Buffer.from(String(token || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

// ---- Suppression list ----
async function isSuppressed(email) {
  const r = await pool.query('SELECT 1 FROM email_suppression WHERE email = $1', [norm(email)]);
  return r.rowCount > 0;
}
async function suppress(email, reason) {
  await pool.query(
    "INSERT INTO email_suppression (email, reason) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING",
    [norm(email), reason || 'manual']
  );
  // Stop any in-flight sequences for this address.
  await pool.query(
    "UPDATE email_enrollments SET status = 'unsubscribed', next_send_at = NULL WHERE lower(email) = $1 AND status = 'active'",
    [norm(email)]
  );
}
async function unsuppress(email) {
  await pool.query('DELETE FROM email_suppression WHERE email = $1', [norm(email)]);
}

// ---- Templates / rendering ----
function renderStr(str, vars) {
  return String(str || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, function (m, k) {
    return (vars && vars[k] != null) ? String(vars[k]) : '';
  });
}
async function getTemplate(key) {
  const r = await pool.query('SELECT * FROM email_templates WHERE key = $1', [key]);
  return r.rows[0] || null;
}
function defaultFooter(unsub) {
  return '<hr style="border:none;border-top:1px solid #eee;margin:28px 0 14px">' +
    '<p style="font:12px/1.6 Arial,Helvetica,sans-serif;color:#999">' +
    'You are receiving this because you ordered from Turtle &amp; Sun. ' +
    '<a href="' + unsub + '" style="color:#999;text-decoration:underline">Unsubscribe</a>.</p>';
}
function htmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

async function logSend(email, opts, status, resendId, error, subject) {
  try {
    await pool.query(
      `INSERT INTO email_sends (email, template_key, sequence_id, enrollment_id, subject, status, resend_id, error, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [norm(email), opts.templateKey || null, opts.sequenceId || null, opts.enrollmentId || null,
       subject || null, status, resendId || null, error || null, status === 'sent' ? new Date() : null]
    );
  } catch (e) { console.error('[email] logSend error:', e.message); }
}

// Core sender. Every automated email goes through here.
async function sendTemplate(opts) {
  const to = norm(opts.to);
  if (!to) return { status: 'failed', error: 'no recipient' };
  const tpl = await getTemplate(opts.templateKey);
  if (!tpl || !tpl.active) {
    await logSend(to, opts, 'failed', null, 'template missing/inactive', null);
    return { status: 'failed', error: 'template' };
  }
  if (await isSuppressed(to)) {
    await logSend(to, opts, 'skipped', null, 'suppressed', renderStr(tpl.subject, opts.vars));
    return { status: 'skipped' };
  }
  const vars = Object.assign({}, opts.vars || {});
  vars.unsubscribe_url = unsubLink(to);
  vars.site_url = SITE;
  const subject = renderStr(tpl.subject, vars);
  let html = renderStr(tpl.html_body, vars);
  if (!/unsubscribe/i.test(html)) html += defaultFooter(vars.unsubscribe_url);
  const text = tpl.text_body ? renderStr(tpl.text_body, vars) : htmlToText(html);

  if (!enabled()) {
    await logSend(to, opts, 'skipped', null, 'engine disabled', subject);
    return { status: 'skipped', error: 'disabled' };
  }
  try {
    const resp = await resend.emails.send({
      from: FROM, to: to, subject: subject, html: html, text: text,
      headers: {
        'List-Unsubscribe': '<' + vars.unsubscribe_url + '>, <mailto:' + UNSUB_MAILBOX + '?subject=unsubscribe>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
      }
    });
    const rid = (resp && resp.data && resp.data.id) ? resp.data.id : ((resp && resp.id) || null);
    await logSend(to, opts, 'sent', rid, null, subject);
    return { status: 'sent', id: rid };
  } catch (err) {
    await logSend(to, opts, 'failed', null, err.message, subject);
    return { status: 'failed', error: err.message };
  }
}

// ---- Enrollment ----
async function enroll(sequenceKey, email, opts) {
  opts = opts || {};
  const seqRes = await pool.query('SELECT * FROM email_sequences WHERE key = $1 AND active = TRUE', [sequenceKey]);
  const seq = seqRes.rows[0];
  if (!seq) return null;
  const exist = await pool.query(
    "SELECT id FROM email_enrollments WHERE sequence_id = $1 AND lower(email) = $2 AND status = 'active' LIMIT 1",
    [seq.id, norm(email)]
  );
  if (exist.rowCount) return exist.rows[0].id;
  const stepRes = await pool.query(
    'SELECT delay_minutes FROM email_sequence_steps WHERE sequence_id = $1 AND active = TRUE ORDER BY step_order ASC LIMIT 1',
    [seq.id]
  );
  const firstDelay = stepRes.rows[0] ? (stepRes.rows[0].delay_minutes || 0) : 0;
  const nextAt = stepRes.rows[0] ? new Date(Date.now() + firstDelay * 60000) : null;
  try {
    const r = await pool.query(
      `INSERT INTO email_enrollments (sequence_id, email, user_id, status, current_step, next_send_at, context)
       VALUES ($1,$2,$3,'active',0,$4,$5) RETURNING id`,
      [seq.id, norm(email), opts.userId || null, nextAt, JSON.stringify(opts.context || {})]
    );
    return r.rows[0].id;
  } catch (e) {
    console.error('[email] enroll error:', e.message);
    return null;
  }
}

async function onEvent(eventName, payload) {
  payload = payload || {};
  if (!payload.email) return [];
  try {
    const seqs = await pool.query('SELECT key FROM email_sequences WHERE trigger_event = $1 AND active = TRUE', [eventName]);
    const ids = [];
    for (const row of seqs.rows) {
      const id = await enroll(row.key, payload.email, { userId: payload.userId, context: payload.context || {} });
      if (id) ids.push(id);
    }
    return ids;
  } catch (e) { console.error('[email] onEvent error:', e.message); return []; }
}

// ---- Cron worker: advance every due enrollment one step ----
async function advance(en) {
  if (await isSuppressed(en.email)) {
    await pool.query("UPDATE email_enrollments SET status='unsubscribed', next_send_at=NULL WHERE id=$1", [en.id]);
    return;
  }
  const stepNo = en.current_step + 1;
  let stepRes = await pool.query(
    'SELECT * FROM email_sequence_steps WHERE sequence_id=$1 AND active=TRUE AND step_order=$2 LIMIT 1',
    [en.sequence_id, stepNo]
  );
  let step = stepRes.rows[0];
  if (!step) {
    // step_order gap (e.g. a step was deactivated) — find the next active step.
    const nx = await pool.query(
      'SELECT * FROM email_sequence_steps WHERE sequence_id=$1 AND active=TRUE AND step_order>$2 ORDER BY step_order ASC LIMIT 1',
      [en.sequence_id, en.current_step]
    );
    step = nx.rows[0];
    if (!step) {
      await pool.query("UPDATE email_enrollments SET status='completed', next_send_at=NULL WHERE id=$1", [en.id]);
      return;
    }
  }
  const ctx = en.context || {};
  await sendTemplate({ to: en.email, templateKey: step.template_key, vars: ctx, sequenceId: en.sequence_id, enrollmentId: en.id });
  const upcoming = await pool.query(
    'SELECT delay_minutes FROM email_sequence_steps WHERE sequence_id=$1 AND active=TRUE AND step_order>$2 ORDER BY step_order ASC LIMIT 1',
    [en.sequence_id, step.step_order]
  );
  if (upcoming.rows[0]) {
    const nextAt = new Date(Date.now() + (upcoming.rows[0].delay_minutes || 0) * 60000);
    await pool.query(
      "UPDATE email_enrollments SET current_step=$2, last_sent_at=NOW(), next_send_at=$3 WHERE id=$1",
      [en.id, step.step_order, nextAt]
    );
  } else {
    await pool.query(
      "UPDATE email_enrollments SET current_step=$2, last_sent_at=NOW(), status='completed', next_send_at=NULL WHERE id=$1",
      [en.id, step.step_order]
    );
  }
}

async function processDue(limit) {
  if (!enabled()) return { processed: 0, disabled: true };
  limit = limit || 50;
  let processed = 0;
  try {
    const due = await pool.query(
      "SELECT * FROM email_enrollments WHERE status='active' AND next_send_at IS NOT NULL AND next_send_at <= NOW() ORDER BY next_send_at ASC LIMIT $1",
      [limit]
    );
    for (const en of due.rows) {
      try { await advance(en); processed++; }
      catch (e) { console.error('[email] advance error enrollment', en.id, e.message); }
    }
  } catch (e) { console.error('[email] processDue error:', e.message); }
  return { processed };
}

module.exports = {
  register, ensureSeeds, onEvent, enroll, sendTemplate, processDue,
  isSuppressed, suppress, unsuppress, unsubLink
};

// ---- Seeds: starter templates + the post-purchase sequence (idempotent) ----
async function ensureSeeds() {
  try {
    for (const t of STARTER_TEMPLATES) {
      await pool.query(
        `INSERT INTO email_templates (key, name, subject, html_body, text_body, category)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO NOTHING`,
        [t.key, t.name, t.subject, t.html, t.text || null, t.category || 'lifecycle']
      );
    }
    await pool.query(
      `INSERT INTO email_sequences (key, name, trigger_event, description)
       VALUES ('post_purchase','Post-purchase journey','first_purchase','Sent automatically after a customer''s first Loveogram.')
       ON CONFLICT (key) DO NOTHING`
    );
    const seq = (await pool.query("SELECT id FROM email_sequences WHERE key='post_purchase'")).rows[0];
    if (seq) {
      const has = await pool.query('SELECT 1 FROM email_sequence_steps WHERE sequence_id=$1 LIMIT 1', [seq.id]);
      if (has.rowCount === 0) {
        const steps = [
          [1, 'welcome_thankyou', 5],       // ~5 min after purchase
          [2, 'review_request', 2880],      // +48 h
          [3, 'make_another', 30240]        // +21 days
        ];
        for (const s of steps) {
          await pool.query(
            'INSERT INTO email_sequence_steps (sequence_id, step_order, template_key, delay_minutes) VALUES ($1,$2,$3,$4) ON CONFLICT (sequence_id, step_order) DO NOTHING',
            [seq.id, s[0], s[1], s[2]]
          );
        }
      }
    }
    console.log('[email] seeds ready');
  } catch (e) { console.error('[email] ensureSeeds error:', e.message); }
}

function wrap(title, inner) {
  return '<!doctype html><html><body style="margin:0;background:#FBF6EC;font-family:Arial,Helvetica,sans-serif;color:#1C0A00">' +
    '<div style="max-width:560px;margin:0 auto;padding:28px 22px">' +
    '<div style="font-size:22px;font-weight:800;color:#1C2A14;margin-bottom:18px">Turtle &amp; Sun</div>' +
    inner +
    '<p style="font:12px/1.6 Arial;color:#999;margin-top:26px">Turtle &amp; Sun · <a href="{{site_url}}" style="color:#999">{{site_url}}</a><br>' +
    '<a href="{{unsubscribe_url}}" style="color:#999;text-decoration:underline">Unsubscribe</a></p>' +
    '</div></body></html>';
}
const BTN = 'display:inline-block;background:#1C2A14;color:#FFE800;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px';

const STARTER_TEMPLATES = [
  {
    key: 'welcome_thankyou', name: 'Welcome / thank you', category: 'lifecycle',
    subject: 'Your Loveogram is on its way 💛',
    html: wrap('Thank you', '<p style="font-size:16px;line-height:1.6">Hi {{customer_name}},</p>' +
      '<p style="font-size:16px;line-height:1.6">Thank you for your first Loveogram — it means the world to us. We hope it brings a big smile to whoever receives it.</p>' +
      '<p style="font-size:16px;line-height:1.6">Keep an eye on your inbox: your finished piece arrives by email. If anything looks off, just reply — love it or we will remake it.</p>' +
      '<p style="margin:22px 0"><a href="{{site_url}}" style="' + BTN + '">Make another</a></p>')
  },
  {
    key: 'review_request', name: 'Review request (+ discount)', category: 'lifecycle',
    subject: 'How was your Loveogram, {{customer_name}}?',
    html: wrap('Review', '<p style="font-size:16px;line-height:1.6">Hi {{customer_name}},</p>' +
      '<p style="font-size:16px;line-height:1.6">We would love to hear how your Loveogram landed. A quick review helps other families discover us — and takes less than a minute.</p>' +
      '<p style="margin:22px 0"><a href="{{review_url}}" style="' + BTN + '">Leave a review</a></p>' +
      '<p style="font-size:15px;line-height:1.6;color:#555">As a thank you, here is <strong>50% off</strong> your next one with code <strong>{{code}}</strong>.</p>')
  },
  {
    key: 'make_another', name: 'Make another (opportunity)', category: 'lifecycle',
    subject: 'A little idea for your next Loveogram',
    html: wrap('Make another', '<p style="font-size:16px;line-height:1.6">Hi {{customer_name}},</p>' +
      '<p style="font-size:16px;line-height:1.6">Birthdays, anniversaries, a thank-you to someone special — a Loveogram turns a favourite photo into something they will keep. Who comes to mind?</p>' +
      '<p style="margin:22px 0"><a href="{{site_url}}" style="' + BTN + '">Start a new one</a></p>')
  },
  {
    key: 'seasonal_christmas', name: 'Seasonal — Christmas', category: 'occasion',
    subject: 'A heartfelt gift, ready before Christmas 🎄',
    html: wrap('Christmas', '<p style="font-size:16px;line-height:1.6">Hi {{customer_name}},</p>' +
      '<p style="font-size:16px;line-height:1.6">The most loved gifts are the personal ones. Turn a treasured family photo into a Loveogram and give something no shop can sell — in time for Christmas.</p>' +
      '<p style="margin:22px 0"><a href="{{site_url}}" style="' + BTN + '">Create a Christmas Loveogram</a></p>')
  },
  {
    key: 'birthday', name: 'Birthday', category: 'occasion',
    subject: 'Make their birthday unforgettable 🎂',
    html: wrap('Birthday', '<p style="font-size:16px;line-height:1.6">Hi {{customer_name}},</p>' +
      '<p style="font-size:16px;line-height:1.6">Someone special has a birthday coming up. A Loveogram made from a favourite photo is the kind of gift people keep on the mantelpiece for years.</p>' +
      '<p style="margin:22px 0"><a href="{{site_url}}" style="' + BTN + '">Make a birthday Loveogram</a></p>')
  }
];

// ---- Routes (admin + unsubscribe + webhook) ----
function register(app, helpers) {
  helpers = helpers || {};
  const requireRole = helpers.requireRole || function () { return function (req, res, next) { next(); }; };
  const page = helpers.conceptAdminPage || function (title, body) {
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) +
      '</title><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>body{font-family:system-ui,Arial,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#1C0A00}' +
      'table{border-collapse:collapse;width:100%}td,th{border:1px solid #e3dcc8;padding:6px 9px;font-size:13px;text-align:left}' +
      'input,textarea,select{font:inherit;padding:6px;width:100%;box-sizing:border-box}textarea{min-height:160px}' +
      '.btn{display:inline-block;background:#1C2A14;color:#FFE800;text-decoration:none;font-weight:700;padding:8px 14px;border:none;border-radius:8px;cursor:pointer}' +
      '.muted{color:#888}.card{border:1px solid #e3dcc8;border-radius:10px;padding:14px;margin:12px 0}h1,h2{color:#1C2A14}</style></head><body>' +
      body + '</body></html>';
  };

  // ---------- one-click unsubscribe ----------
  async function doUnsub(req, res) {
    const email = norm(req.query.e || (req.body && req.body.e));
    const token = req.query.t || (req.body && req.body.t);
    if (!email || !verifyUnsub(email, token)) {
      return res.status(400).send('Invalid or expired unsubscribe link.');
    }
    try { await suppress(email, 'unsubscribe'); } catch (e) { console.error('[email] unsub error:', e.message); }
    if (req.method === 'POST') return res.status(200).json({ ok: true });
    res.send(page('Unsubscribed',
      '<div style="max-width:520px;margin:60px auto;text-align:center">' +
      '<h1>You are unsubscribed</h1>' +
      '<p class="muted">' + esc(email) + ' will no longer receive marketing email from Turtle &amp; Sun. ' +
      'Order and delivery emails are not affected.</p></div>'));
  }
  app.get('/email/unsubscribe', doUnsub);
  app.post('/email/unsubscribe', doUnsub);

  // ---------- Resend delivery webhook ----------
  app.post('/webhooks/resend', async (req, res) => {
    try {
      const body = req.body || {};
      const type = body.type || '';
      const data = body.data || {};
      const email = norm(Array.isArray(data.to) ? data.to[0] : (data.to || data.email || ''));
      const rid = data.email_id || data.id || null;
      await pool.query('INSERT INTO email_events (resend_id, email, type, payload) VALUES ($1,$2,$3,$4)',
        [rid, email || null, type, body]);
      if (email && (type.indexOf('bounced') >= 0 || type.indexOf('complained') >= 0)) {
        await suppress(email, type.indexOf('complained') >= 0 ? 'complaint' : 'bounce');
      }
    } catch (e) { console.error('[email] resend webhook error:', e.message); }
    res.json({ received: true });
  });

  // ---------- admin dashboard ----------
  app.get('/admin/email', requireRole('admin'), async (req, res) => {
    try {
      const tpls = (await pool.query('SELECT key,name,category,active,updated_at FROM email_templates ORDER BY category,key')).rows;
      const seqs = (await pool.query(
        `SELECT s.id,s.key,s.name,s.trigger_event,s.active,
                (SELECT count(*) FROM email_sequence_steps st WHERE st.sequence_id=s.id) AS steps,
                (SELECT count(*) FROM email_enrollments e WHERE e.sequence_id=s.id AND e.status='active') AS active_enroll
         FROM email_sequences s ORDER BY s.key`)).rows;
      const sends = (await pool.query('SELECT email,template_key,status,subject,created_at FROM email_sends ORDER BY created_at DESC LIMIT 25')).rows;
      const supCount = (await pool.query('SELECT count(*)::int n FROM email_suppression')).rows[0].n;
      const on = enabled();
      let b = '<h1>Email engine</h1>';
      b += '<div class="card"><strong>Sending is ' + (on ? '<span style="color:#2a7">ON</span>' : '<span style="color:#c33">OFF</span>') +
        '</strong> — set <code>EMAIL_ENGINE_ENABLED=true</code> to send. Suppressed addresses: ' + supCount + '. ' +
        '<a href="/admin/email/suppression">manage</a></div>';
      b += '<h2>Templates</h2><table><tr><th>Key</th><th>Name</th><th>Category</th><th>Active</th><th></th></tr>';
      tpls.forEach(function (t) {
        b += '<tr><td>' + esc(t.key) + '</td><td>' + esc(t.name) + '</td><td>' + esc(t.category) + '</td><td>' + (t.active ? 'yes' : 'no') +
          '</td><td><a href="/admin/email/template/' + encodeURIComponent(t.key) + '">edit</a></td></tr>';
      });
      b += '</table><form method="POST" action="/admin/email/template" class="card"><strong>New template</strong>' +
        '<div style="display:flex;gap:8px;margin-top:8px"><input name="key" placeholder="key (slug)" required><input name="name" placeholder="Name" required>' +
        '<button class="btn">Create</button></div></form>';
      b += '<h2>Sequences</h2><table><tr><th>Key</th><th>Name</th><th>Trigger</th><th>Steps</th><th>Active enrol.</th><th>Active</th><th></th></tr>';
      seqs.forEach(function (s) {
        b += '<tr><td>' + esc(s.key) + '</td><td>' + esc(s.name) + '</td><td>' + esc(s.trigger_event || '—') + '</td><td>' + s.steps +
          '</td><td>' + s.active_enroll + '</td><td>' + (s.active ? 'yes' : 'no') + '</td><td><a href="/admin/email/sequence/' + s.id + '">edit</a></td></tr>';
      });
      b += '</table>';
      b += '<div class="card"><strong>Send a test</strong><form method="POST" action="/admin/email/test" style="display:flex;gap:8px;margin-top:8px">' +
        '<input name="to" placeholder="you@example.com" required><select name="template_key">' +
        tpls.map(function (t) { return '<option value="' + esc(t.key) + '">' + esc(t.key) + '</option>'; }).join('') +
        '</select><input name="customer_name" placeholder="name"><button class="btn">Send test</button></form>' +
        '<p class="muted" style="margin:6px 0 0">Test ignores the master switch so you can preview while sending is OFF.</p></div>';
      b += '<div class="card"><strong>Manually enroll someone</strong><form method="POST" action="/admin/email/enroll" style="display:flex;gap:8px;margin-top:8px">' +
        '<input name="email" placeholder="email" required><select name="sequence_key">' +
        seqs.map(function (s) { return '<option value="' + esc(s.key) + '">' + esc(s.key) + '</option>'; }).join('') +
        '</select><input name="customer_name" placeholder="name"><button class="btn">Enroll</button></form></div>';
      b += '<h2>Recent sends</h2><table><tr><th>When</th><th>To</th><th>Template</th><th>Status</th><th>Subject</th></tr>';
      sends.forEach(function (s) {
        b += '<tr><td>' + new Date(s.created_at).toISOString().slice(0, 16).replace('T', ' ') + '</td><td>' + esc(s.email) +
          '</td><td>' + esc(s.template_key || '') + '</td><td>' + esc(s.status) + '</td><td>' + esc(s.subject || '') + '</td></tr>';
      });
      b += '</table>';
      res.send(page('Email engine', b));
    } catch (e) { res.status(500).send('Email admin error: ' + esc(e.message)); }
  });

  // create template
  app.post('/admin/email/template', requireRole('admin'), async (req, res) => {
    try {
      const key = String(req.body.key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const name = String(req.body.name || key);
      if (!key) return res.redirect('/admin/email');
      await pool.query(
        `INSERT INTO email_templates (key,name,subject,html_body) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING`,
        [key, name, 'Subject here', '<p>Hi {{customer_name}},</p><p>Body here.</p>']
      );
      res.redirect('/admin/email/template/' + encodeURIComponent(key));
    } catch (e) { res.status(500).send('error: ' + esc(e.message)); }
  });

  // edit template (live preview + copy-for-AI prompt)
  app.get('/admin/email/template/:key', requireRole('admin'), async (req, res) => {
    try {
      const t = await getTemplate(req.params.key);
      if (!t) return res.redirect('/admin/email');
      const k = encodeURIComponent(t.key);
      let b = '<p><a href="/admin/email">&larr; Email engine</a></p><h1>Template: ' + esc(t.key) + '</h1>';
      b += '<form method="POST" action="/admin/email/template/' + k + '">' +
        '<p><label>Name<br><input name="name" value="' + esc(t.name) + '"></label></p>' +
        '<p><label>Subject<br><input name="subject" value="' + esc(t.subject) + '"></label></p>' +
        '<p><label>HTML body<br><textarea name="html_body" id="htmlbody">' + esc(t.html_body) + '</textarea></label></p>' +
        '<p><label>Plain-text body (optional)<br><textarea name="text_body" style="min-height:90px">' + esc(t.text_body || '') + '</textarea></label></p>' +
        '<p><label><input type="checkbox" name="active" ' + (t.active ? 'checked' : '') + ' style="width:auto"> Active</label></p>' +
        '<button class="btn">Save</button></form>' +
        '<p style="margin:14px 0"><a class="btn" href="/admin/email/template/' + k + '/design">Open visual editor (drag &amp; drop)</a></p>';
      b += `
        <h2>Live preview</h2>
        <p class="muted">Sample values are filled in so you see the real email. Updates as you edit the HTML above.</p>
        <iframe id="tplpreview" sandbox="" style="width:100%;height:520px;border:1px solid #e3dcc8;border-radius:10px;background:#fff"></iframe>
        <h2>Edit with an AI (outside this app)</h2>
        <p class="muted">Copy the prompt + HTML, paste into ChatGPT or Claude (together with any competitor emails), ask for changes, then paste the new HTML back into the box above and Save.</p>
        <div style="margin:8px 0;display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn" id="copyboth">Copy prompt + HTML</button>
          <button type="button" class="btn" id="copyhtml" style="background:#fff;color:#1C2A14;border:1px solid #1C2A14">Copy HTML only</button>
          <button type="button" class="btn" id="copyprompt" style="background:#fff;color:#1C2A14;border:1px solid #1C2A14">Copy prompt only</button>
        </div>
        <label class="muted">The prompt (editable — included by the buttons above):</label>
        <textarea id="aiprompt" style="min-height:240px">${esc(AI_PROMPT)}</textarea>
        <p class="muted">Merge tags: {{customer_name}}, {{site_url}}, {{unsubscribe_url}}, {{code}}, {{review_url}} — plus anything you pass in a sequence context. Keep them intact when editing.</p>
        <script>
        (function(){
          var ta = document.getElementById('htmlbody');
          var frame = document.getElementById('tplpreview');
          var promptEl = document.getElementById('aiprompt');
          var keys = ['customer_name','site_url','unsubscribe_url','code','review_url'];
          var sample = { customer_name:'Ivo', site_url:'https://turtleandsun.com', unsubscribe_url:'#unsubscribe', code:'TS-1A2B3C', review_url:'https://turtleandsun.com/account/review' };
          function render(){
            var html = ta.value || '';
            keys.forEach(function(key){ html = html.split('{{'+key+'}}').join(sample[key]); });
            if(!/unsubscribe/i.test(html)){ html += '<hr style="border:none;border-top:1px solid #eee;margin:24px 0 12px"><p style="font:12px Arial,sans-serif;color:#999">An unsubscribe link is added here automatically in the real email.</p>'; }
            frame.srcdoc = html;
          }
          ta.addEventListener('input', render); render();
          var NL = String.fromCharCode(10);
          function copy(text, btn){ navigator.clipboard.writeText(text).then(function(){ var o = btn.textContent; btn.textContent = 'Copied!'; setTimeout(function(){ btn.textContent = o; }, 1200); }); }
          document.getElementById('copyhtml').addEventListener('click', function(){ copy(ta.value, this); });
          document.getElementById('copyprompt').addEventListener('click', function(){ copy(promptEl.value, this); });
          document.getElementById('copyboth').addEventListener('click', function(){ copy(promptEl.value + NL + NL + '----- CURRENT EMAIL HTML -----' + NL + NL + ta.value, this); });
        })();
        </script>`;
      res.send(page('Template ' + t.key, b));
    } catch (e) { res.status(500).send('error: ' + esc(e.message)); }
  });

  app.post('/admin/email/template/:key', requireRole('admin'), async (req, res) => {
    try {
      await pool.query(
        `UPDATE email_templates SET name=$2, subject=$3, html_body=$4, text_body=$5, active=$6, updated_at=NOW() WHERE key=$1`,
        [req.params.key, String(req.body.name || ''), String(req.body.subject || ''),
         String(req.body.html_body || ''), String(req.body.text_body || '') || null, !!req.body.active]
      );
      res.redirect('/admin/email/template/' + encodeURIComponent(req.params.key));
    } catch (e) { res.status(500).send('error: ' + esc(e.message)); }
  });

  // Visual (GrapesJS) editor for a template — drag/drop, exports email-safe inline-CSS HTML.
  // Same editing engine can later be pointed at greeting-card designs (different output pipeline).
  app.get('/admin/email/template/:key/design', requireRole('admin'), async (req, res) => {
    try {
      const t = await getTemplate(req.params.key);
      if (!t) return res.redirect('/admin/email');
      const k = encodeURIComponent(t.key);
      const initial = JSON.stringify(t.html_body || '<p>Hi {{customer_name}},</p>').replace(/</g, '\\u003c');
      const body = `
        <p><a href="/admin/email/template/${k}">&larr; Back to template</a></p>
        <h1>Visual editor: ${esc(t.key)}</h1>
        <div style="display:flex;gap:8px;align-items:center;margin:8px 0 12px">
          <button class="btn" id="gjsSave">Save &amp; close</button>
          <a class="btn" style="background:#fff;color:#1C2A14;border:1px solid #1C2A14;text-decoration:none" href="/admin/email/template/${k}">Cancel</a>
          <span class="muted" id="gjsStatus"></span>
        </div>
        <p class="muted">Drag blocks from the right, click any text to edit it, use the style panel for colours and spacing. Keep the {{merge tags}} as plain text. Save exports email-safe inline-CSS HTML back to the template.</p>
        <div id="gjs"></div>
        <link rel="stylesheet" href="https://unpkg.com/grapesjs@0.21.13/dist/css/grapes.min.css">
        <script src="https://unpkg.com/grapesjs@0.21.13/dist/grapes.min.js"></script>
        <script src="https://unpkg.com/grapesjs-preset-newsletter@1.0.2"></script>
        <script>
        (function(){
          var INITIAL = ${initial};
          var presetFn = window.grapesjsPresetNewsletter || window['grapesjs-preset-newsletter'];
          var editor = grapesjs.init({
            container: '#gjs', height: '72vh', fromElement: false, storageManager: false,
            plugins: presetFn ? [presetFn] : [],
            components: INITIAL
          });
          function exportHtml(){
            try { return editor.runCommand('gjs-get-inlined-html'); }
            catch (e) { return editor.getHtml() + '<style>' + editor.getCss() + '</style>'; }
          }
          document.getElementById('gjsSave').addEventListener('click', function(){
            var html = exportHtml();
            var st = document.getElementById('gjsStatus'); st.textContent = 'Saving...';
            fetch(location.pathname, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ html: html }) })
              .then(function(r){ return r.json(); })
              .then(function(j){ if(j && j.ok){ window.location = '/admin/email/template/${k}'; } else { st.textContent = 'Save failed.'; } })
              .catch(function(){ st.textContent = 'Save failed - try again.'; });
          });
        })();
        </script>`;
      res.send(page('Visual editor ' + t.key, body));
    } catch (e) { res.status(500).send('error: ' + esc(e.message)); }
  });
  app.post('/admin/email/template/:key/design', requireRole('admin'), async (req, res) => {
    try {
      const html = String((req.body && req.body.html) || '');
      if (!html) return res.status(400).json({ ok: false, error: 'empty' });
      await pool.query('UPDATE email_templates SET html_body=$2, updated_at=NOW() WHERE key=$1', [req.params.key, html]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // edit sequence (toggle active + edit steps)
  app.get('/admin/email/sequence/:id', requireRole('admin'), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const s = (await pool.query('SELECT * FROM email_sequences WHERE id=$1', [id])).rows[0];
      if (!s) return res.redirect('/admin/email');
      const steps = (await pool.query('SELECT * FROM email_sequence_steps WHERE sequence_id=$1 ORDER BY step_order', [id])).rows;
      const tpls = (await pool.query('SELECT key FROM email_templates ORDER BY key')).rows;
      let b = '<p><a href="/admin/email">&larr; Email engine</a></p><h1>Sequence: ' + esc(s.name) + '</h1>';
      b += '<form method="POST" action="/admin/email/sequence/' + id + '">' +
        '<p><label>Name<br><input name="name" value="' + esc(s.name) + '"></label></p>' +
        '<p><label>Trigger event<br><input name="trigger_event" value="' + esc(s.trigger_event || '') + '" placeholder="first_purchase (blank = manual)"></label></p>' +
        '<p><label><input type="checkbox" name="active" ' + (s.active ? 'checked' : '') + ' style="width:auto"> Active</label></p>';
      b += '<h2>Steps</h2><table><tr><th>Order</th><th>Template</th><th>Delay (minutes)</th><th>Active</th></tr>';
      const rows = steps.length ? steps : [];
      for (let i = 0; i < Math.max(rows.length + 1, 4); i++) {
        const st = rows[i] || { step_order: i + 1, template_key: '', delay_minutes: 0, active: true };
        const opts = '<option value="">—</option>' + tpls.map(function (t) {
          return '<option value="' + esc(t.key) + '"' + (t.key === st.template_key ? ' selected' : '') + '>' + esc(t.key) + '</option>';
        }).join('');
        b += '<tr><td><input name="order_' + i + '" value="' + st.step_order + '" style="width:60px"></td>' +
          '<td><select name="tpl_' + i + '">' + opts + '</select></td>' +
          '<td><input name="delay_' + i + '" value="' + st.delay_minutes + '" style="width:100px"></td>' +
          '<td><input type="checkbox" name="active_' + i + '" ' + (st.active ? 'checked' : '') + ' style="width:auto"></td></tr>';
      }
      b += '</table><p class="muted">Delay is measured from the previous step (step 1 from enrollment). Leave template blank to remove a row.</p>' +
        '<button class="btn">Save sequence</button></form>';
      res.send(page('Sequence ' + s.key, b));
    } catch (e) { res.status(500).send('error: ' + esc(e.message)); }
  });
  app.post('/admin/email/sequence/:id', requireRole('admin'), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      await pool.query('UPDATE email_sequences SET name=$2, trigger_event=$3, active=$4, updated_at=NOW() WHERE id=$1',
        [id, String(req.body.name || ''), String(req.body.trigger_event || '').trim() || null, !!req.body.active]);
      await pool.query('DELETE FROM email_sequence_steps WHERE sequence_id=$1', [id]);
      for (let i = 0; i < 12; i++) {
        const tpl = req.body['tpl_' + i];
        if (!tpl) continue;
        const order = parseInt(req.body['order_' + i], 10) || (i + 1);
        const delay = parseInt(req.body['delay_' + i], 10) || 0;
        const active = !!req.body['active_' + i];
        await pool.query(
          'INSERT INTO email_sequence_steps (sequence_id, step_order, template_key, delay_minutes, active) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (sequence_id, step_order) DO UPDATE SET template_key=EXCLUDED.template_key, delay_minutes=EXCLUDED.delay_minutes, active=EXCLUDED.active',
          [id, order, String(tpl), delay, active]
        );
      }
      res.redirect('/admin/email/sequence/' + id);
    } catch (e) { res.status(500).send('error: ' + esc(e.message)); }
  });

  // test send (ignores master switch by temporarily setting enabled via direct resend)
  app.post('/admin/email/test', requireRole('admin'), async (req, res) => {
    try {
      const to = norm(req.body.to);
      const key = String(req.body.template_key || '');
      const tpl = await getTemplate(key);
      if (!to || !tpl) return res.redirect('/admin/email');
      const vars = { customer_name: req.body.customer_name || 'there', site_url: SITE, unsubscribe_url: unsubLink(to), code: 'TS-TEST', review_url: SITE + '/account/review' };
      const subject = '[TEST] ' + renderStr(tpl.subject, vars);
      let html = renderStr(tpl.html_body, vars);
      if (!/unsubscribe/i.test(html)) html += defaultFooter(vars.unsubscribe_url);
      await resend.emails.send({ from: FROM, to: to, subject: subject, html: html, text: htmlToText(html),
        headers: { 'List-Unsubscribe': '<' + vars.unsubscribe_url + '>' } });
      await logSend(to, { templateKey: key }, 'sent', null, null, subject);
      res.redirect('/admin/email');
    } catch (e) { res.status(500).send('test send error: ' + esc(e.message)); }
  });

  // manual enroll
  app.post('/admin/email/enroll', requireRole('admin'), async (req, res) => {
    try {
      await enroll(String(req.body.sequence_key || ''), norm(req.body.email),
        { context: { customer_name: req.body.customer_name || '' } });
      res.redirect('/admin/email');
    } catch (e) { res.status(500).send('enroll error: ' + esc(e.message)); }
  });

  // suppression management
  app.get('/admin/email/suppression', requireRole('admin'), async (req, res) => {
    try {
      const rows = (await pool.query('SELECT email,reason,created_at FROM email_suppression ORDER BY created_at DESC LIMIT 500')).rows;
      let b = '<p><a href="/admin/email">&larr; Email engine</a></p><h1>Suppression list</h1>';
      b += '<form method="POST" action="/admin/email/suppress" class="card" style="display:flex;gap:8px"><input name="email" placeholder="email to suppress"><button class="btn">Suppress</button></form>';
      b += '<table><tr><th>Email</th><th>Reason</th><th>Since</th><th></th></tr>';
      rows.forEach(function (r) {
        b += '<tr><td>' + esc(r.email) + '</td><td>' + esc(r.reason) + '</td><td>' + new Date(r.created_at).toISOString().slice(0, 10) +
          '</td><td><form method="POST" action="/admin/email/unsuppress" style="margin:0"><input type="hidden" name="email" value="' + esc(r.email) + '"><button class="btn" style="background:#fff;color:#c33;border:1px solid #c33">remove</button></form></td></tr>';
      });
      b += '</table>';
      res.send(page('Suppression', b));
    } catch (e) { res.status(500).send('error: ' + esc(e.message)); }
  });
  app.post('/admin/email/suppress', requireRole('admin'), async (req, res) => {
    try { await suppress(norm(req.body.email), 'manual'); } catch (e) {}
    res.redirect('/admin/email/suppression');
  });
  app.post('/admin/email/unsuppress', requireRole('admin'), async (req, res) => {
    try { await unsuppress(norm(req.body.email)); } catch (e) {}
    res.redirect('/admin/email/suppression');
  });

  // cron: walk due enrollments every 5 minutes
  if (cron) {
    cron.schedule('*/5 * * * *', function () { processDue().catch(function (e) { console.error('[email] cron error:', e.message); }); });
  }
  console.log('[email] engine registered' + (enabled() ? '' : ' (sending OFF)'));
}
