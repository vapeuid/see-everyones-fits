#!/usr/bin/env node
'use strict';
/*
  See Everyone's Fits - keeps the most popular ReSkate cosmetics installed so you see more of what other skaters wear.

    node app.js            opens the app in your browser (this PC only, http://127.0.0.1:4777)
    node app.js window     opens it in its own window and quits when that window is closed (the .exe does this)
    node app.js preview    what a sync would install / remove, nothing changes
    node app.js sync       do it (close the ReSkate launcher and the game first)
    node app.js status     what is synced now
    node app.js clear      remove every synced mod (your own mods stay)
    node app.js repair     fix synced folder names ReSkate refuses (close the launcher first)

  Engine: lib/core.js. Community list: lib/community.js. App window: ui/index.html.
*/
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const core = require('./lib/core');
const community = require('./lib/community');

const PORT = 4777;
const UI = path.join(__dirname, 'ui', 'index.html');
const os = require('os');
// the release zip carries manifest.json next to app.js; a source checkout has it in release/
const VERSION = (() => { for (const f of ['manifest.json', path.join('release', 'manifest.json')]) { try { return JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')).version_number; } catch (_) {} } return '0.0.0'; })();
const REPO = 'vapeuid/see-everyones-fits';
let latest = null;   // newest release on GitHub, checked once per start; the app never updates itself
async function checkLatest() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': `SeeEveryonesFits/${VERSION}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return;
    const j = await r.json(); const v = String(j.tag_name || '').replace(/^v/, '');
    if (/^\d+\.\d+\.\d+$/.test(v)) latest = { version: v, url: j.html_url };
  } catch (_) {}
}
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
// a short report people can paste when something goes wrong: no folder paths, no user names
function supportInfo() {
  const cfg = core.loadConfig(); const st = core.loadState(); const scrub = (t) => String(t || '').replace(/[A-Za-z]:[\\/][^\s'"]*/g, '<path>');
  let mods = 'n/a'; try { mods = core.modsInfo(cfg).folders.length; } catch (e) { mods = 'error: ' + scrub(e.message); }
  const rv = core.readJson(core.REVIEW_FILE, null); const s = core.status(cfg, st);
  return [`See Everyone's Fits ${VERSION}`, `Windows ${os.release()}, Node ${process.version}`,
    `Game found: ${core.gameDir(cfg) ? 'yes' : 'NO'} (inside Mods folder: ${core.IN_MODS ? 'yes' : 'no'})`, `Mod folders: ${mods}`,
    `Synced: ${s.count} mods, ${s.usedMB} of ${s.capMB} MB`, `Last check: ${rv ? `${rv.at} - ${rv.items.length} mods looked at, ${rv.newCount} new` : 'none yet'}`,
    `Last job: ${job.action || 'none'}${job.running ? ' (running)' : ''}${job.error ? ' - ERROR: ' + scrub(job.error) : ''}`,
    `Community list: ${cfg.community ? 'on' : 'off'}, NSFW: ${cfg.includeNsfw ? 'on' : 'off'}`].join('\n');
}

// ----------------------------------------------------------------------------- community list (anonymous, mod names only)
async function communityCounts(cfg) {
  if (!cfg.community) return new Map();
  try { const r = await community.read(community.COMMUNITY_TOPIC); core.log(`Community list: ${r.people.length} app users in the last 12 h.`); return r.counts; }
  catch (e) { core.log(`(community list not reachable: ${e.message} - using Thunderstore downloads only)`); return new Map(); }
}
async function shareWorn(cfg, state) {
  if (!cfg.community) return;
  try {
    if (!state.installId) { state.installId = community.newSender(); core.saveState(state); }
    const mods = await core.wornMods(cfg, state);
    const r = await community.publish(community.COMMUNITY_TOPIC, state.installId, mods);
    if (r.ok) core.log(`Shared your ${r.shared} switched-on cosmetic mods with the community list (anonymous).`);
  } catch (e) { core.log(`(could not share with the community list: ${e.message})`); }
}

// ----------------------------------------------------------------------------- jobs (one at a time, output shown live)
const job = { running: false, action: null, lines: [], error: null, finishedAt: null };
async function runJob(action) {
  if (job.running) throw new Error('something is already running');
  Object.assign(job, { running: true, action, lines: [], error: null, finishedAt: null });
  core.setSink((l) => { job.lines.push(l); if (job.lines.length > 400) job.lines.shift(); });
  try {
    const cfg = core.loadConfig(); const state = core.loadState();
    if (action === 'preview') await core.plan(cfg, state, false, await communityCounts(cfg));
    else if (action === 'sync') { await core.plan(cfg, state, true, await communityCounts(cfg)); await shareWorn(cfg, core.loadState()); }
    else if (action === 'clear') core.clear(cfg, state);
    else if (action === 'repair') core.repair(cfg, state);
    else throw new Error('unknown action ' + action);
  } catch (e) { job.error = e.message; core.log('ERROR: ' + e.message); core.endLive && core.endLive(); }
  finally { job.running = false; job.finishedAt = Date.now(); core.setSink(null); }
}

// ----------------------------------------------------------------------------- local app server (127.0.0.1 only)
let lastSeen = Date.now();
function serve(windowed) {
  checkLatest();
  if (windowed) setInterval(() => { if (!job.running && Date.now() - lastSeen > 120000) process.exit(0); }, 15000);   // window closed: no requests for 2 min
  const srv = http.createServer(async (req, res) => {
    lastSeen = Date.now();
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
    const body = () => new Promise((ok) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (_) { ok({}); } }); });
    // only this PC's browser, and only from our own page (blocks other websites from poking the app)
    // only requests addressed to this PC's app (blocks other websites, including DNS-rebinding tricks)
    const host = String(req.headers.host || '').toLowerCase(); if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(403, { error: 'forbidden' });
    const origin = req.headers.origin; if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return send(403, { error: 'forbidden' });
    try {
      if (req.method === 'GET' && req.url === '/') return send(200, fs.readFileSync(UI), 'text/html; charset=utf-8');
      if (req.method === 'GET' && req.url === '/bg.webp') return send(200, fs.readFileSync(path.join(__dirname, 'ui', 'bg.webp')), 'image/webp');
      if (req.method === 'GET' && req.url === '/api/state') {
        const cfg = core.loadConfig(); const state = core.loadState();
        return send(200, { version: VERSION, update: latest && newer(latest.version, VERSION) ? latest : null, config: cfg, game: core.gameDir(cfg), inMods: core.IN_MODS, status: core.status(cfg, state), slots: core.SLOT_NAMES, slotLabels: core.SLOT_LABEL, job: { running: job.running, action: job.action, error: job.error, finishedAt: job.finishedAt }, hasReview: fs.existsSync(core.REVIEW_FILE) });
      }
      if (req.method === 'GET' && req.url === '/api/review') return send(200, core.liveReview() || core.readJson(core.REVIEW_FILE, { items: [] }));
      if (req.method === 'GET' && req.url === '/api/job') return send(200, job);
      if (req.method === 'GET' && req.url === '/api/support') return send(200, { text: supportInfo() });
      if (req.method === 'GET' && req.url.startsWith('/api/preview?')) {
        const q = new URL(req.url, 'http://x').searchParams;
        const mod = q.get('mod') || '', key = q.get('key') || '';
        if (!/^[\w.-]+$/.test(mod) || !key || key.length > 300) return send(400, { ok: false, reason: 'bad request' });
        return send(200, await core.preview(core.loadConfig(), core.loadState(), mod, key, q.get('force') === '1'));
      }
      if (req.method === 'GET' && req.url.startsWith('/previews/')) {
        // files the preview builder wrote; nothing outside the previews folder is ever served
        const rel = decodeURIComponent(req.url.slice('/previews/'.length).split('?')[0]);
        const file = path.resolve(core.PREVIEWS, rel);
        if (!file.startsWith(path.resolve(core.PREVIEWS) + path.sep) || !fs.existsSync(file)) return send(404, { error: 'not found' });
        const type = { '.glb': 'model/gltf-binary', '.png': 'image/png', '.json': 'application/json' }[path.extname(file).toLowerCase()];
        if (!type) return send(404, { error: 'not found' });
        return send(200, fs.readFileSync(file), type);
      }
      if (req.method === 'GET' && req.url === '/viewer.js') return send(200, fs.readFileSync(path.join(__dirname, 'ui', 'viewer.js')), 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && req.url === '/api/coverage') return send(200, await core.coverage(core.loadConfig()));
      if (req.method === 'POST' && req.url === '/api/run') { const p = await body(); runJob(String(p.action)).catch(() => {}); return send(200, { ok: true }); }
      if (req.method === 'POST' && req.url === '/api/config') {
        const p = await body(); const cfg = core.loadConfig();
        if (p.capMB != null) cfg.capMB = Math.min(20480, Math.max(100, Math.round(Number(p.capMB) || 2048)));
        if (p.maxModMB != null) cfg.maxModMB = Math.min(1000, Math.max(5, Math.round(Number(p.maxModMB) || 150)));
        if (Array.isArray(p.protect)) cfg.protect = p.protect.filter((s) => core.SLOT_NAMES.includes(s));
        if (Array.isArray(p.protect)) {   // Thunderstore categories follow the types: decks on -> Skateboards, any clothing type on -> Cosmetics
          const on = core.SLOT_NAMES.filter((s) => !cfg.protect.includes(s));
          cfg.categories = [on.some((s) => s !== 'boards') && 'Cosmetics', on.includes('boards') && 'Skateboards'].filter(Boolean);
        }
        if (p.includeNsfw != null) cfg.includeNsfw = !!p.includeNsfw;
        if (p.community != null) cfg.community = !!p.community;
        if (p.reskateDir != null && fs.existsSync(path.join(String(p.reskateDir), 'Mods'))) cfg.reskateDir = String(p.reskateDir);
        core.saveConfig(cfg); return send(200, { ok: true, config: cfg });
      }
      if (req.method === 'POST' && req.url === '/api/choices') {
        const p = await body(); const clean = (a) => (Array.isArray(a) ? a.map(String).filter((x) => /^[\w.-]+$/.test(x)) : []);
        const cfg = core.loadConfig(); cfg.pins = clean(p.pins); cfg.block = clean(p.block); core.saveConfig(cfg); return send(200, { ok: true });
      }
      send(404, { error: 'not found' });
    } catch (e) { send(500, { error: e.message }); }
  });
  srv.on('error', (e) => { if (e.code === 'EADDRINUSE') { console.log(`See Everyone's Fits is already open: http://127.0.0.1:${PORT}/`); openBrowser(windowed); process.exit(0); } else throw e; });
  srv.listen(PORT, '127.0.0.1', () => { console.log(`See Everyone's Fits ${VERSION} is open: http://127.0.0.1:${PORT}/` + (windowed ? '' : '\nClose this window to quit.')); openBrowser(windowed); });
}
// windowed: Microsoft Edge in app mode (its own window, no tabs or address bar); otherwise the default browser
function openBrowser(windowed) {
  const url = `http://127.0.0.1:${PORT}/`;
  if (process.env.SEEFITS_NO_BROWSER) return;   // automated tests
  if (windowed) {
    for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]) {
      const edge = base && path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
      if (edge && fs.existsSync(edge)) { try { require('child_process').spawn(edge, [`--app=${url}`, '--window-size=1280,860'], { detached: true, stdio: 'ignore' }).unref(); return; } catch (_) {} }
    }
  }
  try { execFileSync('cmd', ['/c', 'start', '', url]); } catch (_) {}
}

// ----------------------------------------------------------------------------- command line
(async () => {
  const cmd = (process.argv[2] || 'app').toLowerCase();
  if (cmd === 'app' || cmd === 'window') return serve(cmd === 'window');
  if (cmd === 'status') { const s = core.status(core.loadConfig(), core.loadState()); console.log(`Synced mods: ${s.count}, ${s.usedMB} of ${s.capMB} MB`); s.mods.forEach((m) => console.log(`  ${m.folder} ${m.version}  ${m.mb} MB`)); return; }
  if (!['preview', 'sync', 'clear', 'repair'].includes(cmd)) { console.log('usage: node app.js [app|window|preview|sync|status|clear|repair]'); process.exitCode = 1; return; }
  await runJob(cmd);
  if (job.error) process.exitCode = 1;
})();
