// HERO CORE - every minted NFT = fighter, CHOG-style faces -> gameplay
// Real CHOG reference: 0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763 on Monad 143 (1969 supply).
// This module is the hackathon replica: it maps the *pattern* (Background/Body/Eyes/Aura -> stats)
// without copying official art. Judges can verify real-CHOG ownership read-only via ownerOf.

export const REAL_CHOG = {
  address: '0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763',
  chainId: 143,
  supply: 1969,
  name: 'Chog Genesis'
};

export const HERO_CONTRACT = {
  name: 'CHOGPIT Hero',
  symbol: 'PITHERO',
  draftSupply: 500, // distinct from 40 Raider Pass
  chainId: 143,
  traits: {
    backgrounds: ["Aqua Depths","Lime Grid","Sky Blue","Red Sky","Lemon Yellow","Light Purple","Monad Purple","Void Black"],
    bodies: ["Prisoner Wrap","Zero THOTS Tee","Gangster Coat","Wizard Cape","Banana Suit","Royal Guard","Scrap Armor","Neon Racer"],
    eyes: ["Closed Crying","Clown Ring","Tired Half","Fire Laser","Dead Flat","Side Eye","Holo Scan","Prism Gaze"],
    auras: ["None","Royal Blue Aura","Royal Aura","Ember Aura","Frost Aura","Monad Pulse"]
  }
};

// Deterministic hero -> gameplay mapping (same logic used in Solidity heroSeed)
export function heroToLoadout(traits) {
  // traits = { background, body, eyes, aura, tier } as indices
  const bg = HERO_CONTRACT.traits.backgrounds[traits.background] ?? 'Unknown';
  const body = HERO_CONTRACT.traits.bodies[traits.body] ?? 'Unknown';
  const eyes = HERO_CONTRACT.traits.eyes[traits.eyes] ?? 'Unknown';
  const aura = HERO_CONTRACT.traits.auras[traits.aura] ?? 'None';

  // Simple hackathon balancing - each trait nudges a stat
  const loadout = {
    name: `${body} ${eyes}`,
    background: bg,
    aura,
    tier: traits.tier ?? 1,
    speed: 4 + (traits.eyes % 4 === 0 ? 0 : traits.eyes % 3 === 1 ? 2 : 1), // eyes spread: Closed(0)->+0, Clown(1)->+2, Dead(4)->+1 etc
    armor: 3 + (traits.body % 4),           // body = tank (Gangster/Wizard tanky)
    ability: traits.aura === 0 ? 'dash' : traits.aura === 1 ? 'shield' : traits.aura === 3 ? 'ember-burst' : 'pulse',
    weapon: traits.body === 2 ? 'shotgun' : traits.body === 3 ? 'staff' : traits.body === 5 ? 'blade' : 'rifle',
    color: ['#0ea5a0','#a3e635','#38bdf8','#f43f5e','#facc15','#c084fc','#6d28d9','#111827'][traits.background] || '#888'
  };
  // Real-CHOG holder bonus (verified off-chain via ownerOf): +1 tier badge, gold frame (read-only)
  loadout.realChogHolderBonus = false; // set true after RPC ownerOf check
  return loadout;
}

// For hackathon demo: resolve hero from tokenId metadata (on-chain SVG data URI or IPFS)
// In production this fetches tokenURI from Monad RPC (viem) and parses traits.
export function resolveHeroFromTokenURI(tokenURI) {
  if (typeof tokenURI !== 'string') throw Error('tokenURI required');
  // supports data:application/json;base64, ...
  if (tokenURI.startsWith('data:application/json;base64,')) {
    const b64 = tokenURI.slice('data:application/json;base64,'.length);
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const attrs = Object.fromEntries((json.attributes||[]).map(a=>[a.trait_type, a.value]));
    // reverse lookup trait indices
    const bgIdx = HERO_CONTRACT.traits.backgrounds.indexOf(attrs.Background);
    const bodyIdx = HERO_CONTRACT.traits.bodies.indexOf(attrs.Body);
    const eyesIdx = HERO_CONTRACT.traits.eyes.indexOf(attrs.Eyes);
    const auraIdx = HERO_CONTRACT.traits.auras.indexOf(attrs.Aura);
    return heroToLoadout({ background: bgIdx, body: bodyIdx, eyes: eyesIdx, aura: auraIdx, tier: Number(attrs.Tier)||1 });
  }
  throw Error('Unsupported tokenURI format for hackathon demo - use on-chain base64 JSON');
}

// Lobby helper: wallet holds N heroes -> pick active fighter
export function pickActiveHero(ownedTokenIds, ownedTraitsById, preferredId=null) {
  if (!ownedTokenIds.length) return null; // guest - uses default raider (no NFT needed, per your rule)
  if (preferredId && ownedTokenIds.includes(preferredId)) return { tokenId: preferredId, loadout: heroToLoadout(ownedTraitsById[preferredId]) };
  // default: lowest tokenId (first mint = first hero)
  const id = [...ownedTokenIds].sort((a,b)=>a-b)[0];
  return { tokenId: id, loadout: heroToLoadout(ownedTraitsById[id]) };
}
