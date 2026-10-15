#!/usr/bin/env node
'use strict';
/*
  Smoke test for lib/format against a real install. Reads only; writes the item index and previews to
  the folders you give it.

    node lib/format/test.js <game folder> <cache folder> [preview folder] [--previews N] [--only <text>]

  Runs inspectMod on every folder in <game folder>/Mods, then buildPreview on a sample of the items
  found (N added items and N replaced items; default 4), and prints a summary.
*/
const fs = require('fs');
const path = require('path');
const fmt = require('./index');

function args() {
  const a = process.argv.slice(2);
  const opt = { previews: 4, only: '' };
  const pos = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--previews') opt.previews = Number(a[++i]) || 0;
    else if (a[i] === '--only') opt.only = String(a[++i] || '').toLowerCase();
    else pos.push(a[i]);
  }
  [opt.game, opt.cache, opt.out] = pos;
  return opt;
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const secs = (ms) => (ms / 1000).toFixed(1) + ' s';

async function main() {
  const opt = args();
  if (!opt.game || !opt.cache) { console.log('usage: node lib/format/test.js <game folder> <cache folder> [preview folder] [--previews N] [--only <text>]'); process.exit(2); }
  const t0 = Date.now();
  let game;
  try { game = await fmt.openGame(opt.game, opt.cache, { log: (l) => console.log(l) }); }
  catch (e) { console.log('openGame failed:', e.code || '', e.message); process.exit(1); }
  const tOpen = Date.now() - t0;
  console.log(`Game opened in ${secs(tOpen)}: ${game.items.length} game items, catalogue ${game.catalog.size} entries, build ${game.build}.`);

  const modsDir = path.join(opt.game, 'Mods');
  const folders = fs.readdirSync(modsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name).filter((n) => !opt.only || n.toLowerCase().includes(opt.only)).sort();
  const rows = [], failures = new Map(), times = [];
  let adds = 0, replaces = 0, noData = 0;
  for (const name of folders) {
    const dir = path.join(modsDir, name);
    if (!fs.existsSync(path.join(dir, 'Win32'))) { noData++; continue; }
    const t = Date.now();
    const r = await fmt.inspectMod(game, dir);
    const ms = Date.now() - t;
    times.push(ms);
    if (!r.ok) {
      failures.set(r.code, (failures.get(r.code) || []).concat(name));
      console.log(`${pad(name, 46)} FAIL ${r.code}: ${r.reason}`);
      continue;
    }
    adds += r.adds.length; replaces += r.replaces.length;
    rows.push({ name, dir, r });
    const slots = [...new Set([...r.adds, ...r.replaces].map((x) => x.slot || '?'))].join(',');
    console.log(`${pad(name, 46)} +${String(r.adds.length).padEnd(3)} ~${String(r.replaces.length).padEnd(3)} ${pad(slots, 26)} ${secs(ms).padStart(7)}${r.notes.length ? '  | ' + r.notes.join('; ') : ''}`);
  }

  // previews: a sample of added items, then of replaced items
  const previews = [];
  if (opt.out && opt.previews > 0) {
    const pickAdds = [], pickReps = [];
    for (const row of rows) {
      if (pickAdds.length < opt.previews && row.r.adds.length) pickAdds.push({ row, key: row.r.adds[0].key });
      const rep = row.r.replaces.find((x) => x.parts.includes('mesh') || x.parts.includes('texture'));
      if (pickReps.length < opt.previews && rep) pickReps.push({ row, key: rep.key });
    }
    for (const { row, key } of [...pickAdds, ...pickReps]) {
      const t = Date.now();
      const p = await fmt.buildPreview(game, row.dir, key, path.join(opt.out, row.name.replace(/[^\w.-]+/g, '_')));
      previews.push({ mod: row.name, key, ms: Date.now() - t, p });
    }
  }

  console.log('\n==== summary');
  console.log(`mods folders: ${folders.length}, without game data: ${noData}, inspected ok: ${rows.length}, failed: ${[...failures.values()].reduce((s, v) => s + v.length, 0)}`);
  console.log(`items added: ${adds}, game items replaced: ${replaces}`);
  console.log(`mods that add only: ${rows.filter((x) => x.r.adds.length && !x.r.replaces.length).length}, replace only: ${rows.filter((x) => !x.r.adds.length && x.r.replaces.length).length}, both: ${rows.filter((x) => x.r.adds.length && x.r.replaces.length).length}, neither: ${rows.filter((x) => !x.r.adds.length && !x.r.replaces.length).length}`);
  for (const [code, list] of failures) console.log(`  failed (${code}): ${list.length} - ${list.slice(0, 5).join(', ')}${list.length > 5 ? ', ...' : ''}`);
  if (times.length) {
    const s = [...times].sort((a, b) => a - b);
    console.log(`time per mod: median ${secs(s[Math.floor(s.length / 2)])}, max ${secs(s[s.length - 1])}, total ${secs(s.reduce((a, b) => a + b, 0))}; open ${secs(tOpen)}`);
  }
  if (previews.length) {
    console.log('previews:');
    for (const x of previews) console.log(`  ${pad(x.mod, 40)} ${pad(x.key, 34)} ${x.p.ok ? x.p.kind + ' ' + x.p.files.join(' ') + (x.p.info.triangles ? ` (${x.p.info.triangles} tris, ${x.p.info.textures.length} textures)` : '') + (x.p.info.tint ? ` tint ${x.p.info.tint}` : '') : 'FAIL ' + x.p.code + ': ' + x.p.reason} ${secs(x.ms)}`);
  }
  const cacheFiles = fs.existsSync(opt.cache) ? fs.readdirSync(opt.cache).filter((f) => f.startsWith('format-index-')) : [];
  for (const f of cacheFiles) console.log(`cache: ${f} ${(fs.statSync(path.join(opt.cache, f)).size / 1048576).toFixed(1)} MB`);
}

main().catch((e) => { console.error('test crashed:', e); process.exit(1); });
