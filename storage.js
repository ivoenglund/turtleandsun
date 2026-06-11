// storage.js
//
// File storage abstraction. Currently backed by Cloudflare R2 (S3-compatible).
// Keeps a single `uploadBuffer({ buffer, contentType, kind, key })` entrypoint
// so call sites in server.js stay simple and the provider can be swapped later.
//
// Returns { url, key } where url is the public URL for delivery.
//
// Env vars required:
//   R2_ACCOUNT_ID         Cloudflare account id
//   R2_ACCESS_KEY_ID      R2 API token access key
//   R2_SECRET_ACCESS_KEY  R2 API token secret
//   R2_BUCKET             bucket name (e.g. turtleandsun-media)
//   R2_PUBLIC_URL         public base URL — either an r2.dev subdomain or a
//                         custom domain pointed at the bucket. No trailing slash.

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const path = require('path');

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const BUCKET = process.env.R2_BUCKET;
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');

let client = null;
if (ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) {
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
} else {
  console.warn('[storage] R2 env vars missing — uploads will fail. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL.');
}

// Pick a sensible folder prefix per kind. Keeps the bucket tidy and lets
// future lifecycle rules treat customer uploads and gallery media differently.
function folderFor(kind) {
  switch (kind) {
    case 'upload':              return 'uploads';           // customer-uploaded source photos
    case 'concept_media':       return 'concept-media';     // before/after/example media on concepts
    case 'gallery':             return 'gallery';           // public gallery items
    case 'order':               return 'orders';            // rehosted order outputs (future)
    case 'tiktok-thumbnail':    return 'tiktok-thumbnails'; // branded TikTok thumbnail JPEGs
    default:                    return 'misc';
  }
}

function extFromContentType(ct) {
  if (!ct) return '';
  if (ct.includes('jpeg')) return '.jpg';
  if (ct.includes('png'))  return '.png';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('gif'))  return '.gif';
  if (ct.includes('avif')) return '.avif';
  if (ct.includes('mp4'))  return '.mp4';
  if (ct.includes('quicktime') || ct.includes('mov')) return '.mov';
  if (ct.includes('webm')) return '.webm';
  return '';
}

function uniqueKey({ kind, contentType, originalName, baseName }) {
  const folder = folderFor(kind);
  const random = crypto.randomBytes(8).toString('hex');
  const date = new Date().toISOString().slice(0, 10); // 2026-05-26
  let ext = '';
  if (originalName) ext = path.extname(originalName).toLowerCase();
  if (!ext) ext = extFromContentType(contentType);
  if (baseName) {
    // Human-readable filename prefix (e.g. social clip ref: c38_royal-portrait_dog).
    // A short random suffix keeps regenerated versions from colliding in CDN caches.
    const slug = String(baseName).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    if (slug) return `${folder}/${date}/${slug}_${random.slice(0, 6)}${ext}`;
  }
  return `${folder}/${date}/${random}${ext}`;
}

// Upload a Buffer to R2. Returns { url, key }.
//   kind         — 'upload' | 'concept_media' | 'gallery' | 'order' | other
//   contentType  — MIME type, e.g. 'image/jpeg', 'video/mp4'
//   originalName — original filename, used to pick the extension if MIME is vague
//   baseName     — optional human-readable filename prefix (slugified)
async function uploadBuffer({ buffer, contentType, kind = 'misc', originalName, baseName }) {
  if (!client) throw new Error('R2 storage is not configured (env vars missing)');
  if (!buffer || !buffer.length) throw new Error('uploadBuffer: empty buffer');
  if (!PUBLIC_URL) throw new Error('R2_PUBLIC_URL is not set');

  const key = uniqueKey({ kind, contentType, originalName, baseName });
  await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  }));
  return { url: `${PUBLIC_URL}/${key}`, key };
}

// Convenience wrappers matching the old cloudinary.uploadStream interface
// so existing call sites can swap with minimal code change.
async function uploadStream(buffer, options = {}) {
  // Map cloudinary-style { resource_type } to our kind/contentType pair.
  const isVideo = options.resource_type === 'video';
  const contentType = options.contentType
    || (isVideo ? 'video/mp4' : 'image/jpeg');
  const kind = options.kind || 'misc';
  const originalName = options.originalName;
  const { url } = await uploadBuffer({ buffer, contentType, kind, originalName });
  return { secure_url: url, url }; // cloudinary returns secure_url
}

// Download a remote URL (fal.ai CDN etc.) and store it in R2.
// Returns { url, key } — the R2 public URL.
async function downloadAndStore({ remoteUrl, kind = 'order', orderId = null }) {
  const https = require('https');
  const http  = require('http');
  const urlMod = require('url');

  const parsed = urlMod.parse(remoteUrl);
  const lib = parsed.protocol === 'https:' ? https : http;

  const buffer = await new Promise((resolve, reject) => {
    lib.get(remoteUrl, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });

  const ct = remoteUrl.match(/\.mp4(\?|$)/i)  ? 'video/mp4'
           : remoteUrl.match(/\.webm(\?|$)/i) ? 'video/webm'
           : remoteUrl.match(/\.png(\?|$)/i)  ? 'image/png'
           : remoteUrl.match(/\.webp(\?|$)/i) ? 'image/webp'
           : 'image/jpeg';

  const key = orderId
    ? `orders/${orderId}/${kind === 'order-input' ? 'input' : 'output'}${ct.includes('mp4') ? '.mp4' : ct.includes('webm') ? '.webm' : ct.includes('png') ? '.png' : '.jpg'}`
    : null;

  const result = await uploadBuffer({ buffer, contentType: ct, kind: 'order', originalName: key ? key.split('/').pop() : undefined });
  return { ...result, bytes: buffer.length };
}

// Delete an object from R2 by its public URL or key.
// Returns { ok: true } or throws.
async function deleteFromR2(urlOrKey) {
  if (!s3) throw new Error('R2 not configured');
  let key = urlOrKey;
  if (urlOrKey.startsWith('http')) {
    // Strip the public base URL to get the key
    const base = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
    if (base && urlOrKey.startsWith(base + '/')) {
      key = urlOrKey.slice(base.length + 1);
    } else {
      // Fallback: take everything after the first slash following the host
      const m = urlOrKey.match(/^https?:\/\/[^/]+\/(.+)$/);
      if (!m) throw new Error('Cannot derive R2 key from URL: ' + urlOrKey);
      key = m[1];
    }
  }
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  return { ok: true, key };
}

module.exports = { uploadBuffer, uploadStream, downloadAndStore, deleteFromR2 };
