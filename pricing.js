// pricing.js
//
// Pricing engine: one base currency (SEK) + algorithmic FX conversion +
// charm rounding per target currency + line-item resolution.
// Currencies (charm ladders, fallback rates, display meta, country mapping)
// are loaded from the `currencies` DB table at module init and after admin
// edits via refreshCurrencyCache(). Literal values below are boot-time
// defaults that get overwritten by the DB load.

const { pool } = require('./db');

const PRICE_TIERS = {
  image:          { sek_minor:  9900 },
  video:          { sek_minor: 14900 },
  talking:        { sek_minor: 14900 },
  bundle:         { sek_minor: 19900 },
  premium:        { sek_minor: 39900 },
  premium_video:  { sek_minor: 89900 },
};

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

const CHARM_LADDERS = {
  sek: [9,19,29,39,49,59,69,79,89,99,109,119,129,139,149,159,169,179,189,199,229,249,279,299,329,349,379,399,449,499,549,599,649,699,749,799,849,899,949,999,1099,1199,1299,1399,1499,1699,1799,1899,1999,2299,2499,2799,2999,3499,3999,4499,4999,5999,6999,7999,8999,9999,14999,19999,24999,29999],
  usd: [0.99,1.99,2.99,3.99,4.99,5.99,6.99,7.99,8.99,9.99,10.99,11.99,12.99,13.99,14.99,15.99,16.99,17.99,18.99,19.99,21.99,24.99,27.99,29.99,34.99,39.99,44.99,49.99,54.99,59.99,64.99,69.99,74.99,79.99,84.99,89.99,94.99,99.99,109.99,119.99,129.99,149.99,169.99,199.99,249.99,299.99,349.99,399.99,449.99,499.99,699.99,999.99,1999.99],
  eur: [0.99,1.99,2.99,3.99,4.99,5.99,6.99,7.99,8.99,9.99,10.99,11.99,12.99,13.99,14.99,15.99,16.99,17.99,18.99,19.99,21.99,24.99,27.99,29.99,34.99,39.99,44.99,49.99,54.99,59.99,64.99,69.99,74.99,79.99,84.99,89.99,94.99,99.99,109.99,119.99,129.99,149.99,169.99,199.99,249.99,299.99,349.99,399.99,499.99,699.99,999.99],
  gbp: [0.99,1.99,2.99,3.99,4.99,5.99,6.99,7.99,8.99,9.99,10.99,11.99,12.99,13.99,14.99,15.99,16.99,17.99,18.99,19.99,21.99,24.99,27.99,29.99,34.99,39.99,44.99,49.99,54.99,59.99,64.99,69.99,74.99,79.99,84.99,89.99,94.99,99.99,109.99,119.99,129.99,149.99,169.99,199.99,249.99,299.99,349.99,399.99,499.99,699.99,999.99],
};

const FALLBACK_RATES = { sek: 1.0, usd: 0.094, eur: 0.087, gbp: 0.075 };

const CURRENCY_META = {
  sek: { symbol: 'kr', symbol_position: 'after',  decimal_places: 0, display_name: 'Swedish krona', country_codes: ['SE'] },
  usd: { symbol: '$',  symbol_position: 'before', decimal_places: 2, display_name: 'US Dollar',     country_codes: ['US'] },
  eur: { symbol: '€',  symbol_position: 'before', decimal_places: 2, display_name: 'Euro',          country_codes: ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES'] },
  gbp: { symbol: '£',  symbol_position: 'before', decimal_places: 2, display_name: 'British Pound', country_codes: ['GB'] },
};

function getSupportedCurrencies() {
  return Object.keys(CURRENCY_META);
}

function pickCurrencyByCountry(countryCode) {
  if (!countryCode) return 'sek';
  const cc = String(countryCode).toUpperCase();
  for (const [code, meta] of Object.entries(CURRENCY_META)) {
    if (Array.isArray(meta.country_codes) && meta.country_codes.includes(cc)) return code;
  }
  return 'usd';
}

const FX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let fxCache = { byTarget: null, fetchedAt: 0 };

async function getFxRates() {
  const now = Date.now();
  if (fxCache.byTarget && now - fxCache.fetchedAt < FX_CACHE_TTL_MS) return fxCache.byTarget;
  try {
    const { rows } = await pool.query(`SELECT DISTINCT ON (target_currency) target_currency, rate FROM fx_rates WHERE base_currency = 'sek' ORDER BY target_currency, fetched_at DESC`);
    const byTarget = { sek: 1.0 };
    for (const r of rows) byTarget[r.target_currency] = Number(r.rate);
    for (const [k, v] of Object.entries(FALLBACK_RATES)) if (byTarget[k] == null) byTarget[k] = v;
    fxCache = { byTarget, fetchedAt: now };
    return byTarget;
  } catch (err) {
    console.warn('[pricing] FX rate read failed, using fallback:', err.message);
    return { ...FALLBACK_RATES };
  }
}

function getFxRateSync(rates, targetCurrency) {
  const key = (targetCurrency || 'sek').toLowerCase();
  return rates[key] ?? FALLBACK_RATES[key] ?? 1.0;
}

async function loadCurrenciesFromDb() {
  try {
    const { rows } = await pool.query(`SELECT code, symbol, symbol_position, decimal_places, charm_ladder, fallback_rate, display_name, country_codes FROM currencies WHERE active = TRUE ORDER BY sort_order ASC, code ASC`);
    if (rows.length === 0) {
      console.warn('[pricing] currencies table empty — using code defaults');
      return false;
    }
    for (const k of Object.keys(CHARM_LADDERS)) delete CHARM_LADDERS[k];
    for (const k of Object.keys(FALLBACK_RATES)) delete FALLBACK_RATES[k];
    for (const k of Object.keys(CURRENCY_META)) delete CURRENCY_META[k];
    for (const r of rows) {
      const code = String(r.code).toLowerCase();
      CHARM_LADDERS[code] = Array.isArray(r.charm_ladder) ? r.charm_ladder : [];
      FALLBACK_RATES[code] = Number(r.fallback_rate);
      CURRENCY_META[code] = {
        symbol: r.symbol,
        symbol_position: r.symbol_position,
        decimal_places: r.decimal_places,
        display_name: r.display_name,
        country_codes: Array.isArray(r.country_codes) ? r.country_codes : [],
      };
    }
    console.log('[pricing] loaded', rows.length, 'currencies from DB:', Object.keys(CURRENCY_META).join(','));
    return true;
  } catch (err) {
    console.warn('[pricing] currencies load failed, using code defaults:', err.message);
    return false;
  }
}

async function refreshCurrencyCache() {
  fxCache = { byTarget: null, fetchedAt: 0 };
  return await loadCurrenciesFromDb();
}

loadCurrenciesFromDb().catch(() => {});

function snapUp(amount, ladder) {
  for (const val of ladder) if (val >= amount) return val;
  const magnitude = Math.pow(10, Math.floor(Math.log10(amount)));
  return Math.ceil(amount / magnitude) * magnitude - 1;
}

function convertAndCharm(sekMinor, targetCurrency, rates) {
  const target = (targetCurrency || 'sek').toLowerCase();
  if (target === 'sek') {
    const ladder = CHARM_LADDERS.sek || [];
    const major = sekMinor / 100;
    return Math.round(snapUp(major, ladder) * 100);
  }
  const rate = getFxRateSync(rates, target);
  const exactMajor = (sekMinor / 100) * rate;
  const ladder = CHARM_LADDERS[target];
  if (!ladder || ladder.length === 0) return Math.round(exactMajor * 100);
  return Math.round(snapUp(exactMajor, ladder) * 100);
}

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

function bracketLookup(breaks, quantity) {
  if (!Array.isArray(breaks) || breaks.length === 0) return null;
  const sorted = [...breaks].sort((a, b) => a.min - b.min);
  let pick = sorted[0];
  for (const b of sorted) if (quantity >= b.min) pick = b;
  return pick.unit_price_sek_minor;
}

function applyModifiers(unitSekMinor, rules, modifiers) {
  if (!rules?.modifiers || !modifiers) return unitSekMinor;
  let unit = unitSekMinor;
  for (const [key, value] of Object.entries(modifiers)) {
    const mod = rules.modifiers[`${key}_${value}`];
    if (!mod) continue;
    if (mod.type === 'flat') unit += mod.add_sek_minor || 0;
    if (mod.type === 'percent') unit = Math.round(unit * (mod.factor || 1));
  }
  return unit;
}

async function priceLineItem(item, currency, ratesParam) {
  const concept = item.concept;
  const quantity = Math.max(1, item.quantity || 1);
  const rules = (concept && concept.pricing_rules) || {};
  const breakUnit = bracketLookup(rules.quantity_breaks, quantity);
  let unit = breakUnit != null ? breakUnit : unitPriceSekMinor(concept);
  unit = applyModifiers(unit, rules, item.modifiers);
  const recipientCount = Array.isArray(item.recipients) ? item.recipients.length : 0;
  const recipientFee = (rules.per_recipient_fee_sek_minor || 0) * recipientCount;
  const totalSek = (unit * quantity) + recipientFee;
  const rates = ratesParam || await getFxRates();
  const displayCurrency = (currency || 'sek').toLowerCase();
  const displayMinor = convertAndCharm(totalSek, displayCurrency, rates);
  const fxRateUsed = getFxRateSync(rates, displayCurrency);
  return { unit_price_sek_minor: unit, total_sek_minor: totalSek, display_currency: displayCurrency, display_price_minor: displayMinor, fx_rate_used: fxRateUsed };
}

async function displayPrice(sekMinor, currency, ratesParam) {
  const rates = ratesParam || await getFxRates();
  return convertAndCharm(sekMinor, (currency || 'sek').toLowerCase(), rates);
}

function formatDisplay(minor, currency) {
  const code = (currency || 'sek').toLowerCase();
  const major = minor / 100;
  const meta = CURRENCY_META[code];
  if (meta) {
    const formatted = meta.decimal_places > 0 ? major.toFixed(meta.decimal_places) : String(Math.round(major));
    return meta.symbol_position === 'before' ? meta.symbol + formatted : formatted + ' ' + meta.symbol;
  }
  switch (code) {
    case 'sek': return `${Math.round(major)} kr`;
    case 'usd': return `$${major.toFixed(2)}`;
    case 'eur': return `€${major.toFixed(2)}`;
    case 'gbp': return `£${major.toFixed(2)}`;
    default:    return `${major}`;
  }
}

module.exports = {
  PRICE_TIERS, CHARM_LADDERS, FALLBACK_RATES, CURRENCY_META,
  defaultTierFor, unitPriceSekMinor,
  getFxRates, getFxRateSync, snapUp, convertAndCharm,
  priceLineItem, displayPrice, formatDisplay,
  loadCurrenciesFromDb, refreshCurrencyCache,
  getSupportedCurrencies, pickCurrencyByCountry,
};
