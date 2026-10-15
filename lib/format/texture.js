'use strict';
// Texture resources. The header (144 or 180 bytes, little-endian; resource meta u32 = version 11-13):
//   +8 type (0 = 2D), +12 format ordinal, [+4 skipped from version 12], u16 flags, width, height, depth,
//   slices, u8 mip count, first mip, 4 (8 in the 180-byte form) unknown bytes, the pixel chunk GUID,
//   u32 mip sizes[15], u32 chunk size; the 180-byte form ends with the texture group name
//   (e.g. "Character_Eyewear_C_TextureGroup": C = colour, N = normal, Packed = masks).
// The pixel chunk holds every mip, largest first, as raw blocks (for an array, layer 0 first).
const { guidText } = require('./toc');
const { decodeImage, mipBytes } = require('./bc');
const { fail } = require('./errors');

const FORMATS = { 18: 'rgba8', 20: 'rgba8', 23: 'bgra8', 24: 'bgra8', 54: 'bc1', 55: 'bc1', 56: 'bc1', 57: 'bc1', 60: 'bc3', 61: 'bc3', 66: 'bc7', 67: 'bc7' };

function readTextureHeader(h, meta) {
  if (h.length !== 144 && h.length !== 180) fail('bad-texture', 'texture header has an unknown length');
  const version = meta && meta.length >= 4 ? meta.readUInt32LE(0) : 12;
  const t = { type: h.readUInt32LE(8), format: h.readInt32LE(12) };
  let p = 16 + (version >= 12 ? 4 : 0);
  t.width = h.readUInt16LE(p + 2); t.height = h.readUInt16LE(p + 4);
  t.mips = h[p + 10];
  p += 12 + (h.length === 180 ? 8 : 4);
  t.chunk = guidText(h, p);
  p += 16 + 15 * 4;
  t.chunkSize = h.readUInt32LE(p);
  // 180-byte form: chunk size, 8-byte hash, then the (possibly cut-off) texture group name
  t.group = h.length === 180 ? h.toString('latin1', p + 12).replace(/\0.*$/s, '').replace(/[^\x20-\x7e]/g, '') : '';
  t.role = /_C_Textu/i.test(t.group) ? 'color' : /_N_Textu/i.test(t.group) ? 'normal' : /_Packed_Textu/i.test(t.group) ? 'mask' : '';
  t.codec = FORMATS[t.format] || null;
  if (!t.width || !t.height || t.width > 16384 || t.height > 16384 || !t.mips || t.mips > 15) fail('bad-texture', 'texture header is invalid');
  return t;
}

// Decodes the largest mip whose longer side is at most `maxSide` -> { width, height, rgba }.
function decodeTexture(t, pixels, maxSide = 1024) {
  // 0 = 2D; 3 = 2D array (layered clothing): its first layer comes first, with the usual mip chain
  if (t.type !== 0 && t.type !== 3) fail('unsupported-texture', 'only 2D textures can be shown');
  if (!t.codec) fail('unsupported-texture', 'texture format ' + t.format + ' is not supported');
  let w = t.width, h = t.height, off = 0, level = 0;
  while (level + 1 < t.mips && Math.max(w, h) > maxSide) {
    off += mipBytes(t.codec, w, h);
    w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); level++;
  }
  if (off + mipBytes(t.codec, w, h) > pixels.length) fail('bad-texture', 'texture pixels are truncated');
  return { width: w, height: h, rgba: decodeImage(t.codec, pixels, off, w, h) };
}

// Halves an image (2x2 box filter) until its longer side is at most maxSide.
function shrink(img, maxSide) {
  let { width: w, height: h, rgba } = img;
  while (Math.max(w, h) > maxSide && w > 1 && h > 1) {
    const nw = w >> 1, nh = h >> 1, out = Buffer.alloc(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let c = 0; c < 4; c++) {
      const p = ((2 * y) * w + 2 * x) * 4 + c;
      out[(y * nw + x) * 4 + c] = (rgba[p] + rgba[p + 4] + rgba[p + w * 4] + rgba[p + w * 4 + 4] + 2) >> 2;
    }
    w = nw; h = nh; rgba = out;
  }
  return { width: w, height: h, rgba };
}

module.exports = { readTextureHeader, decodeTexture, shrink };
