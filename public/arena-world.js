// Shared deterministic geometry for the browser renderer and authoritative PvP server.
// An NFT's metadata traits (or its token ID fallback) seed the terrain details.
export const WORLD_W = 3200;
export const WORLD_H = 2240;
export const LIVE_SPAWNS = [
  { x: 900, y: 890 }, { x: 800, y: 1180 },
  { x: 900, y: 1230 }, { x: 950, y: 780 }
];
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const hash = value => [...String(value)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
// These three featured pits have content-addressed, read-only trait snapshots
// taken from their real IPFS metadata on 19 October 2026. A snapshot is used
// ONLY when tokenURI on Monad still equals the exact pinned CID/path below.
// This avoids silently falling back to token-ID-only routes when an IPFS
// gateway rejects requests from a Cloudflare Worker. Unknown NFTs still use
// their own fetched on-chain tokenURI/metadata or a clearly labelled fallback.
const PINNED_METADATA_CID = 'bafybeid4ybujnscdipkno7ps5utqelp5ry5ryreqhay3zhgk3a6x4jruqu';
const PINNED_ART_CID = 'bafybeihau2egcccbdxymeckmmbrqytbfor5gkt3en6d5fsbueymdbq7g6e';
const PINNED_CHOG_TRAITS = {
  '1': { art: '1462', traits: [
    ['Background', 'Deep Aqua'], ['Base', 'Origin'], ['Skin', 'Pink'], ['Side', 'Left'],
    ['Body', 'Yellow 143 Jersey'], ['Mouth', 'Flat'], ['Eyes', 'BTC Glass'], ['Head', 'MCGA'],
    ['Accessory', 'Fwog'], ['Form', 'Chog'], ['Tier', 'Uncommon'], ['Naked', 'No']
  ] },
  '2': { art: '1463', traits: [
    ['Background', 'Sunlight'], ['Aura', 'Aqua Aura'], ['Base', 'Origin'], ['Skin', 'Origin'],
    ['Side', 'Left'], ['Body', 'Mon Hoodie'], ['Mouth', 'Flat'], ['Eyes', 'Modern VR'],
    ['Head', 'Chog Cap'], ['Form', 'Chog'], ['Tier', 'Uncommon'], ['Naked', 'No']
  ] },
  '100': { art: '1561', traits: [
    ['Background', 'Lemon'], ['Aura', 'Cool Aura'], ['Base', 'Origin'], ['Skin', 'Red'],
    ['Side', 'Right'], ['Body', 'Jesus'], ['Mouth', 'Lip Bite'], ['Eyes', 'Purple laser'],
    ['Head', 'Clown Nose'], ['Form', 'Chog'], ['Tier', 'Common'], ['Naked', 'No']
  ] }
};
export function pinnedChogMetadata(id, onChainUri) {
  const entry = PINNED_CHOG_TRAITS[String(id)];
  if (!entry || onChainUri !== `ipfs://${PINNED_METADATA_CID}/${entry.art}.json`) return null;
  return {
    name: `CHOG #${entry.art}`,
    image: `ipfs://${PINNED_ART_CID}/${entry.art}.webp`,
    attributes: entry.traits.map(([trait_type, value]) => ({ trait_type, value }))
  };
}
// A Chog's traits shape its arena; its token ID remains part of the seed even
// when two NFTs share attributes. Metadata stays off-chain, but builder rights
// are checked against the current on-chain owner on every save.
export function nftArenaIdentity(id, metadata) {
  const attributes = Array.isArray(metadata?.attributes) ? metadata.attributes.slice(0, 48)
    .filter(item => item && typeof item.trait_type === 'string' &&
      (typeof item.value === 'string' || typeof item.value === 'number'))
    .map(item => ({ name: item.trait_type.slice(0, 60), value: String(item.value).slice(0, 80) })) : [];
  const trait = name => attributes.find(item => item.name.toLowerCase() === name)?.value;
  const aura = trait('aura'), background = trait('background'), skin = trait('skin');
  const genome = `CHOG:${id}|${attributes.length
    ? attributes.map(({ name, value }) => `${name}:${value}`).sort().join('|') : 'TOKEN_ID_ONLY'}`;
  return { genome, metadataSource: attributes.length ? 'NFT TRAITS + TOKEN ID' : 'TOKEN ID FALLBACK',
    traitLabel: aura ? `AURA: ${aura.toUpperCase()}` : background
      ? `BACKGROUND: ${background.toUpperCase()}` : 'CHOG TOKEN-SEEDED PIT',
    traitHighlights: [background && `BACKGROUND ${background}`, aura && `AURA ${aura}`,
      skin && `SKIN ${skin}`].filter(Boolean).slice(0, 3) };
}
export const circleRect = (x, y, r, box) => {
  const dx = x - clamp(x, box.x, box.x + box.w);
  const dy = y - clamp(y, box.y, box.y + box.h);
  return dx * dx + dy * dy < r * r;
};
const rngFor = seed => {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
};
export const BOT_STARTS = [
  [1210, 770], [760, 1190], [1470, 1040], [1810, 885], [2250, 1220],
  [2500, 850], [1750, 1550], [850, 540], [2760, 1700]
];
const LOOT_STARTS = [
  [1070, 855], [1260, 1140], [1435, 740], [1750, 1150], [2080, 970],
  [2190, 1430], [2510, 1310], [640, 1250], [800, 615], [1820, 1650],
  [2660, 740], [2920, 1360], [1240, 1740], [570, 700], [2580, 1860]
];
const BASE_OBSTACLES = [
  { type: 'container', x: 1220, y: 900, w: 160, h: 85 },
  { type: 'container', x: 1910, y: 1250, w: 165, h: 80 },
  { type: 'truck', x: 1670, y: 760, w: 86, h: 150 },
  { type: 'shed', x: 2490, y: 1020, w: 158, h: 135 },
  { type: 'shed', x: 550, y: 1490, w: 140, h: 130 },
  { type: 'crate', x: 1100, y: 1060, w: 64, h: 64 },
  { type: 'crate', x: 1530, y: 830, w: 64, h: 64 },
  { type: 'crate', x: 2330, y: 1170, w: 64, h: 64 },
  { type: 'crate', x: 2140, y: 1580, w: 64, h: 64 },
  { type: 'wall', x: 610, y: 630, w: 260, h: 32 },
  { type: 'wall', x: 505, y: 770, w: 32, h: 190 },
  { type: 'wall', x: 690, y: 1040, w: 225, h: 32 },
  { type: 'wall', x: 1160, y: 620, w: 32, h: 200 },
  { type: 'wall', x: 1370, y: 1040, w: 32, h: 205 },
  { type: 'wall', x: 1490, y: 1270, w: 220, h: 32 },
  { type: 'wall', x: 1850, y: 1080, w: 32, h: 160 },
  { type: 'wall', x: 1830, y: 1540, w: 230, h: 32 },
  { type: 'wall', x: 2220, y: 760, w: 32, h: 235 },
  { type: 'wall', x: 2250, y: 1315, w: 160, h: 32 },
  { type: 'wall', x: 2480, y: 1410, w: 32, h: 225 },
  { type: 'wall', x: 2260, y: 1610, w: 200, h: 32 },
  { type: 'wall', x: 2650, y: 1100, w: 260, h: 32 },
  { type: 'wall', x: 2690, y: 1610, w: 32, h: 235 },
  { type: 'wall', x: 970, y: 1860, w: 330, h: 32 },
  { type: 'wall', x: 520, y: 1370, w: 250, h: 32 }
];
// Route ownership is tangible in play: the NFT's trait + token-ID seed opens
// different wall gaps and puts two new barriers in different corridors. The
// open training pit keeps the old terrain. Server and renderer use this SAME
// function; no browser-provided layout can affect authoritative collision.
const NFT_ROUTES = [
  { name: 'BREACH ROUTE', opens: ['1370:1040', '2250:1315'],
    gates: [{ type: 'wall', x: 1130, y: 1510, w: 32, h: 170 },
      { type: 'wall', x: 2020, y: 650, w: 32, h: 170 }] },
  { name: 'CROSSFIRE PASS', opens: ['1160:620', '2480:1410'],
    gates: [{ type: 'wall', x: 1370, y: 1700, w: 210, h: 32 },
      { type: 'wall', x: 2300, y: 1830, w: 200, h: 32 }] },
  { name: 'SPLIT-LANE PIT', opens: ['1490:1270', '2220:760'],
    gates: [{ type: 'wall', x: 1060, y: 1520, w: 32, h: 170 },
      { type: 'wall', x: 2570, y: 740, w: 190, h: 32 }] }
];
const WEAPON_SPOTS = [
  { x: 1010, y: 967, weapon: 'SMG' }, { x: 1480, y: 1220, weapon: 'SHOTGUN' },
  { x: 1950, y: 890, weapon: 'RIFLE' }, { x: 2390, y: 1250, weapon: 'BLASTER' }
];

export function buildArenaWorld(genome = 'demo') {
  const seed = hash(genome);
  const rng = rngFor(seed);
  const training = genome === 'demo' || genome === 'demo-training';
  const route = training ? null : NFT_ROUTES[seed % NFT_ROUTES.length];
  const obstacles = BASE_OBSTACLES
    .filter(box => !route?.opens.includes(`${box.x}:${box.y}`))
    .map(box => ({ ...box }));
  if (route) obstacles.push(...route.gates.map(box => ({ ...box })));
  for (let i = 0; i < 22; i++) {
    const x = 230 + rng() * (WORLD_W - 460), y = 190 + rng() * (WORLD_H - 380);
    if (Math.hypot(x - 910, y - 890) < 260 || Math.hypot(x - 2320, y - 1470) < 230) continue;
    if (Math.abs(x - (1600 + Math.sin(y / 280) * 190)) < 120) continue;
    if (Math.abs(y - (1110 + Math.sin(x / 350) * 115)) < 120) continue;
    const box = { type: rng() > .65 ? 'container' : 'crate', x, y, w: rng() > .7 ? 106 : 62, h: rng() > .7 ? 76 : 62 };
    if (obstacles.some(other => box.x < other.x + other.w + 35 && box.x + box.w + 35 > other.x && box.y < other.y + other.h + 35 && box.y + box.h + 35 > other.y)) continue;
    obstacles.push(box);
  }
  const decor = [];
  for (let i = 0; i < 155; i++) {
    const x = 55 + rng() * (WORLD_W - 110), y = 55 + rng() * (WORLD_H - 110);
    const nearRoad = Math.abs(x - (1600 + Math.sin(y / 280) * 190)) < 120 || Math.abs(y - (1110 + Math.sin(x / 350) * 115)) < 115;
    if (!nearRoad && Math.hypot(x - 910, y - 890) > 130) decor.push({ x, y, kind: rng() > .78 ? 'tree' : rng() > .55 ? 'rock' : 'bush', size: 25 + rng() * 27 });
  }
  const cacheSpots = LOOT_STARTS.map(([x, y], i) => {
    const spot = { x: x + (i > 2 ? (rng() - .5) * 85 : 0), y: y + (i > 2 ? (rng() - .5) * 85 : 0) };
    const blocked = point => obstacles.some(box => circleRect(point.x, point.y, 38, box));
    if (blocked(spot)) {
      const alternatives = [{ x, y }, { x: x + 90, y }, { x: x - 90, y }, { x, y: y + 90 }, { x, y: y - 90 }];
      return alternatives.find(point => !blocked(point)) || spot;
    }
    return spot;
  });
  return {
    biome: seed % 3,
    layoutName: route?.name || 'OPEN TRAINING PIT',
    mapCode: (seed % 65536).toString(16).toUpperCase().padStart(4, '0'),
    obstacles, decor, cacheSpots,
    spawn: { x: 900, y: 890 }, extract: { x: 2320, y: 1470 },
    weaponSpots: WEAPON_SPOTS.map(spot => ({ ...spot }))
  };
}
