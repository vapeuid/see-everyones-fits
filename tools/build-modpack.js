#!/usr/bin/env node
'use strict';
/*
  Builds the Thunderstore modpack edition: a package that lists the current top cosmetics and boards as dependencies,
  so the ReSkate launcher installs them all in one click.

    node tools/build-modpack.js [--game <ReSkate folder>] [--mb 2048] [--version 1.2.0]

  Picks mods the same way the app does with its default settings (no clashes, never skin / face / body, no NSFW,
  within --mb of space), as if nothing else were installed. Runs in its own data folder
  (%LOCALAPPDATA%\SeeEveryonesFits-modpack), so it never touches the app's settings or synced mods.
  Output: dist/See_Everyones_Fits-modpack-<version>.zip, and release/modpack.json (what went into it).
*/
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LOCAL = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
const appConfig = (() => { try { return JSON.parse(fs.readFileSync(path.join(LOCAL, 'SeeEveryonesFits', 'config.json'), 'utf8')); } catch (_) { return {}; } })();
process.env.SEEFITS_DATA = path.join(LOCAL, 'SeeEveryonesFits-modpack');   // before lib/core loads
const core = require('../lib/core');
const community = require('../lib/community');
const { check } = require('./privacy-check');

const ROOT = path.join(__dirname, '..');
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const fail = (msg) => { console.error('BUILD FAILED: ' + msg); process.exit(1); };

(async () => {
  const game = arg('game', appConfig.reskateDir);
  if (!game || !fs.existsSync(path.join(game, 'Mods'))) fail('pass --game <your ReSkate folder> (the one with Skate.exe and Mods)');
  const capMB = Math.max(200, Number(arg('mb', 2048)) || 2048);
  const cfg = { ...core.DEFAULTS, reskateDir: game, capMB, includeNsfw: false, protect: ['skin', 'face', 'body'], categories: ['Cosmetics', 'Skateboards'], pins: [], block: [] };
  core.saveConfig(cfg);
  const state = { synced: {}, skipped: core.loadState().skipped };   // remembered skips make weekly runs fast
  let counts = new Map();
  try { counts = (await community.read(community.COMMUNITY_TOPIC)).counts; } catch (_) {}

  const summary = await core.plan(cfg, state, false, counts, { ignoreOwn: true });
  const picked = summary.items.filter((i) => i.status === 'planned');
  if (picked.length < 5) fail(`only ${picked.length} mods picked - something is wrong`);

  // version: one minor step per build unless given
  const lastFile = path.join(ROOT, 'release', 'modpack.json');
  const last = (() => { try { return JSON.parse(fs.readFileSync(lastFile, 'utf8')); } catch (_) { return null; } })();
  const version = arg('version', last ? last.version.replace(/^(\d+)\.(\d+)\.\d+$/, (m, a, b) => `${a}.${+b + 1}.0`) : '1.0.0');
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail('version must be like 1.2.0');

  const dependencies = picked.map((i) => `${i.name}-${i.version}`);
  const description = "You won't look different. Everyone else will. The most-worn ReSkate cosmetics and boards in one click, so other skaters' modded fits actually show up. No clashes. Updated weekly. Full app free on GitHub.";
  if (description.length > 250) fail('description too long');
  const manifest = { name: 'See_Everyones_Fits', version_number: version, website_url: 'https://github.com/vapeuid/see-everyones-fits', description, dependencies };

  // the pack's own game content (the See Everyone's Fits deck, built with ReSkate Studio), if present
  const content = path.join(ROOT, 'release', 'pack-content');
  const hasDeck = fs.existsSync(path.join(content, 'layout.toc'));

  const label = (i) => { const slots = [...new Set((i.items || []).map((x) => core.SLOT_LABEL[x.slot] || x.slot).filter((s) => s && s !== 'other'))]; return slots.join(', ') || '-'; };
  const readme = [
    "# See Everyone's Fits",
    '',
    "**You won't look different. Everyone else will.**",
    '',
    "In ReSkate you only see someone's modded fit if you have that exact mod installed; otherwise they look stock to you.",
    "This pack installs the most-worn cosmetics and boards on Thunderstore in one click, so far more of the fits around",
    'you actually show up.',
    '',
    '## What now?',
    '',
    '1. **Start ReSkate.** The first start takes longer while the game merges the new mods.',
    ...(hasDeck ? ["2. **Open your board menu and equip the See Everyone's Fits deck.** If it's there, the pack worked."] : ['2. **Open your closet and board menu.** Hundreds of new items are there to wear.']),
    '3. **Join a busy session.** Fits that used to look stock now show for real.',
    '',
    `**This week: ${picked.length} mods, about ${(summary.usedMB / 1024).toFixed(1)} GB.** Picked by what players download`,
    'and wear, with no two mods replacing the same game files, and nothing that changes your skin, face or body.',
    'Updated weekly. Updates add the new top mods; mods that drop out stay installed until you remove them.',
    '',
    '# WANT TO CHOOSE WHAT YOU GET? GET THE FREE APP',
    '',
    'In the ReSkate launcher? Press the **THUNDERSTORE** button above to open this page in your browser, where the links work.',
    '',
    'Download: **https://github.com/vapeuid/see-everyones-fits/releases/latest/download/See_Everyones_Fits.zip**',
    '',
    'Guide and source: **https://github.com/vapeuid/see-everyones-fits**',
    '',
    "The free **See Everyone's Fits app** picks mods for you with the space you choose (500 MB to 20 GB), lets you switch",
    'types on or off (decks, tops, shoes, ...), shows a 3D preview of every item, keeps everything updated and removes',
    'mods that drop out. Open source: https://github.com/vapeuid/see-everyones-fits',
    '',
    '## In this pack',
    '',
    '| Mod | What it adds |',
    '|---|---|',
    ...picked.map((i) => `| [${i.name.replace(/_/g, ' ')}](${i.page}) | ${label(i)} |`),
    '',
    'All credit goes to the creators of these mods. Not affiliated with ReSkate, Thunderstore or EA.',
    '',
  ].join('\n');

  const name = `See_Everyones_Fits-modpack-${version}`;
  const stage = path.join(ROOT, 'dist', name);
  fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(stage, 'README.md'), readme);
  fs.copyFileSync(path.join(ROOT, 'release', 'icon.png'), path.join(stage, 'icon.png'));
  if (hasDeck) fs.cpSync(content, stage, { recursive: true });   // layout.toc + Win32/ at the top: a real mod the launcher loads
  const problems = check(stage);
  if (problems.length) { console.error(problems.join('\n')); fail('privacy check found the lines above'); }
  const zip = path.join(ROOT, 'dist', name + '.zip');
  fs.rmSync(zip, { force: true });
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', stage, ...fs.readdirSync(stage)]);
  fs.writeFileSync(lastFile, JSON.stringify({ version, builtAt: new Date().toISOString(), capMB, usedMB: summary.usedMB, dependencies }, null, 2) + '\n');
  console.log(`\nBuilt ${path.relative(ROOT, zip)}: ${picked.length} mods, ${summary.usedMB} MB. Upload it to Thunderstore (category Modpacks).${hasDeck ? "" : " (No deck yet: put the Studio-built deck mod in release/pack-content/.)"}`);
})().catch((e) => fail(e.message));
