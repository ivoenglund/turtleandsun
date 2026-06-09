// Turtle & Sun — TikTok local helper
// Saves videos from the admin panel straight to C:\TikTok
// Run once: node helper.js  (or double-click start.bat)

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const SAVE_DIR = 'C:\\TikTok';
const PORT     = 3999;

if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed   = url.parse(req.url, true);
  const videoUrl = parsed.query.url;
  const filename = (parsed.query.filename || 'video.mp4').replace(/[^a-z0-9._-]/gi, '_');
  const savePath = path.join(SAVE_DIR, filename);

  if (parsed.pathname !== '/save' || !videoUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Missing url param' }));
    return;
  }

  console.log('Saving:', filename, '→', savePath);
  const file = fs.createWriteStream(savePath);

  https.get(videoUrl, (response) => {
    response.pipe(file);
    file.on('finish', () => {
      file.close();
      console.log('Done:', savePath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: savePath, filename }));
    });
  }).on('error', (err) => {
    fs.unlink(savePath, () => {});
    console.error('Error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  });

}).listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('✅ TikTok helper is running');
  console.log('   Videos will be saved to: ' + SAVE_DIR);
  console.log('   Listening on port ' + PORT);
  console.log('');
  console.log('Keep this window open while you work.');
});
