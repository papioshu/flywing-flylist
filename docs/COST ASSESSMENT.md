# Cost assessment — FLYLIST (spec §10)

Status as of 2026-10-14. **No paid service is activated, subscribed to, or required.** Nothing in this repo can spend
money as shipped: the only X provider is `none` (never makes a call), X budgets default to 0 units, no partner
collections are configured, and every deferred integration needs an explicit `ENABLED_INTEGRATIONS` entry plus a
campaign policy change before it does anything.

No prices below are confirmed. Where a cost depends on a vendor's pricing, it says so and names where to check.
Re-check before approving anything; vendor pricing and free-tier limits change.

## 1. What works without additional paid services

| Feature | How | Cost today |
|---|---|---|
| APPLY 4 FLYLIST flow, SIWE wallet verification | Free wallet signature, verified in the Edge Function (ecrecover; ERC-1271/6492 over RPC for smart wallets) | None |
| Registrations, admin dashboard, audit trail, CSV exports | Supabase Postgres + one Edge Function | Supabase plan (see §4) |
| $55 native-ETH check (Ethereum OR Robinhood Chain) | `eth_getBalance` on free public RPCs (`ethereum-rpc.publicnode.com`, `rpc.mainnet.chain.robinhood.com`) | None (rate-limited) |
| ETH/USD price | Chainlink feed read with `eth_call` (free), Coinbase public spot as fallback (free, no key) | None |
| Campaign policy versioning, admin config UI | Database + function | None |
| Partner-NFT ownership checks (when enabled) | Standard `eth_call` reads (`balanceOf` / `ownerOf` / ERC-1155 `balanceOf`) on the same RPCs. No NFT indexer. Verified live: `scripts/live-nft.ts` | None (rate-limited) |
| Access codes (when enabled) | Generated, hashed and redeemed in the database | None |
| Self-reported X username | Stored, marked `unverified (self-reported)` | None |
| Static site hosting | Cloudflare Pages (free plan; HostGator dropped 2026-10-15) | None |

## 2. What requires external API access

| Feature | External dependency | Status |
|---|---|---|
| **X account verification (OAuth)** and **required-follow verification** | X (Twitter) API: an X developer app with OAuth 2.0, and API access that can read follow relationships | **Not built, not configured.** Only the provider interface, cost controls and data model exist (Phase B). A real provider is Phase C and needs owner approval. |
| Production-grade RPC at campaign scale | An RPC provider account (e.g. Alchemy, QuickNode, Infura) for Ethereum + Robinhood Chain | Optional. The free public RPCs work but are rate-limited; Robinhood's docs say not to rely on its public RPC for production. Free tiers of providers may be enough (unconfirmed). |
| WalletConnect (phones outside a wallet browser) | Reown project ID | Optional, has a free tier (confirm at cloud.reown.com). Not a per-call cost in this code. |

Paid NFT indexers (e.g. Alchemy NFT API, Moralis, SimpleHash-type services) are **not** needed: the configured-collection
checks are plain contract reads. An indexer would only become necessary for features this spec doesn't ask for
(e.g. "any NFT from any of 10,000 collections" or full holder snapshots without known token IDs).

## 3. Which operations could incur usage charges

| Operation | When it happens | Charged by |
|---|---|---|
| X OAuth token exchange + reading the authenticated user | Once per X verification attempt (`POST /me/verification/x/complete`) | X API (depends on the plan; **unconfirmed**) |
| X follow-relationship lookup(s) | Same request, one per required account | X API (depends on the plan; **unconfirmed**) |
| Eligibility RPC reads (2 chains × ~3 calls + Chainlink) | Once per fresh eligibility check (cached 5 min per wallet; capped 10 per wallet per 10 min and 10 per IP per minute; none for already-registered wallets) | Only if a paid RPC provider is configured, and only past its free tier |
| Partner-NFT reads (≈2 + token-ID count calls per collection) | Once per fresh eligibility check, only in community / hybrid modes | Same as above |
| Smart-wallet signature verification (ERC-1271/6492) | Sign-in by a contract wallet | Same as above |
| Supabase Edge Function invocations, DB size, egress | Every API request | Supabase plan quotas (free tier vs Pro; **D004 still open**) |

## 4. Expected cost drivers

1. **X verification, if approved.** Cost scales with verification attempts × (1 + number of required accounts). The
   controls already built keep this bounded: a verified result is reused for 30 days (`xVerificationCacheSeconds`),
   a 5-minute retry cooldown, hourly caps per wallet / X account / IP, and hard daily + total unit budgets reserved
   before every call. The unit estimate per call comes from the provider implementation, which doesn't exist yet;
   map units to the real X price list when one is chosen. **X API pricing and tiers: not confirmed here.** Check the
   X developer portal's current pricing before approval.
2. **Supabase plan.** The free tier pauses projects after about a week idle (this already happened to BMBSQD) and has
   no daily backups. Pro has a monthly fee (confirm current price at supabase.com/pricing). Decision D004 is still
   open.
3. **RPC volume at scale.** Roughly 7–9 JSON-RPC calls per fresh eligibility check, plus partner-NFT reads when
   community gating is on. Caching and per-wallet/IP caps keep repeats down. Public RPCs cost nothing but may
   rate-limit under a launch spike, which shows up as `unavailable` (never `ineligible`); a provider free tier is the
   first step (limits **unconfirmed**).
4. Hosting is Cloudflare Pages on the free plan. The domain is a fixed cost the owner already planned.

## 5. What remains disabled pending approval

| Integration | Switch(es) needed | Default |
|---|---|---|
| Paid X API follow / account verification | Build a real `XVerificationProvider` (Phase C) → add `x_verification` to `ENABLED_INTEGRATIONS` → select it in the policy → set non-zero budgets | Provider `none`, budgets 0 |
| Partner-community (NFT holder) gating | Owner names the real partner collections → `community_gating` in `ENABLED_INTEGRATIONS` → migration lifting the D013 access-mode lock → `accessMode` community/hybrid | Off, no collections |
| Access-code (invite) gating | `access_codes` in `ENABLED_INTEGRATIONS` → D013 migration → `accessMode` invite_code/hybrid | Off (codes can be generated but do nothing in `open` mode) |
| Paid NFT indexing | Not needed for the current design | Not built |
| Production mint allowlist / Merkle root | Contract interface + rules final, leaf format per `FWGAllowlist.sol` (D006) | Not built |
| Including unverified approved wallets in the final export | Policy `finalExportIncludesUnverified` | Off |

Until then the campaign runs as the owner decided: **open mode, X not required (handle collected, unverified), $55 of
native ETH on Ethereum or Robinhood Chain, final export = admin-approved wallets only.**
