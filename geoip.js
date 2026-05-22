const path = require('path');
const fs = require('fs');
const maxmind = require('maxmind');

const DB_PATH = process.env.GEOIP_DB_PATH || path.join(__dirname, 'geoip', 'GeoLite2-City.mmdb');

let readerPromise = null;
let warned = false;

function getReader() {
  if (readerPromise) return readerPromise;
  if (!fs.existsSync(DB_PATH)) {
    if (!warned) {
      console.warn(`[geoip] database not found at ${DB_PATH} — geo lookups will return null. See README for download instructions.`);
      warned = true;
    }
    readerPromise = Promise.resolve(null);
    return readerPromise;
  }
  readerPromise = maxmind.open(DB_PATH).catch((err) => {
    console.error('[geoip] failed to open database:', err.message);
    return null;
  });
  return readerPromise;
}

const EMPTY = { country: null, region: null, city: null, lat: null, lng: null };

async function lookup(ip) {
  if (!ip) return { ...EMPTY };
  try {
    const reader = await getReader();
    if (!reader) return { ...EMPTY };
    const r = reader.get(ip);
    if (!r) return { ...EMPTY };
    return {
      country: r.country?.iso_code ?? r.registered_country?.iso_code ?? null,
      region: r.subdivisions?.[0]?.names?.en ?? r.subdivisions?.[0]?.iso_code ?? null,
      city: r.city?.names?.en ?? null,
      lat: r.location?.latitude ?? null,
      lng: r.location?.longitude ?? null,
    };
  } catch (err) {
    console.error('[geoip] lookup error:', err.message);
    return { ...EMPTY };
  }
}

module.exports = { lookup };
