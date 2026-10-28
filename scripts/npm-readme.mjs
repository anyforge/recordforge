// Strips GitHub-only sections (hero images + Sponsor) from the READMEs so the
// npm tarball ships a clean readme without personal payment codes. Wired via
// package.json `prepack` (strip) and `postpack` (restore).
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const FILES = ['README.md', 'README.zh-CN.md'];
// Backup into node_modules (never packed) so the raw READMEs with payment codes
// never leak into the npm tarball.
const bakDir = path.join(root, 'node_modules', '.recordforge-npm-bak');
const bak = (f) => path.join(bakDir, f);

function strip(text) {
  // drop the two hero image paragraphs
  text = text.replace(/^\s*<p align="center">\s*<img[^\n]*>\s*<\/p>\s*$/gm, '');
  // drop the Sponsor / 赞助 section (heading to end of file)
  text = text.replace(/\n+## Sponsor\n[\s\S]*$/, '\n');
  text = text.replace(/\n+## 赞助\n[\s\S]*$/, '\n');
  // collapse runs of blank lines
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trimEnd() + '\n';
}

const mode = process.argv[2];
for (const f of FILES) {
  const p = path.join(root, f);
  if (mode === 'strip') {
    mkdirSync(bakDir, { recursive: true });
    if (existsSync(bak(f))) throw new Error('stale backup exists: ' + bak(f));
    renameSync(p, bak(f));
    writeFileSync(p, strip(readFileSync(bak(f), 'utf8')));
    console.log('stripped', f);
  } else if (mode === 'restore') {
    if (existsSync(bak(f))) {
      renameSync(bak(f), p);
      console.log('restored', f);
    }
  } else {
    console.error('usage: npm-readme.mjs <strip|restore>');
    process.exit(1);
  }
}
