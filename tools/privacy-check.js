#!/usr/bin/env node
'use strict';
/*
  Stops a release if a file would leak something personal.

    node tools/privacy-check.js [folder]        (default: the repo root)

  Checks every text file for user folders (C:\Users\<name>), IP addresses, e-mail addresses, access tokens, this PC's
  name and user name, and the words in tools/private-words.txt (one per line; that file is never committed or shipped).
  Checks PNG / WebP images for embedded metadata (text, EXIF, XMP). Exit code 1 when anything is found.
*/
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEXT = new Set(['.js', '.json', '.md', '.html', '.css', '.ps1', '.bat', '.cmd', '.txt', '.yml', '.yaml', '']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'research']);
const SKIP_FILES = new Set(['private-words.txt', 'LICENSE', 'node-LICENSE']);   // verbatim licence texts (GPL, Node.js)

function words() {
  const out = [];
  const user = os.userInfo().username;
  if (user && user.length >= 5 && !/^(user|admin|administrator|owner)$/i.test(user)) out.push(user);
  if (os.hostname()) out.push(os.hostname());
  try { for (const w of fs.readFileSync(path.join(__dirname, 'private-words.txt'), 'utf8').split(/\r?\n/)) if (w.trim() && !w.startsWith('#')) out.push(w.trim()); } catch (_) {}
  return [...new Set(out)];
}

const RULES = [
  ['user folder', /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!Public\b|Default\b|<)[A-Za-z0-9._-]+/gi],
  ['OneDrive path', /OneDrive[\\/]/gi],
  ['e-mail address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[A-Za-z]{2,}/g],
  ['access token', /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bpa]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,})\b/g],
];
const IP = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g;
const ALLOWED_IP = new Set(['127.0.0.1', '0.0.0.0']);
const ALLOWED_MAIL = /@(users\.noreply\.github\.com|example\.(com|org))$/i;

function imageMetadata(buf, ext) {
  const found = [];
  if (ext === '.png' && buf.readUInt32BE(0) === 0x89504e47) {
    for (let o = 8; o + 8 <= buf.length;) { const n = buf.readUInt32BE(o), t = buf.toString('ascii', o + 4, o + 8); if (['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(t)) found.push(t); o += 12 + n; }
  }
  if (ext === '.webp' && buf.toString('ascii', 0, 4) === 'RIFF') {
    for (let o = 12; o + 8 <= buf.length;) { const t = buf.toString('ascii', o, o + 4), n = buf.readUInt32LE(o + 4); if (['EXIF', 'XMP '].includes(t)) found.push(t.trim()); o += 8 + n + (n & 1); }
  }
  return found;
}

function check(root) {
  const problems = []; const extra = words();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name), rel = path.relative(root, p);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue; }
      if (SKIP_FILES.has(e.name)) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (ext === '.png' || ext === '.webp') { for (const m of imageMetadata(fs.readFileSync(p), ext)) problems.push(`${rel}: image metadata chunk ${m}`); continue; }
      if (!TEXT.has(ext)) continue;
      const text = fs.readFileSync(p, 'utf8');
      text.split(/\r?\n/).forEach((line, i) => {
        const at = `${rel}:${i + 1}`;
        for (const [what, re] of RULES) for (const m of line.matchAll(re)) if (!(what === 'e-mail address' && ALLOWED_MAIL.test(m[0]))) problems.push(`${at}: ${what}`);
        for (const m of line.matchAll(IP)) if (m.slice(1).every((n) => +n <= 255) && !ALLOWED_IP.has(m[0])) problems.push(`${at}: IP address`);
        const low = line.toLowerCase();
        for (const w of extra) if (low.includes(w.toLowerCase())) problems.push(`${at}: private word #${extra.indexOf(w) + 1}`);
      });
    }
  };
  walk(root);
  return problems;
}

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  const problems = check(root);
  if (problems.length) { console.log(`Privacy check FAILED (${problems.length}):`); for (const p of problems) console.log('  ' + p); process.exit(1); }
  console.log(`Privacy check passed: ${root}`);
}
module.exports = { check };
