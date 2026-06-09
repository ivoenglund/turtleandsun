// Background service worker.
// Handles TikTok upload and TikTok Studio stats scraping.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POST_TIKTOK') {
    handlePostTikTok(message.data).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message.type === 'FETCH_TIKTOK_STUDIO_STATS') {
    scrapeTikTokStudio().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

// ── TikTok upload ─────────────────────────────────────────────────────────────

async function handlePostTikTok(data) {
  const UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload';
  const res = await fetch(data.videoUrl);
  if (!res.ok) throw new Error('Video download failed: ' + res.status);
  const arrayBuffer = await res.arrayBuffer();
  const videoBytes = Array.from(new Uint8Array(arrayBuffer));
  const tabs = await chrome.tabs.query({ url: 'https://www.tiktok.com/tiktokstudio/upload*' });
  let tabId;
  if (tabs.length > 0) {
    tabId = tabs[0].id;
    await chrome.tabs.update(tabId, { active: true });
  } else {
    const tab = await chrome.tabs.create({ url: UPLOAD_URL });
    tabId = tab.id;
    await waitForTabLoad(tabId);
    await sleep(2000);
  }
  await chrome.tabs.sendMessage(tabId, {
    type: 'FILL_TIKTOK',
    caption: data.caption,
    hashtags: data.hashtags,
    videoBytes,
    filename: data.filename || 'clip.mp4',
  });
  return { ok: true };
}

// ── TikTok Studio stats scraper ───────────────────────────────────────────────

async function scrapeTikTokStudio() {
  const STUDIO_URL = 'https://www.tiktok.com/tiktokstudio/content';

  // Check if the tab is already open
  const existing = await chrome.tabs.query({ url: 'https://www.tiktok.com/tiktokstudio/content*' });
  let tab, ownedTab = false;

  if (existing.length > 0) {
    tab = existing[0];
    await chrome.tabs.reload(tab.id);
    await waitForTabLoad(tab.id);
  } else {
    tab = await chrome.tabs.create({ url: STUDIO_URL, active: false });
    ownedTab = true;
    await waitForTabLoad(tab.id);
  }

  // Wait for React/JS to render the video list
  await sleep(3500);

  const [{result}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const linkEls = [...document.querySelectorAll('a[href*="/video/"]')];
      const videos = [];

      for (const linkEl of linkEls) {
        const url = linkEl.href;
        const videoId = url.match(/\/video\/(\d+)/)?.[1];
        if (!videoId) continue;

        // Walk up to find the row container
        let row = linkEl.parentElement;
        for (let i = 0; i < 8 && row && row !== document.body; i++) {
          if (row.innerText && /\d/.test(row.innerText) && row.querySelectorAll('a[href*="/video/"]').length === 1) break;
          row = row.parentElement;
        }

        // Extract all standalone numbers from the row text
        const allText = (row?.innerText || '').split('\n').map(t => t.trim()).filter(Boolean);
        const nums = allText.filter(t => /^\d+$/.test(t)).map(Number);

        videos.push({ url, videoId, views: nums[0] || 0, likes: nums[1] || 0, comments: nums[2] || 0 });
      }
      return videos;
    }
  });

  if (ownedTab) {
    try { await chrome.tabs.remove(tab.id); } catch(e) {}
  }

  return { ok: true, videos: result || [] };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
