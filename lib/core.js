'use strict';
// See Everyone's Fits engine: Thunderstore ranking, download + safe unpack, clash / protected-slot checks, plan, apply, cache.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const fmt = require('./format');

const HERE = path.join(__dirname, '..');
// Settings, state, cache and previews live in %LOCALAPPDATA%\SeeEveryonesFits, never in the app folder: the app folder may sit
// inside ReSkate's Mods folder (the launcher would scan cached mods there) and must stay free of personal data.
const DATA = process.env.SEEFITS_DATA || path.join(process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'), 'SeeEveryonesFits');
const CONFIG_FILE = path.join(DATA, 'config.json');
const STATE_FILE = path.join(DATA, 'state.json');
const REVIEW_FILE = path.join(DATA, 'review-data.json');
const CACHE = path.join(DATA, 'cache');
const PREVIEWS = path.join(DATA, 'previews');
// Installed through the ReSkate launcher, the app is <game>\Mods\<package>\ and knows the game folder from that.
const SELF = path.basename(HERE);
const IN_MODS = path.basename(path.dirname(HERE)).toLowerCase() === 'mods' && ['ReSkateLauncher.exe', 'Skate.exe'].some((f) => fs.existsSync(path.join(HERE, '..', '..', f)));
fs.mkdirSync(DATA, { recursive: true });
const API = 'https://thunderstore.io/c/reskate/api/v1/package/';
// Windows' own tar.exe reads zip files (Git's tar on the PATH does not)
const TAR = (() => { const t = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'); return fs.existsSync(t) ? t : 'tar'; })();

const DEFAULTS = {
  reskateDir: '',                 // only used when the app is not inside ReSkate's Mods folder
  capMB: 2048,                    // storage for synced mods (your own mods do not count)
  maxModMB: 150,                  // skip single mods bigger than this
  categories: ['Cosmetics', 'Skateboards'],
  includeNsfw: false,             // Thunderstore's NSFW flag
  minDownloads: 200,              // ignore barely used mods
  pins: [],                       // "Team-Name" entries always kept (counted in the cap)
  block: [],                      // "Team-Name" entries never installed
  clashLimit: 2,                  // uncommon game files shared with an installed mod before it counts as a clash
  protect: ['skin', 'face', 'body'],   // synced mods may never change these slots
  community: true,                // share / read the public "what app users wear" list (anonymous, mod names only)
};

// ----------------------------------------------------------------------------- logging (the app shows it live)
let sink = null;
const log = (...a) => { const line = a.join(' '); console.log(line); if (sink) sink(line); };
const setSink = (fn) => { sink = fn; };

// ----------------------------------------------------------------------------- small helpers
const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return d; } };   // tolerates a BOM (Notepad / PowerShell)
const writeJson = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 2) + '\n'); fs.renameSync(f + '.tmp', f); };
function loadConfig() {
  const c = readJson(CONFIG_FILE, null);
  if (!c) { writeJson(CONFIG_FILE, DEFAULTS); return JSON.parse(JSON.stringify(DEFAULTS)); }
  return { ...DEFAULTS, ...c };
}
const saveConfig = (c) => writeJson(CONFIG_FILE, c);
const loadState = () => { const s = readJson(STATE_FILE, {}); return { synced: s.synced || {}, skipped: s.skipped || {} }; };
const saveState = (s) => writeJson(STATE_FILE, s);
function dirSize(p) {
  let n = 0; if (!fs.existsSync(p)) return 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); n += e.isDirectory() ? dirSize(q) : fs.statSync(q).size; }
  return n;
}
// ReSkate's own folder naming (Launcher/mod_manager.cpp folder_name): mods.json refuses names over 64 characters
// or with other characters, and then no mod loads at all.
const MAX_FOLDER = 64;
function folderName(name) {
  let s = String(name).replace(/[^A-Za-z0-9_.\- ]/g, '_').replace(/^[. ]+/, '').replace(/[. ]+$/, '');
  if (s.length > MAX_FOLDER) s = s.slice(0, MAX_FOLDER);
  return s || 'Mod';
}
const validFolder = (f) => !!f && f.length <= MAX_FOLDER && f[0] !== '.' && /^[A-Za-z0-9_.\- ]+$/.test(f);
const baseName = (folder) => folder.replace(/-\d+(\.\d+)+$/, '');   // "K7-Paw_Paws-3.0.0" -> "K7-Paw_Paws"

function running() {
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).toLowerCase();
    return ['reskatelauncher.exe', 'skate.exe'].filter((p) => out.includes('"' + p + '"'));
  } catch (_) { return []; }
}

// ----------------------------------------------------------------------------- clash check (game file names in a mod's TOC files)
function tocNames(modDir) {
  const names = new Set(); const win = path.join(modDir, 'Win32');
  if (!fs.existsSync(win)) return names;
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) walk(q);
      else if (e.name.endsWith('.toc')) {
        const b = fs.readFileSync(q); let cur = '';
        for (const c of b) { if (c >= 32 && c < 127) cur += String.fromCharCode(c); else { if (cur.length >= 12 && cur.includes('/')) names.add(cur.toLowerCase()); cur = ''; } }
      }
    }
  };
  walk(win); return names;
}

// ----------------------------------------------------------------------------- what a mod touches, from its game file names
// e.g. .../ownables/body/skin/custskintype_tone_body_ap_00150_... -> {slot:'skin', item:'tone body', colorway:'00150'}
// first match wins: [slot, any of these path parts]
const SLOTS = [['skin', ['/ownables/body/skin/']], ['tattoos', ['/tattoo']], ['hair', ['/hair/', 'hair_scalp', '_haircap']],
  ['face', ['/head/', '/face/', '/makeup/', '/eyebrow', '/beard', '/facial', 'face_layer']], ['body', ['/cas/body/', '/bodyblends/']],
  ['tops', ['/apparel/top/']], ['bottoms', ['/apparel/bottom/']], ['costumes', ['/apparel/fullbody', '/apparel/costume', '/apparel/onepiece']], ['socks', ['/footwear/sock']], ['shoes', ['/footwear/']],
  ['hats', ['/accessories/headwear/']], ['glasses', ['/accessories/eyewear/']], ['accessories', ['/accessories/']], ['boards', ['/skateboard/']]];
const SLOT_NAMES = SLOTS.map(([s]) => s);
const SLOT_LABEL = { skin: 'Skin', tattoos: 'Tattoos', hair: 'Hair', face: 'Face & makeup', body: 'Body', tops: 'Tops', bottoms: 'Bottoms', costumes: 'Costumes', socks: 'Socks', shoes: 'Shoes', hats: 'Hats', glasses: 'Glasses', accessories: 'Accessories', boards: 'Decks & boards' };
function describe(names) {
  const out = new Map();
  for (const n of names) {
    if (n.includes('cas_main_sharedbundle') || n.includes('/configs/')) continue;
    const slot = (SLOTS.find(([, parts]) => parts.some((p) => n.includes(p))) || ['other'])[0];
    const file = n.split('/').pop().replace(/_(cas_main|complex|bundlereftable|dmpreset).*$/, '');
    const cw = (file.match(/_([0-9]{4,5})(_|$)/) || [])[1] || '';
    const item = file.replace(/^(gen|deck|custskintype)_/, '').replace(/_[0-9]{4,5}.*$/, '').replace(/_ap$/, '').replace(/_/g, ' ');
    const key = slot + '|' + item + '|' + cw; if (!out.has(key)) out.set(key, { slot, item, colorway: cw });
  }
  return [...out.values()];
}

// ----------------------------------------------------------------------------- ReSkate mods folder
function gameDir(cfg) {
  if (IN_MODS) return path.join(HERE, '..', '..');
  if (cfg.reskateDir && fs.existsSync(path.join(cfg.reskateDir, 'Mods'))) return cfg.reskateDir;
  return null;
}
function modsInfo(cfg) {
  const game = gameDir(cfg);
  if (!game) throw new Error("ReSkate not found: put the See Everyone's Fits folder in your ReSkate Mods folder (or install it from the ReSkate launcher).");
  const modsDir = path.join(game, 'Mods');
  const listFile = path.join(modsDir, 'mods.json');
  const list = readJson(listFile, { mods: [], schema: 1 });
  // the app's own folder is never a cosmetic mod
  const folders = fs.readdirSync(modsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !(IN_MODS && e.name === SELF)).map((e) => e.name);
  return { game, modsDir, listFile, list, folders };
}
// ReSkate refuses the whole mods.json (and loads no mod) if one row breaks its rules, so check before every save
function checkModList(list) {
  const seen = new Set();
  for (const x of list.mods || []) {
    if (!x || typeof x.enabled !== 'boolean' || !validFolder(x.name)) throw new Error(`mods.json row ${JSON.stringify(x)} breaks ReSkate's rules - fix that mod's folder name first`);
    if (seen.has(x.name.toLowerCase())) throw new Error(`mods.json lists ${x.name} twice`);
    seen.add(x.name.toLowerCase());
  }
}
function writeModList(m) {
  checkModList(m.list);
  writeJson(m.listFile, { mods: m.list.mods.map((x) => ({ enabled: x.enabled, name: x.name })), schema: 1 });
}

// ----------------------------------------------------------------------------- Thunderstore
let pkgCache = null;
async function fetchPackages() {
  if (pkgCache && Date.now() - pkgCache.at < 10 * 60000) return pkgCache.list;
  const r = await fetch(API, { headers: { 'User-Agent': 'SeeEveryonesFits/1.0' } });
  if (!r.ok) throw new Error(`Thunderstore answered HTTP ${r.status}`);
  pkgCache = { at: Date.now(), list: await r.json() }; return pkgCache.list;
}
function rank(pkgs, cfg) {
  const block = new Set(cfg.block.map((x) => x.toLowerCase()));
  return pkgs
    .filter((p) => !p.is_deprecated && (cfg.includeNsfw || !p.has_nsfw_content))
    .filter((p) => (p.categories || []).some((c) => cfg.categories.includes(c)))
    .filter((p) => !(p.categories || []).some((c) => ['Maps', 'Audio', 'Modpacks', 'Libraries'].includes(c)))
    .filter((p) => !block.has(p.full_name.toLowerCase()))
    .map((p) => { const v = p.versions[0]; return { name: p.full_name, version: v.version_number, url: v.download_url, icon: v.icon, page: p.package_url, zipBytes: v.file_size, deps: (v.dependencies || []).filter((d) => !/^ReSkate-/i.test(d)), downloads: p.versions.reduce((n, x) => n + (x.downloads || 0), 0), rating: p.rating_score || 0, cats: p.categories }; })
    .filter((p) => p.downloads >= cfg.minDownloads && !p.deps.length && mb(p.zipBytes) <= cfg.maxModMB)
    .sort((a, b) => b.downloads - a.downloads || b.rating - a.rating);
}

// ----------------------------------------------------------------------------- download + safe unpack
async function download(c) {
  fs.mkdirSync(CACHE, { recursive: true });
  const zip = path.join(CACHE, `${c.name}-${c.version}.zip`);
  if (fs.existsSync(zip) && fs.statSync(zip).size === c.zipBytes) return zip;
  const r = await fetch(c.url, { headers: { 'User-Agent': 'SeeEveryonesFits/1.0' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`download ${c.name}: HTTP ${r.status}`);
  fs.writeFileSync(zip + '.part', Buffer.from(await r.arrayBuffer())); fs.renameSync(zip + '.part', zip);
  return zip;
}
function extract(zip, dest) {
  // every entry is checked first: no absolute paths, no "..", no drive letters
  const entries = execFileSync(TAR, ['-tf', zip], { encoding: 'utf8', maxBuffer: 64 << 20 }).split(/\r?\n/).filter(Boolean);
  for (const e of entries) if (/^[\\/]|^[a-z]:|(^|[\\/])\.\.([\\/]|$)/i.test(e)) throw new Error(`unsafe path in ${path.basename(zip)}: ${e}`);
  // the mod is the folder holding Win32/ + layout.toc: at the top of the zip, or one folder down ("<Name>/", "Patch/")
  const norm = entries.map((e) => e.replace(/\\/g, '/'));
  const roots = [...new Set(norm.filter((e) => /(^|\/)layout\.toc$/i.test(e)).map((e) => e.replace(/layout\.toc$/i, '')).filter((r) => r.split('/').length <= 2 && norm.some((e) => e.toLowerCase().startsWith((r + 'Win32/').toLowerCase()))))];
  if (!roots.length) throw new Error(`${path.basename(zip)} has no mod folder (no Win32 + layout.toc)`);
  if (roots.length > 1) throw new Error(`${path.basename(zip)} holds ${roots.length} mods in one package - skipped`);
  const tmp = dest + '.unpack';
  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(dest, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
  execFileSync(TAR, ['-xf', zip, '-C', tmp]);
  fs.renameSync(path.join(tmp, roots[0]), dest);
  for (const f of ['manifest.json', 'icon.png', 'README.md']) { const top = path.join(tmp, f); if (roots[0] && fs.existsSync(top) && !fs.existsSync(path.join(dest, f))) fs.copyFileSync(top, path.join(dest, f)); }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ----------------------------------------------------------------------------- plan (+ apply when doIt)
// community: Map(Thunderstore name -> number of app users wearing it) from lib/community.js
async function plan(cfg, state, doIt, community = new Map()) {
  if (doIt) { const busy = running(); if (busy.length) throw new Error(`close ${busy.join(' and ')} first - the launcher rewrites mods.json and merges mods at launch`); repair(cfg, state); }
  const m = modsInfo(cfg);
  if (doIt) checkModList(m.list);   // stop before changing anything, not halfway
  const pkgs = await fetchPackages();
  const ranked = rank(pkgs, cfg);
  const synced = state.synced;                           // folder -> {name, version, bytes, installedAt, source}
  const enabled = new Set(m.list.mods.filter((x) => x.enabled).map((x) => x.name));
  // your own mods: every folder we did not install. They are never touched and count as "already have".
  const own = m.folders.filter((f) => !synced[f]);
  const ownBase = new Set(own.map((f) => baseName(f).toLowerCase()));
  const sets = []; const freq = new Map();
  const addSet = (label, s) => { sets.push({ label, s }); for (const x of s) freq.set(x, (freq.get(x) || 0) + 1); };
  for (const f of own) if (enabled.has(f) || !m.list.mods.some((x) => x.name === f)) addSet(f, tocNames(path.join(m.modsDir, f)));
  const clashWith = (s) => { for (const o of sets) { let n = 0; for (const x of s) if (o.s.has(x) && (freq.get(x) || 0) < 4 && ++n >= cfg.clashLimit) return o.label; } return null; };

  const capBytes = cfg.capMB * 1048576; let used = 0;
  const keep = []; const install = []; const review = [];
  const protect = new Set((cfg.protect || []).map((x) => String(x).toLowerCase()));
  const lc = (x) => String(x).toLowerCase();
  const offWhy = (x) => `has ${SLOT_LABEL[x.slot] || x.slot} (${x.item}), which you turned off`;
  const pins = new Set(cfg.pins.map(lc));
  const commN = (c) => community.get(c.name) || 0;
  const sourceOf = (c) => (pins.has(lc(c.name)) ? 'pinned' : commN(c) >= 2 ? 'community' : 'popular');
  // order: your pins, then what app users wear (2+ people), then Thunderstore downloads
  const tier = { pinned: 0, community: 1, popular: 2 };
  const order = ranked.slice().sort((a, b) => tier[sourceOf(a)] - tier[sourceOf(b)] || commN(b) - commN(a) || b.downloads - a.downloads);
  const rec = (c, status, extra) => review.push({ name: c.name, version: c.version, downloads: c.downloads, mb: mb(c.zipBytes * 1.5), icon: c.icon, page: c.page, cats: c.cats, source: sourceOf(c), community: commN(c), status, ...extra });
  let checked = 0, failsInRow = 0, downloadedBytes = 0;
  const maxDownload = capBytes * 3;   // one run never downloads more than 3x the cap while looking for mods that fit
  for (const c of order) {
    const lname = lc(c.name);
    if (ownBase.has(lname) || ownBase.has(baseName(folderName(c.name)).toLowerCase())) continue;
    const prev = state.skipped[lname];
    if (prev && prev.version === c.version) {
      // the type settings can change between runs: re-check them from the remembered items
      const off = (prev.items || []).find((x) => protect.has(x.slot));
      if (off) { const why = offWhy(off); rec(c, 'protected', { why, items: prev.items }); if (prev.kind !== 'protected') state.skipped[lname] = { ...prev, kind: 'protected', why }; continue; }
      if (prev.kind !== 'protected') { rec(c, prev.kind || 'clash', { why: prev.why, items: prev.items || [], with: prev.with || null }); continue; }
      delete state.skipped[lname];   // was skipped for a type that is allowed again: look at it normally
    }
    const mine = Object.entries(synced).find(([, s]) => lc(s.name) === lname);
    const bytes = mine && mine[1].version === c.version ? mine[1].bytes : c.zipBytes * 1.5;
    if (used + bytes > capBytes) { if (used >= capBytes * 0.97) break; continue; }   // try smaller ones until the cap is nearly full
    if (downloadedBytes > maxDownload) { log(`(stopped looking: downloaded ${mb(downloadedBytes)} MB this run - the next run continues)`); break; }
    let names; let staged = null;
    try {
      if (mine && mine[1].version === c.version) names = tocNames(path.join(m.modsDir, mine[0]));
      else { const zip = await download(c); downloadedBytes += c.zipBytes; staged = path.join(CACHE, 'staging', c.name); extract(zip, staged); names = tocNames(staged); }
    } catch (e) {
      log(`  ! ${c.name}: ${e.message}`);
      if (++failsInRow >= 5) throw new Error('5 downloads / unpacks failed in a row - stopping (see the lines above)');
      continue;                                   // errors are not remembered: the next run tries again
    }
    failsInRow = 0; checked++;
    if (checked % 10 === 0) log(`  checked ${checked} mods...`);
    const items = await modItems(cfg, staged || path.join(m.modsDir, mine[0]), names);
    const hit = items.find((x) => protect.has(x.slot));
    if (hit) { const why = offWhy(hit); state.skipped[lname] = { version: c.version, why, kind: 'protected', items }; rec(c, 'protected', { why, items }); continue; }
    const clash = clashWith(names);
    if (clash) { const why = `replaces the same game files as ${clash}`; state.skipped[lname] = { version: c.version, why, kind: 'clash', items, with: clash }; rec(c, 'clash', { why, items, with: clash }); continue; }
    const realBytes = staged ? dirSize(staged) : bytes;
    if (used + realBytes > capBytes) continue;
    used += realBytes; addSet(c.name, names); rec(c, 'planned', { items, mb: mb(realBytes) });
    if (mine && mine[1].version === c.version) keep.push({ c, folder: mine[0], bytes: realBytes });
    else install.push({ c, staged, bytes: realBytes, replaces: mine ? mine[0] : null });
  }
  const keepFolders = new Set([...keep.map((k) => k.folder), ...install.filter((i) => i.replaces).map((i) => i.replaces)]);
  const remove = Object.keys(synced).filter((f) => !keepFolders.has(f) || install.some((i) => i.replaces === f));
  for (const f of remove) if (!install.some((i) => i.replaces === f)) review.push({ name: synced[f].name, version: synced[f].version, mb: mb(synced[f].bytes), status: 'remove', why: 'no longer in the target set', items: [] });

  log(`Thunderstore: ${pkgs.length} packages, ${ranked.length} cosmetic / skateboard candidates.`);
  log(`Plan: ${keep.length + install.length} mods, ${mb(used)} of ${cfg.capMB} MB (${install.length} new, ${keep.length} kept, ${remove.length} to remove).`);
  const summary = { at: new Date().toISOString(), capMB: cfg.capMB, usedMB: mb(used), protect: [...protect], pins: cfg.pins, block: cfg.block, newCount: install.length, keepCount: keep.length, removeCount: remove.length, items: review };
  writeJson(REVIEW_FILE, summary);
  if (!doIt) { saveState(state); pruneCache(install.map((i) => `${i.c.name}-${i.c.version}.zip`)); log('Preview done - nothing was changed.'); return summary; }

  // ------------------------------------------------------------------ apply
  const busy = running();
  if (busy.length) throw new Error(`close ${busy.join(' and ')} first - the launcher rewrites mods.json and merges mods at launch`);
  fs.copyFileSync(m.listFile, m.listFile + '.bak-seefits');
  for (const f of remove) {
    if (!synced[f]) continue;                                           // never delete anything we did not install
    fs.rmSync(path.join(m.modsDir, f), { recursive: true, force: true });
    m.list.mods = m.list.mods.filter((x) => x.name !== f); delete synced[f];
    log(`removed ${f}`);
  }
  for (const i of install) {
    const folder = folderName(i.c.name);                                 // "Team-Name", updates replace it in place
    const target = path.join(m.modsDir, folder);
    if (fs.existsSync(target) && !synced[folder]) { log(`skip ${folder}: a folder with that name exists and is not ours`); continue; }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(i.staged, target);
    if (!m.list.mods.some((x) => x.name === folder)) m.list.mods.push({ enabled: true, name: folder });
    synced[folder] = { name: i.c.name, version: i.c.version, bytes: i.bytes, installedAt: new Date().toISOString(), source: sourceOf(i.c) };
    log(`installed ${folder} ${i.c.version}`);
  }
  writeModList(m); saveState(state);
  pruneCache([]);
  log(`Done. Synced mods use ${mb(Object.values(synced).reduce((n, s) => n + s.bytes, 0))} MB. Start ReSkate - new cosmetics load at launch.`);
  return summary;
}

// How much of other players' modded cosmetics fits in a given storage limit. Estimate: share of all cosmetic /
// skateboard downloads on Thunderstore covered by the top mods that fit (clash and protected-slot skips not counted).
async function coverage(cfg) {
  const pkgs = await fetchPackages();
  const dl = (p) => p.versions.reduce((n, v) => n + (v.downloads || 0), 0);
  const all = pkgs.filter((p) => !p.is_deprecated && (cfg.includeNsfw || !p.has_nsfw_content) && (p.categories || []).some((c) => cfg.categories.includes(c)) && !(p.categories || []).some((c) => ['Maps', 'Audio', 'Modpacks', 'Libraries'].includes(c)));
  const total = all.reduce((n, p) => n + dl(p), 0) || 1;
  const ranked = rank(pkgs, { ...cfg, block: [] });
  const points = [];
  for (let capMB = 500; capMB <= 20000; capMB += 250) {
    let used = 0, got = 0, mods = 0;
    for (const c of ranked) { const b = c.zipBytes * 1.5 / 1048576; if (used + b > capMB) continue; used += b; got += c.downloads; mods++; }
    points.push({ capMB, mods, pct: Math.round((got / total) * 100) });
  }
  let freeMB = null; const game = gameDir(cfg);
  try { if (game) { const s = fs.statfsSync(game); freeMB = Math.round((s.bavail * s.bsize) / 1048576); } } catch (_) {}
  return { points, freeMB };
}

// Renames synced folders whose names ReSkate refuses (over 64 characters / other characters) and fixes their
// mods.json rows. Only our own folders; one bad row makes ReSkate load no mods at all.
function repair(cfg, state) {
  const busy = running();
  if (busy.length) throw new Error(`close ${busy.join(' and ')} first - the launcher rewrites mods.json and merges mods at launch`);
  const m = modsInfo(cfg); const synced = state.synced; let fixed = 0;
  for (const old of Object.keys(synced)) {
    if (validFolder(old)) continue;
    const name = folderName(synced[old].name || old);
    const from = path.join(m.modsDir, old); const to = path.join(m.modsDir, name);
    if (fs.existsSync(to) && !synced[name]) { log(`! cannot rename ${old}: ${name} exists and is not ours - removing ours`); fs.rmSync(from, { recursive: true, force: true }); m.list.mods = m.list.mods.filter((x) => x.name !== old); delete synced[old]; fixed++; continue; }
    if (fs.existsSync(from)) { fs.rmSync(to, { recursive: true, force: true }); fs.renameSync(from, to); }
    const row = m.list.mods.find((x) => x.name === old);
    if (row) { if (m.list.mods.some((x) => x.name === name)) m.list.mods = m.list.mods.filter((x) => x !== row); else row.name = name; }
    synced[name] = synced[old]; delete synced[old];
    log(`renamed ${old} -> ${name} (ReSkate allows ${MAX_FOLDER} characters)`); fixed++;
  }
  if (fixed) { fs.copyFileSync(m.listFile, m.listFile + '.bak-seefits'); writeModList(m); saveState(state); }
  // any row ReSkate would still refuse (ours or not) is reported, never edited
  for (const x of m.list.mods) if (!validFolder(x.name)) log(`! mods.json row "${x.name}" is not a name ReSkate accepts - rename that folder and its row (not installed by this app)`);
  if (!fixed) log('Folder names: all fine.');
  return fixed;
}

// cache: after a preview only the zips of the planned installs stay; after a sync nothing stays
// ----------------------------------------------------------------------------- exact item lists + previews (lib/format)
// The format reader knows exactly which items a mod adds or replaces. If it cannot run (no Windows / no game DLL),
// the app falls back to guessing from the mod's file names.
const FMT_CACHE = path.join(DATA, 'format');
let fmtGame = null, fmtWarned = false;
function openFormat(cfg) {
  if (!fmtGame) fmtGame = fmt.openGame(gameDir(cfg), FMT_CACHE).catch((e) => { fmtGame = null; throw e; });
  return fmtGame;
}
async function modItems(cfg, dir, names) {
  try {
    const r = await fmt.inspectMod(await openFormat(cfg), dir);
    if (r.ok && (r.adds.length || r.replaces.length)) {
      return [...r.adds.map((a) => ({ slot: a.slot || 'other', item: a.name, key: a.key, change: 'adds' })),
        ...r.replaces.map((x) => ({ slot: x.slot || 'other', item: x.name, key: x.key, change: 'replaces', what: x.what }))];
    }
  } catch (e) { if (!fmtWarned) { fmtWarned = true; log(`(exact item check unavailable: ${e.message} - guessing from file names)`); } }
  return describe(names);
}

const safeName = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 90);
const PREVIEW_LIMIT = 400 * 1048576;
const PREVIEW_VERSION = 2;   // bump when lib/format changes what a preview looks like
let previewQueue = Promise.resolve();
// Builds (or reuses) the preview of one item of one mod. The mod comes from the Mods folder when it is installed,
// otherwise its Thunderstore zip is downloaded and unpacked inside the previews folder.
function preview(cfg, state, modName, key, force) {
  const job = previewQueue.then(() => previewNow(cfg, state, modName, key, force));
  previewQueue = job.catch(() => {});
  return job;
}
async function previewNow(cfg, state, modName, key, force) {
  const m = modsInfo(cfg); const lname = String(modName).toLowerCase();
  let dir = null, ver = null;
  const mine = Object.entries(state.synced).find(([, s]) => String(s.name).toLowerCase() === lname);
  if (mine) { dir = path.join(m.modsDir, mine[0]); ver = mine[1].version; }
  if (!dir) { const own = m.folders.find((f) => baseName(f).toLowerCase() === lname || f.toLowerCase() === folderName(modName).toLowerCase()); if (own) { dir = path.join(m.modsDir, own); ver = 'own'; } }
  if (!dir) {
    const p = (await fetchPackages()).find((x) => x.full_name.toLowerCase() === lname);
    if (!p) return { ok: false, reason: 'this mod is no longer on Thunderstore' };
    const v = p.versions[0]; ver = v.version_number;
    const src = path.join(PREVIEWS, safeName(p.full_name) + '@' + safeName(ver), 'src');
    if (!fs.existsSync(path.join(src, 'Win32'))) extract(await download({ name: p.full_name, version: ver, url: v.download_url, zipBytes: v.file_size }), src);
    dir = src;
  }
  const out = path.join(PREVIEWS, safeName(modName) + '@' + safeName(ver));
  const meta = path.join(out, safeName(key) + '.v' + PREVIEW_VERSION + '.result.json');   // new version = previews rebuild
  if (!force && fs.existsSync(meta)) return readJson(meta, { ok: false, reason: 'unreadable preview' });
  fs.mkdirSync(out, { recursive: true });
  const r = await fmt.buildPreview(await openFormat(cfg), dir, key, out);
  const rel = path.relative(PREVIEWS, out).split(path.sep).map(encodeURIComponent).join('/');
  const res = r.ok ? { ok: true, kind: r.kind, files: r.files.map((f) => `/previews/${rel}/${encodeURIComponent(f)}`), info: r.info } : { ok: false, code: r.code, reason: r.reason };
  writeJson(meta, res); trimPreviews(out);
  return res;
}
// previews are a cache: oldest mod folders go first once they pass 400 MB
function trimPreviews(keep) {
  try {
    const dirs = fs.readdirSync(PREVIEWS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => { const p = path.join(PREVIEWS, e.name); return { p, size: dirSize(p), at: fs.statSync(p).mtimeMs }; }).sort((a, b) => a.at - b.at);
    let total = dirs.reduce((n, d) => n + d.size, 0);
    for (const d of dirs) { if (total <= PREVIEW_LIMIT) break; if (d.p === keep) continue; fs.rmSync(d.p, { recursive: true, force: true }); total -= d.size; }
  } catch (_) {}
}

function pruneCache(keepZips) {
  const keep = new Set(keepZips);
  fs.rmSync(path.join(CACHE, 'staging'), { recursive: true, force: true });
  if (!fs.existsSync(CACHE)) return;
  let freed = 0;
  for (const f of fs.readdirSync(CACHE)) { const p = path.join(CACHE, f); if (keep.has(f)) continue; try { freed += fs.statSync(p).size; fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
  if (freed > 1048576) log(`(cache: freed ${mb(freed)} MB)`);
}

function status(cfg, state) {
  const list = Object.entries(state.synced).map(([folder, s]) => ({ folder, ...s, mb: mb(s.bytes) })).sort((a, b) => b.bytes - a.bytes);
  return { count: list.length, usedMB: mb(list.reduce((n, s) => n + s.bytes, 0)), capMB: cfg.capMB, mods: list, running: running() };
}

function clear(cfg, state) {
  const busy = running(); if (busy.length) throw new Error(`close ${busy.join(' and ')} first`);
  const m = modsInfo(cfg); fs.copyFileSync(m.listFile, m.listFile + '.bak-seefits');
  for (const f of Object.keys(state.synced)) { fs.rmSync(path.join(m.modsDir, f), { recursive: true, force: true }); m.list.mods = m.list.mods.filter((x) => x.name !== f); log(`removed ${f}`); }
  state.synced = {}; writeModList(m); saveState(state); log('All synced mods removed. Your own mods were not touched.');
}

// the Thunderstore names of the cosmetic mods you have switched on (yours + synced), for the community list
async function wornMods(cfg, state) {
  const m = modsInfo(cfg); const pkgs = await fetchPackages();
  const byLower = new Map(pkgs.filter((p) => (p.categories || []).some((c) => cfg.categories.includes(c))).map((p) => [p.full_name.toLowerCase(), p.full_name]));
  const on = m.list.mods.filter((x) => x.enabled).map((x) => (state.synced[x.name] ? state.synced[x.name].name : baseName(x.name)));
  return [...new Set(on.map((n) => byLower.get(n.toLowerCase())).filter(Boolean))];
}

module.exports = { HERE, preview, SLOT_LABEL, coverage, DATA, PREVIEWS, CACHE, IN_MODS, gameDir, modsInfo, DEFAULTS, SLOT_NAMES, REVIEW_FILE, log, setSink, readJson, loadConfig, saveConfig, loadState, saveState, plan, repair, folderName, validFolder, status, clear, running, wornMods, fetchPackages };
