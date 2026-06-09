// Background service worker.
// Receives POST_TIKTOK from the admin relay, finds/opens the TikTok upload tab,
// downloads the video, and sends everything to the TikTok content script.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'POST_TIKTOK') return;
  handlePostTikTok(message.data).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
  return true; // async
});

async function handlePostTikTok(data) {
  const UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload';

  // Download video as ArrayBuffer in background (bypasses CORS on content script side)
  const res = await fetch(data.videoUrl);
  if (!res.ok) throw new Error('Video download failed: ' + res.status);
  const arrayBuffer = await res.arrayBuffer();
  const videoBytes = Array.from(new Uint8Array(arrayBuffer)); // serialisable

  // Find existing TikTok upload tab
  const tabs = await chrome.tabs.query({ url: 'https://www.tiktok.com/tiktokstudio/upload*' });

  let tabId;
  if (tabs.length > 0) {
    tabId = tabs[0].id;
    await chrome.tabs.update(tabId, { active: true });
  } else {
    // Open upload page and wait for it to load
    const tab = await chrome.tabs.create({ url: UPLOAD_URL });
    tabId = tab.id;
    await waitForTabLoad(tabId);
    await sleep(2000); // let React render
  }

  // Send data + video bytes to content script
  await chrome.tabs.sendMessage(tabId, {
    type: 'FILL_TIKTOK',
    caption: data.caption,
    hashtags: data.hashtags,
    videoBytes,
    filename: data.filename || 'clip.mp4',
  });

  return { ok: true };
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
