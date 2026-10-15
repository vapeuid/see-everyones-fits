'use strict';
// EBX asset documents. They are RIFF files ("RIFF" size "EBX\0"/"EBXS") with chunks:
//   EBXD instance data (start aligned to 16), EFIX fixups (file GUID, type GUIDs, instances, imports),
//   EBXX array/boxed tables, REFL or RFL2 reflection (types + fields + names; RFL2 names are hashed).
// Because each document carries its own reflection, no external type database is needed.
// Values: arrays are an i32 displacement (count at target-4); pointers are 0 (null), odd (import index
// << 1 | 1) or even (relative to the field, an instance of this file); C strings are a u32 displacement;
// resource refs are u64 ids; boxed values are {u32 type, pad, i64 displacement from field+8}.
const { guidText } = require('./toc');
const { fail } = require('./errors');

const T = { inherited: 0, structure: 2, pointer: 3, string: 6, cString: 7, enumeration: 8, fileRef: 9, boolean: 10,
  int8: 11, uint8: 12, int16: 13, uint16: 14, int32: 15, uint32: 16, uint64: 17, int64: 18, float32: 19, float64: 20,
  guid: 21, sha1: 22, resourceRef: 23, typeRef: 25, boxedValueRef: 26, delegate: 28 };
const typeOf = (enc) => (enc >> 4) & 0x1F;
const isArray = (enc) => (enc & 0x0F) === 4;

function readEbx(b) {
  if (b.length < 16 || b.readUInt32LE(0) !== 0x46464952) fail('bad-ebx', 'asset is not an EBX document');
  const riffEnd = Math.min(b.readUInt32LE(4) + 8, b.length);
  const chunks = {};
  let p = 12;
  while (p + 8 <= riffEnd) {
    const id = b.toString('latin1', p, p + 4), size = b.readUInt32LE(p + 4);
    if (p + 8 + size > riffEnd) fail('bad-ebx', 'EBX chunk runs past the end');
    chunks[id] = { begin: p + 8, end: p + 8 + size };
    p += 8 + size + (size & 1);
  }
  const D = chunks.EBXD, F = chunks.EFIX, R = chunks.RFL2 || chunks.REFL, X = chunks.EBXX;
  if (!D || !F || !R) fail('bad-ebx', 'EBX document lacks a required chunk');
  const dataStart = (D.begin + 15) & ~15, dataEnd = D.end;
  const doc = { imports: [], instances: [], types: [], fields: [] };

  p = F.begin;
  const u32 = () => { if (p + 4 > b.length) fail('bad-ebx', 'EBX table is truncated'); const v = b.readUInt32LE(p); p += 4; return v; };
  const guid = () => { if (p + 16 > b.length) fail('bad-ebx', 'EBX table is truncated'); const v = guidText(b, p); p += 16; return v; };
  const count = (limit) => { const n = u32(); if (n > limit) fail('bad-ebx', 'EBX table is too large'); return n; };
  doc.fileGuid = guid();
  const typeGuids = []; for (let i = 0, n = count(65536); i < n; i++) typeGuids.push(guid());
  const typeSigs = []; for (let i = 0, n = count(65536); i < n; i++) typeSigs.push(u32());
  const exported = u32();
  for (let i = 0, n = count(1 << 20); i < n; i++) {
    const off = u32();
    if (dataStart + off + 2 > dataEnd) fail('bad-ebx', 'EBX instance is out of range');
    doc.instances.push({ type: b.readUInt16LE(dataStart + off), offset: off, exported: i < exported });
  }
  const skipOffsets = () => { const n = count(1 << 22); p += n * 4; };
  skipOffsets(); skipOffsets();
  for (let i = 0, n = count(1 << 20); i < n; i++) doc.imports.push({ fileGuid: guid(), classGuid: guid() });

  p = R.begin;
  const hashed = !!chunks.RFL2;
  const ids = []; for (let i = 0, n = count(65536); i < n; i++) ids.push({ guid: guid(), sig: u32() });
  for (let i = 0, n = count(65536); i < n; i++) {
    const t = { nameHash: u32(), fieldIndex: b.readInt32LE(p), fieldCount: b.readUInt16LE(p + 4), size: b.readUInt16LE(p + 8) };
    p += 12;
    doc.types.push(t);
  }
  for (let i = 0, n = count(1 << 20); i < n; i++) {
    doc.fields.push({ nameHash: u32(), offset: u32(), enc: b.readUInt16LE(p) >> 1, classRef: b.readUInt16LE(p + 2) });
    p += 4;
  }
  const groups = count(1 << 20); p += groups * 12;
  const mappings = count(1 << 20); p += mappings * 8;
  const cstr = (o) => { if (o >= R.end) fail('bad-ebx', 'EBX name is out of range'); const e = b.indexOf(0, o); return b.toString('latin1', o, e < 0 || e > R.end ? R.end : e); };
  if (hashed) {
    const names = new Map();
    for (let i = 0, n = count(1 << 20); i < n; i++) { const h = u32(); names.set(h, u32()); }
    const base = p;
    const name = (h) => (names.has(h) ? cstr(base + names.get(h)) : '');
    for (const t of doc.types) t.name = name(t.nameHash);
    for (const f of doc.fields) f.name = name(f.nameHash);
  } else {
    const base = p;
    for (const t of doc.types) t.name = cstr(base + t.nameHash);
    for (const f of doc.fields) f.name = cstr(base + f.nameHash);
  }
  for (const t of doc.types) if (t.fieldIndex < 0 || t.fieldIndex + t.fieldCount > doc.fields.length) fail('bad-ebx', 'EBX type has an invalid field range');
  for (const inst of doc.instances) inst.descriptor = ids.findIndex((x) => x.guid === typeGuids[inst.type] && x.sig === typeSigs[inst.type]);

  // EBXX: array records, then boxed-value records {offset from the data start, count, hash, u16 type, u16 class}
  const boxedTypes = new Map();
  if (X && X.end - X.begin >= 8) {
    const arrays = b.readUInt32LE(X.begin), boxes = b.readUInt32LE(X.begin + 4);
    for (let i = 0, q = X.begin + 8 + arrays * 16; i < boxes && q + 16 <= X.end; i++, q += 16) boxedTypes.set(b.readUInt32LE(q), b.readUInt16LE(q + 14));
  }
  const byOffset = new Map(doc.instances.map((x, i) => [x.offset, i]));
  const inData = (pos, n) => { if (pos < dataStart || pos + n > dataEnd) fail('bad-ebx', 'EBX value is out of range'); };
  const relString = (pos) => {
    const d = b.readUInt32LE(pos);
    if (d === 0xFFFFFFFF) return '';
    const s = pos + d; inData(s, 1);
    const e = b.indexOf(0, s);
    return b.toString('latin1', s, e < 0 || e > dataEnd ? dataEnd : e);
  };
  let depth = 0;
  function object(desc, start) {
    if (desc < 0 || desc >= doc.types.length) fail('bad-ebx', 'EBX object has an unknown type');
    if (++depth > 64) fail('bad-ebx', 'EBX types nest too deeply');
    const t = doc.types[desc];
    inData(start, t.size);
    const o = { $type: t.name };
    fields(o, t, start, 0);
    depth--;
    return o;
  }
  function fields(o, t, start, level) {
    if (level > 32) fail('bad-ebx', 'EBX inheritance is too deep');
    for (let k = 0; k < t.fieldCount; k++) {
      const f = doc.fields[t.fieldIndex + k];
      if (typeOf(f.enc) === T.inherited) { if (doc.types[f.classRef]) fields(o, doc.types[f.classRef], start, level + 1); continue; }
      o[f.name] = isArray(f.enc) ? array(f, start + f.offset) : value(typeOf(f.enc), f.classRef, start + f.offset);
    }
  }
  function array(f, pos) {
    inData(pos, 4);
    const target = pos + b.readInt32LE(pos);
    inData(target - 4, 4);
    const n = b.readInt32LE(target - 4);
    if (n < 0 || n > dataEnd - target) fail('bad-ebx', 'EBX array is out of range');
    const type = typeOf(f.enc), out = [];
    const step = type === T.structure ? (doc.types[f.classRef] || fail('bad-ebx', 'EBX array has an unknown type')).size
      : ({ [T.boolean]: 1, [T.int8]: 1, [T.uint8]: 1, [T.int16]: 2, [T.uint16]: 2, [T.int32]: 4, [T.uint32]: 4, [T.enumeration]: 4, [T.float32]: 4,
        [T.int64]: 8, [T.uint64]: 8, [T.float64]: 8, [T.pointer]: 8, [T.cString]: 8, [T.resourceRef]: 8, [T.fileRef]: 8, [T.typeRef]: 8, [T.delegate]: 8,
        [T.guid]: 16, [T.boxedValueRef]: 16, [T.sha1]: 20, [T.string]: 32 })[type];
    if (!step) return out;
    for (let i = 0; i < n; i++) out.push(value(type, f.classRef, target + i * step));
    return out;
  }
  function value(t, classRef, pos) {
    switch (t) {
      case T.boolean: inData(pos, 1); return b[pos] !== 0;
      case T.int8: inData(pos, 1); return b.readInt8(pos);
      case T.uint8: inData(pos, 1); return b[pos];
      case T.int16: inData(pos, 2); return b.readInt16LE(pos);
      case T.uint16: inData(pos, 2); return b.readUInt16LE(pos);
      case T.int32: case T.enumeration: inData(pos, 4); return b.readInt32LE(pos);
      case T.uint32: inData(pos, 4); return b.readUInt32LE(pos);
      case T.int64: inData(pos, 8); return b.readBigInt64LE(pos).toString();
      case T.uint64: inData(pos, 8); return b.readBigUInt64LE(pos).toString();
      case T.float32: inData(pos, 4); return b.readFloatLE(pos);
      case T.float64: inData(pos, 8); return b.readDoubleLE(pos);
      case T.guid: inData(pos, 16); return guidText(b, pos);
      case T.sha1: inData(pos, 20); return b.toString('hex', pos, pos + 20);
      case T.resourceRef: inData(pos, 8); return { $res: b.readBigUInt64LE(pos).toString(16) };
      case T.string: inData(pos, 32); return b.toString('latin1', pos, pos + 32).replace(/\0.*$/s, '');
      case T.cString: case T.fileRef: inData(pos, 4); return relString(pos);
      case T.pointer: {
        inData(pos, 4);
        const e = b.readInt32LE(pos);
        if (e === 0) return null;
        if (e & 1) return { $import: doc.imports[e >> 1] || null };
        return { $ref: byOffset.has(pos + e - dataStart) ? byOffset.get(pos + e - dataStart) : -1 };
      }
      case T.boxedValueRef: {
        inData(pos, 16);
        const enc = b.readUInt32LE(pos);
        const target = pos + 8 + Number(b.readBigInt64LE(pos + 8));
        const o = { $boxed: enc };
        if (target < dataStart || target >= dataEnd) return o;
        if (enc & 0x80000000) {   // a primitive: its field type is in bits 5-9
          const t = (enc >> 5) & 0x1F;
          if (t !== T.structure && t !== T.pointer) { try { o.value = value(t, 0, target); } catch (_) { /* left unread */ } }
          return o;
        }
        // a structure, typed by its EBXX record: an index into the EFIX type list (e.g. ColorRgb for a tint)
        const cls = boxedTypes.get(target - dataStart);
        const desc = cls === undefined ? -1 : ids.findIndex((x) => x.guid === typeGuids[cls] && x.sig === typeSigs[cls]);
        if (desc >= 0) { try { o.value = object(desc, target); o.$type = o.value.$type; } catch (_) { /* left unread */ } }
        // texture bindings start with an import pointer
        if (target + 4 <= dataEnd) {
          const ptr = b.readInt32LE(target);
          if ((ptr & 1) && (ptr >> 1) < doc.imports.length) o.$import = doc.imports[ptr >> 1];
        }
        return o;
      }
      case T.structure: return object(classRef, pos);
      default: return undefined;
    }
  }
  doc.objects = doc.instances.map((inst) => {
    if (inst.descriptor < 0) return null;
    const start = dataStart + inst.offset;
    const o = object(inst.descriptor, start);
    if (inst.exported && start - 16 >= dataStart) o.$guid = guidText(b, start - 16);
    return o;
  });
  doc.root = doc.objects[0] || null;
  doc.rootType = doc.root ? doc.root.$type : null;
  // follows an internal pointer value to its object
  doc.deref = (v) => (v && typeof v.$ref === 'number' && v.$ref >= 0 ? doc.objects[v.$ref] : null);
  return doc;
}

module.exports = { readEbx };
