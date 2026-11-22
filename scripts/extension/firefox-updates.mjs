// The update manifest a self-distributed Firefox add-on is checked against:
// the unlisted build carries its address as `update_url` (pack.mjs), and
// Firefox reads it now and then to learn of a newer signed file.
//
//   node scripts/extension/firefox-updates.mjs <manifest.json> <signed.xpi> <link>
//
// The link is where that signed file is downloaded from; its SHA-256 goes
// beside it, so a file swapped in under the same name is refused.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [manifestPath, xpiPath, link] = process.argv.slice(2);
if (!manifestPath || !xpiPath || !link?.startsWith('https://')) {
  throw new Error('usage: firefox-updates.mjs <manifest.json> <signed.xpi> <https link>');
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const id = manifest.browser_specific_settings?.gecko?.id;
if (!id) throw new Error(`${manifestPath} names no Firefox id`);
const hash = createHash('sha256').update(readFileSync(xpiPath)).digest('hex');

const updates = {
  addons: {
    [id]: {
      updates: [{ version: manifest.version, update_link: link, update_hash: `sha256:${hash}` }],
    },
  },
};
process.stdout.write(`${JSON.stringify(updates, null, 2)}\n`);
