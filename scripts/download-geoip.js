const fs = require('fs');
const path = require('path');
const https = require('https');
const tar = require('tar');

const DB_PATH = process.env.GEOIP_DB_PATH || path.join(__dirname, '..', 'geoip', 'GeoLite2-City.mmdb');
const LICENSE_KEY = process.env.MAXMIND_LICENSE_KEY;

// Always exit 0 so a missing/failed download never blocks server startup —
// the app degrades gracefully without the GeoIP database.
function done(msg) {
  if (msg) console.log(msg);
  process.exit(0);
}
function fail(msg) {
  console.warn('[geoip] download failed:', msg, '— continuing without GeoIP');
  process.exit(0);
}

if (fs.existsSync(DB_PATH)) {
  done('[geoip] database already present, skipping download');
}
if (!LICENSE_KEY) {
  done('[geoip] MAXMIND_LICENSE_KEY not set, skipping download');
}

const url = `https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${encodeURIComponent(LICENSE_KEY)}&suffix=tar.gz`;

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function extract(res) {
  const targetDir = path.dirname(DB_PATH);
  fs.mkdirSync(targetDir, { recursive: true });
  // Extract into a temp dir on the SAME filesystem as the target so the final
  // rename is atomic (avoids leaving a half-written .mmdb that "skip if exists" would keep).
  const tmpDir = fs.mkdtempSync(path.join(targetDir, '.geoip-tmp-'));

  const stream = tar.x({ cwd: tmpDir, strip: 1, filter: (p) => p.endsWith('.mmdb') });
  stream.on('error', (err) => { cleanup(tmpDir); fail(err.message); });
  stream.on('finish', () => {
    try {
      const extracted = path.join(tmpDir, 'GeoLite2-City.mmdb');
      if (!fs.existsSync(extracted)) { cleanup(tmpDir); return fail('.mmdb not found in archive'); }
      fs.renameSync(extracted, DB_PATH);
      cleanup(tmpDir);
      const mb = (fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(1);
      done(`[geoip] downloaded GeoLite2-City.mmdb (${mb} MB) to ${DB_PATH}`);
    } catch (err) {
      cleanup(tmpDir);
      fail(err.message);
    }
  });

  res.pipe(stream);
}

function get(u, redirects) {
  if (redirects > 5) return fail('too many redirects');
  const req = https.get(u, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      return get(res.headers.location, redirects + 1);
    }
    if (res.statusCode !== 200) {
      res.resume();
      return fail('HTTP ' + res.statusCode + (res.statusCode === 401 ? ' (check MAXMIND_LICENSE_KEY)' : ''));
    }
    extract(res);
  });
  req.on('error', (err) => fail(err.message));
  req.setTimeout(60000, () => { req.destroy(); fail('request timed out after 60s'); });
}

console.log('[geoip] downloading GeoLite2-City database from MaxMind...');
get(url, 0);
