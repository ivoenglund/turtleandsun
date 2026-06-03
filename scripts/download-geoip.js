const fs   = require('fs');
const path = require('path');
const https = require('https');
const tar   = require('tar');

const DB_PATH     = process.env.GEOIP_DB_PATH || path.join(__dirname, '..', 'geoip', 'GeoLite2-City.mmdb');
const LICENSE_KEY = process.env.MAXMIND_LICENSE_KEY;

// R2 cache key — we keep one copy of the mmdb in R2 and refresh weekly.
const R2_KEY        = 'geoip/GeoLite2-City.mmdb';
const MAX_AGE_DAYS  = 7;

function done(msg) { if (msg) console.log(msg); process.exit(0); }
function fail(msg)  { console.warn('[geoip]', msg, '— continuing without GeoIP'); process.exit(0); }

// ─── helpers ────────────────────────────────────────────────────────────────

function ensureDir() { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); }

function ageInDays(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
  } catch { return Infinity; }
}

async function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    function get(u, hops) {
      if (hops > 5) return reject(new Error('too many redirects'));
      const req = https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); return get(res.headers.location, hops + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end',  () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(120000, () => { req.destroy(); reject(new Error('timeout')); });
    }
    get(url, 0);
  });
}

async function extractMmdb(tarBuffer) {
  ensureDir();
  const tmpDir = fs.mkdtempSync(path.join(path.dirname(DB_PATH), '.geoip-tmp-'));
  try {
    await new Promise((res, rej) => {
      const stream = tar.x({ cwd: tmpDir, strip: 1, filter: p => p.endsWith('.mmdb') });
      stream.on('finish', res);
      stream.on('error',  rej);
      const { Readable } = require('stream');
      Readable.from(tarBuffer).pipe(stream);
    });
    const extracted = path.join(tmpDir, 'GeoLite2-City.mmdb');
    if (!fs.existsSync(extracted)) throw new Error('.mmdb not found in archive');
    fs.renameSync(extracted, DB_PATH);
    const mb = (fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(1);
    console.log(`[geoip] extracted GeoLite2-City.mmdb (${mb} MB)`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ─── R2 helpers ─────────────────────────────────────────────────────────────

function r2Client() {
  const { S3Client } = require('@aws-sdk/client-s3');
  const id  = process.env.R2_ACCOUNT_ID;
  const key = process.env.R2_ACCESS_KEY_ID;
  const sec = process.env.R2_SECRET_ACCESS_KEY;
  if (!id || !key || !sec) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${id}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: key, secretAccessKey: sec },
  });
}

async function r2GetMeta(s3, bucket) {
  try {
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    const r = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: R2_KEY }));
    return r.LastModified;
  } catch { return null; }
}

async function r2Download(s3, bucket) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: R2_KEY }));
  const chunks = [];
  for await (const chunk of r.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function r2Upload(s3, bucket, filePath) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const body = fs.readFileSync(filePath);
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: R2_KEY,
    Body: body, ContentType: 'application/octet-stream',
  }));
  console.log('[geoip] uploaded mmdb to R2 cache');
}

// ─── main ────────────────────────────────────────────────────────────────────

(async () => {
  // If local file is fresh (< MAX_AGE_DAYS), nothing to do.
  if (ageInDays(DB_PATH) < MAX_AGE_DAYS) {
    return done('[geoip] local database is fresh, skipping download');
  }

  const s3     = r2Client();
  const bucket = process.env.R2_BUCKET;

  // Try R2 cache first (fast, free, no MaxMind rate limit).
  if (s3 && bucket) {
    try {
      const lastMod = await r2GetMeta(s3, bucket);
      if (lastMod) {
        const ageDays = (Date.now() - new Date(lastMod).getTime()) / (1000 * 60 * 60 * 24);
        if (ageDays < MAX_AGE_DAYS) {
          console.log(`[geoip] downloading mmdb from R2 cache (${ageDays.toFixed(1)} days old)…`);
          ensureDir();
          const buf = await r2Download(s3, bucket);
          fs.writeFileSync(DB_PATH, buf);
          const mb = (buf.length / 1024 / 1024).toFixed(1);
          return done(`[geoip] restored from R2 cache (${mb} MB)`);
        }
        console.log('[geoip] R2 cache is stale, re-downloading from MaxMind…');
      } else {
        console.log('[geoip] no R2 cache found, downloading from MaxMind…');
      }
    } catch (err) {
      console.warn('[geoip] R2 cache read failed:', err.message, '— falling back to MaxMind');
    }
  }

  // Fall back to MaxMind (once per MAX_AGE_DAYS across all containers).
  if (!LICENSE_KEY) return done('[geoip] MAXMIND_LICENSE_KEY not set, skipping download');

  try {
    const url = `https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${encodeURIComponent(LICENSE_KEY)}&suffix=tar.gz`;
    console.log('[geoip] downloading from MaxMind…');
    const tarBuf = await downloadUrl(url);
    await extractMmdb(tarBuf);

    // Cache in R2 so future container restarts skip MaxMind.
    if (s3 && bucket) {
      await r2Upload(s3, bucket, DB_PATH).catch(e => console.warn('[geoip] R2 upload failed:', e.message));
    }
    done('[geoip] download complete');
  } catch (err) {
    fail(err.message);
  }
})();
