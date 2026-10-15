'use strict';
// MeshSet resources (character meshes). Little-endian; a "pointer" is a u64 counted from byte 16.
//   +0 u32[4] layout words {208, 188, 384, 0} (the only layout seen on skate. cosmetics)
//   +48 u64 pointers to the levels of detail, +180 u16 LOD count
//   LOD: +8 u32 section count, +12 ptr section table, +84 index format (33 = 16-bit), +88 index bytes,
//        +92 vertex bytes, +116 GUID of the geometry chunk (vertex buffer, then index buffer)
//   section (384 bytes): +31 u8 primitive (3 = triangle list), +32 triangles, +36 first index,
//        +40 vertex start (bytes), +44 vertex count, +112 vertex declaration:
//        16 x {usage, format, offset, stream}, +64 16 x {stride, classification}, +96 elements, +97 streams
// A section's streams follow one another (not interleaved) from its vertex start.
// Usages: 1 position, 2/3 bone indices, 4/5 bone weights, 33 uv0, 34 uv1; formats: 3 float3, 8 half4,
// 2 float2, 6 half2, 13 ubyte4n, 23 ushort4.
const { guidText } = require('./toc');
const { fail } = require('./errors');

const LAYOUT = [208, 188, 384, 0];

function half(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

function meshSetInfo(r) {
  if (r.length < 192 || LAYOUT.some((v, i) => r.readUInt32LE(i * 4) !== v)) fail('unsupported-mesh', 'unsupported mesh layout');
  const ptr = (o) => {
    if (o + 8 > r.length) fail('bad-mesh', 'mesh data is truncated');
    const v = Number(r.readBigUInt64LE(o)) + 16;
    if (v <= 16 || v >= r.length) fail('bad-mesh', 'mesh pointer is out of range');
    return v;
  };
  const lodCount = r.readUInt16LE(180);
  if (!lodCount || lodCount > 16) fail('bad-mesh', 'mesh has no levels of detail');
  const lods = [];
  for (let l = 0; l < lodCount; l++) {
    const at = ptr(48 + l * 8);
    if (at + 132 > r.length) fail('bad-mesh', 'mesh data is truncated');
    const lod = { sectionCount: r.readUInt32LE(at + 8), indexFormat: r.readUInt32LE(at + 84), indexBytes: r.readUInt32LE(at + 88),
      vertexBytes: r.readUInt32LE(at + 92), chunk: guidText(r, at + 116), sections: [] };
    if (lod.sectionCount > 4096) fail('bad-mesh', 'mesh has too many sections');
    const table = lod.sectionCount ? ptr(at + 12) : 0;
    for (let s = 0; s < lod.sectionCount; s++) {
      const S = table + s * 384, d = S + 112;
      if (S + 384 > r.length) fail('bad-mesh', 'mesh section is truncated');
      const sec = { primitive: r[S + 31], triangles: r.readUInt32LE(S + 32), firstIndex: r.readUInt32LE(S + 36),
        vertexStart: r.readUInt32LE(S + 40), vertexCount: r.readUInt32LE(S + 44), streams: [], elements: [] };
      const elements = r[d + 96], streams = r[d + 97];
      if (elements > 16 || streams > 16) fail('bad-mesh', 'mesh vertex declaration is malformed');
      for (let k = 0; k < streams; k++) sec.streams.push(r[d + 64 + k * 2]);
      for (let e = 0; e < elements; e++) sec.elements.push({ usage: r[d + e * 4], format: r[d + e * 4 + 1], offset: r[d + e * 4 + 2], stream: r[d + e * 4 + 3] });
      lod.sections.push(sec);
    }
    lods.push(lod);
  }
  return { lods };
}

// One LOD as a single triangle mesh -> { positions, uvs|null, indices, triangles }.
function readLodGeometry(info, lodIndex, geometry) {
  const lod = info.lods[lodIndex];
  if (lod.indexFormat !== 33) fail('unsupported-mesh', 'unsupported mesh layout (32-bit indices)');
  if (geometry.length < lod.vertexBytes + lod.indexBytes) fail('bad-mesh', 'mesh geometry is truncated');
  const pos = [], uv = [], idx = [];
  let uvSections = 0;
  // A section without texture coordinates next to ones with them is a shell the renderer does not texture
  // (seen on sneakers, overlapping the shoe); it is left out so it cannot z-fight the textured surface.
  const hasUv = (s) => s.elements.some((e) => e.usage === 33 && e.stream < s.streams.length);
  const anyUvSection = lod.sections.some((s) => s.vertexCount && s.triangles && hasUv(s));
  for (const s of lod.sections) {
    if (!s.vertexCount || !s.triangles) continue;
    if (anyUvSection && !hasUv(s)) continue;
    if (s.primitive !== 3) fail('unsupported-mesh', 'unsupported mesh layout (not a triangle list)');
    const bases = [];
    let end = s.vertexStart;
    for (const stride of s.streams) { if (!stride) fail('bad-mesh', 'mesh stream has no size'); bases.push(end); end += stride * s.vertexCount; }
    if (end > lod.vertexBytes) fail('bad-mesh', 'mesh vertices run past the vertex buffer');
    const el = (usage) => s.elements.find((e) => e.usage === usage && e.stream < s.streams.length);
    const P = el(1), U = el(33);
    if (!P) fail('unsupported-mesh', 'unsupported mesh layout (no positions)');
    if (P.format !== 3 && P.format !== 8) fail('unsupported-mesh', 'unsupported mesh layout (position format ' + P.format + ')');
    if (U && U.format !== 6 && U.format !== 2) fail('unsupported-mesh', 'unsupported mesh layout (uv format ' + U.format + ')');
    if (U) uvSections++;
    const first = pos.length / 3;
    const at = (e, v) => bases[e.stream] + v * s.streams[e.stream] + e.offset;
    for (let v = 0; v < s.vertexCount; v++) {
      const a = at(P, v);
      if (P.format === 3) pos.push(geometry.readFloatLE(a), geometry.readFloatLE(a + 4), geometry.readFloatLE(a + 8));
      else pos.push(half(geometry.readUInt16LE(a)), half(geometry.readUInt16LE(a + 2)), half(geometry.readUInt16LE(a + 4)));
      if (!U) uv.push(0, 0);   // a section without uvs (e.g. a placeholder) keeps the others
      else {
        const b = at(U, v);
        if (U.format === 6) uv.push(half(geometry.readUInt16LE(b)), half(geometry.readUInt16LE(b + 2)));
        else uv.push(geometry.readFloatLE(b), geometry.readFloatLE(b + 4));
      }
    }
    const start = s.firstIndex * 2;
    if (start + s.triangles * 6 > lod.indexBytes) fail('bad-mesh', 'mesh indices run past the index buffer');
    for (let i = 0; i < s.triangles * 3; i++) {
      const v = geometry.readUInt16LE(lod.vertexBytes + start + i * 2);
      if (v >= s.vertexCount) fail('bad-mesh', 'mesh triangle names a missing vertex');
      idx.push(first + v);
    }
  }
  if (!idx.length) fail('bad-mesh', 'mesh has no triangles');
  for (const v of pos) if (!Number.isFinite(v)) fail('bad-mesh', 'mesh has invalid vertex positions');
  return { positions: Float32Array.from(pos), uvs: uvSections ? Float32Array.from(uv) : null, indices: Uint32Array.from(idx), triangles: idx.length / 3 };
}

module.exports = { meshSetInfo, readLodGeometry };
