'use strict';
// Bundle-reference tables (resources named *_bundlereftable): which bundle the game loads for a
// character preset. Little-endian layout:
//   +8 lookups ptr, +16 path pool ptr, +24 bundle list ptr, +72 lookup count, +76 bundle count;
//   bundles: {u32 path token, u32 flags} (index 0 is a sentinel);
//   lookups: {u64 FNV-1a-64 of the lower-case path, u32 bundle index, u32 path token}, two rows per
//   preset (full path and leaf name); path tokens: length << 24 | inline flag 0x800000 | pool offset,
//   each descriptor {u32 parent token, text} so paths share their prefixes.
// A bundle name here is the TOC bundle name without "win32/" and "_cas_main_bundlereftable".
const { fail } = require('./errors');

function readRefTable(d) {
  if (d.length < 0x100) fail('bad-reftable', 'bundle-reference table is truncated');
  const payload = d.length - 20;
  const ptr = (o) => { const v = Number(d.readBigUInt64LE(o)); if (v >= payload) fail('bad-reftable', 'bundle-reference table pointer is out of range'); return v; };
  const pool = ptr(16), bundles = ptr(24), lookups = ptr(8);
  const count = d.readUInt32LE(72), bundleCount = d.readUInt32LE(76);
  if (bundles + bundleCount * 8 > payload || lookups + count * 16 > payload) fail('bad-reftable', 'bundle-reference table counts do not fit');
  const cache = new Map();
  function text(token, depth) {
    if (token === 0xFFFFFFFF) return '';
    if (depth > 128) fail('bad-reftable', 'bundle-reference path is cyclic');
    if (cache.has(token)) return cache.get(token);
    const at = pool + (token & 0x7FFFFF), length = token >>> 24;
    if (at + 8 > payload) fail('bad-reftable', 'bundle-reference path is out of range');
    const frag = (token & 0x800000) ? at + 4 : pool + d.readUInt32LE(at + 4);
    if (frag + length > payload) fail('bad-reftable', 'bundle-reference path is out of range');
    const s = text(d.readUInt32LE(at), depth + 1) + d.toString('latin1', frag, frag + length);
    cache.set(token, s);
    return s;
  }
  const bundleNames = [];
  for (let i = 0; i < bundleCount; i++) bundleNames.push(text(d.readUInt32LE(bundles + i * 8), 0));
  const presets = new Map();   // lower-case full path -> bundle index
  for (let i = 0; i < count; i++) {
    const at = lookups + i * 16;
    const bundle = d.readUInt32LE(at + 8);
    if (bundle >= bundleCount) fail('bad-reftable', 'bundle-reference row names no bundle');
    presets.set(text(d.readUInt32LE(at + 12), 0).toLowerCase(), bundle);
  }
  return { bundleNames, presets };
}

const tocBundleName = (refName) => 'win32/' + refName.toLowerCase() + '_cas_main_bundlereftable';

// Resolves an item AssetName (a leaf like "fat_joint_ap" or a full path) -> { path, bundle (TOC name) }.
function resolvePreset(table, assetName) {
  const want = String(assetName || '').toLowerCase();
  if (!want) return null;
  let hit = table.presets.has(want) ? want : null;
  if (!hit) {
    if (!table.leafIndex) {
      table.leafIndex = new Map();
      for (const p of table.presets.keys()) { const leaf = p.slice(p.lastIndexOf('/') + 1); if (!table.leafIndex.has(leaf) || p < table.leafIndex.get(leaf)) table.leafIndex.set(leaf, p); }
    }
    hit = table.leafIndex.get(want) || null;
  }
  return hit ? { path: hit, bundle: tocBundleName(table.bundleNames[table.presets.get(hit)]) } : null;
}

// TOC bundle name -> the preset leaf names that load it.
function presetsByBundle(table) {
  const out = new Map();
  for (const [p, i] of table.presets) {
    const b = tocBundleName(table.bundleNames[i]);
    if (!out.has(b)) out.set(b, new Set());
    out.get(b).add(p.slice(p.lastIndexOf('/') + 1));
  }
  return out;
}

module.exports = { readRefTable, resolvePreset, presetsByBundle, tocBundleName };
