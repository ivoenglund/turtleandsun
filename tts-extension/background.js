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
  if (message.type === 'FETCH_TIKTOK_FOLLOWERS') {
    scrapeTikTokFollowers().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

// ── TikTok follower count scraper ────────────────────────────────────────────
// Studio home -> find own @username -> profile page -> followers-count element.

async function scrapeTikTokFollowers() {
  // 1. Find the username via TikTok Studio (any page there links to the profile).
  const studioTab = await chrome.tabs.create({ url: 'https://www.tiktok.com/tiktokstudio', active: false });
  await waitForTabLoad(studioTab.id);
  await sleep(2500);
  const [{ result: username }] = await chrome.scripting.executeScript({
    target: { tabId: studioTab.id },
    func: () => {
      const a = [...document.querySelectorAll('a[href*="/@"]')]
        .map(x => (x.getAttribute('href').match(/\/@([\w.\-]+)/) || [])[1])
        .filter(Boolean);
      return a[0] || null;
    },
  });
  try { await chrome.tabs.remove(studioTab.id); } catch (e) {}
  if (!username) return { ok: false, error: 'username not found in Studio' };

  // 2. Profile page carries the follower count.
  const profTab = await chrome.tabs.create({ url: 'https://www.tiktok.com/@' + username, active: false });
  await waitForTabLoad(profTab.id);
  await sleep(2500);
  const [{ result: followers }] = await chrome.scripting.executeScript({
    target: { tabId: profTab.id },
    func: () => {
      const parseNum = (t) => {
        t = String(t).replace(/ /g, ' ').trim();
        const m = t.match(/^(\d+(?:[.,]\d+)?)\s*(k|m|tn|mn|md)?$/i);
        if (m) {
          const suf0 = (m[2] || '');
          const frac = (m[1].match(/[.,](\d+)$/) || [])[1] || '';
          let n = (!suf0 && frac.length === 3)
            ? Number(m[1].replace(/[.,]/g, ''))
            : parseFloat(m[1].replace(',', '.'));
          const suf = suf0.toLowerCase();
          if (suf === 'k' || suf === 'tn') n *= 1e3;
          if (suf === 'm' || suf === 'mn') n *= 1e6;
          if (suf === 'md') n *= 1e9;
          return Math.round(n);
        }
        const plain = t.replace(/[\s.,]/g, '');
        return /^\d+$/.test(plain) && /^[\d\s.,]+$/.test(t) ? Number(plain) : null;
      };
      // Preferred: TikTok's stable data attribute.
      const el = document.querySelector('strong[data-e2e="followers-count"]');
      if (el) { const n = parseNum(el.innerText); if (n !== null) return n; }
      // Fallback: "<number> Followers/Följare" anywhere in the page text.
      const m = (document.body.innerText || '').match(/([\d.,\s]+(?:tn|k|mn|m)?)\s*(followers|följare)/i);
      if (m) { const n = parseNum(m[1]); if (n !== null) return n; }
      return null;
    },
  });
  try { await chrome.tabs.remove(profTab.id); } catch (e) {}
  if (followers === null || followers === undefined) return { ok: false, error: 'followers count not found on profile' };
  return { ok: true, username, followers };
}

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

        // Stats appear after the privacy label. Be tolerant: any UI language,
        // thousand separators ("1 651"), and compact counts ("1,2 tn", "1.2K").
        const parseNum = (t) => {
          t = String(t).replace(/ /g, ' ').trim();
          const m = t.match(/^(\d+(?:[.,]\d+)?)\s*(k|m|tn|mn|md)?$/i);
          if (m) {
            const suf0 = (m[2] || '');
            const frac = (m[1].match(/[.,](\d+)$/) || [])[1] || '';
            // "1,651" with no suffix = thousands separator, not a decimal.
            let n = (!suf0 && frac.length === 3)
              ? Number(m[1].replace(/[.,]/g, ''))
              : parseFloat(m[1].replace(',', '.'));
            const suf = suf0.toLowerCase();
            if (suf === 'k' || suf === 'tn') n *= 1e3;
            if (suf === 'm' || suf === 'mn') n *= 1e6;
            if (suf === 'md') n *= 1e9;
            return Math.round(n);
          }
          const plain = t.replace(/[\s.,]/g, '');
          return /^\d+$/.test(plain) && /^[\d\s.,]+$/.test(t) ? Number(plain) : null;
        };
        const parts = (row?.innerText || '').split('\n').map(t => t.trim()).filter(Boolean);
        const ANCHORS = ['Alla', 'Everyone', 'Offentlig', 'Public', 'Vänner', 'Friends', 'Endast du', 'Only you', 'Privat', 'Private'];
        const anchorIdx = parts.findIndex(p => ANCHORS.some(a => p === a || p.startsWith(a + ' ')));
        let views = 0, likes = 0, comments = 0;
        let nums;
        if (anchorIdx >= 0) {
          nums = parts.slice(anchorIdx + 1).map(parseNum).filter(n => n !== null);
        } else {
          // Layout changed? Fall back to the trailing numeric columns of the row.
          nums = parts.map(parseNum).filter(n => n !== null).slice(-3);
        }
        views = nums[0] || 0; likes = nums[1] || 0; comments = nums[2] || 0;

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
