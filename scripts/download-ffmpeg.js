// Downloads a static ffmpeg binary to /tmp/ffmpeg if not already present.
// Uses John Van Sickle's static builds (https://johnvansickle.com/ffmpeg/).
// Always exits 0 — a missing ffmpeg just disables the social clips feature gracefully.

const fs   = require('fs');
const https = require('https');
const path  = require('path');
const { execSync } = require('child_process');

const DEST = process.env.FFMPEG_PATH || '/tmp/ffmpeg';
const URL  = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';

function done(msg) { if (msg) console.log(msg); process.exit(0); }
function fail(msg) { console.warn('[ffmpeg]', msg, '— social clips will be unavailable'); process.exit(0); }

// Already present?
if (fs.existsSync(DEST)) {
  try {
    execSync(`${DEST} -version`, { stdio: 'ignore' });
    return done('[ffmpeg] binary already present and working');
  } catch {
    fs.unlinkSync(DEST); // corrupted — re-download
  }
}

// Already in PATH?
try {
  const which = execSync('which ffmpeg 2>/dev/null').toString().trim();
  if (which) {
    console.log('[ffmpeg] found system ffmpeg at', which, '— skipping download');
    // symlink or copy to DEST so server.js always uses FFMPEG_PATH
    try { fs.symlinkSync(which, DEST); } catch {}
    return done();
  }
} catch {}

console.log('[ffmpeg] downloading static binary from johnvansickle.com…');

const tmpTar = DEST + '.tar.xz';

function get(url, dest, cb, redirects) {
  if (redirects > 5) return fail('too many redirects');
  const req = https.get(url, res => {
    if (res.statusCode >= 300 && res.headers.location) {
      res.resume();
      return get(res.headers.location, dest, cb, redirects + 1);
    }
    if (res.statusCode !== 200) {
      res.resume();
      return fail('HTTP ' + res.statusCode);
    }
    const out = fs.createWriteStream(dest);
    res.pipe(out);
    out.on('finish', () => { out.close(); cb(); });
    out.on('error', e => fail(e.message));
  });
  req.on('error', e => fail(e.message));
  req.setTimeout(120000, () => { req.destroy(); fail('timeout'); });
}

get(URL, tmpTar, () => {
  try {
    const tmpDir = DEST + '_extract';
    fs.mkdirSync(tmpDir, { recursive: true });
    execSync(`tar -xJf ${tmpTar} -C ${tmpDir} --wildcards '*/ffmpeg' --strip-components=1`, { timeout: 60000 });
    const extracted = path.join(tmpDir, 'ffmpeg');
    if (!fs.existsSync(extracted)) throw new Error('ffmpeg not found in archive');
    fs.renameSync(extracted, DEST);
    fs.chmodSync(DEST, 0o755);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.unlinkSync(tmpTar);
    done(`[ffmpeg] downloaded static binary to ${DEST}`);
  } catch(e) {
    fail(e.message);
  }
}, 0);
