'use strict';
// The retail item catalogue from ReSkate's content cache (a folder of *.cache files the ReSkate launcher
// installs per game build). Each file is a stream of varint-length-prefixed protobuf records; an owned
// item record has field 6 = presentation {2 title, 3 description, 10 asset id "own_..."} and field 23 = rarity.
// Optional: without it, names fall back to the item key.
const fs = require('fs');
const path = require('path');

function varint(b, s) {
  let v = 0;
  for (let shift = 0; shift < 64; shift += 7) {
    if (s.at >= b.length) return -1;
    const x = b[s.at++];
    v += (x & 127) * 2 ** shift;
    if (!(x & 128)) return v;
  }
  return -1;
}
function fields(b) {
  const out = [], s = { at: 0 };
  while (s.at < b.length) {
    const key = varint(b, s);
    if (key < 0) return null;
    const number = Math.floor(key / 8), wire = key % 8;
    if (wire === 0) { if (varint(b, s) < 0) return null; }
    else if (wire === 2) { const n = varint(b, s); if (n < 0 || s.at + n > b.length) return null; out.push({ number, bytes: b.subarray(s.at, s.at + n) }); s.at += n; }
    else if (wire === 1) s.at += 8;
    else if (wire === 5) s.at += 4;
    else return null;
  }
  return s.at === b.length ? out : null;
}
const first = (f, n) => f.find((x) => x.number === n);

// -> Map(lower-case key -> { title, rarity }); empty when the folder is missing or unreadable.
function readCatalog(dir) {
  const items = new Map();
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.cache')).sort(); } catch (_) { return items; }
  for (const name of names) {
    let b;
    try { b = fs.readFileSync(path.join(dir, name)); } catch (_) { continue; }
    const s = { at: 0 };
    while (s.at < b.length) {
      const n = varint(b, s);
      if (n <= 0 || s.at + n > b.length) break;
      const rec = b.subarray(s.at, s.at + n);
      s.at += n;
      const f = fields(rec);
      const pres = f && first(f, 6);
      const pf = pres && fields(pres.bytes);
      const asset = pf && first(pf, 10);
      if (!asset) continue;
      const key = asset.bytes.toString('utf8').toLowerCase();
      if (!key.startsWith('own_') || items.has(key)) continue;
      const title = first(pf, 2), rarity = first(f, 23);
      items.set(key, { title: title ? title.bytes.toString('utf8') : null, rarity: rarity ? rarity.bytes.toString('utf8') : null });
    }
  }
  return items;
}

module.exports = { readCatalog };
