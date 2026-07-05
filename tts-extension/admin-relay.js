// Runs on turtleandsun.com/admin/* pages.
// Relays messages between the page and the background service worker.
window.addEventListener('message', (event) => {
  if (event.source !== window) return;

  if (event.data?.type === 'TTS_POST_TIKTOK') {
    chrome.runtime.sendMessage({ type: 'POST_TIKTOK', data: event.data.data }, (response) => {
      window.postMessage({ type: 'TTS_POST_TIKTOK_REPLY', ...response }, '*');
    });
  }

  if (event.data?.type === 'TTS_FETCH_TIKTOK_STATS') {
    chrome.runtime.sendMessage({ type: 'FETCH_TIKTOK_STUDIO_STATS' }, (response) => {
      window.postMessage({ type: 'TTS_FETCH_TIKTOK_STATS_REPLY', ...response }, '*');
    });
  }

  if (event.data?.type === 'TTS_FETCH_TIKTOK_FOLLOWERS') {
    chrome.runtime.sendMessage({ type: 'FETCH_TIKTOK_FOLLOWERS' }, (response) => {
      window.postMessage({ type: 'TTS_FETCH_TIKTOK_FOLLOWERS_REPLY', ...response }, '*');
    });
  }
});
