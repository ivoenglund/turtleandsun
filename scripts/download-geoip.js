// Downloads the MaxMind GeoLite2 databases (City + ASN) at server start.
// Order of preference per edition: fresh local file -> R2 cache -> MaxMind.
// The ASN edition powers datacenter detection for the "humans only" filter.
const fs   = require('fs');
const path = require('path');
const https = require('https');
const tar   = require('tar');

const GEOIP_DIR   = process.env.GEOIP_DB_PATH
  ? path.dirname(process.env.GEOIP_DB_PATH)
  : path.join(__dirname, '..', 'geoip');
const LICENSE_KEY = process.env.MAXMIND_LICENSE_KEY;
const MAX_AGE_DAYS = 7;

const EDITIONS = [
  { id: 'GeoLite2-City', file: process.env.GEOIP_DB_PATH || path.join(GEOIP_DIR, 'GeoLite2-City.mmdb'), r2Key: 'geoip/GeoLite2-City.mmdb' },
  { id: 'GeoLite2-ASN',  file: process.env.GEOIP_ASN_DB_PATH || path.join(GEOIP_DIR, 'GeoLite2-ASN.mmdb'), r2Key: 'geoip/GeoLite2-ASN.mmdb' },
];

function ageInDays(filePath) {
  try { return (Date.now() - fs.statSync(filePath).mtimeMs) / 86400000; }
  catch { return Infinity; }
}

async function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    function get(u, hops) {
      if (hops > 5) return reject(new Error('too many redirects'));
      const req = https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); return get(res.headers.location, hops + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
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

async function extractMmdb(tarBuffer, edition) {
  fs.mkdirSync(path.dirname(edition.file), { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(path.dirname(edition.file), '.geoip-tmp-'));
  try {
    await new Promise((res, rej) => {
      const stream = tar.x({ cwd: tmpDir, strip: 1, filter: p => p.endsWith('.mmdb') });
      stream.on('finish', res);
      stream.on('error',  rej);
      const { Readable } = require('stream');
      Readable.from(tarBuffer).pipe(stream);
    });
    const extracted = path.join(tmpDir, edition.id + '.mmdb');
    if (!fs.existsSync(extracted)) throw new Error('.mmdb not found in archive');
    fs.renameSync(extracted, edition.file);
    const mb = (fs.statSync(edition.file).size / 1024 / 1024).toFixed(1);
    console.log(`[geoip] extracted ${edition.id}.mmdb (${mb} MB)`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

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

async function r2GetMeta(s3, bucket, key) {
  try {
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    const r = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return r.LastModified;
  } catch { return null; }
}

async function r2Download(s3, bucket, key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of r.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function r2Upload(s3, bucket, key, filePath) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key,
    Body: fs.readFileSync(filePath), ContentType: 'application/octet-stream',
  }));
  console.log(`[geoip] uploaded ${key} to R2 cache`);
}

async function ensureEdition(edition, s3, bucket) {
  if (ageInDays(edition.file) < MAX_AGE_DAYS) {
    console.log(`[geoip] ${edition.id} is fresh, skipping`);
    return;
  }
  if (s3 && bucket) {
    try {
      const lastMod = await r2GetMeta(s3, bucket, edition.r2Key);
      if (lastMod && (Date.now() - new Date(lastMod).getTime()) / 86400000 < MAX_AGE_DAYS) {
        console.log(`[geoip] restoring ${edition.id} from R2 cache…`);
        fs.mkdirSync(path.dirname(edition.file), { recursive: true });
        fs.writeFileSync(edition.file, await r2Download(s3, bucket, edition.r2Key));
        return;
      }
    } catch (err) {
      console.warn(`[geoip] R2 cache read failed for ${edition.id}:`, err.message);
    }
  }
  if (!LICENSE_KEY) { console.log('[geoip] MAXMIND_LICENSE_KEY not set, skipping', edition.id); return; }
  const url = `https://download.maxmind.com/app/geoip_download?edition_id=${edition.id}&license_key=${encodeURIComponent(LICENSE_KEY)}&suffix=tar.gz`;
  console.log(`[geoip] downloading ${edition.id} from MaxMind…`);
  const tarBuf = await downloadUrl(url);
  await extractMmdb(tarBuf, edition);
  if (s3 && bucket) {
    await r2Upload(s3, bucket, edition.r2Key, edition.file).catch(e => console.warn('[geoip] R2 upload failed:', e.message));
  }
}

(async () => {
  const s3     = r2Client();
  const bucket = process.env.R2_BUCKET;
  for (const edition of EDITIONS) {
    try { await ensureEdition(edition, s3, bucket); }
    catch (err) { console.warn(`[geoip] ${edition.id} failed:`, err.message, '— continuing'); }
  }
  process.exit(0);
})();
