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

  // Scroll to load all videos (infinite scroll)
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async () => {
      let last = 0, attempts = 0;
      while (attempts < 15) {
        window.scrollTo(0, document.body.scrollHeight);
        await new Promise(r => setTimeout(r, 1500));
        const cur = document.querySelectorAll('a[href*="/video/"]').length;
        if (cur === last) { attempts++; } else { attempts = 0; }
        last = cur;
        if (attempts >= 2) break;
      }
      window.scrollTo(0, 0);
    }
  });

  await sleep(500);

  const [{result}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const linkEls = [...document.querySelectorAll('a[href*="/video/"]')];
      const videos = [];

      const seen = new Set();
      for (const linkEl of linkEls) {
        const url = linkEl.href;
        const videoId = url.match(/\/video\/(\d+)/)?.[1];
        if (!videoId || seen.has(videoId)) continue;
        seen.add(videoId);

        // Walk up until this container has exactly one video link
        let row = linkEl.parentElement;
        while (row && row !== document.body) {
          if (row.querySelectorAll('a[href*="/video/"]').length === 1) {
            const txt = row.innerText || '';
            if (txt.split('\n').length > 3) break;
          }
          row = row.parentElement;
        }

        // Stats appear after "Alla" (Swedish for "All" = Public privacy setting)
        const parts = (row?.innerText || '').split('\n').map(t => t.trim()).filter(Boolean);
        const allaIdx = parts.findIndex(p => p === 'Alla' || p.startsWith('Alla '));
        let views = 0, likes = 0, comments = 0;
        if (allaIdx >= 0) {
          const nums = parts.slice(allaIdx + 1).filter(t => /^\d+$/.test(t)).map(Number);
          views = nums[0] || 0; likes = nums[1] || 0; comments = nums[2] || 0;
        }

        videos.push({ url, videoId, views, likes, comments });
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
