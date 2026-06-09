// Runs on tiktok.com/upload.
// Receives FILL_TIKTOK from background, sets the video file and fills caption/hashtags.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'FILL_TIKTOK') return;
  fillTikTok(message).then(sendResponse).catch(e => { console.error('[TTS]', e); sendResponse({ ok: false, error: e.message }); });
  return true;
});

async function fillTikTok({ caption, hashtags, videoBytes, filename }) {
  console.log('[TTS] Starting TikTok fill…');

  // ── 1. Set the video file ──────────────────────────────────────────────────
  const fileInput = await waitFor('input[type="file"]', 15000);
  const blob = new Blob([new Uint8Array(videoBytes)], { type: 'video/mp4' });
  const file = new File([blob], filename, { type: 'video/mp4' });
  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  console.log('[TTS] Video file set:', filename);

  // ── 2. Wait for the caption editor to appear (after video processes) ───────
  // TikTok uses a Draft.js contenteditable div for the caption
  const captionSelectors = [
    '.public-DraftEditor-content',
    '[contenteditable="true"][data-testid*="caption"]',
    '[contenteditable="true"][placeholder]',
    'div[contenteditable="true"]',
  ];

  let captionEl = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(750);
    for (const sel of captionSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) { captionEl = el; break; }
    }
    if (captionEl) break;
  }

  if (!captionEl) throw new Error('Caption field not found after 30 s');
  console.log('[TTS] Caption field found');

  // ── 3. Type caption + hashtags ─────────────────────────────────────────────
  captionEl.focus();
  await sleep(200);

  const fullText = caption + (hashtags ? '\n\n' + hashtags : '');

  // Clear existing text then insert
  document.execCommand('selectAll', false, null);
  await sleep(100);
  document.execCommand('delete', false, null);
  await sleep(100);
  document.execCommand('insertText', false, fullText);

  // Fallback: set innerText and dispatch input event
  if (!captionEl.textContent.trim()) {
    captionEl.innerText = fullText;
    captionEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }

  console.log('[TTS] Caption filled — ready to review and post!');

  // Flash a banner so user knows it's done
  showBanner('✅ Turtle & Sun: video + caption filled. Review and click Post!');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function waitFor(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const obs = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { obs.disconnect(); resolve(el); }
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
  setTimeout(() => div.remove(), 8000);
}
