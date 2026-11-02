// Runs in the page, ahead of its scripts. Full build only.
//
// A player whose playlists take a one-use token cannot be asked again, by the
// app or from inside the page, so what it was answered is the only copy. Other
// responses go unread: a playlist is told by its first bytes.
//
// Nothing here can reach the extension, so each playlist goes out in an event
// for playlist-relay.js. A page can send that event too, so the worker believes
// none of it.

(() => {
  const EVENT = 'universal-downloader-playlist';
  const MAX_CHARS = 4 * 1024 * 1024;
  const SIGNATURE = /^﻿?\s*#EXTM3U/;
  const PEEK_BYTES = 16;
  // A playlist comes under its own type or passed off as text. Nothing else is
  // cloned, so a video is never read twice.
  const PLAYLIST_TYPE = /mpegurl|^text\/plain|octet-stream|^$/i;

  function report(url, text) {
    if (!url || text.length > MAX_CHARS || !SIGNATURE.test(text)) return;
    document.dispatchEvent(new CustomEvent(EVENT, { detail: JSON.stringify({ url, text }) }));
  }

  function readXhr(xhr) {
    if (xhr.status < 200 || xhr.status > 299) return;
    if (xhr.responseType === '' || xhr.responseType === 'text') {
      report(xhr.responseURL, xhr.responseText);
    } else if (xhr.responseType === 'arraybuffer' && xhr.response?.byteLength <= MAX_CHARS) {
      const head = new TextDecoder().decode(new Uint8Array(xhr.response, 0, Math.min(PEEK_BYTES, xhr.response.byteLength)));
      if (SIGNATURE.test(head)) report(xhr.responseURL, new TextDecoder().decode(xhr.response));
    }
  }

  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        readXhr(this);
      } catch {
        // A buffer the player has already passed to a worker.
      }
    });
    return send.apply(this, args);
  };

  async function readFetch(response) {
    if (!response.ok || !PLAYLIST_TYPE.test(response.headers.get('content-type') ?? '')) return;
    const reader = response.clone().body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > MAX_CHARS || (text.length >= PEEK_BYTES && !SIGNATURE.test(text))) {
        await reader.cancel();
        return;
      }
    }
    report(response.url, text);
  }

  const original = window.fetch;
  window.fetch = function (...args) {
    const answer = original.apply(this, args);
    // Attached first, so the clone is taken before the page reads the body.
    answer.then(readFetch).catch(() => {});
    return answer;
  };
})();
