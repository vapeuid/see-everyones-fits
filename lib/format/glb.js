'use strict';
// glTF 2.0 binary (.glb) writer for one textured triangle mesh, plus smooth vertex normals.

function computeNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;   // area-weighted
    for (const k of [a, b, c]) { n[k] += x; n[k + 1] += y; n[k + 2] += z; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (l > 0) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; } else { n[i + 1] = 1; }
  }
  return n;
}

const pad4 = (b, fill = 0) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]) : b);

// mesh: { positions: Float32Array, uvs: Float32Array|null, indices: Uint32Array }; png: Buffer|null
function writeGlb(mesh, png, name) {
  const { positions, uvs, indices } = mesh;
  const normals = computeNormals(positions, indices);
  const count = positions.length / 3;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) { const k = i % 3; if (positions[i] < min[k]) min[k] = positions[i]; if (positions[i] > max[k]) max[k] = positions[i]; }
  const small = count <= 65535;
  const idx = small ? Uint16Array.from(indices) : indices;
  const parts = [];
  const views = [];
  const add = (buf, target) => {
    const offset = parts.reduce((s, p) => s + p.length, 0);
    const padded = pad4(buf);
    parts.push(padded);
    views.push(Object.assign({ buffer: 0, byteOffset: offset, byteLength: buf.length }, target ? { target } : {}));
    return views.length - 1;
  };
  const view = (ta) => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength);
  const accessors = [];
  const attributes = {};
  accessors.push({ bufferView: add(view(positions), 34962), componentType: 5126, count, type: 'VEC3', min, max }); attributes.POSITION = 0;
  accessors.push({ bufferView: add(view(normals), 34962), componentType: 5126, count, type: 'VEC3' }); attributes.NORMAL = 1;
  if (uvs) { accessors.push({ bufferView: add(view(uvs), 34962), componentType: 5126, count, type: 'VEC2' }); attributes.TEXCOORD_0 = accessors.length - 1; }
  accessors.push({ bufferView: add(view(idx), 34963), componentType: small ? 5123 : 5125, count: idx.length, type: 'SCALAR' });
  const gltf = {
    asset: { version: '2.0', generator: "See Everyone's Fits preview" },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: [{ attributes, indices: accessors.length - 1, material: 0 }] }],
    materials: [{ name: 'preview', doubleSided: true, pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.8 } }],
    accessors, bufferViews: views, buffers: [{ byteLength: 0 }],
  };
  if (png && uvs) {
    gltf.images = [{ bufferView: add(png), mimeType: 'image/png' }];
    gltf.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
    gltf.textures = [{ source: 0, sampler: 0 }];
    gltf.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  }
  const bin = Buffer.concat(parts);
  gltf.buffers[0].byteLength = bin.length;
  const json = pad4(Buffer.from(JSON.stringify(gltf), 'utf8'), 0x20);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546C67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(json.length, 0); jh.writeUInt32LE(0x4E4F534A, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004E4942, 4);
  return Buffer.concat([header, jh, json, bh, bin]);
}

module.exports = { writeGlb, computeNormals };
