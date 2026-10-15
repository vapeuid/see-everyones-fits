#!/usr/bin/env node
'use strict';
/*
  See Everyone's Fits - keeps the most popular ReSkate cosmetics installed so you see more of what other skaters wear.

    node app.js            opens the app in your browser (this PC only, http://127.0.0.1:4777)
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
  } catch (e) { job.error = e.message; core.log('ERROR: ' + e.message); }
  finally { job.running = false; job.finishedAt = Date.now(); core.setSink(null); }
}

// ----------------------------------------------------------------------------- local app server (127.0.0.1 only)
function serve() {
  const srv = http.createServer(async (req, res) => {
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
        return send(200, { config: cfg, game: core.gameDir(cfg), inMods: core.IN_MODS, status: core.status(cfg, state), slots: core.SLOT_NAMES, slotLabels: core.SLOT_LABEL, job: { running: job.running, action: job.action, error: job.error, finishedAt: job.finishedAt }, hasReview: fs.existsSync(core.REVIEW_FILE) });
      }
      if (req.method === 'GET' && req.url === '/api/review') return send(200, core.readJson(core.REVIEW_FILE, { items: [] }));
      if (req.method === 'GET' && req.url === '/api/job') return send(200, job);
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
  srv.on('error', (e) => { if (e.code === 'EADDRINUSE') { console.log(`See Everyone's Fits is already open: http://127.0.0.1:${PORT}/`); openBrowser(); process.exit(0); } else throw e; });
  srv.listen(PORT, '127.0.0.1', () => { console.log(`See Everyone's Fits is open in your browser: http://127.0.0.1:${PORT}/\nClose this window to quit.`); openBrowser(); });
}
function openBrowser() { try { execFileSync('cmd', ['/c', 'start', '', `http://127.0.0.1:${PORT}/`]); } catch (_) {} }

// ----------------------------------------------------------------------------- command line
(async () => {
  const cmd = (process.argv[2] || 'app').toLowerCase();
  if (cmd === 'app') return serve();
  if (cmd === 'status') { const s = core.status(core.loadConfig(), core.loadState()); console.log(`Synced mods: ${s.count}, ${s.usedMB} of ${s.capMB} MB`); s.mods.forEach((m) => console.log(`  ${m.folder} ${m.version}  ${m.mb} MB`)); return; }
  if (!['preview', 'sync', 'clear', 'repair'].includes(cmd)) { console.log('usage: node app.js [app|preview|sync|status|clear|repair]'); process.exitCode = 1; return; }
  await runJob(cmd);
  if (job.error) process.exitCode = 1;
})();
