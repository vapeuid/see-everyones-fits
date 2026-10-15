'use strict';
// Colourways. Many items share one template colour map (a grey detail texture, "param_base_c") and get
// their colours from the appearance preset: linear RGB colours param_region_color_<r>, _<r>a, _<r>b for
// regions r = 0..3, and a mask texture (param_base_msk).
//   - The region is the UV tile: the mesh's first UV set runs over u = 0..4, one unit per region, and the
//     textures repeat in every tile. Some meshes also use tiles left of 0 (a T-shirt's sleeves); those are
//     treated as region 0 [guess, matches the item thumbnails seen].
//   - The mask's blue channel picks the colour inside a region: ~0.5 = the region colour, 0 = its "a"
//     colour, 1 = its "b" colour (red is metalness, green a detail term).
//   - Stitches come from the green channel of param_stitchesrgb and take param_stitchcolor.
// The game multiplies colour map and tint in linear light. The preview bakes them into one atlas with
// one copy of the texture per UV tile (the mesh's u is divided by the tile count to match), treating the
// template's mid grey as neutral.

const toLin = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; toLin[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
const toSrgb = (l) => { const c = l <= 0 ? 0 : l >= 1 ? 1 : l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055; return Math.round(c * 255); };

const rgbOf = (v) => (v && v.value && typeof v.value.R === 'number' ? [v.value.R, v.value.G, v.value.B] : null);

// params: Map(short parameter name -> boxed value from the EBX reader) of the item's main appearance preset.
// -> { regions: [{ main, a, b }] x 4, stitch, base, mask, stitches } or null when the item has no colourway
function tintFromParams(params) {
  const regions = [0, 1, 2, 3].map((r) => {
    const main = rgbOf(params.get('region_color_' + r));
    return { main, a: rgbOf(params.get(`region_color_${r}a`)) || main, b: rgbOf(params.get(`region_color_${r}b`)) || main };
  });
  // layered clothing (texture arrays) names the same slots with a _ta suffix
  const guid = (name) => { const v = params.get(name) || params.get(name + '_ta'); return v && v.$import ? v.$import.fileGuid : null; };
  const mask = guid('base_msk');
  if (!mask || !regions.some((r) => r.main)) return null;
  const first = regions.find((r) => r.main);
  for (const r of regions) if (!r.main) Object.assign(r, first);   // a region the preset leaves out
  return { regions, stitch: rgbOf(params.get('stitchcolor')), base: guid('base_c'), mask, stitches: guid('stitchesrgb') };
}

// Nearest-neighbour lookup of another image at this image's resolution.
function sampler(img, width, height) {
  if (!img) return null;
  if (img.width === width && img.height === height) return (x, y) => (y * width + x) * 4;
  return (x, y) => (Math.min(img.height - 1, Math.floor(y * img.height / height)) * img.width + Math.min(img.width - 1, Math.floor(x * img.width / width))) * 4;
}

// colour, mask, stitches: { width, height, rgba }; firstTile, tiles: the UV tiles the mesh uses.
// -> { width: colour.width * tiles, height, rgba }, tile firstTile + i at x = i * colour.width
function bake(colour, mask, stitches, tint, firstTile = 0, tiles = 1) {
  const { width, height } = colour;
  const W = width * tiles;
  const out = Buffer.alloc(W * height * 4);
  const ms = sampler(mask, width, height), ss = sampler(stitches, width, height);
  for (let t = 0; t < tiles; t++) {
    const tile = firstTile + t;
    const region = tint.regions[tile < 0 ? 0 : Math.min(tile, 3)];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4, o = (y * W + t * width + x) * 4;
        const b = mask.rgba[ms(x, y) + 2];
        let c = b < 64 ? region.a : b < 192 ? region.main : region.b;
        if (ss && tint.stitch && stitches.rgba[ss(x, y) + 1] > 127) c = tint.stitch;
        for (let k = 0; k < 3; k++) out[o + k] = toSrgb(toLin[colour.rgba[i + k]] * c[k] * 2);
        out[o + 3] = colour.rgba[i + 3];
      }
    }
  }
  return { width: W, height, rgba: out };
}

// The UV tiles a mesh's first UV set spans -> { first, count }, or null when it spans more than 4.
function uvTiles(uvs) {
  if (!uvs || !uvs.length) return { first: 0, count: 1 };
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < uvs.length; i += 2) { if (uvs[i] < min) min = uvs[i]; if (uvs[i] > max) max = uvs[i]; }
  const first = Math.floor(min + 1e-3), last = Math.ceil(max - 1e-3) - 1;
  const count = Math.max(1, last - first + 1);
  return count > 4 ? null : { first, count };
}

module.exports = { tintFromParams, bake, uvTiles };
