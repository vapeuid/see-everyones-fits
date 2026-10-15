'use strict';
// Reading payloads out of cas archives.
//
// A data layer (the game's Data folder, or a mod folder) keeps its archives at
// <root>/Win32/<package folder>/cas_NN.cas; layout.toc names the package folder of each install chunk.
// A payload is a stream of blocks, each with an 8-byte header:
//   u32 BE decoded size (low 24 bits; top byte = dictionary flag), u16 LE codec (low 7 bits, bits 8-11 =
//   encoded size bits 16-19), u16 BE encoded size.
// Codecs: 0x00 raw, 0x02 zlib, 0x09 LZ4, 0x0F zstd, 0x11 Oodle Kraken, 0x15 Oodle Selkie, 0x19 Oodle Leviathan.
// Everything is decoded in this process (Kraken by oodle.js); nothing here writes or runs anything.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { fail, FormatError } = require('./errors');
const oodle = require('./oodle');

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
    const head = buf.readUInt32BE(p);
    const comp = buf.readUInt16LE(p + 4);
    const encoded = buf.readUInt16BE(p + 6) + (((comp >> 8) & 0x0F) << 16);
    p += 8;
    if (p + encoded > buf.length) return null;
    out.push({ codec: comp & 0x7F, decoded: head & 0xFFFFFF, dict: (head >>> 24) !== 0, encoded, at: p });
    p += encoded;
  }
  return out;
}

// Decodes payloads whose blocks are all raw without copying; null when one is compressed.
function decodeLocal(buf) {
  const bl = blocks(buf);
  if (!bl || bl.some((b) => b.codec !== 0 || b.decoded !== b.encoded)) return null;
  return bl.length === 1 ? buf.subarray(bl[0].at, bl[0].at + bl[0].encoded) : Buffer.concat(bl.map((b) => buf.subarray(b.at, b.at + b.encoded)));
}

// LZ4 block format: tokens of (literal count, match length), 2-byte little-endian match offsets.
function lz4(src, size) {
  const out = Buffer.alloc(size);
  let s = 0, d = 0;
  const more = (n) => { let b; do { if (s >= src.length) throw new Error('truncated'); b = src[s++]; n += b; } while (b === 255); return n; };
  while (s < src.length) {
    const token = src[s++];
    let lit = token >> 4;
    if (lit === 15) lit = more(lit);
    if (s + lit > src.length || d + lit > size) throw new Error('literals overrun');
    src.copy(out, d, s, s + lit); s += lit; d += lit;
    if (s >= src.length) break;   // the last sequence has literals only
    const off = src[s] | (src[s + 1] << 8); s += 2;
    let len = token & 15;
    if (len === 15) len = more(len);
    len += 4;
    if (!off || off > d || d + len > size) throw new Error('bad match');
    for (let k = 0; k < len; k++, d++) out[d] = out[d - off];
  }
  if (d !== size) throw new Error('wrong size');
  return out;
}

const CODEC_NAMES = { 0x09: 'LZ4', 0x0F: 'zstd', 0x15: 'Oodle Selkie', 0x19: 'Oodle Leviathan' };

function decodeBlock(b, data) {
  switch (b.codec) {
    case 0x00:
      if (b.decoded !== b.encoded) fail('decode', 'a raw block has the wrong size');
      return data;
    case 0x11: case 0x15: case 0x19:
      try { return oodle.decompress(data, b.decoded); }
      catch (e) {
        if (e instanceof oodle.OodleError && e.code === 'unsupported-codec') fail('unsupported-codec', e.message);
        return fail('decode', 'a payload did not decode: ' + e.message);
      }
    case 0x02: {
      let out;
      try { out = zlib.inflateSync(data); } catch (_) { return fail('decode', 'a zlib block did not decode'); }
      if (out.length !== b.decoded) fail('decode', 'a zlib block has the wrong size');
      return out;
    }
    case 0x09:
      try { return lz4(data, b.decoded); } catch (e) { return fail('decode', 'an LZ4 block did not decode (' + e.message + ')'); }
    case 0x0F: {
      if (b.dict || typeof zlib.zstdDecompressSync !== 'function') fail('unsupported-codec', 'zstd data' + (b.dict ? ' with a dictionary' : '') + ' is not supported');
      let out;
      try { out = zlib.zstdDecompressSync(data); } catch (_) { return fail('decode', 'a zstd block did not decode'); }
      if (out.length !== b.decoded) fail('decode', 'a zstd block has the wrong size');
      return out;
    }
    default:
      return fail('unsupported-codec', `compression ${CODEC_NAMES[b.codec] || '0x' + b.codec.toString(16)} is not supported`);
  }
}

// One encoded payload -> Buffer of the decoded bytes; throws FormatError.
function decodePayload(buf) {
  const local = decodeLocal(buf);
  if (local) return local;
  const bl = blocks(buf);
  if (!bl) fail('decode', 'a payload is not a block stream');
  const total = bl.reduce((n, b) => n + b.decoded, 0);
  if (total > 512 << 20) fail('decode', 'a payload is larger than the safety limit');
  const out = Buffer.allocUnsafe(total);
  let d = 0;
  for (const b of bl) {
    const part = decodeBlock(b, buf.subarray(b.at, b.at + b.encoded));
    out.set(part, d);
    d += part.length;
  }
  return out;
}

const YIELD_MS = 40;   // hand the event loop back this often during long batches
const pause = () => new Promise((resolve) => setImmediate(resolve));

// jobs: [{ layer, file }] -> Promise<[Buffer | FormatError]> in the same order. (A second argument, once
// the game folder for its Oodle DLL, is accepted and ignored.)
async function decodeMany(jobs) {
  const results = new Array(jobs.length);
  let slice = Date.now();
  for (let i = 0; i < jobs.length; i++) {
    try { results[i] = decodePayload(jobs[i].layer.read(jobs[i].file)); }
    catch (e) { results[i] = e instanceof FormatError ? e : new FormatError('decode', 'a payload did not decode: ' + e.message); }
    if (Date.now() - slice > YIELD_MS) { await pause(); slice = Date.now(); }
  }
  return results;
}

module.exports = { Layer, blocks, decodeLocal, decodePayload, decodeMany };
