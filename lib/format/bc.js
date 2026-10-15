'use strict';
// Software decoders for block-compressed textures: BC1, BC3, BC4, BC5, BC7 (4x4 pixel blocks) and
// plain RGBA8/BGRA8. Output is straight-alpha RGBA8, rows top to bottom.
// The BC7 partition and anchor tables are the standard ones from the BPTC format specification.

const P2 = '0011001100110011000100010001000101110111011101110001001100110111' +
  '0000000100010011001101110111111100010011011111110000000100110111' +
  '0000000000010011001101111111111100000001011111110000000000010111' +
  '0001011111111111000000001111111100001111111111110000000000001111' +
  '0000100011101111011100010000000000000000100011100111001100010000' +
  '0011000100000000000010001100111000000000100011000111001100110001' +
  '0011000100010000000010001000110001100110011001100011011001101100' +
  '0001011111101000000011111111000001110001100011100011100110011100' +
  '0101010101010101000011110000111101011010010110100011001111001100' +
  '0011110000111100010101011010101001101001011010010101101010100101' +
  '0111001111001110000100111100100000110010010011000011101111011100' +
  '0110100110010110001111001100001101100110100110010000011001100000' +
  '0100111001000000001001110010000000000010011100100000010011100100' +
  '0110110010010011001101101100100101100011100111000011100111000110' +
  '0110110011001001011000110011100101111110100000010001100011100111' +
  '0000111100110011001100111111000000100010111011100100010001110111';
const P3 = '0011001102212222000100112211222100002001221122110222002200110111' +
  '0000000011221122001100110022002200220022111111110011001122112211' +
  '0000000011112222000011111111222200001111222222220012001200120012' +
  '0112011201120112012201220122012200110112112212220011200122002220' +
  '0001001101121122011100112001220000001122112211220022002200221111' +
  '0111011102220222000100012221222100000011012201220000110022102210' +
  '0122012200110000001200121122222201101221122101100000011012211221' +
  '0022110211020022011001102002222200110122012200110000200022112221' +
  '0000000211221222022200220012001100110012002202220120012001200120' +
  '0000111122220000012012012012012001202012120101200011220011220011' +
  '0011112222000011010101012222222200000000212121210022112200221122' +
  '0022001100220011022012210220122101012222222201010000212121212121' +
  '0101010101012222022201110222011100021112000211120000211221122112' +
  '0222011101110222000211121112000201100110011022220000000021122112' +
  '0110011022222222002200110011002200221122112200220000000000002112' +
  '0002000100020001022212220222122201012222222222220111201122012220';
const A2 = [15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
  15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15];
const A3A = [3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15,
  8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3];
const A3B = [15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8,
  15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8];
const W = { 2: [0, 21, 43, 64], 3: [0, 9, 18, 27, 37, 46, 55, 64], 4: [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64] };
// per mode: subsets, partition bits, rotation bits, index-selection bit, colour bits, alpha bits,
// p-bits per endpoint, shared p-bits, index bits, secondary index bits
const MODES = [
  [3, 4, 0, 0, 4, 0, 1, 0, 3, 0], [2, 6, 0, 0, 6, 0, 0, 1, 3, 0], [3, 6, 0, 0, 5, 0, 0, 0, 2, 0], [2, 6, 0, 0, 7, 0, 1, 0, 2, 0],
  [1, 0, 2, 1, 5, 6, 0, 0, 2, 3], [1, 0, 2, 0, 7, 8, 0, 0, 2, 2], [1, 0, 0, 0, 7, 7, 1, 0, 4, 0], [2, 6, 0, 0, 5, 5, 1, 0, 2, 0]];

const interp = (a, b, w) => (a * (64 - w) + b * w + 32) >> 6;

function bc7Block(src, o, px) {   // px: 64-byte RGBA output for the 4x4 block
  const words = [src.readUInt32LE(o), src.readUInt32LE(o + 4), src.readUInt32LE(o + 8), src.readUInt32LE(o + 12)];
  let bit = 0;
  const read = (n) => {
    let v = 0;
    for (let k = 0; k < n; k++, bit++) v |= ((words[bit >>> 5] >>> (bit & 31)) & 1) << k;
    return v;
  };
  let mode = 0;
  while (mode < 8 && !read(1)) mode++;
  if (mode === 8) { px.fill(0); return; }
  const [ns, pb, rb, isb, cb, ab, epb, spb, ib, ib2] = MODES[mode];
  const partition = read(pb), rotation = read(rb), sel = read(isb);
  const ne = ns * 2;
  const ep = [];
  for (let i = 0; i < ne; i++) ep.push([0, 0, 0, 255]);
  for (let c = 0; c < 3; c++) for (let i = 0; i < ne; i++) ep[i][c] = read(cb);
  if (ab) for (let i = 0; i < ne; i++) ep[i][3] = read(ab);
  const pbits = [];
  if (epb) for (let i = 0; i < ne; i++) pbits.push(read(1));
  else if (spb) for (let s = 0; s < ns; s++) { const p = read(1); pbits.push(p, p); }
  for (let i = 0; i < ne; i++) {
    for (let c = 0; c < 4; c++) {
      const bits = c < 3 ? cb : ab;
      if (!bits) continue;
      let v = ep[i][c], n = bits;
      if (pbits.length) { v = (v << 1) | pbits[i]; n++; }
      v <<= 8 - n;
      ep[i][c] = v | (v >> n);
    }
  }
  const subsetOf = (i) => (ns === 1 ? 0 : ns === 2 ? P2.charCodeAt(partition * 16 + i) - 48 : P3.charCodeAt(partition * 16 + i) - 48);
  const isAnchor = (i) => i === 0 || (ns === 2 && i === A2[partition]) || (ns === 3 && (i === A3A[partition] || i === A3B[partition]));
  const idx = new Array(16), idx2 = new Array(16);
  for (let i = 0; i < 16; i++) idx[i] = read(isAnchor(i) ? ib - 1 : ib);
  if (ib2) for (let i = 0; i < 16; i++) idx2[i] = read(i === 0 ? ib2 - 1 : ib2);
  for (let i = 0; i < 16; i++) {
    const s = subsetOf(i), e0 = ep[s * 2], e1 = ep[s * 2 + 1];
    let cw, aw;
    if (!ib2) { cw = W[ib][idx[i]]; aw = cw; }
    else if (!sel) { cw = W[ib][idx[i]]; aw = W[ib2][idx2[i]]; }
    else { cw = W[ib2][idx2[i]]; aw = W[ib][idx[i]]; }
    let r = interp(e0[0], e1[0], cw), g = interp(e0[1], e1[1], cw), b = interp(e0[2], e1[2], cw), a = interp(e0[3], e1[3], aw);
    if (rotation === 1) [a, r] = [r, a]; else if (rotation === 2) [a, g] = [g, a]; else if (rotation === 3) [a, b] = [b, a];
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = a;
  }
}

function color565(c, out, k) { out[k] = ((c >> 11) & 31) * 255 / 31 | 0; out[k + 1] = ((c >> 5) & 63) * 255 / 63 | 0; out[k + 2] = (c & 31) * 255 / 31 | 0; }
function bc1Block(src, o, px, opaque) {
  const c0 = src.readUInt16LE(o), c1 = src.readUInt16LE(o + 2);
  const pal = new Uint8Array(16);
  color565(c0, pal, 0); color565(c1, pal, 4);
  pal[3] = pal[7] = 255;
  if (c0 > c1 || opaque) {
    for (let c = 0; c < 3; c++) { pal[8 + c] = (2 * pal[c] + pal[4 + c]) / 3 | 0; pal[12 + c] = (pal[c] + 2 * pal[4 + c]) / 3 | 0; }
    pal[11] = pal[15] = 255;
  } else {
    for (let c = 0; c < 3; c++) pal[8 + c] = (pal[c] + pal[4 + c]) >> 1;
    pal[11] = 255;   // index 3 stays transparent black
  }
  const bits = src.readUInt32LE(o + 4);
  for (let i = 0; i < 16; i++) { const q = ((bits >>> (2 * i)) & 3) * 4; px[i * 4] = pal[q]; px[i * 4 + 1] = pal[q + 1]; px[i * 4 + 2] = pal[q + 2]; px[i * 4 + 3] = pal[q + 3]; }
}
function bc4Block(src, o, out, channel) {   // writes 16 values into out[i*4 + channel]
  const a0 = src[o], a1 = src[o + 1];
  const pal = [a0, a1];
  if (a0 > a1) for (let i = 1; i < 7; i++) pal.push(((7 - i) * a0 + i * a1) / 7 | 0);
  else { for (let i = 1; i < 5; i++) pal.push(((5 - i) * a0 + i * a1) / 5 | 0); pal.push(0, 255); }
  // 48 index bits, little-endian, 3 bits per pixel
  const b0 = src.readUIntLE(o + 2, 3), b1 = src.readUIntLE(o + 5, 3);
  for (let i = 0; i < 16; i++) out[i * 4 + channel] = pal[i < 8 ? (b0 >>> (3 * i)) & 7 : (b1 >>> (3 * (i - 8))) & 7];
}

const BLOCK = { bc1: 8, bc4: 8, bc3: 16, bc5: 16, bc7: 16 };

// format: 'bc1' | 'bc3' | 'bc4' | 'bc5' | 'bc7' | 'rgba8' | 'bgra8'; data starts at the mip to decode.
function decodeImage(format, data, offset, width, height) {
  const out = Buffer.alloc(width * height * 4);
  if (format === 'rgba8' || format === 'bgra8') {
    data.copy(out, 0, offset, offset + out.length);
    if (format === 'bgra8') for (let i = 0; i < out.length; i += 4) { const t = out[i]; out[i] = out[i + 2]; out[i + 2] = t; }
    return out;
  }
  const size = BLOCK[format];
  const px = new Uint8Array(64);
  let o = offset;
  for (let by = 0; by < height; by += 4) {
    for (let bx = 0; bx < width; bx += 4) {
      if (format === 'bc1') bc1Block(data, o, px, false);
      else if (format === 'bc3') { bc1Block(data, o + 8, px, true); bc4Block(data, o, px, 3); }
      else if (format === 'bc4') { bc4Block(data, o, px, 0); for (let i = 0; i < 16; i++) { px[i * 4 + 1] = px[i * 4 + 2] = px[i * 4]; px[i * 4 + 3] = 255; } }
      else if (format === 'bc5') {
        bc4Block(data, o, px, 0); bc4Block(data, o + 8, px, 1);
        for (let i = 0; i < 16; i++) {   // rebuild z of a tangent-space normal
          const x = px[i * 4] / 127.5 - 1, y = px[i * 4 + 1] / 127.5 - 1;
          px[i * 4 + 2] = Math.round((Math.sqrt(Math.max(0, 1 - x * x - y * y)) * 0.5 + 0.5) * 255); px[i * 4 + 3] = 255;
        }
      } else bc7Block(data, o, px);
      o += size;
      for (let i = 0; i < 16; i++) {
        const x = bx + (i & 3), y = by + (i >> 2);
        if (x < width && y < height) { const d = (y * width + x) * 4; out[d] = px[i * 4]; out[d + 1] = px[i * 4 + 1]; out[d + 2] = px[i * 4 + 2]; out[d + 3] = px[i * 4 + 3]; }
      }
    }
  }
  return out;
}

function mipBytes(format, width, height) {
  const size = BLOCK[format];
  return size ? Math.max(1, (width + 3) >> 2) * Math.max(1, (height + 3) >> 2) * size : width * height * 4;
}

module.exports = { decodeImage, mipBytes };
