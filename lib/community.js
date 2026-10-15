'use strict';
// Community list over ntfy.sh (free, no account, no server of our own).
// Each app posts the Thunderstore names of the cosmetic mods it has switched on; other apps read the last 12 h of posts
// (ntfy.sh keeps messages about that long) and count how many people use each mod. Only names are exchanged: the
// planner only ever installs mods that are on Thunderstore's own list, so nobody can push files to anyone.
const crypto = require('crypto');

const NTFY = 'https://ntfy.sh';
const COMMUNITY_TOPIC = 'see-everyones-fits-v1';
const MAX_BODY = 3800;                       // ntfy's message limit is 4096 bytes

// an anonymous id per install (so one person counts once); not linked to any account
const newSender = () => 'u' + crypto.randomBytes(8).toString('hex');
const validTopic = (t) => /^[a-z0-9_-]{8,64}$/i.test(String(t || ''));

async function publish(topic, sender, mods) {
  if (!validTopic(topic)) return { ok: false, error: 'bad topic' };
  const list = [];
  for (const m of mods) { list.push(m); if (JSON.stringify({ v: 1, app: 'reskate-sync', sender, mods: list }).length > MAX_BODY) { list.pop(); break; } }
  const body = JSON.stringify({ v: 1, app: 'reskate-sync', sender: String(sender).slice(0, 40), mods: list });
  const r = await fetch(`${NTFY}/${topic}`, { method: 'POST', body, headers: { 'User-Agent': 'SeeEveryonesFits/1.0' }, signal: AbortSignal.timeout(15000) });
  return { ok: r.ok, shared: list.length, error: r.ok ? null : `ntfy HTTP ${r.status}` };
}

// -> { counts: Map(modName -> number of people), people: [{sender, at, mods}] }  (latest post per sender)
async function read(topic) {
  const counts = new Map(); const latest = new Map();
  if (!validTopic(topic)) return { counts, people: [] };
  const r = await fetch(`${NTFY}/${topic}/json?poll=1&since=12h`, { headers: { 'User-Agent': 'SeeEveryonesFits/1.0' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`ntfy HTTP ${r.status}`);
  for (const line of (await r.text()).split('\n')) {
    let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
    if (ev.event !== 'message' || !ev.message) continue;
    let p; try { p = JSON.parse(ev.message); } catch (_) { continue; }
    if (!p || p.app !== 'reskate-sync' || !Array.isArray(p.mods) || !p.sender) continue;
    const prev = latest.get(p.sender); if (!prev || prev.at < ev.time) latest.set(p.sender, { sender: String(p.sender).slice(0, 40), at: ev.time, mods: p.mods.filter((x) => typeof x === 'string' && /^[\w.-]{3,120}$/.test(x)).slice(0, 300) });
  }
  for (const p of latest.values()) for (const m of new Set(p.mods)) counts.set(m, (counts.get(m) || 0) + 1);
  return { counts, people: [...latest.values()] };
}

module.exports = { COMMUNITY_TOPIC, newSender, validTopic, publish, read };
