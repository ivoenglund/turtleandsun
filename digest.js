const { pool } = require('./db');
const { Resend } = require('resend');

// digest.js creates its own Resend client (it can't import server.js — that would
// be circular, since server.js requires this module).
const resend = new Resend(process.env.RESEND_API_KEY);

// Hardcoded FX for the approximate USD bottom line — update by hand for now.
const FX_TO_USD = { sek: 0.094, eur: 1.08, gbp: 1.26, usd: 1.00 };
const SUPPORTED = new Set(['sek', 'usd', 'eur', 'gbp']);
const COUNTRY_TO_CURRENCY = {
  NO: 'NOK', DK: 'DKK', CH: 'CHF', CA: 'CAD', AU: 'AUD', JP: 'JPY', IN: 'INR', BR: 'BRL', MX: 'MXN',
};
const SUGGEST_THRESHOLD = 20;

function fmtNative(amount, currency) {
  const a = Number(amount) || 0;
  if (currency === 'sek') return `${Math.round(a)} kr`;
  if (currency === 'usd') return `$${a.toFixed(2)}`;
  if (currency === 'eur') return `€${a.toFixed(2)}`;
  if (currency === 'gbp') return `£${a.toFixed(2)}`;
  return `${a.toFixed(2)} ${String(currency || '').toUpperCase()}`;
}
function toUsd(amount, currency) {
  return (Number(amount) || 0) * (FX_TO_USD[currency] || 0);
}
function block(title, inner) {
  return `<div style="background:#fff;border:1px solid #eee;border-radius:8px;padding:16px 18px;margin-bottom:14px;">
    <div style="font-family:Arial,sans-serif;font-size:13px;font-weight:700;color:#1C0A00;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:10px;">${title}</div>
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#3C2000;line-height:1.6;">${inner}</div>
  </div>`;
}

async function sendDailyDigest() {
  const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });

  // 1) REVENUE (last 24h vs previous 24h)
  let revenueHtml;
  try {
    const last = await pool.query(
      `SELECT currency, COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS total
       FROM orders WHERE status='paid' AND created_at >= NOW() - INTERVAL '24 hours'
       GROUP BY currency ORDER BY currency`
    );
    const prev = await pool.query(
      `SELECT currency, COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS total
       FROM orders WHERE status='paid'
         AND created_at >= NOW() - INTERVAL '48 hours' AND created_at < NOW() - INTERVAL '24 hours'
       GROUP BY currency`
    );
    let lastOrders = 0, lastUsd = 0;
    const lines = last.rows.map(r => {
      lastOrders += r.n;
      lastUsd += toUsd(r.total, r.currency);
      return `${(r.currency || '?').toUpperCase()}: ${r.n} order${r.n === 1 ? '' : 's'} · ${fmtNative(r.total, r.currency)}`;
    });
    let prevOrders = 0, prevUsd = 0;
    prev.rows.forEach(r => { prevOrders += r.n; prevUsd += toUsd(r.total, r.currency); });

    const orderDelta = lastOrders - prevOrders;
    const orderDeltaStr = (orderDelta >= 0 ? '+' : '') + orderDelta;
    const revDeltaStr = prevUsd > 0
      ? ((lastUsd - prevUsd) / prevUsd * 100 >= 0 ? '+' : '') + ((lastUsd - prevUsd) / prevUsd * 100).toFixed(0) + '%'
      : '—';

    revenueHtml =
      (lines.length ? lines.join('<br>') : 'No orders.') +
      `<br><br><strong>≈ $${lastUsd.toFixed(2)} USD total</strong>` +
      `<br><span style="color:#888;">vs previous 24h: ${orderDeltaStr} orders, ${revDeltaStr} revenue</span>`;
  } catch (e) { console.error('[digest] revenue error:', e.message); revenueHtml = '(error)'; }

  // 2) ORDERS BY PRODUCT (last 24h)
  let productsHtml;
  try {
    const r = await pool.query(
      `SELECT product, COUNT(*)::int AS n FROM orders
       WHERE status='paid' AND created_at >= NOW() - INTERVAL '24 hours' GROUP BY product`
    );
    const counts = { image: 0, video: 0, bundle: 0 };
    r.rows.forEach(row => { if (row.product in counts) counts[row.product] = row.n; });
    productsHtml = `Image: ${counts.image}<br>Video: ${counts.video}<br>Bundle: ${counts.bundle}`;
  } catch (e) { console.error('[digest] products error:', e.message); productsHtml = '(error)'; }

  // 3) VISITORS (last 24h)
  let visitorsHtml;
  try {
    const tot = await pool.query(`SELECT COUNT(DISTINCT ip)::int AS n FROM visits WHERE created_at >= NOW() - INTERVAL '24 hours'`);
    const top = await pool.query(
      `SELECT country, COUNT(DISTINCT ip)::int AS n FROM visits
       WHERE created_at >= NOW() - INTERVAL '24 hours' AND country IS NOT NULL
       GROUP BY country ORDER BY n DESC LIMIT 10`
    );
    const susp = await pool.query(
      `SELECT ip, country, COUNT(*)::int AS hits FROM visits
       WHERE created_at >= NOW() - INTERVAL '24 hours'
       GROUP BY ip, country HAVING COUNT(*) > 30 ORDER BY hits DESC LIMIT 5`
    );
    const list = top.rows.length
      ? top.rows.map(r => `${r.country}: ${r.n}`).join('<br>')
      : 'No country data.';
    const suspList = susp.rows.length
      ? susp.rows.map(r => `${r.ip} · ${r.country || '?'} · ${r.hits} hits`).join('<br>')
      : 'None.';
    visitorsHtml = `<strong>${tot.rows[0].n}</strong> unique visitors<br><br>` +
      `<span style="color:#888;">Top countries</span><br>${list}<br><br>` +
      `<span style="color:#888;">Suspicious activity (IPs with &gt; 30 visits in 24h)</span><br>${suspList}`;
  } catch (e) { console.error('[digest] visitors error:', e.message); visitorsHtml = '(error)'; }

  // 4) CURRENCY SUGGESTIONS (last 24h)
  let suggestionsHtml;
  try {
    const r = await pool.query(
      `SELECT country, COUNT(DISTINCT ip)::int AS n FROM visits
       WHERE created_at >= NOW() - INTERVAL '24 hours' AND country IS NOT NULL GROUP BY country`
    );
    const byCurrency = {}; // currency -> { count, countries: [] }
    r.rows.forEach(row => {
      const cur = COUNTRY_TO_CURRENCY[(row.country || '').toUpperCase()];
      if (!cur || SUPPORTED.has(cur.toLowerCase())) return;
      if (!byCurrency[cur]) byCurrency[cur] = { count: 0, countries: [] };
      byCurrency[cur].count += row.n;
      byCurrency[cur].countries.push(`${row.country} ${row.n}`);
    });
    const flags = Object.keys(byCurrency)
      .filter(cur => byCurrency[cur].count >= SUGGEST_THRESHOLD)
      .map(cur => `⚠ Consider adding ${cur} (${byCurrency[cur].countries.join(', ')})`);
    suggestionsHtml = flags.length ? flags.join('<br>') : 'No new currencies suggested.';
  } catch (e) { console.error('[digest] suggestions error:', e.message); suggestionsHtml = '(error)'; }

  // 5) DELIVERY HEALTH (last 24h)
  let healthHtml;
  try {
    const pending = await pool.query(
      `SELECT COUNT(*)::int AS n FROM orders
       WHERE status = 'paid' AND result_url IS NULL AND created_at >= NOW() - INTERVAL '24 hours'`
    );
    const failed = await pool.query(
      `SELECT COUNT(*)::int AS n FROM failed_deliveries
       WHERE created_at >= NOW() - INTERVAL '24 hours' AND resolved = false`
    );
    healthHtml = `Paid but not delivered (24h): ${pending.rows[0].n}<br>Failed deliveries (24h, unresolved): ${failed.rows[0].n}`;
  } catch (e) { console.error('[digest] health error:', e.message); healthHtml = '(error)'; }

  // 6) QUICK LINKS
  const linksHtml =
    `<a href="https://turtleandsun.com/admin/visits">/admin/visits</a><br>` +
    `<a href="https://turtleandsun.com/admin/failed-deliveries">/admin/failed-deliveries</a><br>` +
    `<a href="https://turtle-and-sun.sentry.io/">Sentry</a>`;

  const html = `<div style="max-width:560px;margin:0 auto;background:#FFF9E6;padding:24px;">
    <h1 style="font-family:Arial,sans-serif;font-size:20px;color:#1C0A00;margin:0 0 16px;">Turtleandsun Daily — ${date}</h1>
    ${block('Revenue (last 24h)', revenueHtml)}
    ${block('Orders by product (last 24h)', productsHtml)}
    ${block('Visitors (last 24h)', visitorsHtml)}
    ${block('Currency suggestions', suggestionsHtml)}
    ${block('Delivery health (last 24h)', healthHtml)}
    ${block('Quick links', linksHtml)}
  </div>`;

  try {
    await resend.emails.send({
      from: 'Turtle and Sun <noreply@turtleandsun.com>',
      to: 'ivo.englund@gmail.com',
      subject: `Turtleandsun Daily — ${date}`,
      html,
    });
    console.log('[digest] sent for', date);
  } catch (e) {
    console.error('[digest] send failed:', e.message);
  }
}

module.exports = { sendDailyDigest };
