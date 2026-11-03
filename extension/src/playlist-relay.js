// The other half of page-playlists.js, in the extension's isolated world: that
// script can see the playlists and cannot reach the worker, and this one is
// the other way round.

document.addEventListener('universal-downloader-playlist', (event) => {
  let found;
  try {
    found = JSON.parse(event.detail);
  } catch {
    return;
  }
  chrome.runtime.sendMessage({ action: 'playlist', url: found?.url, text: found?.text }).catch(() => {});
});
