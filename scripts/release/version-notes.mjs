// The release page of one version, from what that version itself added.
//
//   node scripts/release/version-notes.mjs 2.9.4 <commit> > notes.md
//
// Until 3.3.0 each docs/releases/<version>.md carried every earlier version's
// items below its own, so a version's own items are the ones its file has and
// the version before it did not. Folded `<details>` blocks of earlier versions
// are dropped too: each version now has a release page of its own.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(root, 'docs', 'releases');
const [version, sha = ''] = process.argv.slice(2);
if (!version) throw new Error('usage: version-notes.mjs <version> [commit]');

const numbers = (name) => name.split('.').map(Number);
const older = (a, b) => {
  const [x, y] = [numbers(a), numbers(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
};
const versions = readdirSync(dir)
  .filter((name) => name.endsWith('.md'))
  .map((name) => name.slice(0, -3))
  .sort(older);
const at = versions.indexOf(version);
if (at < 0) throw new Error(`no docs/releases/${version}.md`);

const halves = (name) => {
  const text = readFileSync(join(dir, `${name}.md`), 'utf8').replace(/\r\n/g, '\n');
  const [turkish = '', english = ''] = text.split(/^## English\s*$/m);
  const fold = (part) => part.replace(/<details>[\s\S]*?<\/details>/g, '').trim();
  return [fold(turkish), fold(english)];
};
const bullets = (part) => new Set(part.split('\n').filter((line) => line.trim().startsWith('- ')));

const own = halves(version);
const before = at > 0 ? halves(versions[at - 1]) : ['', ''];
const [turkish, english] = own.map((part, index) => {
  const carried = bullets(before[index]);
  return part
    .split('\n')
    .filter((line) => !carried.has(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
});

const repo = process.env.GITHUB_REPOSITORY || 'zearkreast/umd-plus';
const built = sha
  ? `Built from <a href="https://github.com/${repo}/commit/${sha}"><code>${sha.slice(0, 7)}</code></a> · `
  : '';
process.stdout.write(`## Yenilikler

${turkish}

<details>
<summary><b>English</b></summary>

${english}

</details>

<sub>Her dosyanın SHA-256 özeti \`SHA256SUMS.txt\` içinde. · ${built}Based on <a href="https://github.com/unsalable/downloader">unsalable/downloader</a> by Melih (MIT)</sub>
`);
