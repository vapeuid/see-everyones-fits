'use strict';
// Reading payloads out of cas archives.
//
// A data layer (the game's Data folder, or a mod folder) keeps its archives at
// <root>/Win32/<package folder>/cas_NN.cas; layout.toc names the package folder of each install chunk.
// A payload is a stream of blocks, each with an 8-byte header:
//   u32 BE decoded size (low 24 bits; top byte = dictionary flag), u16 LE codec (low 7 bits, bits 8-11 =
//   encoded size bits 16-19), u16 BE encoded size. Codecs: 0x00 raw, 0x02 zlib, 0x11/0x15/0x19 Oodle.
// Raw payloads are read here; anything compressed goes in one batch to oodle.ps1, which uses the
// game's own oo2core DLL. Everything here only reads.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { fail, FormatError } = require('./errors');

class Layer {
  constructor(root, installChunks) { this.root = root; this.installChunks = installChunks; }
  archivePath(loc) {
    const dir = this.installChunks.get(loc.installChunk);
    if (dir === undefined) fail('unknown-archive', 'a file points at an install chunk the game does not list');
    return path.join(this.root, 'Win32', ...dir.split('/'), 'cas_' + String(loc.archive).padStart(2, '0') + '.cas');
  }
  read(file) {
    const p = this.archivePath(file.location);
    let fd;
    try { fd = fs.openSync(p, 'r'); } catch (_) { return fail('missing-archive', 'an archive the mod needs is missing (' + path.basename(p) + ')'); }
    try {
      const b = Buffer.allocUnsafe(file.size);
      const got = fs.readSync(fd, b, 0, file.size, file.offset);
      if (got !== file.size) fail('truncated-archive', 'an archive is shorter than its index says (' + path.basename(p) + ')');
      return b;
    } finally { fs.closeSync(fd); }
  }
}

// Block headers of an encoded payload; null when they do not tile the buffer.
function blocks(buf) {
  const out = [];
  let p = 0;
  while (p < buf.length) {
    if (p + 8 > buf.length) return null;
    const decoded = buf.readUInt32BE(p) & 0xFFFFFF;
    const comp = buf.readUInt16LE(p + 4);
    const encoded = buf.readUInt16BE(p + 6) + (((comp >> 8) & 0x0F) << 16);
    p += 8;
    if (p + encoded > buf.length) return null;
    out.push({ codec: comp & 0x7F, decoded, encoded, at: p });
    p += encoded;
  }
  return out;
}

// Decodes payloads in the JS process when every block is raw; null when a helper is needed.
function decodeLocal(buf) {
  const bl = blocks(buf);
  if (!bl || bl.some((b) => b.codec !== 0 || b.decoded !== b.encoded)) return null;
  return bl.length === 1 ? buf.subarray(bl[0].at, bl[0].at + bl[0].encoded) : Buffer.concat(bl.map((b) => buf.subarray(b.at, b.at + b.encoded)));
}

function findOodle(gameRoot) {
  let names = [];
  try { names = fs.readdirSync(gameRoot).filter((n) => /^oo2core_\d+_win64\.dll$/i.test(n)).sort(); } catch (_) { /* below */ }
  return names.length ? path.join(gameRoot, names[names.length - 1]) : null;
}

function powershell() {
  const sys = process.env.SystemRoot || process.env.windir;
  const p = sys ? path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
  return p && fs.existsSync(p) ? p : 'powershell.exe';
}

const BATCH = 3000;   // jobs per helper process (one process costs ~1-2 s of compile time)

// jobs: [{ layer, file }] -> Promise<[Buffer | FormatError]> in the same order.
async function decodeMany(jobs, gameRoot) {
  const results = new Array(jobs.length);
  const remote = [];
  jobs.forEach((j, i) => {
    try {
      const raw = j.layer.read(j.file);
      const local = decodeLocal(raw);
      if (local) results[i] = local;
      else remote.push({ i, path: j.layer.archivePath(j.file.location), offset: j.file.offset, size: j.file.size });
    } catch (e) { results[i] = e instanceof FormatError ? e : new FormatError('read', e.message); }
  });
  if (!remote.length) return results;
  if (process.platform !== 'win32') { for (const r of remote) results[r.i] = new FormatError('no-oodle', 'compressed game data can only be read on Windows'); return results; }
  const dll = findOodle(gameRoot);
  if (!dll) { for (const r of remote) results[r.i] = new FormatError('no-oodle', "the game's Oodle DLL (oo2core_*_win64.dll) was not found in the game folder"); return results; }
  for (let s = 0; s < remote.length; s += BATCH) await runHelper(remote.slice(s, s + BATCH), dll, results);
  return results;
}

function runHelper(batch, dll, results) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reskate-format-'));
  const jobsFile = path.join(dir, 'jobs.txt'), outFile = path.join(dir, 'out.bin');
  fs.writeFileSync(jobsFile, batch.map((b) => `${b.path}\t${b.offset}\t${b.size}`).join('\n'), 'utf8');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'oodle.ps1'), '-Jobs', jobsFile, '-Dll', dll, '-Out', outFile];
  return new Promise((resolve) => {
    execFile(powershell(), args, { windowsHide: true, maxBuffer: 64 << 20, timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
      try {
        const lines = String(stdout || '').split(/\r?\n/).filter((l) => l.length);
        if (lines.length !== batch.length) {
          const why = (String(stderr || '').split(/\r?\n/).find((l) => l.trim()) || (err && err.message) || 'no output').slice(0, 200);
          for (const b of batch) results[b.i] = new FormatError('decoder-failed', 'the decoder helper failed: ' + why);
          return;
        }
        const out = fs.readFileSync(outFile);
        let at = 0;
        lines.forEach((l, k) => {
          // keep file names, drop folders (messages may reach logs or the UI)
          if (l.startsWith('ERR ')) { results[batch[k].i] = new FormatError('decode', 'a payload did not decode: ' + l.slice(4).replace(/[A-Za-z]:[\\/][^'"]*[\\/]/g, '')); return; }
          const n = Number(l);
          results[batch[k].i] = out.subarray(at, at + n);
          at += n;
        });
      } catch (e) {
        for (const b of batch) if (!results[b.i]) results[b.i] = new FormatError('decoder-failed', 'the decoder helper failed: ' + e.message);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        resolve();
      }
    });
  });
}

module.exports = { Layer, blocks, decodeLocal, decodeMany, findOodle };
