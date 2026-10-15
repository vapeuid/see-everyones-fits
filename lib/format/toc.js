'use strict';
// Superbundle TOC, bundle region and binary bundle manifest.
//
// TOC (after the 0x22C envelope, big-endian): bundle hash/data offsets, bundle count, chunk hash/guid
// offsets, chunk count, names offset, chunk data offset, data word count, flags. Flag bit 2 means the
// bundle names are Huffman-compressed (the base game's TOCs); without it they are plain C strings.
// Bundle rows: {u32 name, u32 size | loadFlag << 30, u64 region offset}. Chunk rows: byte-reversed
// GUID + i32 (-1 removed, else 0x80 << 24 | index of 4 words {id hi, id lo, offset, size}).
// A location id packs patch << 48 | install chunk << 16 | archive; patch = the file lives in the mod layer.
const { hasEnvelope, ENVELOPE } = require('./native');
const { fail } = require('./errors');

// Native GUID bytes -> canonical text (the first three fields are stored little-endian).
function guidText(b, at = 0) {
  const h = (i) => (b[at + i] < 16 ? '0' : '') + b[at + i].toString(16);
  return h(3) + h(2) + h(1) + h(0) + '-' + h(5) + h(4) + '-' + h(7) + h(6) + '-' + h(8) + h(9) + '-' +
    h(10) + h(11) + h(12) + h(13) + h(14) + h(15);
}

function location(hi, lo) {
  return { patch: ((hi >>> 16) & 0xFF) !== 0, installChunk: ((hi & 0xFFFF) * 65536 + (lo >>> 16)) >>> 0, archive: lo & 0xFFFF };
}

function huffmanDecoder(d, namesOffset, wordCount, tableOffset, tableCount) {
  if (namesOffset + wordCount * 4 > d.length || tableOffset + tableCount * 4 > d.length) fail('bad-toc', 'TOC name table runs past the end');
  const words = new Uint32Array(wordCount);
  for (let i = 0; i < wordCount; i++) words[i] = d.readUInt32BE(namesOffset + i * 4);
  // The table lists node values in pairs; each pair becomes a parent numbered by a counter.
  const value = [], left = [], right = [];
  const byValue = new Map();
  let pending = -1, counter = 0, root = -1;
  for (let i = 0; i < tableCount; i++) {
    const v = d.readUInt32BE(tableOffset + i * 4);
    let n = byValue.get(v);
    if (n === undefined) { n = value.length; value.push(v); left.push(-1); right.push(-1); byValue.set(v, n); }
    if (pending < 0) { pending = n; continue; }
    const parent = value.length;
    value.push(counter); left.push(pending); right.push(n);
    if (!byValue.has(counter)) byValue.set(counter, parent);
    root = parent; counter++; pending = -1;
  }
  const bits = wordCount * 32;
  return (bit) => {
    if (root < 0) return '';
    let s = '';
    while (bit < bits) {
      let n = root;
      while (left[n] >= 0) {
        if (bit >= bits) fail('bad-toc', 'TOC bundle name runs past its bit stream');
        n = ((words[bit >>> 5] >>> (bit & 31)) & 1) ? right[n] : left[n];
        bit++;
      }
      const ch = (~value[n]) & 0xFFFF;
      if (ch === 0) return s;
      if (ch > 0x7F) fail('bad-toc', 'TOC bundle name is not ASCII');
      s += String.fromCharCode(ch);
      if (s.length > 1024) fail('bad-toc', 'TOC bundle name is too long');
    }
    return fail('bad-toc', 'TOC bundle name is unterminated');
  };
}

function readToc(buf) {
  if (!hasEnvelope(buf) || buf.length < ENVELOPE + 48) fail('bad-toc', 'not a superbundle TOC');
  const d = buf.subarray(ENVELOPE);
  const u = (o) => d.readUInt32BE(o);
  const bundleData = u(4), bundleCount = d.readInt32BE(8), chunkGuids = u(16), chunkCount = d.readInt32BE(20);
  const namesOffset = u(32), chunkData = u(36), dataCount = d.readInt32BE(40), flags = u(44);
  if (bundleCount < 0 || chunkCount < 0 || dataCount < 0) fail('bad-toc', 'TOC has negative counts');
  if (bundleData + bundleCount * 16 > d.length || (chunkCount && (chunkGuids + chunkCount * 20 > d.length || chunkData + dataCount * 4 > d.length)))
    fail('bad-toc', 'TOC tables run past the end of the file');
  const decode = (flags & 4) ? huffmanDecoder(d, namesOffset, u(48), u(56), u(52)) : null;
  const bundles = [];
  for (let i = 0; i < bundleCount; i++) {
    const o = bundleData + i * 16;
    const nameOffset = u(o), sizeFlag = u(o + 4), regionOffset = Number(d.readBigUInt64BE(o + 8));
    const size = sizeFlag & 0x3FFFFFFF;
    if ((sizeFlag >>> 30) !== 1) fail('bad-toc', 'TOC bundle data outside the TOC is not supported');
    if (regionOffset + size > d.length) fail('bad-toc', 'TOC bundle region runs past the end');
    let name;
    if (decode) name = decode(nameOffset);
    else {
      const start = namesOffset + nameOffset;
      const end = d.indexOf(0, start);
      if (start >= d.length || end < 0) fail('bad-toc', 'TOC bundle name is out of range');
      name = d.toString('latin1', start, end);
    }
    bundles.push({ name, region: d.subarray(regionOffset, regionOffset + size) });
  }
  const chunks = [];
  for (let i = 0; i < chunkCount; i++) {
    const o = chunkGuids + i * 20;
    const g = Buffer.from(d.subarray(o, o + 16)).reverse();
    const enc = d.readInt32BE(o + 16);
    if (enc === -1) { chunks.push({ guid: guidText(g), removed: true }); continue; }
    const w = enc & 0xFFFFFF;
    if ((enc >>> 24) !== 0x80 || w + 4 > dataCount) fail('bad-toc', 'TOC chunk entry is invalid');
    const at = chunkData + w * 4;
    chunks.push({ guid: guidText(g), location: location(u(at), u(at + 4)), offset: u(at + 8), size: u(at + 12) });
  }
  return { flags, bundles, chunks };
}

// Bundle region: where each of the bundle's files is in cas. The first file is normally the manifest.
function readRegion(r) {
  if (r.length < 0x24) fail('bad-bundle', 'bundle region is truncated');
  const metaOffset = r.readInt32BE(0), metaSize = r.readInt32BE(4), locations = r.readUInt32BE(8);
  const total = r.readInt32BE(12), dataOffset = r.readUInt32BE(16);
  if (total < 0 || total !== r.readInt32BE(32) || locations + total > r.length) fail('bad-bundle', 'bundle region header is invalid');
  const files = [];
  let cur = null, p = dataOffset;
  for (let i = 0; i < total; i++) {
    const flag = r[locations + i];
    if (flag === 1) { const e = r.readUInt32BE(p); p += 4; cur = { patch: (e & 0xFF0000) !== 0, installChunk: (e >>> 8) & 0xFF, archive: e & 0xFF }; }
    else if (flag !== 0) { cur = location(r.readUInt32BE(p), r.readUInt32BE(p + 4)); p += 8; }
    if (!cur || p + 8 > r.length) fail('bad-bundle', 'bundle region file table is invalid');
    files.push({ location: cur, offset: r.readUInt32BE(p), size: r.readUInt32BE(p + 4) });
    p += 8;
  }
  const inline = metaSize > 0 && metaOffset > 0 && metaOffset + metaSize <= r.length ? r.subarray(metaOffset, metaOffset + metaSize) : null;
  return { files, inline };
}

const SALT = 0x7065636E, MAGIC = 0xED1CEDB8;
const hex = (b, s, e) => b.toString('hex', s, e);

// Binary bundle manifest: every asset of the bundle (EBX, resources, chunks) with its SHA-1.
function readManifest(data) {
  if (data.length < 36 || data.readUInt32BE(0) !== data.length - 4) fail('bad-manifest', 'bundle manifest size does not match');
  let le = true;
  if (((data.readUInt32LE(4) ^ SALT) >>> 0) !== MAGIC) {
    if (((data.readUInt32BE(4) ^ SALT) >>> 0) !== MAGIC) fail('bad-manifest', 'bundle manifest magic is unknown');
    le = false;
  }
  let p = 8;
  const u = () => { const v = le ? data.readUInt32LE(p) : data.readUInt32BE(p); p += 4; return v; };
  const total = u(), ebxCount = u(), resCount = u(), chunkCount = u();
  const strings = u() + 4; u(); u();
  if (ebxCount + resCount + chunkCount !== total || p + total * 20 + ebxCount * 8 + resCount * 36 + chunkCount * 24 > data.length)
    fail('bad-manifest', 'bundle manifest counts do not fit');
  const sha = [];
  for (let i = 0; i < total; i++) { sha.push(hex(data, p, p + 20)); p += 20; }
  const str = (o) => { const s = strings + o; const e = data.indexOf(0, s); if (s >= data.length || e < 0) fail('bad-manifest', 'bundle manifest name is out of range'); return data.toString('latin1', s, e); };
  const ebx = [], res = [], chunks = [];
  for (let i = 0; i < ebxCount; i++) { const n = u(); const size = u(); ebx.push({ kind: 'ebx', name: str(n), size, sha1: sha[i] }); }
  for (let i = 0; i < resCount; i++) { const n = u(); const size = u(); res.push({ kind: 'res', name: str(n), size, sha1: sha[ebxCount + i] }); }
  for (const r of res) r.type = u() >>> 0;
  for (const r of res) { r.meta = Buffer.from(data.subarray(p, p + 16)); p += 16; }
  for (const r of res) { r.rid = (le ? data.readBigUInt64LE(p) : data.readBigUInt64BE(p)).toString(16); p += 8; }
  for (let i = 0; i < chunkCount; i++) {
    const g = Buffer.from(data.subarray(p, p + 16)); p += 16;
    const guid = guidText(le ? g : g.reverse());
    u(); u();
    chunks.push({ kind: 'chunk', name: guid, guid, sha1: sha[ebxCount + resCount + i] });
  }
  return { ebx, res, chunks };
}

module.exports = { guidText, readToc, readRegion, readManifest };
