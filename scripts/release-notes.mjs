// The text of the release page, from .github/release-template.md and what is
// new in this version, docs/releases/<version>.md.
//
//   node scripts/release-notes.mjs > notes.md
//
// The version comes from tauri.conf.json, the repository and the commit from
// GITHUB_REPOSITORY and GITHUB_SHA (or the local checkout). CHANGES, when set,
// stands in for the Turkish part of the version's file.
//
// The version's file has a Turkish part and, after a line `## English`, an
// English one. Without a file the page links to the commits instead.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const version = JSON.parse(read('src-tauri/tauri.conf.json')).version;
const repo = process.env.GITHUB_REPOSITORY || 'zearkreast/downloader-plus';
const sha = process.env.GITHUB_SHA || execSync('git rev-parse HEAD', { cwd: root }).toString().trim();

const changesFile = `docs/releases/${version}.md`;
const [turkish = '', english = ''] = existsSync(join(root, changesFile))
  ? read(changesFile).split(/^## English\s*$/m).map((part) => part.trim())
  : [];
const commits = `https://github.com/${repo}/commits/${sha}`;
const changes = process.env.CHANGES?.trim() || turkish || `Değişiklikler için [commit geçmişine](${commits}) bakın.`;
const changesEn = english || `See [the commits](${commits}) for what changed.`;

const values = {
  version,
  repo,
  sha,
  short: sha.slice(0, 7),
  // The default branch rather than this commit: one release is replaced in
  // place, and its pictures should follow the newest files.
  raw: `https://raw.githubusercontent.com/${repo}/main`,
  download: `https://github.com/${repo}/releases/latest/download`,
  changes,
  changes_en: changesEn,
};

const page = read('.github/release-template.md').replace(/\{\{(\w+)\}\}/g, (whole, key) => {
  if (!(key in values)) throw new Error(`unknown placeholder ${whole} in the release template`);
  return values[key];
});
process.stdout.write(page);
