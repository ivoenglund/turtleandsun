// Runs on turtleandsun.com/admin/* pages.
// Listens for postMessage from the page and relays to the background service worker.
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type === 'TTS_POST_TIKTOK') {
    chrome.runtime.sendMessage({ type: 'POST_TIKTOK', data: event.data.data }, (response) => {
      // Relay response back to page
      window.postMessage({ type: 'TTS_POST_TIKTOK_REPLY', ...response }, '*');
    });
  }
});
