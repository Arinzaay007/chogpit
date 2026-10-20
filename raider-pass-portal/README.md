# CHOGPIT Raider Pass — Privy email-only owner preview

**Not publicly deployed. No owner Privy app is configured. No Monad NFT has been minted by this portal; no CHOG is paid.** This separate Node 22+ app is excluded from game-only ZIPs and the public game server. Anyone can still raid official Chog NFT-owned arenas, open sample boxes and join private rooms **without registering or connecting a wallet**.

## Chosen signup behavior

A player enters an email and completes Privy's emailed verification code inside **Privy's login modal, configured to display only email**. `PrivyProvider` uses `loginMethods: ['email']` and `embeddedWallets.ethereum.createOnLogin: 'users-without-wallets'`; `login({loginMethods:['email'], prefill:{type:'email',value:email}})` opens that modal. In the **owner's dashboard**, also enable email login and EVM automatic wallet creation and **disable external wallets**. The app never asks players to select/connect an existing wallet, sign a wallet message during signup, pay gas or disclose a seed. Privy provisions a **user-controlled embedded EVM wallet** as part of modal login. Review the owner's actual user-control, export/recovery and signer/delegation settings before use; CHOGPIT never generates, receives or stores wallet keys.

**Important distinction:** Privy [documents that automatic `createOnLogin` does not run for whitelabel `useLoginWithEmail().loginWithCode()`](https://docs.privy.io/basics/react/advanced/automatic-wallet-creation). This portal deliberately uses the email-only **modal**, not the whitelabel OTP flow. The email form pre-fills the modal; a provider-sent verification code is **not** a wallet connection or registration signature. Monad mainnet (chain 143) is the SDK's network setting; registration submits **no transaction**.

Privy [publishes a free Developer plan for **0–499 monthly active users**](https://www.privy.io/pricing); at 500–2,499 MAU, its published Core tier is **$299/month** (check live terms). The **40-NFT mint cap does not limit email signups or MAUs**. No account, paid plan or auto-upgrade is created or authorized here. Owner must monitor usage/quotas and stop enrollment before incurring a charge; free-tier hosting likewise has no uptime guarantee.

## What is implemented and deliberately locked

- Isolated responsive portal with disabled-by-default email form, no wallet picker or registration-signature UI, and an honest **40-NFT cap in an undeployed contract draft**. No fabricated live supply count. Old `/challenge` and `/bind` routes return HTTP 410 when registration is configured.
- Backend requires a current **Privy-signed identity token**, not an access token. It pins ES256, issuer `privy.io`, **exact** owner app-ID audience, expiration, issue time and a Privy DID. It parses the *signed* JSON-string `linked_accounts` claim, requires exactly one email and exactly one EVM wallet with Privy embedded-wallet client markers, and compares them with the form email and browser wallet address. Missing, contradictory or external-wallet attestations fail closed. Privy requires **Return user data in an identity token** enabled in the app dashboard. The server verifies with the **owner app's ES256 public verification key**; no app secret or server-custodial signer is needed. A browser-supplied user object, email or address alone is never authoritative. The official [identity-token guide](https://docs.privy.io/user-management/users/identity-tokens) distinguishes these tokens from access tokens (`verifyAuthToken` must not be used for an identity token).
- Local SQLite binds an HMAC of the signed email, a separate HMAC of the Privy DID, the **public** EVM address and timestamp. An identical retry is safe; a different DID/email/address needs a manual, independently reviewed recovery process. Raw emails, DIDs and identity JWTs are not persisted. The old provider's SQLite schema is explicitly rejected rather than migrated across wallet identities. This is **preview-only local storage**, not a durable public claim system or an anti-sybil guarantee.
- `/api/pass-portal/claim`, `/mint`, `/api/claim/*` and `/api/reward/*` **always return 423**. No issuer key, contract address, MON sponsorship, NFT mint or CHOG access exists in this portal. `GET /api/pass-portal/status` reports `contract:null`, `verifiedMintCount:null`, `mintEnabled:false`, `chogRewardsEnabled:false`. Email registration is **not** an NFT or reservation.
- Synthetic ES256 tests check issuer/audience/signature/age, Privy DID and linked email/wallet association, duplicate/retry/mismatch handling, disabled old signature routes and the permanent mint/reward lock. The SDK bundles locally; **none of these tests signs in to a live owner-issued Privy app**, verifies actual OTP delivery/recovery, or proves its identity-token lightweight account format in practice. Live owner-controlled testing and a security review are mandatory before a public enrollment decision.

## Local preview on Windows PowerShell (Node.js 22+)

Extract `CHOGPIT_Privy_Test_Portal.zip` into your Windows Downloads folder. It creates a `raider-pass-portal` directory (without dependencies or secrets). Open PowerShell:

```powershell
cd "$HOME\Downloads\raider-pass-portal"   # or the folder where you extracted it
npm ci
npm test
npm run check:bundle
npm run dev                         # http://localhost:4287; signup OFF by default
```

On a machine with only ~2 GB RAM, npm's large peer graph may exhaust memory during a fresh `npm ci`. The supplied `pnpm-lock.yaml` also works as a lower-memory option with Node 22 / Corepack: `corepack pnpm install --frozen-lockfile --ignore-scripts`, then `corepack pnpm rebuild better-sqlite3 --config.dangerouslyAllowAllBuilds=true`, then `corepack pnpm test` and `corepack pnpm run check:bundle`. Rebuilding the SQLite native dependency matters; ignoring its build without a subsequent rebuild leaves local tests unusable.

**Only if you want to test your own app:** create a Privy **Web** app on the free Developer tier, enable **email** and **Return user data in an identity token**, disable external wallets, enable automatic **EVM** embedded-wallet creation, and allow the exact local origin `http://localhost:4287`. Independently check real email OTP, the lightweight signed wallet markers, recovery/export, current pricing and account control. Privy's [Monad setup guide](https://docs.monad.xyz/templates/next-serwist-privy-embedded-wallet) shows the dashboard settings. Get the app's **public App ID** and **public ES256 JWT verification key** from your own dashboard (the settings may label it “Verify with key instead”). If a matching key is not available, the preview remains **off**; never supply a guess or a test key. Configure **only on your own machine**, not in chat or committed files:

```powershell
$env:PASS_PORTAL_PREVIEW = '1'
$env:PRIVY_APP_ID = 'YOUR_PUBLIC_PRIVY_APP_ID'
$env:PRIVY_IDENTITY_PUBLIC_KEY = Get-Content -Raw 'C:\your-private-notes\privy-public-verify-key.pem'
$env:PASS_PORTAL_ORIGIN = 'http://localhost:4287'
$env:PASS_ACCOUNT_HMAC_KEY = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
npm run dev
```

The **public** verification key and app ID must belong to that exact owner app. The HMAC key is private: keep it stable and out of chat/source control; never paste a Privy session/identity token, app secret, sponsor signer key or wallet seed. Default SQLite file: `.cache/privy-accounts.sqlite` (excluded from saved snapshots), **not** the older provider's database. For a one-time **Windows** owner test, set `PASS_PORTAL_DB_PATH=':memory:'` to avoid persisting test accounts: they will reset when you stop the server. The POSIX owner-only file-mode assertion is skipped on Windows because Windows uses NTFS ACLs, not POSIX mode bits. Do not treat this preview as a public durable account database. Use `PASS_PORTAL_DB_PATH` for a different disposable preview file. Set `PASS_PORTAL_ORIGIN` to the exact browser origin you explicitly allow in your Privy dashboard; the server refuses cross-origin registration. `NODE_ENV=production` or missing/invalid owner configuration keeps the signup path disabled. Do not expose this preview as a public registration service.

The isolated package pins its dependencies and bundles the official Privy React SDK locally (including required bundler peers from its optional UI modules). This does **not** enable Solana signups, Stripe payment, external-wallet selection, minting or a paid Privy feature. At this revision `npm audit --omit=dev` reports **1 high and 24 moderate** transitive dependency advisories (the high advisory concerns an older `ws` inside optional wallet-connector packages). Treat this preview as **not suitable for public signup** until dependencies and bundled reachable paths receive an independent security review; do not silently force incompatible nested versions.

## Before any real NFT claim or CHOG program

1. Test a real owner-app email signup and confirm that the signed `linked_accounts` claim contains **email + Privy-created user-controlled EVM wallet**, matching the exact displayed address. Check wallet recovery/export, signing authorization model, provider usage and actual browser-origin/OTP behavior. The present tests are synthetic; a stolen but current token can replay registration for the same binding, so session, rate limits and recovery need an independent review.
2. Publish fair access and anti-farming rules; one email or wallet is not one person. Review `../contracts/ChogpitRaiderPassDraft.sol`; deploy/verify its hard-40-cap ERC-721 on **real Monad mainnet** from the owner's wallet and build a durable, audited claim intake. Fund an **authorized project issuer** with MON for gas.
3. The player must **deliberately tap Claim** after signup. Only then would the already-provisioned embedded wallet authorize a non-spending, chain-143/contract/recipient/nonce/deadline-bound EIP-712 mint consent. The project pays gas, reconciles final chain receipts and verifies `ownerOf` before displaying `MINTED`. **This entire service is absent here; the claim button stays locked.**
4. A funded CHOG program would pay only the verified **box-opening raider** holding a real pass at the time of payout, with fresh wallet proof and holder-aware controls. The **40 NFTs** and proposed **40 CHOG-backed box openings** are separate limits. Sample boxes, emails and created wallets reserve neither NFTs nor CHOG. CHOG stays off.
