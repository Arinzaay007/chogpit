# CHOG payout stays locked - hero link plan

**Reminder you asked for:** real CHOG is still coming, but NOT moved yet. Hero mint = fighter now, CHOG = later once holder-aware path is funded, reviewed and owner-funded.

## Link
- Hero (CHOGPIT Hero 500) proves you play; **Raider Pass (40)** proves you get paid. Opening raider must hold a *real minted Raider Pass before payout* - not the pit owner, not a browser sample.
- New draft `ChogRewardVaultHolderAwareDraft.sol` adds `isHolder(recipient) = raiderPass.balanceOf(recipient) > 0` check at every 50+ auto-pay and final sub-50 settlement. No holder = credit stays, emitted as `HolderRejected`, never auto-sent.
- Vault stays `batchesPaused=true`, `MAX_BATCH=40`, reserve 25 CHOG/slot, 1,000 CHOG max campaign, same 5/10/25 odds via Entropy seed. Still needs audit + real addresses.

## Next ordered steps (no CHOG moves now)
1. Owner deploys & funds real 40-cap Raider Pass + publishes address
2. Replace `raiderPass` placeholder in holder-aware vault, audit, verify on Monad 143
3. Owner funds vault with 1,000 CHOG only after verification + sets UTC start/end
4. Enable only after cut-off / holder-race rules are published

Keep `mintEnabled=false`, `chogRewardsEnabled=false` until then.
