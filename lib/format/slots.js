'use strict';
// See Everyone's Fits slot names for game items: from the item asset's folder (items/cust_<x>/...), or else from
// the game paths of what the item is made of (the same path rules lib/core.js uses).
const SLOT_NAMES = ['skin', 'tattoos', 'hair', 'face', 'body', 'tops', 'bottoms', 'costumes', 'socks', 'shoes', 'hats', 'glasses', 'accessories', 'boards'];

const FOLDERS = {
  cust_tops: 'tops', cust_bottoms: 'bottoms', cust_shoes: 'shoes', cust_socks: 'socks', cust_hats: 'hats', cust_eyewear: 'glasses',
  cust_tattoo: 'tattoos', cust_scalphair: 'hair', cust_face: 'face', cust_heads: 'face', cust_eyebrows: 'face', cust_facialhair: 'face',
  cust_makeup: 'face', cust_moles: 'face', cust_eyecolor: 'face', cust_haircolor: 'hair', cust_bodies: 'body',
  cust_outfit: 'costumes', cust_outfits: 'costumes', cust_fullbodycostume: 'costumes', cust_handwear: 'accessories',
  cust_accessories: 'accessories', cust_jewelry: 'accessories', cust_board: 'boards', cust_board_stickers: 'boards', truck: 'boards',
  boardwheelcolors0: 'boards', boardtapecolors0: 'boards', boardtapetextures: 'boards',
};

const PATH_RULES = [['skin', ['/ownables/body/skin/']], ['tattoos', ['/tattoo']], ['hair', ['/hair/', 'hair_scalp', '_haircap']],
  ['face', ['/head/', '/face/', '/makeup/', '/eyebrow', '/beard', '/facial', 'face_layer']], ['body', ['/cas/body/', '/bodyblends/']],
  ['tops', ['/apparel/top/']], ['bottoms', ['/apparel/bottom/']], ['costumes', ['/apparel/fullbody', '/apparel/costume', '/apparel/onepiece']],
  ['socks', ['/footwear/sock']], ['shoes', ['/footwear/']], ['hats', ['/accessories/headwear/']], ['glasses', ['/accessories/eyewear/']],
  ['accessories', ['/accessories/']], ['boards', ['/skateboard/']]];

function slotFromAsset(assetName) {
  const n = String(assetName || '').toLowerCase();
  if (n.includes('/ownables/body/skin/')) return 'skin';
  const parts = n.split('/');
  if (parts[0] === 'items' && parts.length > 2) {
    if (FOLDERS[parts[1]]) return FOLDERS[parts[1]];
    if (/^(type_)?board/.test(parts[1])) return 'boards';   // board_gripcolor1, board_bottomart, type_boardsticker, ...
  }
  return null;
}

function slotFromPath(gamePath) {
  const n = String(gamePath || '').toLowerCase();
  const hit = PATH_RULES.find(([, keys]) => keys.some((k) => n.includes(k)));
  return hit ? hit[0] : null;
}

module.exports = { SLOT_NAMES, slotFromAsset, slotFromPath };
