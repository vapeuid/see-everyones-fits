'use strict';
/*
  lib/format - reads skate. (Frostbite) game data and ReSkate mods: what a cosmetic mod adds or replaces,
  and 3D / texture previews of its items. Read-only on the game and its Mods folder.

    const fmt = require('./lib/format');
    const game = await fmt.openGame(gameRoot, cacheDir, { catalogDir, log });   // throws FormatError
    const r = await fmt.inspectMod(game, modDir);
      // { ok:true, adds:[{key,name,slot}], replaces:[{key,name,slot,what,parts}], notes:[], complete, stats }
    const p = await fmt.buildPreview(game, modDir, key, outDir);
      // { ok:true, kind, files, info }: kind 'mesh' (<key>.glb + .json), 'texture' (<key>.png + .json, items
      // without a mesh of their own such as deck art) or 'before-after' (<key>-before.png, -after.png, .json)
      // info.tint: 'applied' (the colourway's region colours are baked into the colour map), 'not applied'
      // (the item has a colourway the preview could not bake; info.tintNote says why) or 'none'
    // every failure: { ok:false, code, reason } (openGame throws a FormatError with the same fields instead)

  openGame indexes the game's own items once per game build (3-15 s, depending on the disk cache) and keeps
  that index (about 1 MB) in cacheDir. Compressed data is decoded by the game's own Oodle DLL through a
  PowerShell helper (oodle.ps1), so this needs Windows. The add/replace scan reads uncompressed tables and
  decodes only the item assets a mod adds or changes.
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FormatError, fail, softFail } = require('./errors');
const { readLayout } = require('./native');
const { readToc, readRegion, readManifest } = require('./toc');
const { Layer, decodeLocal, decodeMany } = require('./cas');
const { readEbx } = require('./ebx');
const { readRefTable, resolvePreset, presetsByBundle } = require('./reftable');
const { readCatalog } = require('./catalog');
const { meshSetInfo, readLodGeometry } = require('./mesh');
const { readTextureHeader, decodeTexture, shrink } = require('./texture');
const { encodePng } = require('./png');
const { writeGlb } = require('./glb');
const { SLOT_NAMES, slotFromAsset, slotFromPath } = require('./slots');
const { tintFromParams, bake, uvTiles } = require('./tint');

const INDEX_VERSION = 2;
const ITEMS_TOC = 'Win32/items.toc';
const SHARED_BUNDLE = 'win32/characters/customization/configs/cas_main_sharedbundle';
const REF_TABLE = 'characters/customization/configs/cas_main_bundlereftable';
const RES_TEXTURE = 0x6BDE20BA, RES_MESHSET = 0x49B156D4, RES_REFTABLE = 0x428EC9D4;
// appearance-preset parameter keys seen holding the colour map (simple materials, layered clothing)
const COLOR_PARAMS = new Set(['0bb23445-4861-79a3-30fc-c5140100e899', 'ee63fb35-d01a-aec9-30fc-c51401009c73']);
const MAX_MANIFEST = 32 << 20;

const lower = (s) => String(s).toLowerCase();
const isItemAsset = (name) => { const n = lower(name); return (n.startsWith('items/') || /(^|\/)own_[^/]*$/.test(n)) && !n.startsWith('thumbnail/'); };
const keyName = (key) => String(key).replace(/^own_/i, '').replace(/_+/g, ' ').trim() || String(key);
const safeKey = (key) => lower(key).replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'item';

// ----------------------------------------------------------------------------- bundles in a layer
// The asset list of a bundle and where each asset's payload is. The list itself is normally the
// region's first file (uncompressed); entries run ebx, then res, then chunks.
function listBundle(bundle, layerFor) {
  const region = readRegion(bundle.region);
  if (region.inline) return { manifest: readManifest(region.inline), files: region.files, first: 0 };
  const expected = region.files.length - 1;
  let compressed = null;
  // tools write the manifest first; a few more small files are tried for other tools
  for (const f of region.files.slice(0, 4)) {
    if (f.size > MAX_MANIFEST) continue;
    let raw;
    try { raw = layerFor(f.location).read(f); } catch (e) { if (f === region.files[0]) throw e; continue; }
    for (const data of [raw, decodeLocal(raw)]) {
      if (!data) continue;
      try {
        const m = readManifest(data);
        if (m.ebx.length + m.res.length + m.chunks.length === expected) return { manifest: m, files: region.files, first: 1 };
      } catch (_) { /* not the manifest */ }
    }
    if (!compressed && f === region.files[0]) compressed = f;
  }
  return compressed ? { pending: compressed, region } : null;
}
// Second chance for a manifest stored compressed (needs the decoder).
async function listCompressed(entries, game) {
  const res = await decodeMany(entries.map((e) => ({ layer: e.layerFor(e.pending.location), file: e.pending })), game.root);
  return res.map((d, i) => {
    if (d instanceof FormatError) return null;
    try {
      const m = readManifest(d);
      const region = entries[i].region;
      return m.ebx.length + m.res.length + m.chunks.length === region.files.length - 1 ? { manifest: m, files: region.files, first: 1 } : null;
    } catch (_) { return null; }
  });
}
const assetsOf = (L) => [...L.manifest.ebx, ...L.manifest.res, ...L.manifest.chunks].map((a, i) => ({ a, file: L.files[L.first + i] }));

// ----------------------------------------------------------------------------- game
async function openGame(gameRoot, cacheDir, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  if (!gameRoot || !fs.existsSync(path.join(gameRoot, 'Data', 'layout.toc'))) throw new FormatError('no-game', 'the game folder has no Data/layout.toc');
  const dataRoot = path.join(gameRoot, 'Data');
  const layout = readLayout(dataRoot);
  const base = new Layer(dataRoot, layout.installChunks);
  const itemsToc = path.join(dataRoot, ...ITEMS_TOC.split('/'));
  let stat;
  try { stat = fs.statSync(itemsToc); } catch (_) { throw new FormatError('no-game', 'the game has no Data/Win32/items.toc'); }
  const build = crypto.createHash('sha1').update(fs.readFileSync(path.join(dataRoot, 'layout.toc'))).update(`${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 16);
  const game = { root: gameRoot, dataRoot, base, installChunks: layout.installChunks, build, changelist: layout.changelist,
    tocs: new Map(), assetMaps: new Map(), inspections: new Map(), catalog: new Map(), log };
  game.catalog = readCatalog(options.catalogDir || defaultCatalogDir());

  const cacheFile = cacheDir ? path.join(cacheDir, `format-index-${build}.json`) : null;
  let index = null;
  if (cacheFile) { try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (c.version === INDEX_VERSION && c.build === build) index = c; } catch (_) { /* rebuild */ } }
  if (!index) {
    const t0 = Date.now();
    log('Indexing the game\'s own items (once per game version)...');
    index = await buildIndex(game);
    log(`Indexed ${index.items.length} game items in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
    if (cacheFile) {
      try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cacheFile + '.tmp', JSON.stringify(index)); fs.renameSync(cacheFile + '.tmp', cacheFile); }
      catch (e) { log('(could not save the item index: ' + e.message + ')'); }
    }
  }
  game.items = index.items;
  game.itemsByKey = new Map(index.items.map((it) => [lower(it.key), it]));
  game.itemsByPreset = new Map();
  for (const it of index.items) for (const [, n] of it.assetPaths) { const k = lower(n); if (!game.itemsByPreset.has(k)) game.itemsByPreset.set(k, []); game.itemsByPreset.get(k).push(it); }
  game.refTable = { bundleNames: index.ref.bundleNames, presets: new Map(index.ref.presets) };
  game.presetsByBundle = presetsByBundle(game.refTable);
  return game;
}

// ReSkate's content cache (per game build) has the retail catalogue; optional.
function defaultCatalogDir() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return '';
  const root = path.join(local, 'ReSkate', 'cache');
  try {
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
    dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return dirs[0] || '';
  } catch (_) { return ''; }
}

function baseToc(game, rel) {
  const k = lower(rel);
  if (game.tocs.has(k)) return game.tocs.get(k);
  let v = null;
  const file = path.join(game.dataRoot, ...rel.split('/'));
  if (fs.existsSync(file)) {
    const toc = readToc(fs.readFileSync(file));
    v = { toc, bundles: new Map(toc.bundles.map((b) => [lower(b.name), b])), chunks: new Map(toc.chunks.map((c) => [c.guid, c])) };
  }
  game.tocs.set(k, v);
  return v;
}
// The game's own copy of a bundle: listing plus kind:name -> asset.
function baseBundle(game, rel, name) {
  const k = lower(rel) + '|' + lower(name);
  if (game.assetMaps.has(k)) return game.assetMaps.get(k);
  let v = null;
  const t = baseToc(game, rel);
  const b = t && t.bundles.get(lower(name));
  if (b) {
    const L = listBundle(b, () => game.base);
    if (L && !L.pending) {
      const map = new Map();
      for (const x of assetsOf(L)) map.set(x.a.kind + ':' + lower(x.a.name), x);
      v = { listing: L, map };
    }
  }
  if (game.assetMaps.size > 400) game.assetMaps.clear();   // bound memory on huge scans
  game.assetMaps.set(k, v);
  return v;
}

async function buildIndex(game) {
  const t = baseToc(game, ITEMS_TOC);
  const sb = t && t.bundles.get(SHARED_BUNDLE);
  if (!sb) fail('no-game', 'the game has no item bundle (cas_main_sharedbundle)');
  const L = listBundle(sb, () => game.base);
  if (!L || L.pending) fail('bad-game', "the game's item bundle could not be read");
  const jobs = [];
  let ref = null;
  for (const x of assetsOf(L)) {
    if (x.a.kind === 'ebx' && isItemAsset(x.a.name)) jobs.push(x);
    else if (x.a.kind === 'res' && x.a.name === REF_TABLE) ref = x;
  }
  if (!ref) fail('bad-game', "the game's bundle-reference table is missing");
  jobs.push(ref);
  const out = await decodeMany(jobs.map((x) => ({ layer: game.base, file: x.file })), game.root);
  if (out[out.length - 1] instanceof FormatError) throw out[out.length - 1];
  const table = readRefTable(out[out.length - 1]);
  const items = [];
  let failed = 0;
  for (let i = 0; i < jobs.length - 1; i++) {
    if (out[i] instanceof FormatError) { failed++; continue; }
    try {
      const item = itemFromDoc(readEbx(out[i]), jobs[i].a.name);
      if (item) items.push(item);
    } catch (_) { failed++; }
  }
  if (!items.length) fail('bad-game', `no game items could be read (${failed} failed)` + (out[0] instanceof FormatError ? ': ' + out[0].message : ''));
  return { version: INDEX_VERSION, build: game.build, changelist: game.changelist, items, ref: { bundleNames: table.bundleNames, presets: [...table.presets] } };
}

function itemFromDoc(doc, assetName) {
  const root = doc.root;
  if (!root || typeof root.Key !== 'string' || !root.Key || !root.ItemData) return null;
  const data = doc.deref(root.ItemData);
  const assetPaths = data && Array.isArray(data.AssetPaths) ? data.AssetPaths.filter((p) => p && p.AssetName).map((p) => [p.AssetTypeId, p.AssetName]) : [];
  return { key: root.Key, asset: assetName, slot: slotFromAsset(assetName), assetPaths };
}

const displayName = (game, key) => { const c = game.catalog.get(lower(key)); return (c && c.title) || keyName(key); };

// ----------------------------------------------------------------------------- inspect a mod
function tocsIn(modDir) {
  const out = [];
  const win32 = path.join(modDir, 'Win32');
  (function walk(dir, depth) {
    if (depth > 12) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.toc$/i.test(e.name)) out.push('Win32/' + path.relative(win32, full).split(path.sep).join('/'));
    }
  })(win32, 0);
  return out.sort();
}
function signature(modDir, tocs) {
  return tocs.map((rel) => { try { const s = fs.statSync(path.join(modDir, ...rel.split('/'))); return `${rel}:${s.size}:${s.mtimeMs}`; } catch (_) { return rel; } }).join('|');
}

const whatOf = (a) => {
  if (a.kind === 'res') return a.type === RES_TEXTURE ? 'texture' : a.type === RES_MESHSET ? 'mesh' : 'data';
  if (a.kind === 'chunk') return null;   // goes with a texture or mesh in the same bundle
  const n = lower(a.name);
  if (/_mesh$/.test(n)) return 'mesh';
  if (/_dmpreset$/.test(n)) return 'shape';
  if (/_ap$/.test(n)) return 'appearance';
  return 'data';
};
const WHAT_ORDER = ['mesh', 'shape', 'texture', 'appearance', 'item', 'thumbnail', 'data'];

async function scanMod(game, modDir) {
  const tocs = tocsIn(modDir);
  if (!tocs.length) fail('no-game-data', 'the mod has no game data (no Win32/*.toc)');
  const sig = signature(modDir, tocs);
  const memo = game.inspections.get(modDir);
  if (memo && memo.sig === sig) return memo.scan;
  const mod = new Layer(modDir, game.installChunks);
  const scan = { modDir, mod, tocs: [], added: [], changed: [], chunkOverrides: [], notes: [], newTocs: [], unreadable: 0, bundles: 0 };
  const pending = [];
  const diff = (rel, b, L) => {
    scan.bundles++;
    const known = baseBundle(game, rel, b.name);
    for (const x of assetsOf(L)) {
      if (!x.file || !x.file.location.patch) continue;   // a base file the mod only carries along
      const k = x.a.kind + ':' + lower(x.a.name);
      const rec = { rel, bundle: lower(b.name), a: x.a, file: x.file };
      const prev = known ? known.map.get(k) : undefined;
      if (!prev) scan.added.push(rec); else if (prev.a.sha1 !== x.a.sha1) scan.changed.push(rec);
    }
  };
  for (const rel of tocs) {
    let mt;
    try { mt = readToc(fs.readFileSync(path.join(modDir, ...rel.split('/')))); }
    catch (e) { scan.notes.push(`${rel} could not be read (${e.message})`); continue; }
    const bt = baseToc(game, rel);
    scan.tocs.push({ rel, toc: mt });
    if (!bt) { scan.newTocs.push(rel); continue; }
    for (const c of mt.chunks) {
      const o = bt.chunks.get(c.guid);
      if (o && !c.removed && (c.location.patch || o.offset !== c.offset)) scan.chunkOverrides.push({ rel, guid: c.guid });
    }
    const layerFor = (loc) => (loc.patch ? mod : game.base);
    for (const b of mt.bundles) {
      let L;
      try {
        const region = readRegion(b.region);
        if (!region.files.some((f) => f.location.patch)) continue;
        L = listBundle(b, layerFor);
      } catch (e) { scan.unreadable++; if (scan.unreadable <= 3) scan.notes.push(`bundle ${b.name.split('/').pop()} could not be read (${e.message})`); continue; }
      if (!L) { scan.unreadable++; continue; }
      if (L.pending) { pending.push({ rel, b, layerFor, pending: L.pending, region: L.region }); continue; }
      diff(rel, b, L);
    }
  }
  if (pending.length) {
    const lists = await listCompressed(pending, game);
    lists.forEach((L, i) => { if (L) diff(pending[i].rel, pending[i].b, L); else scan.unreadable++; });
  }
  if (scan.unreadable > 3) scan.notes.push(`${scan.unreadable} bundles could not be read`);

  // decode only what names items: item assets the mod adds or changes, and its bundle-reference table
  const wanted = [...scan.added, ...scan.changed].filter((r) => (r.a.kind === 'ebx' && isItemAsset(r.a.name)) || (r.a.kind === 'res' && r.a.name === REF_TABLE));
  const out = wanted.length ? await decodeMany(wanted.map((r) => ({ layer: mod, file: r.file })), game.root) : [];
  scan.docs = new Map();   // asset name -> parsed EBX
  let decodeErrors = 0, firstError = null;
  wanted.forEach((r, i) => {
    if (out[i] instanceof FormatError) { decodeErrors++; firstError = firstError || out[i]; return; }
    try {
      if (r.a.kind === 'res') scan.refTable = readRefTable(out[i]);
      else scan.docs.set(lower(r.a.name), { rec: r, doc: readEbx(out[i]) });
    } catch (e) { decodeErrors++; firstError = firstError || e; }
  });
  if (decodeErrors) {
    if (decodeErrors === wanted.length && firstError && firstError.code === 'no-oodle') throw firstError;
    scan.notes.push(`${decodeErrors} item asset(s) could not be decoded (${firstError.message})`);
  }
  game.inspections.set(modDir, { sig, scan });
  if (game.inspections.size > 64) game.inspections.delete(game.inspections.keys().next().value);
  return scan;
}

function classify(game, scan) {
  const adds = [], replaces = new Map(), notes = [...scan.notes];
  const addedSet = new Set(scan.added);
  const replace = (key, what, via) => {
    const it = game.itemsByKey.get(lower(key));
    const k = lower(key);
    if (!replaces.has(k)) replaces.set(k, { key: it ? it.key : key, name: displayName(game, key), slot: it ? it.slot : null, parts: new Set(), via: new Set() });
    const r = replaces.get(k);
    if (what) r.parts.add(what);
    if (via) r.via.add(via);
  };
  const ref = scan.refTable || game.refTable;
  let lists = 0;
  for (const { rec, doc } of scan.docs.values()) {
    if (doc.rootType === 'DelMarItemCollectionAsset') { lists++; continue; }
    const item = itemFromDoc(doc, rec.a.name);
    if (!item) continue;
    const base = game.itemsByKey.get(lower(item.key));
    if (addedSet.has(rec) && !base) {
      let slot = item.slot;
      if (!slot) for (const [, n] of item.assetPaths) { const hit = resolvePreset(ref, n); slot = hit && (slotFromPath(hit.bundle) || slotFromPath(hit.path)); if (slot) break; }
      adds.push({ key: item.key, name: displayName(game, item.key), slot: slot || null });
    } else replace(item.key, 'item', rec.a.name);
  }
  // other changed assets -> the presets loading their bundle -> the game items made of those presets
  const unmatched = new Set();
  for (const r of scan.changed) {
    if (r.a.kind === 'ebx' && isItemAsset(r.a.name)) continue;
    if (r.a.name === REF_TABLE || r.a.type === RES_REFTABLE) continue;
    const what = whatOf(r.a);
    const leaf = lower(r.a.name).split('/').pop();
    if (/^own_/.test(leaf) && lower(r.a.name).startsWith('thumbnail/')) { if (game.itemsByKey.has(leaf.replace(/_lrg$/, ''))) replace(leaf.replace(/_lrg$/, ''), 'thumbnail'); continue; }
    if (!what) continue;
    const presets = game.presetsByBundle.get(r.bundle);
    let hit = false;
    for (const p of presets || []) for (const it of game.itemsByPreset.get(p) || []) { replace(it.key, what, r.a.name); hit = true; }
    if (!hit) unmatched.add(r.bundle.split('/').pop().replace(/_cas_main_bundlereftable$/, ''));
  }
  if (lists && !adds.length) notes.push('edits the game\'s item list without adding a new item');
  if (unmatched.size) notes.push(`changes shared game data no single item owns (${[...unmatched].slice(0, 3).join(', ')}${unmatched.size > 3 ? ', ...' : ''})`);
  const covered = new Set(scan.changed.filter((r) => r.a.kind === 'chunk').map((r) => r.a.guid));
  const loose = scan.chunkOverrides.filter((c) => !covered.has(c.guid));
  if (loose.length) notes.push(`replaces ${loose.length} streamed data chunk(s) directly`);
  if (scan.newTocs.length) {
    const names = scan.newTocs.map((rel) => rel.replace(/\.toc$/i, '').split('/').pop());
    notes.push(`ships ${names.length} superbundle(s) the game does not have (maps, levels or other new content): ${names.slice(0, 3).join(', ')}${names.length > 3 ? ', ...' : ''}`);
  }
  const out = [...replaces.values()].map((r) => {
    const parts = WHAT_ORDER.filter((w) => r.parts.has(w));
    return { key: r.key, name: r.name, slot: r.slot, what: parts[0] || 'data', parts };
  });
  out.sort((a, b) => (a.slot || '~').localeCompare(b.slot || '~') || a.key.localeCompare(b.key));
  adds.sort((a, b) => a.key.localeCompare(b.key));
  return { adds, replaces: out, notes };
}

async function inspectMod(game, modDir) {
  const t0 = Date.now();
  try {
    if (!game || !game.items) fail('no-game', 'openGame() has not finished');
    if (!modDir || !fs.existsSync(modDir)) fail('no-mod', 'the mod folder does not exist');
    const scan = await scanMod(game, modDir);
    const r = classify(game, scan);
    // complete = every bundle of the mod could be read (otherwise adds/replaces may be missing some)
    return { ok: true, ...r, complete: scan.unreadable === 0, stats: { tocs: scan.tocs.length, bundles: scan.bundles, addedAssets: scan.added.length, changedAssets: scan.changed.length, ms: Date.now() - t0 } };
  } catch (e) { return softFail(e); }
}

// ----------------------------------------------------------------------------- previews
// Reads assets with the mod's copies first, then the game's. Decoding is batched: each decode() is one
// helper process, so a preview takes three or four of them.
function makeReader(game, scan) {
  const layerFor = (loc) => (loc.patch ? scan.mod : game.base);
  const baseLayer = () => game.base;
  const cache = new Map();
  const bundle = (name, preferBase) => {
    const k = (preferBase ? 'b:' : 'm:') + lower(name);
    if (cache.has(k)) return cache.get(k);
    let L = null;
    if (!preferBase) {
      for (const t of scan.tocs) {
        const b = t.toc.bundles.find((x) => lower(x.name) === lower(name));
        if (!b) continue;
        const got = listBundle(b, layerFor);
        if (got && !got.pending) { L = Object.assign(got, { rel: t.rel, layerFor, fromMod: true }); break; }
      }
    }
    if (!L) for (const rel of [ITEMS_TOC, ...scan.tocs.map((t) => t.rel)]) {
      const bb = baseBundle(game, rel, name);
      if (bb) { L = Object.assign({}, bb.listing, { rel, layerFor: baseLayer, fromMod: false }); break; }
    }
    cache.set(k, L);
    return L;
  };
  // where a chunk's bytes are: the mod's TOC entry, the game's TOC entry, or the bundle's own copy
  const chunkJob = (L, guid, preferBase) => {
    if (!preferBase) for (const t of scan.tocs.filter((x) => x.rel === L.rel)) {
      const c = t.toc.chunks.find((x) => x.guid === guid && !x.removed);
      if (c) return { layer: layerFor(c.location), file: c };
    }
    const bt = baseToc(game, L.rel);
    const c = bt && bt.chunks.get(guid);
    if (c && !c.removed) return { layer: game.base, file: c };
    const x = assetsOf(L).find((y) => y.a.kind === 'chunk' && y.a.guid === guid);
    return x ? { layer: L.layerFor(x.file.location), file: x.file } : null;
  };
  const job = (L, x) => ({ layer: L.layerFor(x.file.location), file: x.file });
  const decode = async (jobs) => {
    const out = await decodeMany(jobs, game.root);
    return out.map((d) => { if (d instanceof FormatError) throw d; return d; });
  };
  const tryDecode = (jobs) => decodeMany(jobs, game.root);   // per-job FormatError allowed
  const resById = (L, rid) => assetsOf(L).find((y) => y.a.kind === 'res' && y.a.rid === rid);
  return { bundle, chunkJob, job, decode, tryDecode, resById };
}

const textureType = (doc) => doc && /Texture/.test(doc.rootType || '') && doc.root && doc.root.Resource && doc.root.Resource.$res;
const shapeStem = (p) => lower(p).replace(/_(geometry|dmpreset|dmliteasset|complex_dmpreset)$/, '');

async function itemDoc(game, scan, rd, key) {
  for (const { doc } of scan.docs.values()) if (doc.root && lower(doc.root.Key || '') === lower(key)) return doc;
  const it = game.itemsByKey.get(lower(key));
  const L = it && rd.bundle(SHARED_BUNDLE, true);
  const x = L && assetsOf(L).find((y) => y.a.kind === 'ebx' && lower(y.a.name) === lower(it.asset));
  return x ? readEbx((await rd.decode([rd.job(L, x)]))[0]) : null;
}

// EBX of a bundle, decoded and parsed in one batch (unreadable ones are skipped).
async function bundleDocs(rd, L, filter) {
  const list = assetsOf(L).filter((y) => y.a.kind === 'ebx' && (!filter || filter(y)));
  const out = list.length ? await rd.tryDecode(list.map((x) => rd.job(L, x))) : [];
  const docs = [];
  out.forEach((d, i) => { if (!(d instanceof FormatError)) { try { docs.push({ x: list[i], doc: readEbx(d) }); } catch (_) { /* skip */ } } });
  return docs;
}

// The textures the item's appearance presets bind -> { textures: [{ doc, param, L, fromMod, primary }], tint }.
// An item has one preset per material (type 3, 17, or 20-26 for costumes); textures and the shader
// parameter assets (common/shadercomponents/parameters/param_*) live in each preset's bundle. `tint` is
// the main preset's colourway (see tint.js), or null.
async function presetTextures(rd, ref, assetNames) {
  const byBundle = new Map();
  assetNames.forEach((name, order) => {
    const ap = resolvePreset(ref, name);
    if (!ap) return;
    if (!byBundle.has(ap.bundle)) byBundle.set(ap.bundle, []);
    byBundle.get(ap.bundle).push({ path: ap.path, order });
  });
  const textures = [];
  let tint = null;
  for (const [bundleName, aps] of byBundle) {
    const L = rd.bundle(bundleName);
    if (!L) continue;
    const texNames = new Set(assetsOf(L).filter((y) => y.a.kind === 'res' && y.a.type === RES_TEXTURE).map((y) => lower(y.a.name)));
    const apPaths = new Set(aps.map((x) => x.path));
    const wantsParams = aps.some((x) => x.order === 0);
    const docs = await bundleDocs(rd, L, (y) => {
      const n = lower(y.a.name);
      return apPaths.has(n) || texNames.has(n) || (wantsParams && n.startsWith('common/shadercomponents/parameters/'));
    });
    const paramNames = new Map(docs.filter((d) => lower(d.x.a.name).startsWith('common/shadercomponents/parameters/'))
      .map((d) => [d.doc.fileGuid, lower(d.x.a.name).split('/').pop().replace(/^param_/, '')]));
    const bound = new Map();   // texture file guid -> { param, order }
    for (const { path: p, order } of aps) {
      const apDoc = docs.find((d) => lower(d.x.a.name) === p);
      const params = new Map();
      for (const pi of (apDoc && apDoc.doc.root && apDoc.doc.root.ParamInfo) || []) {
        const v = pi && pi.Value && pi.Value.Value;
        const par = pi && pi.Value && pi.Value.Parameter && pi.Value.Parameter.$import;
        if (v && par && paramNames.has(par.fileGuid)) params.set(paramNames.get(par.fileGuid), v);
        if (v && v.$import && !bound.has(v.$import.fileGuid)) bound.set(v.$import.fileGuid, { param: pi.ParamKey && pi.ParamKey.Data, slot: par ? paramNames.get(par.fileGuid) || '' : '', order });
      }
      if (order === 0) tint = tintFromParams(params);
    }
    for (const d of docs) {
      const hit = textureType(d.doc) && bound.get(d.doc.fileGuid);
      if (hit && !textures.some((t) => t.doc.fileGuid === d.doc.fileGuid)) textures.push({ doc: d.doc, param: hit.param, slot: hit.slot, L, fromMod: d.x.file.location.patch, primary: hit.order === 0 });
    }
  }
  return { textures, tint };
}

// Reads the texture headers, picks the colour map, decodes it and bakes the colourway into it
// -> { list, colour: { t, image } | null, tint: 'applied' | 'not applied' | 'none' }
async function loadTextures(rd, preset, maxSide, forMesh) {
  const texs = preset.textures;
  const withRes = texs.map((t) => ({ ...t, res: rd.resById(t.L, t.doc.root.Resource.$res) })).filter((t) => t.res);
  const heads = withRes.length ? await rd.tryDecode(withRes.map((t) => rd.job(t.L, t.res))) : [];
  const list = [];
  withRes.forEach((t, i) => {
    if (heads[i] instanceof FormatError) return;
    try { t.header = readTextureHeader(heads[i], t.res.a.meta); list.push(t); } catch (_) { /* skip */ }
  });
  // the mod's own colour map first (deck art, a recoloured template), then the template's
  const score = (t) => (t.fromMod ? 16 : 0) + (COLOR_PARAMS.has(t.param) ? 8 : 0) + (t.header.role === 'color' ? 4 : 0) + (t.primary ? 2 : 0) + (/bc7|bc3/.test(t.header.codec || '') ? 1 : 0);
  let colourCands = list.filter((t) => COLOR_PARAMS.has(t.param) || t.header.role === 'color').sort((a, b) => score(b) - score(a));
  // On a mesh, a graphic_* texture is a decal placed by offset and scale, not a map of the whole surface, so
  // it goes last (deck art, grips and stickers without a mesh keep their graphic).
  if (forMesh) {
    const isDecal = (t) => /^graphic/.test(t.slot || '');
    // with a colourway the tinted base map is what the item looks like; a mod's own pattern or full map wins otherwise
    const rank = (t) => (preset.tint && /^base_c(_ta)?$/.test(t.slot || '') ? 0 : isDecal(t) ? 2 : 1);
    colourCands = colourCands.map((t, i) => [t, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([t]) => t);
  }
  const pixelsOf = async (t) => {
    const j = rd.chunkJob(t.L, t.header.chunk);
    if (!j) return null;
    const [px] = await rd.tryDecode([j]);
    return px instanceof FormatError ? null : px;
  };
  let colour = null;
  for (const t of colourCands) {
    const px = await pixelsOf(t);
    if (!px) continue;
    try { colour = { t, image: decodeTexture(t.header, px, maxSide) }; break; } catch (_) { /* next */ }
  }
  // the colourway's mask and stitch textures, decoded at the colour map's size (baked by applyTint)
  let tint = 'none', tintInputs = null, tintNote = '';
  const tp = preset.tint;
  if (colour && tp && colour.t.doc.fileGuid === tp.base) {
    tint = 'not applied';
    try {
      const find = (guid) => list.find((t) => t.doc.fileGuid === guid);
      const load = async (t) => { const px = t && await pixelsOf(t); return px ? decodeTexture(t.header, px, maxSide) : null; };
      const mask = await load(find(tp.mask));
      if (mask) tintInputs = { tint: tp, mask, stitches: tp.stitches && tp.stitch ? await load(find(tp.stitches)) : null };
      else tintNote = 'the colourway mask could not be read';
    } catch (e) { tintInputs = null; tintNote = 'the colourway textures could not be read'; }
  } else if (colour && tp) { tint = 'not applied'; tintNote = 'the colour map shown is not the one the colourway tints'; }
  const info = list.map((t) => ({ name: String(t.doc.root.Name || t.res.a.name).split('/').pop(), role: COLOR_PARAMS.has(t.param) ? 'color' : t.header.role || 'other',
    width: t.header.width, height: t.header.height, format: t.header.codec || String(t.header.format), fromMod: !!t.fromMod, ...(t.slot ? { slot: t.slot } : {}) }));
  return { list: info, colour, tint, tintNote, tintInputs };
}

// Bakes the colourway into the colour map. With a mesh whose first UV set spans several tiles (one per
// region) the result is an atlas of one tinted copy per tile and the mesh's u is divided to match.
function applyTint(tex, mesh) {
  if (!tex.colour || !tex.tintInputs) return;
  let span = { first: 0, count: 1 };
  if (mesh) {
    if (!mesh.uvs) { tex.tintNote = 'the mesh has no texture coordinates'; return; }
    span = uvTiles(mesh.uvs);
    if (!span) { tex.tintNote = 'the mesh tiles its texture in a way the preview does not bake'; return; }
  }
  try {
    const { tint, mask, stitches } = tex.tintInputs;
    const per = span.count > 2 ? 512 : 1024;   // keep the atlas within 2048 x 1024
    const scale = (img) => (img && Math.max(img.width, img.height) > per ? shrink(img, per) : img);
    tex.colour.image = bake(scale(tex.colour.image), scale(mask), scale(stitches), tint, span.first, span.count);
    if (mesh && (span.first !== 0 || span.count !== 1)) for (let i = 0; i < mesh.uvs.length; i += 2) mesh.uvs[i] = (mesh.uvs[i] - span.first) / span.count;
    tex.tint = 'applied';
  } catch (_) { tex.tint = 'not applied'; tex.tintNote = 'baking the colourway failed'; }
}

async function meshPreview(game, scan, rd, key, outDir) {
  const doc = await itemDoc(game, scan, rd, key);
  if (!doc) fail('no-item', 'the item was not found');
  const item = itemFromDoc(doc, doc.root.Name || '');
  const ref = scan.refTable || game.refTable;
  const shape = item.assetPaths.find(([t]) => t === 2) || item.assetPaths.find(([t]) => t === 1);
  // appearance presets: every asset path that is not a shape (1 morph preset, 2 mesh); the main one first
  const apNames = item.assetPaths.filter(([t]) => t !== 1 && t !== 2).sort((x, y) => (x[0] === 3 || x[0] === 20 ? -1 : 0) - (y[0] === 3 || y[0] === 20 ? -1 : 0)).map(([, n]) => n);
  if (!shape) return texturePreviewOnly(game, rd, ref, item, apNames, outDir);
  const where = resolvePreset(ref, shape[1]);
  if (!where) fail('no-mesh', "the item's mesh is not registered in the bundle table");
  const GL = rd.bundle(where.bundle);
  if (!GL) fail('no-mesh', 'the bundle holding the mesh is missing');

  // batch 1: every EBX of the mesh bundle, and the textures the appearance preset binds
  const [docs, preset] = await Promise.all([bundleDocs(rd, GL), presetTextures(rd, ref, apNames)]);
  const shapeDoc = (docs.find((d) => lower(d.x.a.name) === where.path) || {}).doc;
  if (!shapeDoc) fail('no-mesh', "the item's mesh asset is missing");
  let meshImport = null;
  if (shapeDoc.rootType === 'DingoMorphPreset') { const pre = shapeDoc.deref(shapeDoc.root.Preset); meshImport = pre && pre.ReferenceMesh && pre.ReferenceMesh.$import; }
  else { const o = shapeDoc.objects.find((x) => x && x.Mesh && x.Mesh.$import); meshImport = o && o.Mesh.$import; }
  const meshes = docs.filter((d) => d.doc.root && d.doc.root.MeshSetResource);
  let meshDoc = meshImport && (meshes.find((d) => d.doc.fileGuid === meshImport.fileGuid) || {}).doc;
  if (!meshDoc) {   // the reference goes through an asset elsewhere: take the bundle's mesh of the same name
    const stem = shapeStem(where.path);
    meshDoc = (meshes.find((d) => lower(d.x.a.name) === stem + '_mesh') || meshes.find((d) => lower(d.x.a.name).startsWith(stem)) || (meshes.length === 1 ? meshes[0] : {})).doc;
  }
  if (!meshDoc) fail(meshImport ? 'no-mesh' : 'unsupported-mesh', meshImport ? 'the mesh asset is missing' : 'unsupported mesh layout (' + shapeDoc.rootType + ')');
  const ms = rd.resById(GL, meshDoc.root.MeshSetResource.$res);
  if (!ms) fail('no-mesh', 'the mesh data is missing');

  // batch 2: mesh resource; batch 3: its finest geometry; textures alongside
  const [meshRes] = await rd.decode([rd.job(GL, ms)]);
  const info = meshSetInfo(meshRes);
  const gj = rd.chunkJob(GL, info.lods[0].chunk);
  if (!gj) fail('no-mesh', 'the mesh geometry is missing');
  const [[geometry], tex] = await Promise.all([rd.decode([gj]), loadTextures(rd, preset, 1024, true)]);
  let mesh;
  try { mesh = readLodGeometry(info, 0, geometry); }
  catch (e) { if (e.code === 'bad-mesh' && /no triangles/.test(e.message)) fail('empty-mesh', "the mod's mesh for this item is empty (it hides the item in game)"); throw e; }
  applyTint(tex, mesh);
  const png = tex.colour && mesh.uvs ? encodePng(tex.colour.image.width, tex.colour.image.height, tex.colour.image.rgba) : null;
  const sk = safeKey(item.key);
  const it = game.itemsByKey.get(lower(item.key));
  const meta = { key: item.key, name: displayName(game, item.key), slot: (it && it.slot) || item.slot || slotFromPath(where.bundle), triangles: mesh.triangles,
    textures: tex.list, tint: tex.tint, ...(tex.tintNote && tex.tint !== 'applied' ? { tintNote: tex.tintNote } : {}), colorTexture: tex.colour ? tex.list.find((t) => t.name === String(tex.colour.t.doc.root.Name || '').split('/').pop()) || null : null };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, sk + '.glb'), writeGlb(mesh, png, item.key));
  fs.writeFileSync(path.join(outDir, sk + '.json'), JSON.stringify(meta, null, 2));
  return { ok: true, kind: 'mesh', files: [sk + '.glb', sk + '.json'], info: meta };
}

// Items without a mesh of their own (deck art, grip, stickers, colours): the colour texture alone.
async function texturePreviewOnly(game, rd, ref, item, apNames, outDir) {
  if (!apNames.length) fail('no-mesh', 'the item names no mesh or texture (it may be an emote, sound or game setting)');
  const tex = await loadTextures(rd, await presetTextures(rd, ref, apNames), 1024);
  if (!tex.colour) fail('no-texture', 'the item has no mesh and no readable colour texture');
  applyTint(tex, null);
  const sk = safeKey(item.key);
  const meta = { key: item.key, name: displayName(game, item.key), slot: item.slot || slotFromPath((resolvePreset(ref, apNames[0]) || {}).bundle), triangles: 0, textures: tex.list, tint: tex.tint, ...(tex.tintNote && tex.tint !== 'applied' ? { tintNote: tex.tintNote } : {}) };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, sk + '.png'), encodePng(tex.colour.image.width, tex.colour.image.height, tex.colour.image.rgba));
  fs.writeFileSync(path.join(outDir, sk + '.json'), JSON.stringify(meta, null, 2));
  return { ok: true, kind: 'texture', files: [sk + '.png', sk + '.json'], info: meta };
}

// A replaced game item whose textures changed: the game's and the mod's colour texture side by side.
async function beforeAfterPreview(game, scan, rd, key, outDir) {
  const it = game.itemsByKey.get(lower(key));
  if (!it) fail('no-item', 'the item was not found');
  const presets = new Set(it.assetPaths.map(([, n]) => lower(n)));
  const cands = scan.changed.filter((r) => r.a.kind === 'res' && r.a.type === RES_TEXTURE && [...(game.presetsByBundle.get(r.bundle) || [])].some((p) => presets.has(p)));
  if (!cands.length) fail('no-texture', 'the mod changes no texture of this item');
  const pairs = [];
  for (const bundleName of [...new Set(cands.map((r) => r.bundle))].slice(0, 8)) {
    const rel = cands.find((x) => x.bundle === bundleName).rel;
    const ML = rd.bundle(bundleName), bb = baseBundle(game, rel, bundleName);
    if (!ML || !bb) continue;
    const BL = Object.assign({}, bb.listing, { rel, layerFor: () => game.base });
    for (const r of cands.filter((x) => x.bundle === bundleName)) {
      const m = assetsOf(ML).find((y) => y.a.kind === 'res' && lower(y.a.name) === lower(r.a.name));
      const base = assetsOf(BL).find((y) => y.a.kind === 'res' && lower(y.a.name) === lower(r.a.name));
      if (m && base && !pairs.some((p) => lower(p.m.a.name) === lower(r.a.name))) pairs.push({ m, b: base, ML, BL });
    }
  }
  if (!pairs.length) fail('no-texture', "the changed texture could not be matched to the game's");
  const heads = await rd.decode(pairs.flatMap((p) => [rd.job(p.ML, p.m), rd.job(p.BL, p.b)]));
  pairs.forEach((p, i) => { p.mh = readTextureHeader(heads[i * 2], p.m.a.meta); p.bh = readTextureHeader(heads[i * 2 + 1], p.b.a.meta); });
  const score = (p) => (p.mh.role === 'color' ? 2 : 0) + (/_c$/i.test(p.m.a.name) ? 1 : 0);
  pairs.sort((a, b) => score(b) - score(a));
  const p = pairs[0];
  const jm = rd.chunkJob(p.ML, p.mh.chunk), jb = rd.chunkJob(p.BL, p.bh.chunk, true);
  if (!jm || !jb) fail('missing-texture', 'texture pixels are missing');
  const [pm, pb] = await rd.decode([jm, jb]);
  const after = decodeTexture(p.mh, pm, 1024), before = decodeTexture(p.bh, pb, 1024);
  const sk = safeKey(it.key);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, sk + '-before.png'), encodePng(before.width, before.height, before.rgba));
  fs.writeFileSync(path.join(outDir, sk + '-after.png'), encodePng(after.width, after.height, after.rgba));
  const meta = { key: it.key, name: displayName(game, it.key), slot: it.slot, triangles: 0, tint: 'none',
    textures: [{ name: p.m.a.name.split('/').pop(), role: p.mh.role || 'other', width: p.mh.width, height: p.mh.height, format: p.mh.codec || String(p.mh.format) }] };
  fs.writeFileSync(path.join(outDir, sk + '.json'), JSON.stringify(meta, null, 2));
  return { ok: true, kind: 'before-after', files: [sk + '-before.png', sk + '-after.png', sk + '.json'], info: meta };
}

async function buildPreview(game, modDir, itemKey, outDir) {
  try {
    if (!game || !game.items) fail('no-game', 'openGame() has not finished');
    if (!outDir) fail('bad-args', 'no output folder given');
    if (!modDir || !fs.existsSync(modDir)) fail('no-mod', 'the mod folder does not exist');
    const scan = await scanMod(game, modDir);
    const r = classify(game, scan);
    const k = lower(itemKey);
    const rd = makeReader(game, scan);
    if (r.adds.some((a) => lower(a.key) === k)) return await meshPreview(game, scan, rd, itemKey, outDir);
    const rep = r.replaces.find((x) => lower(x.key) === k);
    if (!rep) fail('no-item', 'the mod neither adds nor replaces this item');
    if (rep.parts.some((p) => p === 'mesh' || p === 'shape' || p === 'item')) return await meshPreview(game, scan, rd, itemKey, outDir);
    if (rep.parts.includes('texture')) return await beforeAfterPreview(game, scan, rd, itemKey, outDir);
    fail('nothing-to-preview', 'the mod changes nothing of this item that can be shown');
  } catch (e) { return softFail(e); }
}

module.exports = { openGame, inspectMod, buildPreview, FormatError, SLOT_NAMES,
  _internal: { listBundle, assetsOf, makeReader, scanMod, classify } };   // for tests and tools, not a stable API
