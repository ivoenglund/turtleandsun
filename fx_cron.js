// fx_cron.js
//
// Daily FX rate fetcher. Pulls the ECB reference rates XML, computes SEK-base
// cross-rates for every currency we support, and writes one row per pair
// into the fx_rates table.
//
// ECB feed: https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
//   - Free, no API key, updated once per business day around 16:00 CET.
//   - All rates are expressed against EUR (1 EUR = X target).
//   - We rebase to SEK because that's our home currency.
//
// Fallback strategy: if the fetch fails, we don't write new rows — the
// pricing engine keeps using the previous day's cached rows. If no rows
// exist at all (first boot), pricing.js falls back to its hardcoded
// FALLBACK_RATES.

const { pool } = require('./db');

const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

// Currencies we surface to customers. Add to this list as new charm
// ladders go into pricing.js.
const TARGETS = ['usd', 'eur', 'gbp', 'sek'];

// Parse ECB XML — flat structure, one <Cube currency="X" rate="Y"/> per pair.
// We're not pulling a full XML parser dependency just for this; a simple
// regex extraction is enough for the well-known feed shape.
function parseEcbXml(xml) {
  const rates = { eur: 1.0 };
  const re = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const code = m[1].toLowerCase();
    const rate = Number(m[2]);
    if (Number.isFinite(rate) && rate > 0) rates[code] = rate;
  }
  return rates;
}

// Build SEK-base rates from EUR-base ECB feed.
//   EUR-base: rates[X] = X per 1 EUR
//   SEK-base: result[X] = X per 1 SEK = rates[X] / rates[SEK]
function rebaseToSek(eurRates) {
  const sekPerEur = eurRates.sek;
  if (!sekPerEur || sekPerEur <= 0) {
    throw new Error('ECB feed did not return a SEK rate');
  }
  const out = { sek: 1.0 };
  for (const code of TARGETS) {
    if (code === 'sek') continue;
    const targetPerEur = eurRates[code];
    if (targetPerEur && targetPerEur > 0) {
      out[code] = targetPerEur / sekPerEur;
    }
  }
  return out;
}

async function fetchEcbRates() {
  // Node 18+ has global fetch; fal of node-cron etc. already require modern
  // node, so this is safe.
  const res = await fetch(ECB_URL, {
    headers: { 'User-Agent': 'Turtleandsun/1.0 (+https://turtleandsun.com)' },
    // ECB feed is ~5KB — a generous timeout is fine.
  });
  if (!res.ok) throw new Error(`ECB fetch failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();
  const eurRates = parseEcbXml(xml);
  if (Object.keys(eurRates).length < 5) {
    throw new Error('ECB feed parsed too few rates — feed format may have changed');
  }
  return rebaseToSek(eurRates);
}

async function writeRates(sekRates) {
  const fetchedAt = new Date();
  for (const [code, rate] of Object.entries(sekRates)) {
    if (code === 'sek') continue;
    await pool.query(
      `INSERT INTO fx_rates (base_currency, target_currency, rate, fetched_at, source)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (base_currency, target_currency, fetched_at) DO NOTHING`,
      ['sek', code, rate, fetchedAt, 'ECB']
    );
  }
}

// Public entrypoint — called by the cron schedule and (optionally) at boot.
async function refreshFxRates() {
  try {
    const rates = await fetchEcbRates();
    await writeRates(rates);
    console.log('[fx_cron] FX rates refreshed:', rates);
    return rates;
  } catch (err) {
    console.error('[fx_cron] Refresh failed:', err.message);
    return null;
  }
}

// Schedule via node-cron. Caller registers this from server.js with the
// same pattern as digest.js. Default: every day at 04:00 UTC.
function scheduleFxRefresh(cron) {
  // Run once at boot so an empty fx_rates table gets seeded immediately.
  // Don't block startup if the network is slow.
  refreshFxRates().catch(() => {});

  // Daily 04:00 UTC. ECB publishes at ~14:15 CET (13:15 UTC) — we pull the
  // morning after to be safe with their cutover.
  cron.schedule('0 4 * * *', () => {
    refreshFxRates().catch(() => {});
  });
}

module.exports = {
  refreshFxRates,
  scheduleFxRefresh,
  parseEcbXml,   // exported for testing
  rebaseToSek,   // exported for testing
};
