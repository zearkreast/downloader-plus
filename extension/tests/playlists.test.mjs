// Unit tests for extension/src/page-playlists.js, which runs in the page: loaded
// here into a bare context with a stand-in for each browser call it wraps.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const { describe, test } = process.env.VITEST ? await import('vitest') : await import('node:test');

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'src', 'page-playlists.js'), 'utf8');

const PLAYLIST = '#EXTM3U\n#EXTINF:4,\nsegment.ts\n';

function page(fetchAnswer) {
  const reported = [];
  class FakeXhr {
    listeners = [];
    addEventListener(name, listener) {
      this.listeners.push([name, listener]);
    }
    send() {
      this.sent = true;
    }
    finish() {
      for (const [name, listener] of this.listeners) if (name === 'load') listener();
    }
  }
  const window = {
    fetch: () => (fetchAnswer instanceof Error ? Promise.reject(fetchAnswer) : Promise.resolve(fetchAnswer)),
  };
  const context = {
    window,
    XMLHttpRequest: FakeXhr,
    TextDecoder,
    Uint8Array,
    JSON,
    CustomEvent: class {
      constructor(name, init) {
        this.detail = init.detail;
      }
    },
    document: {
      dispatchEvent(event) {
        reported.push(JSON.parse(event.detail));
      },
    },
  };
  vm.runInNewContext(source, context);
  return { window, FakeXhr, reported };
}

function xhr(FakeXhr, fields) {
  const request = new FakeXhr();
  Object.assign(request, { status: 200, responseType: '', responseURL: 'https://cdn.example/a.txt' }, fields);
  request.send();
  request.finish();
  return request;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('the playlists a player receives', () => {
  test('a script request keeps its answer, whatever the file is called', () => {
    const { FakeXhr, reported } = page();
    const request = xhr(FakeXhr, { responseText: PLAYLIST });
    assert.equal(request.sent, true);
    assert.deepEqual(reported, [{ url: 'https://cdn.example/a.txt', text: PLAYLIST }]);
  });

  test('a playlist fetched as bytes is read too', () => {
    const { FakeXhr, reported } = page();
    const bytes = new TextEncoder().encode(PLAYLIST);
    xhr(FakeXhr, { responseType: 'arraybuffer', response: bytes.buffer.slice(0, bytes.byteLength) });
    assert.equal(reported[0].text, PLAYLIST);
  });

  test('anything else goes past', () => {
    const { FakeXhr, reported } = page();
    xhr(FakeXhr, { responseText: '<html>' });
    xhr(FakeXhr, { responseText: PLAYLIST, status: 404 });
    xhr(FakeXhr, { responseType: 'arraybuffer', response: new Uint8Array(64).buffer });
    xhr(FakeXhr, { responseType: 'blob', response: {} });
    assert.deepEqual(reported, []);
  });

  test('a buffer already passed to a worker breaks nothing', () => {
    const { FakeXhr } = page();
    const moved = new ArrayBuffer(64);
    structuredClone(moved, { transfer: [moved] });
    assert.doesNotThrow(() => xhr(FakeXhr, { responseType: 'arraybuffer', response: moved }));
  });

  test('fetch hands the page its own response, body unread', async () => {
    const answer = new Response(PLAYLIST, { headers: { 'content-type': 'text/plain' } });
    Object.defineProperty(answer, 'url', { value: 'https://cdn.example/b.txt' });
    const { window, reported } = page(answer);

    const received = await window.fetch('b.txt');
    assert.equal(received, answer);
    await settled();
    assert.equal(await received.text(), PLAYLIST);
    await settled();
    assert.deepEqual(reported, [{ url: 'https://cdn.example/b.txt', text: PLAYLIST }]);
  });

  test('fetch never reads a type a playlist does not come in', async () => {
    const answer = new Response('{}', { headers: { 'content-type': 'application/json' } });
    const clone = answer.clone;
    let cloned = false;
    answer.clone = function () {
      cloned = true;
      return clone.call(this);
    };
    const { window } = page(answer);
    await window.fetch('b.json');
    await settled();
    assert.equal(cloned, false);
  });

  test('a long text answer is let go at its first bytes', async () => {
    const answer = new Response('not a playlist, and the rest of it never read', {
      headers: { 'content-type': 'text/plain' },
    });
    const { window, reported } = page(answer);
    await window.fetch('c.txt');
    await settled();
    assert.deepEqual(reported, []);
  });

  test('a failed fetch still fails for the page', async () => {
    const { window, reported } = page(new Error('offline'));
    await assert.rejects(() => window.fetch('x'), /offline/);
    assert.deepEqual(reported, []);
  });
});
