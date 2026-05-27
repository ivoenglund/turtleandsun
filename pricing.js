// pricing.js
//
// Pricing engine: one base currency (SEK) + algorithmic FX conversion +
// charm rounding per target currency + line-item resolution that handles
// quantity, recipients, and option modifiers.
//
// Resolution flow:
//   1. Look up the concept's tier (or fall back to a tier derived from
//      input_type).
//   2. Apply quantity_breaks if defined and quantity > 1.
//   3. Apply modifier add-ons (flat or percent).
//   4. Multiply by quantity and add per-recipient fee.
//   5. Convert SEK total to display currency via cached FX rate and snap
//      to the per-currency charm ladder.
//
// Stripe integration: locks the converted amount + FX rate at checkout
// (caller stores both in order_line_items so the customer pays exactly
// what they saw).
//
// FX rates are read from the `fx_rates` table; see fx_cron.js for the
// daily ECB updater. If no rate is cached the engine falls back to
// FALLBACK_RATES below — a hardcoded snapshot that prevents launch-day
// panics if the cron hasn't run yet.

const { pool } = require('./db');

// ---------------------------------------------------------------------------
// Default tiers — in SEK minor units (öre). These are the baseline prices
// when a concept doesn't override. Add new tiers as new product categories
// emerge (e.g., premium_video for Phase 3 talking ancestor).
// ---------------------------------------------------------------------------
const PRICE_TIERS = {
  image:          { sek_minor:  9900 },   //  99 kr
  video:          { sek_minor: 14900 },   // 149 kr
  talking:        { sek_minor: 14900 },   // 149 kr — same tier as video
  bundle:         { sek_minor: 19900 },   // 199 kr
  premium:        { sek_minor: 39900 },   // 399 kr — Family Portrait
  premium_video:  { sek_minor: 89900 },   // 899 kr — Talking ancestor
};

// Map a concept's input_type to its default pricing tier when price_tier
// isn't set explicitly on the concept.
function defaultTierFor(inputType) {
  switch (inputType) {
    case 'image':
    case 'image_video':   return 'image';
    case 'video':         return 'video';
    case 'talking':       return 'talking';
    case 'composite':     return 'premium';
    default:              return 'image';
  }
}

// ---------------------------------------------------------------------------
// Charm ladders — psychologically attractive price points per currency.
// Convert a numeric amount, then snap UP to the next ladder value so we
// never under-charge after rounding. Customer-facing prices always end in
// a 9 or a .99.
//
// Add new currencies (DKK, NOK, JPY, CHF, etc.) by appending a ladder.
// ---------------------------------------------------------------------------
const CHARM_LADDERS = {
  // Dense ladders to keep FX conversions close to natural prices instead
  // of jumping a full charm tier when the converted amount lands in a gap.
  // Rule of thumb: include every 9-ending integer up to ~99, then 49 / 99
  // endings, then 99 endings, then 999 endings.
  sek: [
    9, 19, 29, 39, 49, 59, 69, 79, 89, 99,
    109, 119, 129, 139, 149, 159, 169, 179, 189, 199,
    229, 249, 279, 299, 329, 349, 379, 399, 449, 499,
    549, 599, 649, 699, 749, 799, 849, 899, 949, 999,
    1099, 1199, 1299, 1399, 1499, 1699, 1799, 1899, 1999,
    2299, 2499, 2799, 2999, 3499, 3999, 4499, 4999,
    5999, 6999, 7999, 8999, 9999, 14999, 19999, 24999, 29999
  ],
  usd: [
    0.99, 1.99, 2.99, 3.99, 4.99, 5.99, 6.99, 7.99, 8.99, 9.99,
    10.99, 11.99, 12.99, 13.99, 14.99, 15.99, 16.99, 17.99, 18.99, 19.99,
    21.99, 24.99, 27.99, 29.99, 34.99, 39.99, 44.99, 49.99,
    54.99, 59.99, 64.99, 69.99, 74.99, 79.99, 84.99, 89.99, 94.99, 99.99,
    109.99, 119.99, 129.99, 149.99, 169.99, 199.99,
    249.99, 299.99, 349.99, 399.99, 449.99, 499.99, 699.99, 999.99, 1999.99
  ],
  eur: [
    0.99, 1.99, 2.99, 3.99, 4.99, 5.99, 6.99, 7.99, 8.99, 9.99,
    10.99, 11.99, 12.99, 13.99, 14.99, 15.99, 16.99, 17.99, 18.99, 19.99,
    21.99, 24.99, 27.99, 29.99, 34.99, 39.99, 44.99, 49.99,
    54.99, 59.99, 64.99, 69.99, 74.99, 79.99, 84.99, 89.99, 94.99, 99.99,
    109.99, 119.99, 129.99, 149.99, 169.99, 199.99,
    249.99, 299.99, 349.99, 399.99, 499.99, 699.99, 999.99
  ],
  gbp: [
    0.99, 1.99, 2.99, 3.99, 4.99, 5.99, 6.99, 7.99, 8.99, 9.99,
    10.99, 11.99, 12.99, 13.99, 14.99, 15.99, 16.99, 17.99, 18.99, 19.99,
    21.99, 24.99, 27.99, 29.99, 34.99, 39.99, 44.99, 49.99,
    54.99, 59.99, 64.99, 69.99, 74.99, 79.99, 84.99, 89.99, 94.99, 99.99,
    109.99, 119.99, 129.99, 149.99, 169.99, 199.99,
    249.99, 299.99, 349.99, 399.99, 499.99, 699.99, 999.99
  ],
};

// Fallback FX rates used when the fx_rates cache is empty (e.g., first boot
// before the ECB cron has run). These are illustrative — replace via the
// cron as soon as it lands. SEK is base, so all rates are units-per-SEK.
const FALLBACK_RATES = {
  sek: 1.0,
  usd: 0.094,   // 1 SEK ≈ 0.094 USD
  eur: 0.087,   // 1 SEK ≈ 0.087 EUR
  gbp: 0.075,   // 1 SEK ≈ 0.075 GBP
};

// ---------------------------------------------------------------------------
// FX cache (memory) — refreshed on demand from the fx_rates table. 24h TTL.
// ---------------------------------------------------------------------------
const FX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let fxCache = { byTarget: null, fetchedAt: 0 };

async function getFxRates() {
  const now = Date.now();
  if (fxCache.byTarget && now - fxCache.fetchedAt < FX_CACHE_TTL_MS) {
    return fxCache.byTarget;
  }

  try {
    // For each target currency, pick the most recent row with base 'SEK'.
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (target_currency) target_currency, rate
      FROM fx_rates
      WHERE base_currency = 'sek'
      ORDER BY target_currency, fetched_at DESC
    `);

    const byTarget = { sek: 1.0 };
    for (const r of rows) {
      byTarget[r.target_currency] = Number(r.rate);
    }
    // Merge fallbacks for any currency we don't have a cached rate for yet.
    for (const [k, v] of Object.entries(FALLBACK_RATES)) {
      if (byTarget[k] == null) byTarget[k] = v;
    }
    fxCache = { byTarget, fetchedAt: now };
    return byTarget;
  } catch (err) {
    // Don't crash production on a DB hiccup — degrade to fallback table.
    console.warn('[pricing] FX rate read failed, using fallback:', err.message);
    return { ...FALLBACK_RATES };
  }
}

// Sync version for callers that have already loaded rates (e.g., a checkout
// handler that called getFxRates once and wants to use the cached map).
function getFxRateSync(rates, targetCurrency) {
  const key = (targetCurrency || 'sek').toLowerCase();
  return rates[key] ?? FALLBACK_RATES[key] ?? 1.0;
}

// ---------------------------------------------------------------------------
// Charm rounding. snapUp returns the smallest ladder value >= amount.
// If amount exceeds the ladder, fall back to the nearest *999 magnitude.
// ---------------------------------------------------------------------------
function snapUp(amount, ladder) {
  for (const val of ladder) {
    if (val >= amount) return val;
  }
  // Above the ladder: snap UP to nearest 1000 minus 1 (e.g., 24999, 99999).
  const magnitude = Math.pow(10, Math.floor(Math.log10(amount)));
  return Math.ceil(amount / magnitude) * magnitude - 1;
}

// Convert a SEK minor-unit amount to a display amount in target currency
// (minor units), snapping to the charm ladder. Returns an integer.
function convertAndCharm(sekMinor, targetCurrency, rates) {
  const target = (targetCurrency || 'sek').toLowerCase();
  if (target === 'sek') {
    // For SEK we still want to honor the ladder so off-tier prices snap to
    // a nice number (e.g., 247 → 249).
    const ladder = CHARM_LADDERS.sek;
    const major = sekMinor / 100;
    return Math.round(snapUp(major, ladder) * 100);
  }

  const rate = getFxRateSync(rates, target);
  const exactMajor = (sekMinor / 100) * rate;
  const ladder = CHARM_LADDERS[target];

  if (!ladder) {
    // Unknown currency — return an unrounded converted amount.
    return Math.round(exactMajor * 100);
  }

  return Math.round(snapUp(exactMajor, ladder) * 100);
}

// ---------------------------------------------------------------------------
// Per-concept base unit price resolver.
// ---------------------------------------------------------------------------
function unitPriceSekMinor(concept) {
  if (concept.unit_price_sek_minor != null) return concept.unit_price_sek_minor;
  const tier = concept.price_tier || defaultTierFor(concept.input_type);
  const t = PRICE_TIERS[tier];
  if (!t) {
    console.warn(`[pricing] Unknown price_tier '${tier}' on concept`, concept.id || concept.slug);
    return PRICE_TIERS.image.sek_minor;
  }
  return t.sek_minor;
}

// quantity_breaks: [{ min: 1, unit_price_sek_minor: 9900 },
//                   { min: 5, unit_price_sek_minor: 8900 }, ...]
// Returns the unit price for the bracket the quantity falls into.
function bracketLookup(breaks, quantity) {
  if (!Array.isArray(breaks) || breaks.length === 0) return null;
  // Sort ascending by min, pick the highest min <= quantity.
  const sorted = [...breaks].sort((a, b) => a.min - b.min);
  let pick = sorted[0];
  for (const b of sorted) {
    if (quantity >= b.min) pick = b;
  }
  return pick.unit_price_sek_minor;
}

function applyModifiers(unitSekMinor, rules, modifiers) {
  if (!rules?.modifiers || !modifiers) return unitSekMinor;
  let unit = unitSekMinor;
  for (const [key, value] of Object.entries(modifiers)) {
    const modKey = `${key}_${value}`;
    const mod = rules.modifiers[modKey];
    if (!mod) continue;
    if (mod.type === 'flat')    unit += mod.add_sek_minor || 0;
    if (mod.type === 'percent') unit = Math.round(unit * (mod.factor || 1));
  }
  return unit;
}

// ---------------------------------------------------------------------------
// Public: priceLineItem
//
// Inputs:
//   item:     { concept, quantity, recipients[], modifiers{} }
//   currency: 'sek' | 'usd' | 'eur' | 'gbp' | ...
//   rates:    optional pre-loaded FX map (from getFxRates())
//
// Returns:
//   { unit_price_sek_minor, total_sek_minor,
//     display_currency, display_price_minor, fx_rate_used }
// ---------------------------------------------------------------------------
async function priceLineItem(item, currency, ratesParam) {
  const concept = item.concept;
  const quantity = Math.max(1, item.quantity || 1);
  const rules = (concept && concept.pricing_rules) || {};

  // 1) Unit price from quantity_breaks (or base tier)
  const breakUnit = bracketLookup(rules.quantity_breaks, quantity);
  let unit = breakUnit != null ? breakUnit : unitPriceSekMinor(concept);

  // 2) Apply modifiers (4K upsell, A3 size, rush delivery, etc.)
  unit = applyModifiers(unit, rules, item.modifiers);

  // 3) Quantity × unit + per-recipient fee
  const recipientCount = Array.isArray(item.recipients) ? item.recipients.length : 0;
  const recipientFee = (rules.per_recipient_fee_sek_minor || 0) * recipientCount;
  const totalSek = (unit * quantity) + recipientFee;

  // 4) FX convert + charm round, locked
  const rates = ratesParam || await getFxRates();
  const displayCurrency = (currency || 'sek').toLowerCase();
  const displayMinor = convertAndCharm(totalSek, displayCurrency, rates);
  const fxRateUsed = getFxRateSync(rates, displayCurrency);

  return {
    unit_price_sek_minor: unit,
    total_sek_minor: totalSek,
    display_currency: displayCurrency,
    display_price_minor: displayMinor,
    fx_rate_used: fxRateUsed,
  };
}

// ---------------------------------------------------------------------------
// Public: displayPrice — convenience for showing a base SEK amount in a
// given currency without going through line-item resolution. Used by
// the public /gallery and /api/currency endpoints.
// ---------------------------------------------------------------------------
async function displayPrice(sekMinor, currency, ratesParam) {
  const rates = ratesParam || await getFxRates();
  return convertAndCharm(sekMinor, (currency || 'sek').toLowerCase(), rates);
}

// Format a minor-unit amount for human display. Mirrors the existing
// formatPrice() in server.js so legacy call sites stay consistent.
function formatDisplay(minor, currency) {
  const major = minor / 100;
  switch ((currency || 'sek').toLowerCase()) {
    case 'sek': return `${Math.round(major)} kr`;
    case 'usd': return `$${major.toFixed(2)}`;
    case 'eur': return `€${major.toFixed(2)}`;
    case 'gbp': return `£${major.toFixed(2)}`;
    default:    return `${major}`;
  }
}

module.exports = {
  PRICE_TIERS,
  CHARM_LADDERS,
  FALLBACK_RATES,
  defaultTierFor,
  unitPriceSekMinor,
  getFxRates,
  getFxRateSync,
  snapUp,
  convertAndCharm,
  priceLineItem,
  displayPrice,
  formatDisplay,
};
