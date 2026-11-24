// The metadata web-ext sends to addons.mozilla.org with a new version: its
// release notes, in Turkish and English, from docs/releases/<version>.md.
//
//   node scripts/extension/amo-metadata.mjs 3.3.4 > amo-metadata.json
//
// AMO shows release notes as plain text, so the Markdown marks are taken off.
// A version with no notes file sends none, and AMO shows none.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = process.argv[2];
if (!version) throw new Error('usage: amo-metadata.mjs <version>');

const file = join(root, 'docs', 'releases', `${version}.md`);
if (!existsSync(file)) {
  process.stdout.write('{}\n');
  process.exit(0);
}

const plain = (part) =>
  part
    .replace(/<details>[\s\S]*?<\/details>/g, '')
    .split('\n')
    .map((line) =>
      line
        .replace(/^#{1,6}\s*/, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/^- /, '• ')
        .trimEnd(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const [turkish = '', english = ''] = readFileSync(file, 'utf8')
  .replace(/\r\n/g, '\n')
  .split(/^## English\s*$/m)
  .map(plain);

const notes = {};
if (turkish) notes.tr = turkish;
if (english) notes['en-US'] = english;
process.stdout.write(`${JSON.stringify({ version: { release_notes: notes } }, null, 2)}\n`);
