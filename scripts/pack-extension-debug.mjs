// Unpacked copies of the connector for the debug edition of the app (the
// `debug-edition` feature in src-tauri/Cargo.toml), one per browser family:
//
//   node scripts/pack-extension-debug.mjs
//
// writes src-tauri/target/debug/extension-debug/chromium and .../firefox, beside
// the debug build that answers them. Each is the full build, as
// `pack-extension.mjs --full` packs it, with three changes so it can sit beside
// the copy from a store and reach the test app alone: `connectNative` names the
// debug host, the Firefox copy has an id of its own, and the name says Debug.
// The Chromium copy keeps the manifest's `key`, which pins the development id
// the host lets in.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'extension');
const output = join(root, 'src-tauri', 'target', 'debug', 'extension-debug');

// Mirrors of the constants behind `debug-edition` in
// src-tauri/src/bridge/protocol.rs.
const HOST_NAME = 'com.universaldownloader.bridge';
const DEBUG_HOST_NAME = 'com.universaldownloader.bridge.debug';
const DEBUG_FIREFOX_ID = 'connector-debug@universaldownloader.app';

const EXCLUDED = new Set([
  'key.pem',
  'make-icons.mjs',
  'README.md',
  'PRIVACY.md',
  'PRIVACY-CHROME.md',
  'STORE-LISTING.md',
  '.gitignore',
]);

function collect(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (EXCLUDED.has(name) || name.endsWith('.zip') || /\.test\.[cm]?js$/.test(name)) return [];
    return statSync(full).isDirectory() ? collect(full) : [full];
  });
}

function forFirefox(manifest) {
  delete manifest.key;
  delete manifest.minimum_chrome_version;
  manifest.background = { scripts: ['background.js'], type: 'module' };
  manifest.browser_specific_settings = {
    gecko: {
      id: DEBUG_FIREFOX_ID,
      strict_min_version: '140.0',
      data_collection_permissions: { required: ['none'] },
    },
  };
  return manifest;
}

function contentsOf(name, raw, firefox) {
  if (name === 'manifest.json') {
    const manifest = JSON.parse(raw.toString('utf8'));
    return `${JSON.stringify(firefox ? forFirefox(manifest) : manifest, null, 2)}\n`;
  }
  if (name === 'background.js') {
    const text = raw.toString('utf8');
    const line = `const HOST_NAME = '${HOST_NAME}';`;
    if (!text.includes(line)) throw new Error(`background.js no longer says ${line}`);
    return text.replace(line, `const HOST_NAME = '${DEBUG_HOST_NAME}';`);
  }
  if (/^_locales\/[^/]+\/messages\.json$/.test(name)) {
    const messages = JSON.parse(raw.toString('utf8'));
    messages.extName.message += ' (Debug)';
    return `${JSON.stringify(messages, null, 2)}\n`;
  }
  return raw;
}

const files = collect(source).sort();
for (const [family, firefox] of [['chromium', false], ['firefox', true]]) {
  const target = join(output, family);
  rmSync(target, { recursive: true, force: true });
  for (const file of files) {
    const name = relative(source, file).split(sep).join('/');
    const destination = join(target, ...name.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contentsOf(name, readFileSync(file), firefox));
  }
  console.log(`${files.length} files -> ${target}`);
}
