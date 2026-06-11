const path = require('path');
const fs = require('fs');
const maxmind = require('maxmind');

const DB_PATH = process.env.GEOIP_DB_PATH || path.join(__dirname, 'geoip', 'GeoLite2-City.mmdb');
const ASN_DB_PATH = process.env.GEOIP_ASN_DB_PATH || path.join(__dirname, 'geoip', 'GeoLite2-ASN.mmdb');

let readerPromise = null;
let asnReaderPromise = null;
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

function getAsnReader() {
  if (asnReaderPromise) return asnReaderPromise;
  if (!fs.existsSync(ASN_DB_PATH)) {
    asnReaderPromise = Promise.resolve(null);
    return asnReaderPromise;
  }
  asnReaderPromise = maxmind.open(ASN_DB_PATH).catch((err) => {
    console.error('[geoip] failed to open ASN database:', err.message);
    return null;
  });
  return asnReaderPromise;
}

const EMPTY = { country: null, region: null, city: null, lat: null, lng: null, asn_org: null };

async function lookup(ip) {
  if (!ip) return { ...EMPTY };
  try {
    const reader = await getReader();
    const out = { ...EMPTY };
    if (reader) {
      const r = reader.get(ip);
      if (r) {
        out.country = r.country?.iso_code ?? r.registered_country?.iso_code ?? null;
        out.region = r.subdivisions?.[0]?.names?.en ?? r.subdivisions?.[0]?.iso_code ?? null;
        out.city = r.city?.names?.en ?? null;
        out.lat = r.location?.latitude ?? null;
        out.lng = r.location?.longitude ?? null;
      }
    }
    // ASN org (e.g. "AMAZON-02", "GOOGLE-CLOUD-PLATFORM") — used to spot
    // datacenter traffic that executes JS and would otherwise count as human.
    try {
      const asnReader = await getAsnReader();
      if (asnReader) {
        const a = asnReader.get(ip);
        if (a) out.asn_org = a.autonomous_system_organization ?? null;
      }
    } catch { /* ASN db optional */ }
    return out;
  } catch (err) {
    console.error('[geoip] lookup error:', err.message);
    return { ...EMPTY };
  }
}

module.exports = { lookup };
