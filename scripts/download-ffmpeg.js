// Downloads a static ffmpeg binary to /tmp/ffmpeg if not already present.
// Tries multiple sources in order. Always exits 0.

const fs   = require('fs');
const https = require('https');
const path  = require('path');
const { execSync, spawnSync } = require('child_process');

const DEST = process.env.FFMPEG_PATH || '/tmp/ffmpeg';

function done(msg) { if (msg) console.log(msg); process.exit(0); }
function fail(msg) { console.warn('[ffmpeg]', msg); process.exit(0); }

// Already present and working?
if (fs.existsSync(DEST)) {
  const r = spawnSync(DEST, ['-version'], { timeout: 5000 });
  if (r.status === 0) return done('[ffmpeg] binary already present and working');
  fs.unlinkSync(DEST);
}

// Check if already in PATH (e.g. installed by nixpacks)
try {
  const which = execSync('which ffmpeg 2>/dev/null').toString().trim();
  if (which && fs.existsSync(which)) {
    console.log('[ffmpeg] found system ffmpeg at', which);
    try { fs.symlinkSync(which, DEST); } catch { try { fs.copyFileSync(which, DEST); fs.chmodSync(DEST, 0o755); } catch {} }
    return done('[ffmpeg] linked system ffmpeg to ' + DEST);
  }
} catch {}

// Try to find ffmpeg in nix store
try {
  const nixPath = execSync('find /nix -name ffmpeg -type f 2>/dev/null | head -1').toString().trim();
  if (nixPath && fs.existsSync(nixPath)) {
    console.log('[ffmpeg] found nix ffmpeg at', nixPath);
    try { fs.symlinkSync(nixPath, DEST); } catch { try { fs.copyFileSync(nixPath, DEST); fs.chmodSync(DEST, 0o755); } catch {} }
    return done('[ffmpeg] linked nix ffmpeg to ' + DEST);
  }
} catch {}

// Download from GitHub (ffbinaries — zip with single binary, no deps)
const SOURCES = [
  'https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v4.4.1/ffmpeg-4.4.1-linux-64.zip',
];

console.log('[ffmpeg] downloading static binary from GitHub...');

function get(url, cb, redirects) {
  if (redirects > 8) return fail('too many redirects');
  const req = https.get(url, { headers: { 'User-Agent': 'turtleandsun/1.0' } }, res => {
    if (res.statusCode >= 300 && res.headers.location) {
      res.resume();
      return get(res.headers.location, cb, redirects + 1);
    }
    if (res.statusCode !== 200) { res.resume(); return fail('HTTP ' + res.statusCode + ' from ' + url); }
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => cb(Buffer.concat(chunks)));
    res.on('error', e => fail(e.message));
  });
  req.on('error', e => fail(e.message));
  req.setTimeout(90000, () => { req.destroy(); fail('timeout downloading ffmpeg'); });
}

get(SOURCES[0], (zipBuf) => {
  // Unzip using Node's built-in zlib... but zip needs inflate, not gzip.
  // Use Python to unzip since it's guaranteed available on Railway/Linux.
  const tmpZip = DEST + '.zip';
  const tmpDir = DEST + '_unzip';
  try {
    fs.writeFileSync(tmpZip, zipBuf);
    fs.mkdirSync(tmpDir, { recursive: true });
    const r = spawnSync('python3', ['-c', `
import zipfile, os, shutil
with zipfile.ZipFile('${tmpZip}', 'r') as z:
    z.extractall('${tmpDir}')
# find ffmpeg binary
for root, dirs, files in os.walk('${tmpDir}'):
    for f in files:
        if f == 'ffmpeg':
            src = os.path.join(root, f)
            shutil.copy2(src, '${DEST}')
            os.chmod('${DEST}', 0o755)
            print('extracted', src)
            exit(0)
print('ffmpeg not found in zip')
exit(1)
`], { timeout: 30000 });
    if (r.status !== 0) throw new Error('unzip failed: ' + (r.stderr||'').toString());
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.unlinkSync(tmpZip);
    const mb = (fs.statSync(DEST).size / 1024 / 1024).toFixed(1);
    done(`[ffmpeg] downloaded and extracted (${mb} MB) to ${DEST}`);
  } catch(e) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(tmpZip); } catch {}
    fail(e.message);
  }
}, 0);
