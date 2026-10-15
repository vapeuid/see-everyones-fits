'use strict';
/*
  Oodle Kraken decompression in plain JavaScript, for the game data skate. stores with Oodle (CAS codec 0x11).

  This is a JavaScript port of the Kraken decoder in "ooz" by Powzix (https://github.com/powzix/ooz,
  kraken.cpp, Copyright (C) 2016 Powzix), which is free software under the GNU General Public License,
  version 3 or (at your option) any later version. This port is distributed under the same terms
  (GPL-3.0-or-later); see the LICENSE file of this project.

  Only Kraken (Oodle decoder type 6) is implemented: it is the only Oodle codec found in the game's and
  the mods' data. Mermaid/Selkie (10), Leviathan (12), LZNA (5) and BitKnit (11) streams throw an
  OodleError with code 'unsupported-codec'.

  Stream layout, briefly:
    - Per 256 KiB block: a 2-byte header (low nibble 0xC; bit 6 = stored uncompressed; second byte = decoder
      type, bit 7 = checksums present).
    - Per quantum: a 3-byte big-endian header with an 18-bit compressed size (+1) or a "memset" marker,
      plus a 3-byte checksum when checksums are on (not verified here).
    - A quantum is split into 128 KiB chunks. A chunk is either entropy-coded bytes, or an LZ table
      (literal, command, offset and length streams) followed by the LZ runs that rebuild the output.
    - Byte streams are stored raw, Huffman coded (one or two times three interleaved streams), tANS coded,
      run-length coded, or split into several sub-streams.
*/

class OodleError extends Error {
  constructor(code, message) { super(message); this.name = 'OodleError'; this.code = code; }
}
const fail = (message) => { throw new OodleError('bad-data', 'Oodle data is invalid (' + message + ')'); };

const PAD = 32;   // zero bytes around the source so reads a little past either end stay in bounds

// ----------------------------------------------------------------------------- MSB-first bit reader
// bits holds upcoming bits at the top of a 32-bit word; bitpos = 24 - number of valid bits.
function bitReader(buf, p, end) { const br = { buf, p, end, bits: 0, bitpos: 24 }; refill(br); return br; }
function refill(br) {
  while (br.bitpos > 0) {
    br.bits = (br.bits | ((br.p < br.end ? br.buf[br.p] : 0) << br.bitpos)) >>> 0;
    br.bitpos -= 8;
    br.p++;
  }
}
// Reading backwards: p moves down and `end` is the lower bound.
function refillBack(br) {
  while (br.bitpos > 0) {
    br.p--;
    br.bits = (br.bits | ((br.p >= br.end ? br.buf[br.p] : 0) << br.bitpos)) >>> 0;
    br.bitpos -= 8;
  }
}
const shl = (x, n) => (n >= 32 ? 0 : (x << n) >>> 0);
function readBitNoRefill(br) { const r = br.bits >>> 31; br.bits = (br.bits << 1) >>> 0; br.bitpos += 1; return r; }
function readBit(br) { refill(br); return readBitNoRefill(br); }
function readBits(br, n) {   // n = 1..32, no refill
  const r = br.bits >>> (32 - n);
  br.bits = shl(br.bits, n);
  br.bitpos += n;
  return r;
}
const readBitsZero = (br, n) => (n === 0 ? 0 : readBits(br, n));
function readMoreThan24Bits(br, n, back) {
  let rv;
  if (n <= 24) rv = readBitsZero(br, n);
  else {
    rv = readBits(br, 24) * 2 ** (n - 24);
    if (back) refillBack(br); else refill(br);
    rv += readBits(br, n - 24);
  }
  if (back) refillBack(br); else refill(br);
  return rv >>> 0;
}
const rotl = (x, n) => { n &= 31; return n ? ((x << n) | (x >>> (32 - n))) >>> 0 : x >>> 0; };
// An LZ offset coded with the 8-bit value v from the packed offset stream.
function readDistance(br, v, back) {
  let rv;
  if (v < 0xF0) {
    const n = (v >> 4) + 4;
    const w = rotl((br.bits | 1) >>> 0, n);
    br.bitpos += n;
    const m = (2 ** (n + 1) - 1) >>> 0;
    br.bits = (w & ~m) >>> 0;
    rv = ((w & m) >>> 0) * 16 + (v & 0xF) - 248;
  } else {
    const n = v - 0xF0 + 4;
    const w = rotl((br.bits | 1) >>> 0, n);
    br.bitpos += n;
    const m = (2 ** (n + 1) - 1) >>> 0;
    br.bits = (w & ~m) >>> 0;
    rv = 8322816 + ((w & m) >>> 0) * 4096;
    if (back) refillBack(br); else refill(br);
    rv += br.bits >>> 20;
    br.bitpos += 12;
    br.bits = (br.bits << 12) >>> 0;
  }
  if (back) refillBack(br); else refill(br);
  return rv >>> 0;
}
// A long length (literal or match), or -1 when invalid.
function readLength(br, back) {
  let n = Math.clz32(br.bits);
  if (n > 12) return -1;
  br.bitpos += n;
  br.bits = shl(br.bits, n);
  if (back) refillBack(br); else refill(br);
  n += 7;
  br.bitpos += n;
  const rv = (br.bits >>> (32 - n)) - 64;
  br.bits = shl(br.bits, n);
  if (back) refillBack(br); else refill(br);
  return rv;
}
// Truncated-binary count of extra range values used by the code-length tables.
function readFluff(br, numSymbols) {
  if (numSymbols === 256) return 0;
  let x = 257 - numSymbols;
  if (x > numSymbols) x = numSymbols;
  x *= 2;
  const y = 32 - Math.clz32(x - 1);
  const v = br.bits >>> (32 - y);
  const z = (1 << y) - x;
  if ((v >>> 1) >= z) { br.bits = shl(br.bits, y); br.bitpos += y; return v - z; }
  br.bits = shl(br.bits, y - 1);
  br.bitpos += y - 1;
  return v >>> 1;
}
// Position (byte, bit 0..7) of the first unread bit of a bit reader.
const bytePos = (br) => ({ p: br.p - ((24 - br.bitpos + 7) >> 3), bitpos: (br.bitpos - 24) & 7 });
function resetBitReader(br, p, bitpos) {
  br.bitpos = 24; br.p = p; br.bits = 0;
  refill(br);
  br.bits = shl(br.bits, bitpos);
  br.bitpos += bitpos;
}

// ----------------------------------------------------------------------------- Golomb-Rice coded tables
// `count` unary values (zeros ended by a one, MSB first) from (pos.p, pos.bitpos); advances pos.
function riceLengths(buf, pos, end, count, out) {
  let p = pos.p, bitpos = pos.bitpos, made = 0, run = 0;
  if (p >= end) fail('code lengths are truncated');
  while (made < count) {
    if (p >= end) fail('code lengths are truncated');
    const byte = buf[p];
    let stop = false;
    for (; bitpos < 8; bitpos++) {
      if ((byte >> (7 - bitpos)) & 1) {
        out[made++] = run & 0xFF;
        run = 0;
        if (made === count) { bitpos++; stop = true; break; }
      } else run++;
    }
    if (bitpos >= 8) { p++; bitpos = 0; }
    if (stop) break;
  }
  pos.p = p; pos.bitpos = bitpos;
}
// Appends `bitcount` more bits (MSB first) to each of `count` values.
function riceBits(buf, pos, end, count, bitcount, out) {
  if (bitcount === 0) return;
  const required = pos.bitpos + bitcount * count;
  if (((required + 7) >> 3) > end - pos.p) fail('code lengths are truncated');
  let p = pos.p, bp = pos.bitpos;
  for (let i = 0; i < count; i++) {
    let v = 0;
    for (let k = 0; k < bitcount; k++) {
      v = (v << 1) | ((buf[p] >> (7 - bp)) & 1);
      if (++bp === 8) { bp = 0; p++; }
    }
    out[i] = (out[i] << bitcount) | v;
  }
  pos.p += required >> 3;
  pos.bitpos = required & 7;
}
// Symbol ranges: (symbol, count) runs separated by gaps, from the extra Rice values.
function convertToRanges(numSymbols, fluff, lens, at, br) {
  const ranges = [];
  const numRanges = fluff >> 1;
  let sym = 0, used = 0;
  if (fluff & 1) {
    refill(br);
    const v = lens[at++];
    if (v >= 8) fail('bad symbol range');
    sym = readBits(br, v + 1) + (1 << (v + 1)) - 1;
  }
  for (let i = 0; i < numRanges; i++) {
    refill(br);
    let v = lens[at];
    if (v >= 9) fail('bad symbol range');
    const num = readBitsZero(br, v) + (1 << v);
    v = lens[at + 1];
    if (v >= 8) fail('bad symbol range');
    const space = readBits(br, v + 1) + (1 << (v + 1)) - 1;
    ranges.push({ symbol: sym, num });
    used += num;
    sym += num + space;
    at += 2;
  }
  if (sym >= 256 || used >= numSymbols || sym + numSymbols - used > 256) fail('bad symbol ranges');
  ranges.push({ symbol: sym, num: numSymbols - used });
  return ranges;
}

// ----------------------------------------------------------------------------- Huffman
const CODE_PREFIX = [0x0, 0x0, 0x2, 0x6, 0xE, 0x1E, 0x3E, 0x7E, 0xFE, 0x1FE, 0x2FE, 0x3FE];   // first slot per code length
const REV11 = (() => {
  const t = new Uint16Array(2048);
  for (let i = 0; i < 2048; i++) { let r = 0; for (let b = 0; b < 11; b++) if (i & (1 << b)) r |= 1 << (10 - b); t[i] = r; }
  return t;
})();

function codeLengthsOld(br, syms, prefix) {
  if (readBitNoRefill(br)) {
    let sym = 0, numSymbols = 0, avgX4 = 32;
    const forced = readBits(br, 2);
    const threshold = (1 << (31 - (20 >>> forced))) >>> 0;
    let skipZeros = readBit(br);
    do {
      if (!skipZeros) {
        if (!(br.bits & 0xFF000000)) fail('bad code lengths');
        sym += readBits(br, 2 * (Math.clz32(br.bits) + 1)) - 2 + 1;
        if (sym >= 256) break;
      }
      skipZeros = 0;
      refill(br);
      if (!(br.bits & 0xFF000000)) fail('bad code lengths');
      let n = readBits(br, 2 * (Math.clz32(br.bits) + 1)) - 2 + 1;
      if (sym + n > 256) fail('bad code lengths');
      refill(br);
      numSymbols += n;
      do {
        if (br.bits < threshold) fail('bad code lengths');
        const lz = Math.clz32(br.bits);
        const v = readBits(br, lz + forced + 1) + ((lz - 1) << forced);
        const len = (-(v & 1) ^ (v >>> 1)) + ((avgX4 + 2) >> 2);
        if (len < 1 || len > 11) fail('bad code length');
        avgX4 = len + ((3 * avgX4 + 2) >> 2);
        refill(br);
        syms[prefix[len]++] = sym++;
      } while (--n);
    } while (sym !== 256);
    if (sym !== 256 || numSymbols < 2) fail('bad code lengths');
    return numSymbols;
  }
  // sparse: a few symbols with explicit lengths
  const numSymbols = readBits(br, 8);
  if (numSymbols === 0) fail('empty Huffman table');
  if (numSymbols === 1) { syms[0] = readBits(br, 8); return 1; }
  const lenBits = readBits(br, 3);
  if (lenBits > 4) fail('bad code lengths');
  for (let i = 0; i < numSymbols; i++) {
    refill(br);
    const sym = readBits(br, 8);
    const len = readBitsZero(br, lenBits) + 1;
    if (len > 11) fail('bad code length');
    syms[prefix[len]++] = sym;
  }
  return numSymbols;
}

function codeLengthsNew(br, syms, prefix) {
  const forced = readBits(br, 2);
  const numSymbols = readBits(br, 8) + 1;
  const fluff = readFluff(br, numSymbols);
  const lens = new Uint8Array(512 + 16);
  const pos = bytePos(br);
  riceLengths(br.buf, pos, br.end, numSymbols + fluff, lens);
  riceBits(br.buf, pos, br.end, numSymbols, forced, lens);
  resetBitReader(br, pos.p, pos.bitpos);
  let running = 0x1E;
  for (let i = 0; i < numSymbols; i++) {
    let v = lens[i];
    v = -(v & 1) ^ (v >>> 1);
    const len = v + (running >> 2) + 1;
    if (len < 1 || len > 11) fail('bad code length');
    lens[i] = len;
    running += v;
  }
  const ranges = convertToRanges(numSymbols, fluff, lens, numSymbols, br);
  let c = 0;
  for (const r of ranges) {
    let sym = r.symbol;
    for (let n = r.num; n > 0; n--) syms[prefix[lens[c++]]++] = sym++;
  }
  return numSymbols;
}

// Decoding tables indexed by the next 11 bits read LSB first.
function huffLut(prefix, syms) {
  const len = new Uint8Array(2048), sym = new Uint8Array(2048);
  let slot = 0;
  for (let i = 1; i < 11; i++) {
    const start = CODE_PREFIX[i], count = prefix[i] - start;
    if (!count) continue;
    const step = 1 << (11 - i), num = count << (11 - i);
    if (slot + num > 2048) fail('bad Huffman table');
    len.fill(i, slot, slot + num);
    for (let j = 0; j < count; j++) sym.fill(syms[start + j], slot + j * step, slot + (j + 1) * step);
    slot += num;
  }
  const c11 = prefix[11] - CODE_PREFIX[11];
  if (c11) {
    if (slot + c11 > 2048) fail('bad Huffman table');
    len.fill(11, slot, slot + c11);
    sym.set(syms.subarray(CODE_PREFIX[11], CODE_PREFIX[11] + c11), slot);
    slot += c11;
  }
  if (slot !== 2048) fail('incomplete Huffman table');
  const rlen = new Uint8Array(2048), rsym = new Uint8Array(2048);
  for (let i = 0; i < 2048; i++) { const r = REV11[i]; rlen[i] = len[r]; rsym[i] = sym[r]; }
  return { len: rlen, sym: rsym };
}

// Three interleaved streams: forward from `src` to `mid`, backward from `end`, forward from `mid`.
function huffCore(s, src, end, mid, out, dst, dstEnd, lut) {
  const lens = lut.len, syms = lut.sym, midOrg = mid;
  let aBits = 0, aPos = 0, bBits = 0, bPos = 0, cBits = 0, cPos = 0, k, n;
  if (src > mid) fail('bad Huffman stream split');
  while (dst < dstEnd) {
    if (mid - src <= 1) { if (mid - src === 1) aBits |= s[src] << aPos; }
    else aBits |= (s[src] | (s[src + 1] << 8)) << aPos;
    k = aBits & 0x7FF; n = lens[k];
    aPos -= n; aBits >>>= n;
    out[dst++] = syms[k];
    src += (7 - aPos) >> 3; aPos &= 7;
    if (dst < dstEnd) {
      if (end - mid <= 1) {
        if (end - mid === 1) { bBits |= s[mid] << bPos; cBits |= s[mid] << cPos; }
      } else {
        bBits |= (s[end - 1] | (s[end - 2] << 8)) << bPos;
        cBits |= (s[mid] | (s[mid + 1] << 8)) << cPos;
      }
      k = bBits & 0x7FF; n = lens[k];
      out[dst++] = syms[k];
      bPos -= n; bBits >>>= n;
      end -= (7 - bPos) >> 3; bPos &= 7;
      if (dst < dstEnd) {
        k = cBits & 0x7FF; n = lens[k];
        out[dst++] = syms[k];
        cPos -= n; cBits >>>= n;
        mid += (7 - cPos) >> 3; cPos &= 7;
      }
    }
    if (src > mid || mid > end) fail('Huffman streams overlap');
  }
  if (src !== midOrg || end !== mid) fail('Huffman streams do not end where they should');
}

// Huffman-coded bytes: type 1 = one set of three streams, type 2 = two sets (output halves).
function huffBytes(s, pos, size, out, outPos, outSize, type) {
  const end = pos + size;
  const br = bitReader(s, pos, end);
  const prefix = CODE_PREFIX.slice();
  const syms = new Uint8Array(1280);
  let numSyms;
  if (!readBitNoRefill(br)) numSyms = codeLengthsOld(br, syms, prefix);
  else if (!readBitNoRefill(br)) numSyms = codeLengthsNew(br, syms, prefix);
  else fail('unknown Huffman table type');
  let p = br.p - ((24 - br.bitpos) >> 3);
  if (numSyms === 1) { out.fill(syms[0], outPos, outPos + outSize); return p - pos; }
  const lut = huffLut(prefix, syms);
  if (type === 1) {
    if (p + 3 > end) fail('Huffman data is truncated');
    const split = s[p] | (s[p + 1] << 8);
    p += 2;
    huffCore(s, p, end, p + split, out, outPos, outPos + outSize, lut);
  } else {
    if (p + 6 > end) fail('Huffman data is truncated');
    const half = (outSize + 1) >> 1;
    const splitMid = s[p] | (s[p + 1] << 8) | (s[p + 2] << 16);
    p += 3;
    if (splitMid > end - p) fail('bad Huffman split');
    const mid = p + splitMid;
    const splitLeft = s[p] | (s[p + 1] << 8);
    p += 2;
    if (mid - p < splitLeft + 2 || end - mid < 3) fail('bad Huffman split');
    const splitRight = s[mid] | (s[mid + 1] << 8);
    if (end - (mid + 2) < splitRight + 2) fail('bad Huffman split');
    huffCore(s, p, mid, p + splitLeft, out, outPos, outPos + half, lut);
    huffCore(s, mid + 2, end, mid + 2 + splitRight, out, outPos + half, outPos + outSize, lut);
  }
  return size;
}

// ----------------------------------------------------------------------------- tANS
function tansTable(br, lBits) {
  const A = [], B = [];
  refill(br);
  const L = 1 << lBits;
  if (readBitNoRefill(br)) {
    const Q = readBits(br, 3);
    const numSymbols = readBits(br, 8) + 1;
    if (numSymbols < 2) fail('bad tANS table');
    const fluff = readFluff(br, numSymbols);
    const total = fluff + numSymbols;
    const rice = new Uint8Array(512 + 16);
    const pos = bytePos(br);
    riceLengths(br.buf, pos, br.end, total, rice);
    resetBitReader(br, pos.p, pos.bitpos);
    const ranges = convertToRanges(numSymbols, fluff, rice, numSymbols, br);
    refill(br);
    let ri = 0, average = 6, sum = 0;
    for (const r of ranges) {
      let symbol = r.symbol;
      for (let n = r.num; n > 0; n--) {
        refill(br);
        const extra = Q + rice[ri++];
        if (extra > 15) fail('bad tANS table');
        let v = readBitsZero(br, extra) + (1 << extra) - (1 << Q);
        const avg4 = average >> 2;
        let limit = 2 * avg4;
        if (v <= limit) v = avg4 + (-(v & 1) ^ (v >>> 1));
        if (limit > v) limit = v;
        v += 1;
        average += limit - avg4;
        if (v === 1) A.push(symbol); else B.push(symbol * 65536 + v);
        sum += v;
        symbol += 1;
      }
    }
    if (sum !== L) fail('tANS weights do not add up');
    return { A, B };
  }
  const seen = new Uint8Array(256);
  let count = readBits(br, 3) + 1;
  const bitsPerSym = 32 - Math.clz32(lBits);
  const maxDeltaBits = readBits(br, bitsPerSym);
  if (maxDeltaBits === 0 || maxDeltaBits > lBits) fail('bad tANS table');
  let weight = 0, total = 0;
  do {
    refill(br);
    const sym = readBits(br, 8);
    if (seen[sym]) fail('bad tANS table');
    weight += readBits(br, maxDeltaBits);
    if (weight === 0) fail('bad tANS table');
    seen[sym] = 1;
    if (weight === 1) A.push(sym); else B.push(sym * 65536 + weight);
    total += weight;
  } while (--count);
  refill(br);
  const sym = readBits(br, 8);
  if (seen[sym]) fail('bad tANS table');
  if (L - total < weight || L - total <= 1) fail('bad tANS table');
  B.push(sym * 65536 + (L - total));
  A.sort((a, b) => a - b);
  B.sort((a, b) => a - b);
  return { A, B };
}

function tansLut(table, lBits) {
  const L = 1 << lBits;
  const lx = new Uint32Array(L), lbits = new Uint8Array(L), lsym = new Uint8Array(L), lw = new Uint16Array(L);
  const aUsed = table.A.length;
  const left = L - aUsed;
  const sa = left >> 2;
  const ptr = [0, 0, 0, 0];
  let sb = sa + ((left & 3) > 0 ? 1 : 0);
  ptr[1] = sb;
  sb += sa + ((left & 3) > 1 ? 1 : 0);
  ptr[2] = sb;
  sb += sa + ((left & 3) > 2 ? 1 : 0);
  ptr[3] = sb;
  for (let i = 0; i < aUsed; i++) {   // weight-1 symbols fill the end
    const at = left + i;
    lw[at] = 0; lbits[at] = lBits; lx[at] = L - 1; lsym[at] = table.A[i];
  }
  const put = (at, symbol, bits, x, w) => { lsym[at] = symbol; lbits[at] = bits; lx[at] = x; lw[at] = w; };
  let wsum = 0;
  for (const entry of table.B) {
    const weight = entry & 0xFFFF, symbol = entry >>> 16;
    // A symbol of weight W takes W slots with sub-states ww = W .. 2W-1. A slot reads
    // lBits - floor(log2 ww) bits and its next state is (ww << bits) - L plus those bits.
    if (weight > 4) {
      // big weights: each of the four slot regions gets its share as one run of consecutive sub-states
      let ww = weight;
      for (let j = 0; j < 4; j++) {
        const Y = (weight + ((wsum - j - 1) & 3)) >> 2;
        for (let n = 0; n < Y; n++) {
          const nb = lBits - (31 - Math.clz32(ww));
          put(ptr[j]++, symbol, nb, (1 << nb) - 1, (L - 1) & (ww << nb));
          ww++;
        }
      }
    } else {
      let bits = ((1 << weight) - 1) << (wsum & 3);
      bits |= bits >> 4;
      let ww = weight;
      for (let n = weight; n; n--) {
        const idx = 31 - Math.clz32(bits & -bits);
        bits &= bits - 1;
        const at = ptr[idx]++;
        const wb = 31 - Math.clz32(ww);
        put(at, symbol, lBits - wb, (1 << (lBits - wb)) - 1, (L - 1) & (ww << (lBits - wb)));
        ww++;
      }
    }
    wsum += weight;
  }
  return { x: lx, bits: lbits, sym: lsym, w: lw };
}

const u32le = (s, p) => (s[p] | (s[p + 1] << 8) | (s[p + 2] << 16) | (s[p + 3] << 24)) >>> 0;
const u32be = (s, p) => ((s[p] << 24) | (s[p + 1] << 16) | (s[p + 2] << 8) | s[p + 3]) >>> 0;

function tansBytes(s, pos, size, out, outPos, outSize) {
  if (size < 8 || outSize < 5) fail('tANS data is too short');
  let end = pos + size;
  const br = bitReader(s, pos, end);
  if (readBitNoRefill(br)) fail('reserved tANS bit set');
  const lBits = readBits(br, 2) + 8;
  const table = tansTable(br, lBits);
  let src = br.p - ((24 - br.bitpos) >> 3);
  if (src >= end) fail('tANS data is truncated');
  const lut = tansLut(table, lBits);
  const mask = (1 << lBits) - 1;
  let bitsF = u32le(s, src); src += 4;
  let bitsB = u32be(s, end - 4); end -= 4;
  let posF = 32, posB = 32;
  const st = [0, 0, 0, 0, 0];
  st[0] = bitsF & mask; st[1] = bitsB & mask;
  bitsF >>>= lBits; posF -= lBits; bitsB >>>= lBits; posB -= lBits;
  st[2] = bitsF & mask; st[3] = bitsB & mask;
  bitsF >>>= lBits; posF -= lBits; bitsB >>>= lBits; posB -= lBits;
  bitsF = (bitsF | (u32le(s, src) << posF)) >>> 0;
  src += (31 - posF) >> 3;
  posF |= 24;
  st[4] = bitsF & mask;
  bitsF >>>= lBits; posF -= lBits;
  let ptrF = src - (posF >> 3);
  posF &= 7;
  let ptrB = end + (posB >> 3);
  posB &= 7;

  const lx = lut.x, lb = lut.bits, ls = lut.sym, lw = lut.w;
  let dst = outPos;
  const dstEnd = outPos + outSize - 5;
  if (ptrF > ptrB) fail('bad tANS stream');
  let s0 = st[0], s1 = st[1], s2 = st[2], s3 = st[3], s4 = st[4], e;
  const fwdBits = () => { bitsF = (bitsF | (u32le(s, ptrF) << posF)) >>> 0; ptrF += (31 - posF) >> 3; posF |= 24; };
  const backBits = () => { bitsB = (bitsB | (u32be(s, ptrB - 4) << posB)) >>> 0; ptrB -= (31 - posB) >> 3; posB |= 24; };
  if (dst < dstEnd) {
    for (;;) {
      fwdBits();
      e = s0; out[dst++] = ls[e]; posF -= lb[e]; s0 = ((bitsF & lx[e]) >>> 0) + lw[e]; bitsF >>>= lb[e]; if (dst >= dstEnd) break;
      e = s1; out[dst++] = ls[e]; posF -= lb[e]; s1 = ((bitsF & lx[e]) >>> 0) + lw[e]; bitsF >>>= lb[e]; if (dst >= dstEnd) break;
      fwdBits();
      e = s2; out[dst++] = ls[e]; posF -= lb[e]; s2 = ((bitsF & lx[e]) >>> 0) + lw[e]; bitsF >>>= lb[e]; if (dst >= dstEnd) break;
      e = s3; out[dst++] = ls[e]; posF -= lb[e]; s3 = ((bitsF & lx[e]) >>> 0) + lw[e]; bitsF >>>= lb[e]; if (dst >= dstEnd) break;
      fwdBits();
      e = s4; out[dst++] = ls[e]; posF -= lb[e]; s4 = ((bitsF & lx[e]) >>> 0) + lw[e]; bitsF >>>= lb[e]; if (dst >= dstEnd) break;
      backBits();
      e = s0; out[dst++] = ls[e]; posB -= lb[e]; s0 = ((bitsB & lx[e]) >>> 0) + lw[e]; bitsB >>>= lb[e]; if (dst >= dstEnd) break;
      e = s1; out[dst++] = ls[e]; posB -= lb[e]; s1 = ((bitsB & lx[e]) >>> 0) + lw[e]; bitsB >>>= lb[e]; if (dst >= dstEnd) break;
      backBits();
      e = s2; out[dst++] = ls[e]; posB -= lb[e]; s2 = ((bitsB & lx[e]) >>> 0) + lw[e]; bitsB >>>= lb[e]; if (dst >= dstEnd) break;
      e = s3; out[dst++] = ls[e]; posB -= lb[e]; s3 = ((bitsB & lx[e]) >>> 0) + lw[e]; bitsB >>>= lb[e]; if (dst >= dstEnd) break;
      backBits();
      e = s4; out[dst++] = ls[e]; posB -= lb[e]; s4 = ((bitsB & lx[e]) >>> 0) + lw[e]; bitsB >>>= lb[e]; if (dst >= dstEnd) break;
    }
  }
  if (ptrB - ptrF + (posF >> 3) + (posB >> 3) !== 0) fail('tANS streams do not meet');
  if ((s0 | s1 | s2 | s3 | s4) & ~0xFF) fail('bad final tANS state');
  out[dstEnd] = s0; out[dstEnd + 1] = s1; out[dstEnd + 2] = s2; out[dstEnd + 3] = s3; out[dstEnd + 4] = s4;
  return size;
}

// ----------------------------------------------------------------------------- RLE
function rleBytes(s, pos, size, out, outPos, outSize) {
  if (size <= 1) {
    if (size !== 1) fail('empty RLE data');
    out.fill(s[pos], outPos, outPos + outSize);
    return 1;
  }
  let cmd = s, cp = pos + 1, ce = pos + size;
  if (s[pos]) {   // the command bytes start with an entropy-coded part
    const d = decodeBytes(s, pos, pos + size, 0x7FFFFFFF);
    const rest = size - d.used;
    const buf = new Uint8Array(d.size + rest + PAD);
    buf.set(d.buf.subarray(d.start, d.start + d.size), 0);
    buf.set(s.subarray(pos + d.used, pos + size), d.size);
    cmd = buf; cp = 0; ce = d.size + rest;
  }
  let dst = outPos;
  const dstEnd = outPos + outSize;
  let rleByte = 0;
  while (cp < ce) {
    const c = cmd[ce - 1];
    let copy, run;
    if (((c - 1) >>> 0) >= 0x2F) {
      ce--;
      copy = (-1 - c) & 0xF;
      run = c >> 4;
    } else if (c >= 0x10) {
      const data = (cmd[ce - 2] | (cmd[ce - 1] << 8)) - 4096;
      ce -= 2;
      copy = data & 0x3F;
      run = data >> 6;
    } else if (c === 1) {
      rleByte = cmd[cp++];
      ce--;
      continue;
    } else if (c >= 9) {
      run = ((cmd[ce - 2] | (cmd[ce - 1] << 8)) - 0x8FF) * 128;
      ce -= 2;
      copy = 0;
    } else {
      copy = ((cmd[ce - 2] | (cmd[ce - 1] << 8)) - 511) * 64;
      ce -= 2;
      run = 0;
    }
    if (dstEnd - dst < copy + run || ce - cp < copy) fail('RLE data overruns');
    out.set(cmd.subarray(cp, cp + copy), dst);
    cp += copy; dst += copy;
    out.fill(rleByte, dst, dst + run);
    dst += run;
  }
  if (ce !== cp || dst !== dstEnd) fail('RLE data does not end where it should');
  return size;
}

// ----------------------------------------------------------------------------- split streams
function blockSize(s, pos, end, capacity) {
  if (end - pos < 2) fail('block header is truncated');
  const type = (s[pos] >> 4) & 7;
  if (type === 0) {
    let size;
    if (s[pos] >= 0x80) { size = ((s[pos] << 8) | s[pos + 1]) & 0xFFF; pos += 2; }
    else {
      if (end - pos < 3) fail('block header is truncated');
      size = (s[pos] << 16) | (s[pos + 1] << 8) | s[pos + 2];
      if (size & ~0x3FFFF) fail('bad block size');
      pos += 3;
    }
    if (size > capacity || end - pos < size) fail('bad block size');
    return size;
  }
  if (type >= 6) fail('unknown block type');
  let srcSize, dstSize;
  if (s[pos] >= 0x80) {
    if (end - pos < 3) fail('block header is truncated');
    const bits = (s[pos] << 16) | (s[pos + 1] << 8) | s[pos + 2];
    srcSize = bits & 0x3FF;
    dstSize = srcSize + ((bits >> 10) & 0x3FF) + 1;
    pos += 3;
  } else {
    if (end - pos < 5) fail('block header is truncated');
    const bits = u32be(s, pos + 1);
    srcSize = bits & 0x3FFFF;
    dstSize = (((bits >>> 18) | (s[pos] << 14)) & 0x3FFFF) + 1;
    if (srcSize >= dstSize) fail('bad block size');
    pos += 5;
  }
  if (end - pos < srcSize || dstSize > capacity) fail('bad block size');
  return dstSize;
}

const BITMASK = (n) => (2 ** (n + 1) - 1) >>> 0;

// Several entropy-coded sources interleaved into `arrayCount` outputs by coded (source, length) runs.
function multiArray(s, pos, end, out, outPos, outEnd, arrayCount) {
  const org = pos;
  if (end - pos < 4) fail('split data is truncated');
  let numArrays = s[pos++];
  if (!(numArrays & 0x80)) fail('bad split data');
  numArrays &= 0x3F;
  const arrays = [];
  if (numArrays === 0) {
    let d = outPos;
    for (let i = 0; i < arrayCount; i++) {
      const r = decodeBytes(s, pos, end, outEnd - d);
      out.set(r.buf.subarray(r.start, r.start + r.size), d);
      d += r.size;
      pos += r.used;
    }
    return { used: pos - org, size: d - outPos };
  }
  let total = 0;
  for (let i = 0; i < numArrays; i++) {
    const r = decodeBytes(s, pos, end, 0x7FFFFFFF);
    arrays.push({ buf: r.buf, at: r.start, left: r.size });
    total += r.size;
    pos += r.used;
  }
  if (end - pos < 3) fail('split data is truncated');
  const Q = s[pos] | (s[pos + 1] << 8);
  pos += 2;
  const numIndexes = blockSize(s, pos, end, total);
  let numLens = numIndexes - arrayCount;
  if (numLens < 1) fail('bad split data');
  let indexes, lenlog2;
  if (Q & 0x8000) {
    const r = decodeBytes(s, pos, end, numIndexes);
    if (r.size !== numIndexes) fail('bad split data');
    pos += r.used;
    indexes = new Uint8Array(numIndexes); lenlog2 = new Uint8Array(numIndexes);
    for (let i = 0; i < numIndexes; i++) { const t = r.buf[r.start + i]; lenlog2[i] = t >> 4; indexes[i] = t & 0xF; }
    numLens = numIndexes;
  } else {
    const lenCount = numIndexes - arrayCount;
    const r1 = decodeBytes(s, pos, end, numIndexes);
    if (r1.size !== numIndexes) fail('bad split data');
    pos += r1.used;
    indexes = r1.buf.slice(r1.start, r1.start + numIndexes);
    const r2 = decodeBytes(s, pos, end, lenCount);
    if (r2.size !== lenCount) fail('bad split data');
    pos += r2.used;
    lenlog2 = r2.buf.slice(r2.start, r2.start + lenCount);
    for (let i = 0; i < lenCount; i++) if (lenlog2[i] > 16) fail('bad split data');
  }
  const varLen = Q & 0x3FFF;
  if (end - pos < varLen) fail('split data is truncated');
  const lengths = new Uint32Array(numLens);
  let f = pos, bitsF = 0, posF = 24;
  const realEnd = pos + varLen;
  let b = realEnd, bitsB = 0, posB = 24;
  let i = 0;
  for (; i + 2 <= numLens; i += 2) {
    bitsF = (bitsF | (u32be(s, f) >>> (24 - posF))) >>> 0;
    f += (posF + 7) >> 3;
    bitsB = (bitsB | (u32le(s, b - 4) >>> (24 - posB))) >>> 0;
    b -= (posB + 7) >> 3;
    const nf = lenlog2[i], nb = lenlog2[i + 1];
    bitsF = rotl((bitsF | 1) >>> 0, nf);
    posF += nf - 8 * ((posF + 7) >> 3);
    bitsB = rotl((bitsB | 1) >>> 0, nb);
    posB += nb - 8 * ((posB + 7) >> 3);
    lengths[i] = (bitsF & BITMASK(nf)) >>> 0;
    bitsF = (bitsF & ~BITMASK(nf)) >>> 0;
    lengths[i + 1] = (bitsB & BITMASK(nb)) >>> 0;
    bitsB = (bitsB & ~BITMASK(nb)) >>> 0;
  }
  if (i < numLens) {
    bitsF = (bitsF | (u32be(s, f) >>> (24 - posF))) >>> 0;
    const nf = lenlog2[i];
    bitsF = rotl((bitsF | 1) >>> 0, nf);
    lengths[i] = (bitsF & BITMASK(nf)) >>> 0;
  }
  if (indexes[numIndexes - 1]) fail('bad split data');
  let ii = 0, li = 0, d = outPos;
  const step = (Q & 0x8000) ? 1 : 0;
  for (let a = 0; a < arrayCount; a++) {
    if (ii >= numIndexes) fail('bad split data');
    let source;
    while ((source = indexes[ii++]) !== 0) {
      if (source > numArrays || li >= numLens) fail('bad split data');
      const len = lengths[li++];
      const arr = arrays[source - 1];
      if (len > arr.left || len > outEnd - d) fail('bad split data');
      out.set(arr.buf.subarray(arr.at, arr.at + len), d);
      arr.at += len; arr.left -= len; d += len;
    }
    li += step;
  }
  if (ii !== numIndexes || li !== numLens) fail('bad split data');
  for (const arr of arrays) if (arr.left) fail('bad split data');
  return { used: realEnd - org, size: d - outPos };
}

function recursiveBytes(s, pos, size, out, outPos, outSize) {
  const org = pos, end = pos + size, outEnd = outPos + outSize;
  if (size < 6) fail('split data is too short');
  let n = s[pos] & 0x7F;
  if (n < 2) fail('bad split data');
  if (!(s[pos] & 0x80)) {
    pos++;
    let d = outPos;
    do {
      const r = decodeBytes(s, pos, end, outEnd - d);
      out.set(r.buf.subarray(r.start, r.start + r.size), d);
      d += r.size;
      pos += r.used;
    } while (--n);
    if (d !== outEnd) fail('split data does not fill its block');
    return pos - org;
  }
  const r = multiArray(s, pos, end, out, outPos, outEnd, 1);
  if (outPos + r.size !== outEnd) fail('split data does not fill its block');
  return r.used;
}

// ----------------------------------------------------------------------------- byte blocks
// One coded byte block at `pos` -> { buf, start, size, used }: the bytes are buf[start..start+size).
function decodeBytes(s, pos, end, capacity) {
  if (end - pos < 2) fail('block header is truncated');
  const org = pos;
  const type = (s[pos] >> 4) & 7;
  if (type === 0) {   // stored
    let size;
    if (s[pos] >= 0x80) { size = ((s[pos] << 8) | s[pos + 1]) & 0xFFF; pos += 2; }
    else {
      if (end - pos < 3) fail('block header is truncated');
      size = (s[pos] << 16) | (s[pos + 1] << 8) | s[pos + 2];
      if (size & ~0x3FFFF) fail('bad block size');
      pos += 3;
    }
    if (size > capacity || end - pos < size) fail('bad block size');
    return { buf: s, start: pos, size, used: pos + size - org };
  }
  let srcSize, dstSize;
  if (s[pos] >= 0x80) {
    if (end - pos < 3) fail('block header is truncated');
    const bits = (s[pos] << 16) | (s[pos + 1] << 8) | s[pos + 2];
    srcSize = bits & 0x3FF;
    dstSize = srcSize + ((bits >> 10) & 0x3FF) + 1;
    pos += 3;
  } else {
    if (end - pos < 5) fail('block header is truncated');
    const bits = u32be(s, pos + 1);
    srcSize = bits & 0x3FFFF;
    dstSize = (((bits >>> 18) | (s[pos] << 14)) & 0x3FFFF) + 1;
    if (srcSize >= dstSize) fail('bad block size');
    pos += 5;
  }
  if (end - pos < srcSize || dstSize > capacity) fail('bad block size');
  const out = new Uint8Array(dstSize + PAD);
  let used;
  switch (type) {
    case 2: case 4: used = huffBytes(s, pos, srcSize, out, 0, dstSize, type >> 1); break;
    case 5: used = recursiveBytes(s, pos, srcSize, out, 0, dstSize); break;
    case 3: used = rleBytes(s, pos, srcSize, out, 0, dstSize); break;
    case 1: used = tansBytes(s, pos, srcSize, out, 0, dstSize); break;
    default: fail('unknown block type');
  }
  if (used !== srcSize) fail('block does not use its whole size');
  return { buf: out, start: 0, size: dstSize, used: pos + srcSize - org };
}

// ----------------------------------------------------------------------------- LZ
function unpackOffsets(s, pos, end, packedOffs, packedExtra, offsCount, scale, packedLens, lensCount) {
  const a = bitReader(s, pos, end);
  const b = { buf: s, p: end, end: pos, bits: 0, bitpos: 24 };
  refillBack(b);
  if (b.bits < 0x2000) fail('bad LZ length stream');
  let n = Math.clz32(b.bits);
  b.bitpos += n; b.bits = shl(b.bits, n);
  refillBack(b);
  n++;
  const longCount = (b.bits >>> (32 - n)) - 1;
  b.bitpos += n; b.bits = shl(b.bits, n);
  refillBack(b);

  const offs = new Int32Array(offsCount);
  if (scale === 0) {
    for (let i = 0; i < offsCount; i++) offs[i] = -readDistance(i & 1 ? b : a, packedOffs.buf[packedOffs.start + i], (i & 1) === 1);
  } else {
    for (let i = 0; i < offsCount; i++) {
      const cmd = packedOffs.buf[packedOffs.start + i];
      if ((cmd >> 3) > 26) fail('bad LZ offset');
      const back = (i & 1) === 1;
      const v = (((8 + (cmd & 7)) << (cmd >> 3)) | readMoreThan24Bits(back ? b : a, cmd >> 3, back)) >>> 0;
      offs[i] = 8 - v;
    }
    if (scale !== 1) for (let i = 0; i < offsCount; i++) offs[i] = scale * offs[i] - packedExtra.buf[packedExtra.start + i];
  }
  if (longCount > 512) fail('bad LZ length stream');
  const longs = new Int32Array(longCount);
  let i = 0;
  for (; i + 1 < longCount; i += 2) {
    if ((longs[i] = readLength(a, false)) < 0) fail('bad LZ length');
    if ((longs[i + 1] = readLength(b, true)) < 0) fail('bad LZ length');
  }
  if (i < longCount && (longs[i] = readLength(a, false)) < 0) fail('bad LZ length');
  a.p -= (24 - a.bitpos) >> 3;
  b.p += (24 - b.bitpos) >> 3;
  if (a.p !== b.p) fail('LZ offset streams do not meet');
  const lens = new Int32Array(lensCount);
  let li = 0;
  for (let k = 0; k < lensCount; k++) {
    let v = packedLens.buf[packedLens.start + k];
    if (v === 255) { if (li >= longCount) fail('bad LZ length stream'); v = longs[li++] + 255; }
    lens[k] = v + 3;
  }
  if (li !== longCount) fail('LZ length stream left over values');
  return { offs, lens };
}

function readLzTable(mode, s, pos, end, dst, dstPos, dstCount, offset) {
  if (mode > 1) fail('unknown LZ mode');
  if (end - pos < 13) fail('LZ table is truncated');
  if (offset === 0) { dst.set(s.subarray(pos, pos + 8), dstPos); pos += 8; }
  if (s[pos] & 0x80) fail('LZ table uses excess bytes (not supported)');
  const lit = decodeBytes(s, pos, end, dstCount); pos += lit.used;
  const cmd = decodeBytes(s, pos, end, dstCount); pos += cmd.used;
  if (end - pos < 3) fail('LZ table is truncated');
  let scale = 0, packedOffs, packedExtra = null;
  if (s[pos] & 0x80) {
    scale = s[pos] - 127;
    pos++;
    packedOffs = decodeBytes(s, pos, end, cmd.size); pos += packedOffs.used;
    if (scale !== 1) {
      packedExtra = decodeBytes(s, pos, end, packedOffs.size); pos += packedExtra.used;
      if (packedExtra.size !== packedOffs.size) fail('bad LZ offset stream');
    }
  } else {
    packedOffs = decodeBytes(s, pos, end, cmd.size); pos += packedOffs.used;
  }
  const packedLens = decodeBytes(s, pos, end, dstCount >> 2); pos += packedLens.used;
  const u = unpackOffsets(s, pos, end, packedOffs, packedExtra, packedOffs.size, scale, packedLens, packedLens.size);
  return { lit, cmd, offs: u.offs, lens: u.lens };
}

// Mode 0: literals are added to the byte at the last match offset; mode 1: literals are copied.
function lzRuns(mode, dst, start, dstEnd, t) {
  const cmd = t.cmd.buf, lits = t.lit.buf, offs = t.offs, lens = t.lens;
  let ci = t.cmd.start;
  const ce = ci + t.cmd.size;
  let lp = t.lit.start;
  const le = lp + t.lit.size;
  let oi = 0, li = 0, d = start;
  const recent = new Int32Array(7);
  recent[3] = recent[4] = recent[5] = -8;
  let last = -8;
  while (ci < ce) {
    const f = cmd[ci++];
    let litlen = f & 3;
    const idx = f >> 6;
    let matchlen = (f >> 2) & 0xF;
    if (litlen === 3) { if (li >= lens.length) fail('LZ length stream is short'); litlen = lens[li++]; }
    recent[6] = oi < offs.length ? offs[oi] : 0;
    if (d + litlen > dstEnd || lp + litlen > le) fail('LZ literals overrun');
    if (mode === 0) for (let k = 0; k < litlen; k++) dst[d + k] = lits[lp + k] + dst[d + k + last];
    else dst.set(lits.subarray(lp, lp + litlen), d);
    d += litlen; lp += litlen;
    const off = recent[idx + 3];
    recent[idx + 3] = recent[idx + 2];
    recent[idx + 2] = recent[idx + 1];
    recent[idx + 1] = recent[idx];
    recent[3] = off;
    last = off;
    if (idx === 3) oi++;
    if (d + off < 0) fail('LZ offset points before the start');
    let len;
    if (matchlen !== 15) len = matchlen + 2;
    else { if (li >= lens.length) fail('LZ length stream is short'); len = 14 + lens[li++]; }
    if (d + len > dstEnd) fail('LZ match overruns');
    let from = d + off;
    if (off <= -len) dst.copyWithin(d, from, from + len);
    else for (let k = 0; k < len; k++) dst[d + k] = dst[from + k];
    d += len;
  }
  if (oi !== offs.length || li !== lens.length) fail('LZ streams left over values');
  const rest = dstEnd - d;
  if (rest !== le - lp) fail('LZ literals do not fill the chunk');
  if (mode === 0) for (let k = 0; k < rest; k++) dst[d + k] = lits[lp + k] + dst[d + k + last];
  else dst.set(lits.subarray(lp, le), d);
}

// One Kraken quantum (up to 256 KiB of output) from s[pos..end) into dst[dstPos..dstEnd).
function krakenQuantum(dst, dstPos, dstEnd, s, pos, end) {
  const org = pos;
  while (dstEnd - dstPos !== 0) {
    let count = dstEnd - dstPos;
    if (count > 0x20000) count = 0x20000;
    if (end - pos < 4) fail('chunk header is truncated');
    const hdr = (s[pos] << 16) | (s[pos + 1] << 8) | s[pos + 2];
    let used;
    if (!(hdr & 0x800000)) {   // entropy-coded bytes, no LZ
      const r = decodeBytes(s, pos, end, count);
      if (r.size !== count) fail('chunk has the wrong size');
      dst.set(r.buf.subarray(r.start, r.start + r.size), dstPos);
      used = r.used;
    } else {
      pos += 3;
      used = hdr & 0x7FFFF;
      const mode = (hdr >> 19) & 0xF;
      if (end - pos < used) fail('chunk is truncated');
      if (used < count) {
        const t = readLzTable(mode, s, pos, pos + used, dst, dstPos, count, dstPos);
        lzRuns(mode, dst, dstPos + (dstPos === 0 ? 8 : 0), dstPos + count, t);
      } else if (used > count || mode !== 0) fail('bad stored chunk');
      else dst.set(s.subarray(pos, pos + count), dstPos);
    }
    pos += used;
    dstPos += count;
  }
  return pos - org;
}

const DECODER_NAMES = { 5: 'LZNA', 10: 'Mermaid/Selkie', 11: 'BitKnit', 12: 'Leviathan' };

// Decompresses one Oodle stream (e.g. one CAS block) into a new Uint8Array of `size` bytes.
function decompress(src, size) {
  const s = new Uint8Array(src.length + 2 * PAD);
  s.set(src, PAD);
  let pos = PAD;
  const end = PAD + src.length;
  const dst = new Uint8Array(size);
  let offset = 0, hdr = null;
  while (offset < size) {
    if ((offset & 0x3FFFF) === 0) {   // block header
      if (end - pos < 2) fail('block header is truncated');
      const b0 = s[pos], b1 = s[pos + 1];
      if ((b0 & 0xF) !== 0xC || ((b0 >> 4) & 3) !== 0) fail('not an Oodle stream');
      hdr = { uncompressed: (b0 >> 6) & 1, type: b1 & 0x7F, checksums: b1 >> 7 };
      if (hdr.type !== 6) {
        if (DECODER_NAMES[hdr.type]) throw new OodleError('unsupported-codec', `Oodle ${DECODER_NAMES[hdr.type]} data is not supported (only Kraken is)`);
        fail('unknown Oodle decoder ' + hdr.type);
      }
      pos += 2;
    }
    const left = Math.min(0x40000, size - offset);
    if (hdr.uncompressed) {
      if (end - pos < left) fail('stored block is truncated');
      dst.set(s.subarray(pos, pos + left), offset);
      pos += left; offset += left;
      continue;
    }
    if (end - pos < 3) fail('quantum header is truncated');
    const v = (s[pos] << 16) | (s[pos + 1] << 8) | s[pos + 2];
    const qsize = v & 0x3FFFF;
    if (qsize !== 0x3FFFF) {
      const compressed = qsize + 1;
      pos += hdr.checksums ? 6 : 3;
      if (end - pos < compressed) fail('quantum is truncated');
      if (compressed > left) fail('quantum is larger than its output');
      if (compressed === left) dst.set(s.subarray(pos, pos + left), offset);
      else if (krakenQuantum(dst, offset, offset + left, s, pos, pos + compressed) !== compressed) fail('quantum does not use its whole size');
      pos += compressed;
    } else if ((v >> 18) === 1) {   // the whole quantum is one byte value
      dst.fill(s[pos + 3], offset, offset + left);
      pos += 4;
    } else fail('bad quantum header');
    offset += left;
  }
  if (pos !== end) fail('stream has trailing bytes');
  return dst;
}

module.exports = { decompress, OodleError };
