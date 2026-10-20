# CHOGPIT Hero - Hackathon Replica Core

> **Every mint = your hero.** Just like Chog (1,969 faces, traits drive character), each CHOGPIT Hero NFT carries Background / Body / Eyes / Aura -> in-game speed / armor / weapon / ability.
> Guest can still raid/open without a wallet, but a held hero gives the visual + stat seed.

## What we replicate (safely)
- **Pattern, not art:** CHOG Genesis is `0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763` on Monad 143 (1,969). We *do not* copy its images. We rebuild the same *category* system with hackathon-owned labels (Aqua Depths, Gangster Coat, Fire Laser eyes, Royal Blue Aura etc.) so judges see you understand the real collection.
- **Real holder check (read-only):** If a wallet `ownerOf` a real CHOG, the lobby gives a gold-frame badge. No art is duplicated, just a verified badge.
- **Distinct supply:** Hero replica `MAX_SUPPLY = 500` — separate from `Raider Pass = 40` and `real CHOG = 1,969`. No supply confusion.

## How to use in game
1. Wallet holds `tokenIds[]` -> `pickActiveHero(ids, traitsById)` -> `loadout`
2. Loadout drives `public/game.js` fighter: `loadout.speed / armor / weapon / ability / color`
3. Off-chain demo uses `data/chog-hero-sample.json`; on-chain demo reads `tokenURI` base64 JSON and runs `resolveHeroFromTokenURI`

## Files
- `contracts/ChogpitHeroDraft.sol` - hackathon replica (EIP-712 mintWithConsent, owner pays gas, tiered traits). NOT DEPLOYED.
- `hero.mjs` - trait -> loadout mapping + pick helper
- `data/chog-hero-sample.json` - 4 sample heroes for lobby demo
- `tests/hero.mjs` - verifies 1969 vs 500 vs 40 distinct + guest playable

## Hackathon pitch line
> "We made the NFT the fighter: mint a CHOG-inspired hero and its face decides how you raid. Own a real Chog? You keep your badge — we verify it live on Monad, we don’t forge it."

## Next
- Wire `hero.mjs` into `public/app.js` lobby (hero picker + default raider fallback)
- Optional: deploy mock on Monad testnet 10143 for judges who don’t hold real CHOG
