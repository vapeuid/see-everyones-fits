'use strict';
// Frostbite "native DB" container (layout.toc, initfs) and the data-layer layout it describes.
//
// Every native file starts with a 0x22C-byte envelope (magic 00 D1 CE 01, then a signature area).
// The body is a tree of tagged values: tag & 31 = type, tag & 0x80 clear = the value has a name.
//   1 list, 2 object (varint length + children, a 0 tag ends early); 7 string, 19 blob (varint length);
//   6 bool (1), 8/11 int32 (4), 9/12 int64 (8), 15 guid (16), 16 sha1 (20).
const fs = require('fs');
const path = require('path');
const { fail } = require('./errors');

const ENVELOPE = 0x22C;
const FIXED = { 6: 1, 8: 4, 11: 4, 9: 8, 12: 8, 15: 16, 16: 20 };

function hasEnvelope(buf) {
  return buf.length > ENVELOPE && buf[0] === 0x00 && buf[1] === 0xD1 && buf[2] === 0xCE && buf[3] === 0x01;
}

function readNativeDb(buf, start = ENVELOPE) {
  let p = start;
  let nodes = 0;
  const need = (n) => { if (p + n > buf.length) fail('bad-native-db', 'native DB value runs past the end of the file'); };
  const varint = () => {
    let v = 0;
    for (let shift = 0; shift < 63; shift += 7) {
      need(1);
      const b = buf[p++];
      v += (b & 127) * 2 ** shift;
      if (!(b & 128)) return v;
    }
    return fail('bad-native-db', 'native DB has an invalid length');
  };
  function node(depth) {
    if (depth > 32 || ++nodes > 200000) fail('bad-native-db', 'native DB nests too deeply');
    need(1);
    const tag = buf[p++];
    const type = tag & 31;
    if (!type) return null;
    const n = { type, name: '' };
    if (!(tag & 128)) {
      const end = buf.indexOf(0, p);
      if (end < 0) fail('bad-native-db', 'native DB name is unterminated');
      n.name = buf.toString('latin1', p, end);
      p = end + 1;
    }
    if (type === 1 || type === 2) {
      const size = varint();
      need(size);
      const end = p + size;
      n.children = [];
      while (p < end) { const c = node(depth + 1); if (!c) break; n.children.push(c); }
      p = end;
    } else if (type === 7 || type === 19) {
      const size = varint();
      need(size);
      n.bytes = buf.subarray(p, p + size);
      p += size;
      if (type === 7) n.text = n.bytes.toString('latin1').replace(/\0$/, '');
    } else {
      const size = FIXED[type];
      if (!size) fail('bad-native-db', 'native DB has an unknown value type ' + type);
      need(size);
      n.bytes = buf.subarray(p, p + size);
      p += size;
    }
    return n;
  }
  return node(0);
}

const field = (n, key) => (n && n.children ? n.children.find((c) => c.name === key) : undefined);

// Every cas_NN.cas under <root>/Win32, grouped by folder (relative to Win32, forward slashes).
function archiveDirs(root) {
  const win32 = path.join(root, 'Win32');
  const dirs = new Map();
  (function walk(dir, depth) {
    if (depth > 12) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      const m = /^cas_(\d+)\.cas$/i.exec(e.name);
      if (!m) continue;
      const rel = path.relative(win32, dir).split(path.sep).join('/').toLowerCase();
      if (!dirs.has(rel)) dirs.set(rel, new Set());
      dirs.get(rel).add(Number(m[1]));
    }
  })(win32, 0);
  return dirs;
}

// layout.toc -> { changelist, installChunks: Map(id -> package folder relative to Win32) }.
// Named install chunks come from installManifest; the rest are matched by the set of archives they declare.
function readLayout(root, fallbackRoot) {
  const file = path.join(root, 'layout.toc');
  let buf;
  try { buf = fs.readFileSync(file); } catch (_) { return fail('no-layout', 'layout.toc is missing'); }
  if (!hasEnvelope(buf)) fail('bad-layout', 'layout.toc is not a native file');
  const tree = readNativeDb(buf);
  const chunks = new Map();
  const manifest = field(field(tree, 'installManifest'), 'installChunks');
  for (const e of (manifest && manifest.children) || []) {
    const name = field(e, 'name');
    const index = field(e, 'persistentIndex');
    if (name && name.text && index && index.bytes && index.bytes.length === 4) chunks.set(index.bytes.readUInt32LE(0), name.text.toLowerCase());
  }
  const dirs = archiveDirs(fallbackRoot || root);
  const key = (set) => [...set].sort((a, b) => a - b).join(',');
  const byArchives = new Map();
  for (const [dir, set] of dirs) { const k = key(set); if (!byArchives.has(k)) byArchives.set(k, []); byArchives.get(k).push(dir); }
  for (const name of ['layeredInstallChunkFiles', 'unlayeredInstallChunkFiles']) {
    const n = field(tree, name);
    if (!n || n.type !== 19) continue;
    const declared = new Map();
    for (let a = 0; a + 8 <= n.bytes.length; a += 8) {
      const id = n.bytes.readUInt32LE(a + 2);
      if (!declared.has(id)) declared.set(id, new Set());
      declared.get(id).add(n.bytes.readUInt16LE(a));
    }
    for (const [id, set] of declared) {
      const found = byArchives.get(key(set));
      if (found && found.length === 1 && !chunks.has(id)) chunks.set(id, found[0]);
    }
  }
  const head = field(tree, 'head');
  return { changelist: head && head.bytes && head.bytes.length === 4 ? head.bytes.readUInt32LE(0) : 0, installChunks: chunks };
}

module.exports = { ENVELOPE, hasEnvelope, readNativeDb, field, readLayout };
