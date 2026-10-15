#!/usr/bin/env node
'use strict';
/*
  Builds the Thunderstore package: dist/See_Everyones_Fits-<version>.zip

    node tools/build-release.js

  Takes the version from release/manifest.json, copies the app files plus manifest, icon, README, CHANGELOG and
  LICENSE, bundles the Node.js that runs this script as node/node.exe (with tools/node-LICENSE as node/LICENSE),
  runs the privacy check on the result and zips it with Windows' tar.exe.
*/
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { check } = require('./privacy-check');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'release', 'manifest.json'), 'utf8'));
const name = `${manifest.name}-${manifest.version_number}`;
const STAGE = path.join(DIST, name);

// what goes into the package: [source in the repo, path in the package]
const files = [
  ['app.js'], ['lib/core.js'], ['lib/community.js'],
  ...fs.readdirSync(path.join(ROOT, 'lib', 'format')).filter((f) => /\.(js|ps1)$/.test(f) && f !== 'test.js').map((f) => [`lib/format/${f}`]),
  ['ui/index.html'], ['ui/viewer.js'], ['ui/bg.webp'],
  ['See Everyones Fits.bat'], ['Sync now.bat'],
  ['README.md'], ['CHANGELOG.md'], ['LICENSE'],
  ['release/manifest.json', 'manifest.json'], ['release/icon.png', 'icon.png'],
];

function fail(msg) { console.error('BUILD FAILED: ' + msg); process.exit(1); }

// Thunderstore's own rules for the package files
if (!/^[A-Za-z0-9_]+$/.test(manifest.name)) fail('manifest name may only hold letters, digits and _');
if (!/^\d+\.\d+\.\d+$/.test(manifest.version_number)) fail('version_number must be like 1.0.0');
if (manifest.description.length > 250) fail(`description is ${manifest.description.length} characters (max 250)`);
const icon = fs.readFileSync(path.join(ROOT, 'release', 'icon.png'));
if (icon.readUInt32BE(16) !== 256 || icon.readUInt32BE(20) !== 256) fail('icon.png must be 256x256');
const nodeLicense = path.join(__dirname, 'node-LICENSE');
if (!fs.existsSync(nodeLicense)) fail('tools/node-LICENSE is missing (the licence text of the bundled Node.js)');

fs.rmSync(STAGE, { recursive: true, force: true });
for (const [src, dst = src] of files) {
  const from = path.join(ROOT, src), to = path.join(STAGE, dst);
  if (!fs.existsSync(from)) fail(`missing ${src}`);
  fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to);
}
const problems = check(STAGE);   // before node.exe goes in: it is a binary from nodejs.org
if (problems.length) { console.error(problems.join('\n')); fail('privacy check found the lines above'); }
fs.mkdirSync(path.join(STAGE, 'node'), { recursive: true });
fs.copyFileSync(process.execPath, path.join(STAGE, 'node', 'node.exe'));
fs.copyFileSync(nodeLicense, path.join(STAGE, 'node', 'LICENSE'));

const zip = path.join(DIST, name + '.zip');
fs.rmSync(zip, { force: true });
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
execFileSync(TAR, ['-a', '-c', '-f', zip, '-C', STAGE, ...fs.readdirSync(STAGE)]);
const listing = execFileSync(TAR, ['-tf', zip], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
for (const must of ['manifest.json', 'icon.png', 'README.md', 'app.js', 'node/node.exe']) if (!listing.includes(must)) fail(`zip has no ${must} at its root`);
console.log(`Built ${path.relative(ROOT, zip)}: ${listing.length} entries, ${(fs.statSync(zip).size / 1048576).toFixed(1)} MB (Node ${process.version})`);
