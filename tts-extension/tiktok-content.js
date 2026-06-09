// Runs on tiktok.com/tiktokstudio/upload.
// Receives FILL_TIKTOK from background, drops the video file and fills caption/hashtags.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'FILL_TIKTOK') return;
  fillTikTok(message).then(sendResponse).catch(e => { console.error('[TTS]', e); sendResponse({ ok: false, error: e.message }); });
  return true;
});

async function fillTikTok({ caption, hashtags, videoBytes, filename }) {
  console.log('[TTS] Starting TikTok fill…');

  // ── 1. Build the File object ───────────────────────────────────────────────
  const blob = new Blob([new Uint8Array(videoBytes)], { type: 'video/mp4' });
  const file = new File([blob], filename, { type: 'video/mp4' });
  const dt   = new DataTransfer();
  dt.items.add(file);

  // ── 2. Find the upload drop zone (div.upload is TikTok's container) ────────
  const dropZone = await waitFor('div.upload', 15000);
  console.log('[TTS] Drop zone found');

  // ── 3. Dispatch drag-and-drop events ─────────────────────────────────────
  for (const type of ['dragenter', 'dragover']) {
    dropZone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    await sleep(80);
  }
  dropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  console.log('[TTS] Drop event fired');

  // ── 4. Fallback: set file input via native setter so React sees the change ─
  await sleep(800);
  const fileInput = document.querySelector('input[type="file"]');
  if (fileInput) {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files')?.set;
    if (nativeSetter) nativeSetter.call(fileInput, dt.files);
    else fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    fileInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
    console.log('[TTS] File input fallback triggered');
  }

  // ── 5. Wait for caption editor (appears after TikTok processes the video) ──
  const captionSelectors = [
    '.public-DraftEditor-content',
    '[contenteditable="true"][data-testid*="caption"]',
    '[contenteditable="true"][placeholder]',
    'div[contenteditable="true"]',
  ];

  let captionEl = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(750);
    for (const sel of captionSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) { captionEl = el; break; }
    }
    if (captionEl) break;
  }

  if (!captionEl) {
    showBanner('⚠️ Video dropped — caption field not found. Fill it manually.');
    return { ok: true };
  }
  console.log('[TTS] Caption field found');

  // ── 6. Fill caption + hashtags ─────────────────────────────────────────────
  captionEl.focus();
  await sleep(200);
  const fullText = caption + (hashtags ? '\n\n' + hashtags : '');
  document.execCommand('selectAll', false, null);
  await sleep(100);
  document.execCommand('delete', false, null);
  await sleep(100);
  document.execCommand('insertText', false, fullText);

  if (!captionEl.textContent.trim()) {
    captionEl.innerText = fullText;
    captionEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }

  console.log('[TTS] Done — ready to review and post!');
  showBanner('✅ Turtle & Sun: video dropped + caption filled. Review and click Post!');
  return { ok: true };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function waitFor(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const obs = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) { obs.disconnect(); resolve(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); reject(new Error('Timeout: ' + selector)); }, timeout);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function showBanner(text) {
  const existing = document.getElementById('tts-banner');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'tts-banner';
  div.style.cssText = `
    position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:99999;
    background:#25F4EE;color:#000;font-weight:700;font-size:14px;
    padding:12px 24px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);
  `;
  div.textContent = text;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 10000);
}
