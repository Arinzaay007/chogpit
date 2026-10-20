import assert from 'node:assert/strict';
import { HERO_CONTRACT, REAL_CHOG, heroToLoadout, resolveHeroFromTokenURI, pickActiveHero } from '../hero.mjs';
import { readFileSync } from 'node:fs';

// CHOG reference must stay official and not be spoofed
assert.equal(REAL_CHOG.address.toLowerCase(), '0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763');
assert.equal(REAL_CHOG.chainId, 143);
assert.equal(REAL_CHOG.supply, 1969);

// Hero contract is distinct: not 1,969, not 40
assert.equal(HERO_CONTRACT.name, 'CHOGPIT Hero');
assert.equal(HERO_CONTRACT.draftSupply, 500);
assert.notEqual(HERO_CONTRACT.draftSupply, 40);
assert.notEqual(HERO_CONTRACT.draftSupply, REAL_CHOG.supply);

// Traits give different loadouts (NFT is core, not cosmetic)
const fastEyes = heroToLoadout({ background: 0, body: 0, eyes: 1, aura: 0, tier: 1 });
const slowEyes = heroToLoadout({ background: 0, body: 0, eyes: 4, aura: 0, tier: 1 });
assert.notEqual(fastEyes.speed, slowEyes.speed, 'eyes change speed');
assert.notEqual(fastEyes.weapon, heroToLoadout({ background: 0, body: 2, eyes: 1, aura: 0, tier: 1 }).weapon, 'body changes weapon');
assert.equal(heroToLoadout({ background: 0, body: 0, eyes: 0, aura: 1, tier: 2 }).ability, 'shield');

// Guest still playable (no wallet required to raid/open - per spec)
assert.equal(pickActiveHero([], {}), null);
const owned = pickActiveHero([7,2,1], {1:{background:0,body:2,eyes:3,aura:1,tier:3},2:{background:2,body:3,eyes:5,aura:0,tier:1},7:{background:5,body:4,eyes:6,aura:5,tier:2}}, 2);
assert.equal(owned.tokenId, 2);
assert.ok(owned.loadout.name.length > 3);

// Sample file sanity
const sample = JSON.parse(readFileSync(new URL('../data/chog-hero-sample.json', import.meta.url), 'utf8'));
assert.ok(sample.heroes.length >= 3);

console.log('PASS: CHOG-inspired hero is core (1969 real vs 500 replica vs 40 pass distinct), traits -> stats');
