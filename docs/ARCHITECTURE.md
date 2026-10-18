# Architecture — FLY WING GENESIS FLYLIST Registration

## Components

```
Browser (Cloudflare Pages site)                Supabase
┌──────────────────────────────┐   HTTPS   ┌─────────────────────────────┐   SQL   ┌────────────────────┐
│ Vite + React + wagmi/viem    │ ────────▶ │ Edge Function "allowlist"   │ ──────▶ │ Postgres, private  │
│ "/" APPLY 4 FLYLIST modal    │  Bearer   │ (Deno) _shared/app.ts       │ postgres│ schema "allowlist" │
│ "/admin/allowlist" dashboard │  token    │ SIWE, sessions, eligibility,│   .js   │ (not exposed)      │
└──────────────────────────────┘           │ CSV                         │         └────────────────────┘
                                           └──────────────┬──────────────┘
                                                          │ read-only JSON-RPC / HTTPS (free sources)
                                           Ethereum RPC · Robinhood Chain RPC · Chainlink ETH/USD · Coinbase spot
```

- The browser never talks to the database and never computes eligibility. There is no Supabase client or anon key in the front end.
- The `allowlist` schema is not in Supabase's exposed schemas, RLS is on with no policies, and `anon`/`authenticated` are revoked. The function connects with `SUPABASE_DB_URL` (owner role).
- `_shared/app.ts` is a runtime-agnostic `(Request) => Response` handler, the same code in Deno (production), the Node dev server, and the tests. Network reads go through an injectable `fetch` (`AppDeps.fetch`), which tests replace with a fake network at that boundary.

## Landing page (`web/src/components/LandingPage.tsx`)

Built to RichFox's landing wireframe (`landing page wireframe.jpg`, owner 2026-10-14): one full-screen screen and
nothing else. Asset sources in [ASSETS.md](ASSETS.md).

- **Art:** RichFox's cloud landing graphic (FLY WING wordmark baked in), `object-fit: cover`, eager and preloaded
  (AVIF/WebP srcset). On tall portrait screens (aspect < 7/11) the art is sized by width instead, so the wordmark
  isn't cropped, and its top/bottom fade into the art's edge colours.
- **FLY LIST pill** (`FlylistApply`): white rounded pill, red condensed slanted lettering, under the wordmark.
  Positions and sizes are in source-art pixels via container-query units (`--px`), so at 1920×1080 the pill is
  437×82 at y 735, measured within 1–2px of the wireframe. Accessible name "Apply 4 FLY LIST".
- No separate CONNECT WALLET: the FLY LIST pill is the only wallet entry point (owner, 2026-10-14). If no wallet is
  connected, the FLYLIST modal opens on the wallet grid first.
- "Art by RichFox" credit, bottom right. Registration terms and privacy live in the FLYLIST modal's connect step.

`web/src/lib/collection.ts` (supply numbers) is no longer shown on the landing page but stays checked against Nimbus by
`tests/collection.test.ts`.

## Wallets (`web/src/components/WalletPicker.tsx`, `web/src/lib/wallets.ts`, `web/src/lib/wagmi.ts`)

Icon-first grid: each wallet's logo is the button (name as tooltip and accessible name). Connectors: EIP-6963
discovered wallets (wagmi `injected`), Coinbase Wallet (Coinbase's own SDK), WalletConnect (only when
`VITE_WALLETCONNECT_PROJECT_ID` is set). Grid order: MetaMask, Coinbase Wallet, Rabby, up to 3 other installed
wallets, a generic "Browser Wallet" only if nothing announces over EIP-6963, WalletConnect, All Wallets.

- **No duplicates:** installed wallets are matched to the featured list by rdns; wagmi itself drops an EIP-6963
  announcement whose rdns belongs to a configured connector (Coinbase).
- **Official logos only:** MetaMask fox, Rabby rabbit and WalletConnect logomark are the symbols from each brand's
  own logo pack (`web/public/wallets/`, see ASSETS.md), used whether or not the wallet is installed; Coinbase Wallet
  uses the mark bundled in Coinbase's SDK; any other installed wallet uses the icon it announces over EIP-6963. No
  drawn or approximated logos.
- **Not installed:** desktop shows an install link (and "use it on your phone" via WalletConnect); on phones MetaMask
  deep-links into MetaMask's browser and others go through WalletConnect.
- **Interaction:** no card behind the logo; hover (desktop) and press/tap (touch) give a sharp offset
  `filter: drop-shadow` plus a 3px lift in 150ms; the shadow holds while that wallet is opening, with a status
  line; keyboard focus gets an outline; the connected wallet gets a small dot. Reduced motion drops the lift.
- RainbowKit was not used (needs wagmi 2; this app is on wagmi 3). Reown's headless wallet list is paid-plan only.
- Tests: `npm run e2e:wallets` (mock EIP-6963 MetaMask/Rabby/Phantom, keyboard, switching, mobile deep link,
  returning wallet).

## The FLYLIST interaction (`web/src/components/FlylistApply.tsx`)

The page renders the gate card and nothing else wallet-related. **No wallet dialog, signature request or modal is
triggered by page load, wagmi's silent reconnect, or `accountsChanged`.** Only the FLY LIST button (APPLY 4 FLYLIST) starts a flow:

1. No wallet connected → modal shows "Wallet connection requested" with the wallet picker.
2. Connected → **Signature requested**: nonce-bound SIWE (below). A still-valid session token for this wallet in this
   tab's `sessionStorage` is reused instead of asking again; the server validates it either way.
3. **Verification in progress**: `/auth/verify`, then `GET /me/registration`. The session wallet returned by the server
   must equal the connected wallet.
4. Already registered → compact status (passenger / callsign / status). No form. A separate "Change X username" flow
   (`PATCH /me/registration`) corrects the handle without creating a registration.
5. Campaign closed → "Registration closed".
6. **Eligibility check in progress**: `POST /me/eligibility` (server-side).
7. Eligible → the modal: **WALLET ADDRESS** (from the server session, truncated, greyed, read-only, not focusable,
   accessible Copy button) and **X / TWITTER USERNAME** (with or without `@`, labelled self-reported/unverified),
   side by side on desktop, stacked on mobile; **SUBMIT TO FLYLIST**.
8. Ineligible → the $55 rule and the per-chain balances/USD values used. Unavailable (price or RPC outage) → "Check
   unavailable", never "ineligible".

Other states: submitted, registration failed (retry), wallet changed. Every flow run has an id; anything finishing
after the modal closed, a newer run started, or the wallet changed is ignored. If the account changes mid-flow the flow
stops ("Wallet changed") and the visitor restarts for the new wallet, which is checked independently. Double submit is
blocked client-side (in-flight ref + disabled button) and server-side (unique constraint). The modal is rendered in a
portal on `document.body` (the gate card's CSS `filter` would otherwise trap `position: fixed`).

## Eligibility (`_shared/eligibility.ts`)

Owner rule (2026-10-13): **≥ $55 USD of native ETH on Ethereum mainnet (1) OR Robinhood Chain (4663)**. Each chain is
judged on its own; balances are never summed. `$55` is USD-equivalent, not 0.055 ETH.

- **Price:** Chainlink ETH/USD on Ethereum (`0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419`, verified via Chainlink's ENS
  name `eth-usd.data.eth`, 8 decimals) read with `eth_call latestRoundData()`. Rejected if `answer ≤ 0`, outside
  $10–$1M, `answeredInRound < roundId`, `updatedAt` older than `PRICE_MAX_AGE_SECONDS` (default 4500 s; the feed's
  heartbeat is 3600 s) or in the future. Fallback: Coinbase public spot (`/v2/prices/ETH-USD/spot`, no key), parsed as a
  decimal string, sanity-bounded. Both unavailable → result `unavailable`.
- **Balances:** per chain, `eth_blockNumber`, then `eth_chainId` + `eth_getBalance(wallet, thatBlock)`. A chain ID
  mismatch (misconfigured RPC URL) is an error. Default RPCs: `ethereum-rpc.publicnode.com` and Robinhood's official
  `rpc.mainnet.chain.robinhood.com` (both free, rate-limited); override with `RPC_URLS`.
- **Math:** integers only. Pass iff `wei × price ≥ minCents × 10^(18+8−2)`. USD shown/stored as cents, floored.
- **Outcome:** any chain passes → `eligible`. Otherwise, any chain unreadable → `unavailable` (it might have passed).
  Otherwise `ineligible`. A chain without an RPC URL is `not_configured` and ignored.
- **Caching / cost control:** each evaluation is a row in `allowlist.eligibility_checks`. `eligible`/`ineligible`
  results are reused for `ELIGIBILITY_CACHE_SECONDS` (300); `unavailable` is never cached. Fresh evaluations are capped
  per wallet (`ELIGIBILITY_CHECKS_PER_WALLET`, 10 per 10 min) and per IP (`eligibility` bucket, 10/min). An already
  registered wallet triggers no RPC calls.
- **On submit** the server reuses the wallet's own recent check or evaluates again. The browser never submits a result.
  The registration row copies the snapshot (wei, price, decimals, source, price time, USD cents, chain, check id).

This is a registration-time check. It is not a mint allocation, and nothing is re-checked or revoked later.

## Campaign policy (`_shared/policy.ts`) — Phase B

The policy has three layers (spec §7), plus campaign status and provider settings:

| Layer | Fields (camelCase in the API, snake_case columns on `allowlist.campaigns`) | Current value |
|---|---|---|
| Campaign status | `status`, `opensAt`, `closesAt` | open, no window |
| **Registration requirements** (what it takes to apply) | `accessMode` (`open` / `invite_code` / `community` / `hybrid`), `ethBalanceCheckEnabled`, `minEthBalanceUsdCents`, `ethBalanceChainIds` | open, $55, `{1,4663}` |
| **Verification requirements** (what must be proven before eligible) | `xAuthRequired`, `xFollowRequired`, `requiredXAccounts` (`[{id, username}]`, numeric IDs), `allowProvisionalRegistration`; community rule `communityProvider`, `nftRule` (`any`/`all`/`min_n`), `nftMinCollections`, `hybridRule` (`code_or_community`/`code_and_community`) | X not required (owner decision D009) |
| **Mint eligibility** (what reaches the final list) | always admin `approved`; `finalExportIncludesUnverified` decides whether approved wallets with incomplete required verifications are included | false |
| Provider settings / budget | `xProvider` (only `none` is implemented), `xVerificationCacheSeconds` (30 d), `xRetryCooldownSeconds` (300), `xBudgetDailyUnits` / `xBudgetTotalUnits` (0 / 0) | none, zero budget |

**Versioning.** `campaigns.policy_version` is the live version. Every change goes through `PATCH /admin/policy`
(`updatePolicy()`): one SQL statement updates the campaign row **and** appends the full snapshot to
`allowlist.campaign_policies` (append-only: a trigger rejects UPDATE/DELETE), guarded by `expectedVersion` (409 on a
concurrent edit). Each `eligibility_checks` row, `nft_ownership_checks` row, `x_verifications` row and registration
records the `policy_version` it was evaluated under, and a cached eligibility result is only reused under the same
version. History is never rewritten. (Editing the campaign row with raw SQL bypasses versioning; don't.)

**Deferred integrations are refused server-side** unless activated. Activation needs **both** an
`ENABLED_INTEGRATIONS` entry (`x_verification`, `community_gating`, `access_codes`; unknown names fail at startup)
**and** the campaign selecting it:

| Change | Refused with |
|---|---|
| `accessMode` invite_code / hybrid without `access_codes` | 403 `INTEGRATION_DISABLED` |
| `accessMode` community / hybrid without `community_gating` | 403 `INTEGRATION_DISABLED` |
| community mode with no active partner collection (or `min_n` > active) | 400 `NO_COLLECTIONS` / `INVALID_POLICY` |
| any non-`open` mode while the D013 DB lock is in place | 409 `ACCESS_MODE_LOCKED` |
| `xProvider` other than `none` | 403 `PROVIDER_NOT_IMPLEMENTED` (and `INTEGRATION_DISABLED` without the flag) |
| X required while no X provider works and provisional is off | 400 `WOULD_BLOCK_REGISTRATION` |
| `xFollowRequired` with no accounts listed | 400 `INVALID_POLICY` |
| ETH chain without an RPC URL | 400 `UNSUPPORTED_CHAIN` |

**How to enable a deferred mode later (owner approval first):** add the integration to `ENABLED_INTEGRATIONS`;
for invite/community/hybrid also ship a migration that drops `campaigns_access_mode_implemented` (D013); for X, build
and register a real provider (Phase C) and give it a non-zero budget. Then select it in the admin policy tab.

**Status decision** (`decideStatus`):
- No X requirement → `eligible`, `verification_status = not_required`.
- X requirement satisfied by a real verification → `eligible`, `verified`.
- Verified "not following" / auth denied → refused (`X_REQUIREMENT_NOT_MET`).
- Otherwise, with provisional registration on → `pending_verification`, `pending`.
- Otherwise → refused (`X_VERIFICATION_REQUIRED`, or `VERIFICATION_UNAVAILABLE` when no provider works).

A later successful verification promotes a pending registration to `eligible` (system audit entry). A failed one sets
`verification_status = failed` but never silently rejects it; rejecting is an admin decision.

## X verification (`_shared/xverify.ts`)

Two separate operations: **account authentication** (OAuth 2.0 + PKCE S256; `status`) and **follow verification**
against `requiredXAccounts` (`follow_status`). Statuses: `not_configured`, `not_started`, `pending`, `verified`,
`failed`, `unavailable` (follow status adds `not_required`).

- `XVerificationProvider` interface: `authorizeUrl` (free), `completeAuth` (billable), `checkFollows` (billable),
  `estimate` units. **Only `notConfiguredXProvider` ships**: it never makes a network call. No scraping, no browser
  automation, no credential collection.
- `POST /me/verification/x/start` stores a single-use, wallet-bound, 10-minute state (only its SHA-256) and the PKCE
  verifier server-side, and returns the authorize URL. `POST /me/verification/x/complete {state, code}` consumes the
  state atomically, then authenticates and checks follows in one step (no OAuth tokens are stored).
- A provider error or an unknown follow answer is `unavailable`, never "does not follow". Only an explicit `false`
  is `failed`.
- **Cost controls** (all enforced and tested against a fake provider): the provider only counts when activated AND
  selected; a verified result is reused until `verified_until` (no per-visit re-check); retry cooldown per wallet;
  hourly caps per wallet (5), per X account (5) and per IP (20) from the usage ledger; a daily + total budget
  reserved **before** each billable call with one conditional UPDATE on `provider_budgets` (concurrent requests can't
  overshoot), then settled with actual units; every call is logged in `provider_usage` (estimated + actual units,
  outcome, refusals). Budget exhausted → 503 `X_BUDGET_EXHAUSTED`, no call made.

## Community rule: partner NFT ownership (`_shared/nft.ts`)

`CommunityEligibilityProvider` interface; the shipped provider is `nft_ownership`, which reads on-chain over the same
RPC config as the ETH check (no indexer):

- **ERC-721**: collection-wide `balanceOf(owner)`, or `ownerOf(id)` per configured token ID (a reverting `ownerOf`, i.e.
  burned/unminted, counts as not held).
- **ERC-1155**: `balanceOf(owner, id)` for each configured ID, summed against `min_quantity`.
- Every read is pinned to one block and `eth_chainId` must match the collection's chain, so ownership on the wrong
  chain never counts. Empty `eth_call` data → "No contract at this address on chain N".
- Rules: `any`, `all`, `min_n`. An unreadable collection that could change the answer → `unavailable`.
- Snapshot per evaluation in `nft_ownership_checks` (collection, contract, chain, standard, quantity, block, source
  `rpc`, result, policy version). Wallets can qualify through several collections. Registration-time only
  (`purpose = registration`; `mint` reserved for a separate mint-time re-check); a later transfer never revokes a
  registration.
- Used only in `community` / `hybrid` modes. **No partner collections are configured** and none may be invented.

## Access codes (`_shared/accessCodes.ts`)

`FLY-XXXXX-XXXXX-XXXXX-XXXXX` (100 random bits, look-alike-free base32), shown once, stored as SHA-256 of
`ACCESS_CODE_PEPPER` + code; admins see only a 9-char prefix. Optional expiry, max redemptions, revocation, campaign
scope, community attribution. Redemption is one statement: the code row is locked `FOR UPDATE`, every rule is
re-checked on the locked row, and the counter + redemption row are written together, so concurrent redemptions of a
1-use code give exactly one success. One redemption per wallet per campaign. Refusals get one generic message
(no probing) and the real reason in `access_code_audit`. If the registration insert then loses a race, the redemption
is released. A code is never proof of NFT ownership. Only consulted in `invite_code` / `hybrid` modes.

## Database schema

Migrations: `20261012000000_allowlist_registration.sql` (base), `20261013000000_flylist_eligibility.sql` (FLYLIST
Phase A), `20261014000000_flylist_verification.sql` (Phase B: policy history, verification tables).

| Table | Purpose |
|---|---|
| `allowlist.campaigns` | One row per campaign (`fwg-genesis`, "FLY WING GENESIS FLYLIST"). Status + window + access policy (above). |
| `allowlist.registrations` | One row per wallet per campaign. **Unique (`campaign_id`, `wallet_address_normalized`).** |
| `allowlist.eligibility_checks` | Server-side evaluations: result, policy copy, price/source/time, best chain + wei + cents, per-chain snapshots (`chains` jsonb: chainId, status, balanceWei, blockNumber, usdCents, passed, error), expiry (cache). |
| `allowlist.registration_audit` | Append-only history: who (wallet + role), what (`changes` jsonb from/to), when. |
| `allowlist.campaign_policies` | Append-only policy history (trigger-enforced): version, full snapshot, who, why. |
| `allowlist.x_verifications` | Per wallet: X auth `status`, verified `x_user_id`/`x_username`, `follow_status` + `follows`, `verified_until`, attempts, policy version. |
| `allowlist.x_oauth_states` | Pending OAuth/PKCE handshakes (state hash, verifier, wallet, expiry, single use). |
| `allowlist.provider_budgets` / `provider_usage` | Paid-API budget counters (daily + total) and the call ledger (estimated/actual units, outcome). |
| `allowlist.partner_collections` (+ `_audit`) | Community rule config: name, chain, contract, standard, min quantity, token IDs, active. Unique per (campaign, chain, contract). Empty. |
| `allowlist.nft_ownership_checks` | Ownership snapshots per evaluation (see above). |
| `allowlist.access_codes` / `access_code_redemptions` / `access_code_audit` | Hashed codes, redemptions (one per wallet per campaign), full event log. |
| `allowlist.auth_nonces` | Single-use SIWE nonces bound to wallet, chain, purpose, expiry. |
| `allowlist.sessions` | Bearer sessions; only SHA-256 of the token is stored. |
| `allowlist.rate_limits` | Fixed one-minute windows per bucket + salted hash of client IP. |

`registrations` key columns: wallet (`wallet_address` checksummed + `_normalized`), X (`twitter_username` +
`_normalized`, `twitter_verified` false, `twitter_user_id`/`_verified_at`/`_verification_method` empty),
`registration_status` (**registered / pending_verification / eligible / ineligible / approved / rejected**; the base
migration's `waitlisted` maps to `pending_verification`, `removed` to `rejected`), `eligibility_status`
(not_checked / pending / eligible / ineligible), `eligibility_checked_at`, `access_method`, the eligibility snapshot
(`eligibility_check_id`, `eth_balance_wei` numeric(78), `eth_usd_price` + `_decimals`, `eth_usd_price_source`,
`eth_usd_price_at`, `eth_balance_usd_cents`, `eligibility_chain_id`), SIWE proof metadata (`verification_chain_id`,
`verification_method`, `verification_timestamp`), `admin_notes`, timestamps. Phase B adds `policy_version`,
`verification_status` (not_required / pending / verified / failed), `nft_status`, `nft_check_id`, `access_code_id`,
`community_attribution`.

**jsonb parameters** are always sent as text and cast on the server (`$n::text::jsonb`). postgres.js (production)
JSON-encodes values bound to a jsonb parameter, so a pre-serialized string would otherwise be stored as a JSON
*string*. Phase A's `eligibility_checks.policy`/`chains` hit this; the Phase B migration unwraps any such rows.

**Not stored:** signatures, private keys, seed phrases, raw IP addresses, raw session tokens.

## Authentication flow (SIWE / EIP-4361)

1. `POST /auth/nonce {address, chainId, purpose}` → random 24-char nonce (10 min TTL) bound to that wallet, chain and
   purpose (`register` or `admin`; admin nonces only for `ADMIN_WALLETS`).
2. The browser builds the SIWE message (`domain = location.host`, `uri = location.origin`) and the wallet signs it
   (`personal_sign`). Free, no transaction.
3. `POST /auth/verify {message, signature}` → nonce exists/unused/unexpired; version 1; domain/URI match an allowed
   origin; chain allowed and equal to the nonce's; address equal to the nonce's; expected statement; sane times.
   Signature: ecrecover offline, then ERC-1271/ERC-6492 over RPC for smart wallets. Then the nonce is consumed
   **atomically**; a replay gets `NONCE_USED`.
4. 256-bit bearer token (2 h registrants, 1 h admins), SHA-256 stored; the browser keeps it in `sessionStorage` per
   wallet + purpose.

The wallet for registration and eligibility always comes from the verified session, **never from the request body**.
CSRF: no cookies; bearer header; JSON-only state changes (forces preflight); foreign `Origin` → 403.

## API (`/functions/v1/allowlist/...`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/campaign` | none | Name/status/isOpen + public requirements (min USD, chains, access mode, X required). No registrant data. |
| POST | `/auth/nonce` | none | Wallet challenge |
| POST | `/auth/verify` | none | Signature verification → session token |
| POST | `/auth/logout` | session | Revoke session |
| GET | `/me/registration` | session | Own registration (+ campaign). No admin notes, no snapshot internals. |
| POST | `/me/eligibility` | session | Own eligibility: `{walletAddress, registration, eligibility, verification}`. Registered → no check. Closed → 403. |
| GET | `/me/verification` | session | Own X verification + NFT status |
| POST | `/me/verification/x/start` | session | Begin X OAuth (returns `not_configured` today) |
| POST | `/me/verification/x/complete` | session | `{state, code}` OAuth callback; 409 `X_NOT_CONFIGURED` today |
| POST | `/me/registration` | session | `{twitterUsername, accessCode?}` → 201; 409 `ALREADY_REGISTERED`; 403 `INELIGIBLE` (with figures); 503 `ELIGIBILITY_UNAVAILABLE`; 403 `REGISTRATION_CLOSED` / `VERIFICATION_UNAVAILABLE` |
| PATCH | `/me/registration` | session | Correct own X username (while open) |
| GET | `/admin/stats` | admin | Totals, today, unique wallets, counts by status |
| GET | `/admin/registrations` | admin | `q`, `registrationStatus`, `eligibilityStatus`, `from`, `to`, `sort`, `dir`, `page`, `pageSize≤100` |
| PATCH | `/admin/registrations/:id` | admin | `{registrationStatus?, eligibilityStatus?, adminNotes?}` + audit row |
| GET | `/admin/registrations/:id/audit` | admin | History |
| GET | `/admin/export.csv` | admin | Full dataset CSV; same filters as the list, plus `preset` |
| GET / PATCH | `/admin/policy` | admin | Current policy, grouped view, integration state, history / `{expectedVersion, changes, reason}` |
| GET / POST | `/admin/collections` | admin | Partner collections / add one (audited) |
| PATCH | `/admin/collections/:id` | admin | Name, min quantity, token IDs, active (chain/contract/standard are immutable) |
| POST | `/admin/collections/test` | admin | Read-only ownership check of any wallet against the active collections |
| GET / POST | `/admin/access-codes` | admin | List (prefix only) / generate (plaintext returned once) |
| POST | `/admin/access-codes/:id/revoke` | admin | Revoke (audited) |
| GET | `/admin/usage` | admin | Paid-API budgets and the usage ledger |

There is no public endpoint that lists registrations or wallet→X pairs. Admin = admin-purpose SIWE session **and**
wallet currently in `ADMIN_WALLETS`, re-checked every request.

Rate limits (per client IP per minute): campaign 60, nonce 20, verify 20, me 60, eligibility 10, register/update 10,
verification 20, admin 300, export 10, admin collection test 10.

## CSV exports

Server-generated from the database (the source of truth; no live CSV file), UTF-8 with BOM, CRLF, every cell quoted,
oldest first, fetched in 2,000-row keyset batches (never limited to a page). Formula-injection protection: cells
starting with `=`, `+`, `-`, `@`, tab, CR, LF (or full-width `＝＋－＠`) get a leading `'`.

| `preset` | Rows | File |
|---|---|---|
| `all` (default) | everything matching the filters | `flylist-all-YYYY-MM-DD.csv` |
| `pending_verification` | status `pending_verification` | `flylist-pending-verification-…` |
| `eligible` | status `eligible` or `approved` | `flylist-eligible-approved-…` |
| `final` | status **`approved` only** (admin decision), and `verification_status` not_required/verified unless the policy's `finalExportIncludesUnverified` is on | `flylist-final-mint-allowlist-…` |

Pending or merely eligible wallets never appear in the final export.

Columns: `registration_id, campaign_id, wallet_address, twitter_username, twitter_url, twitter_verification`
(`unverified (self-reported)`), `registration_status, eligibility_status, access_method, registered_at_utc,
updated_at_utc, eligibility_checked_at_utc, eligibility_chain_id, eth_balance_wei, eth_balance_eth, eth_usd_price,
eth_usd_price_source, eth_usd_price_at_utc, balance_usd_at_registration, signin_chain_id, policy_version,
verification_status, x_auth_status, x_verified_user_id, x_follow_status, nft_holder_status, qualifying_collections,
access_code` (prefix + label, never the code), `community_attribution, approval_status, admin_notes`.
`twitter_verification` reads `verified via X (@handle)` only after a real X verification.

## Future mint integration (not built yet)

1. **Snapshots.** `allowlist.snapshots (id, campaign_id, phase, created_at, created_by, merkle_root, rules jsonb)` +
   `allowlist.snapshot_entries (snapshot_id, wallet_address, allowed_quantity, proof jsonb)`, built from **approved**
   wallets only, so later registry edits never change a published root.
2. **Merkle tree for `FWGAllowlist.sol`.** Leaf = `keccak256(abi.encodePacked(address wallet, uint256 allowedQuantity,
   uint8 phase))`, verified with OpenZeppelin `MerkleProof` (sorted pairs). **Not** `StandardMerkleTree`'s format.
   Publish via `setMerkleRoot(phase, root)`. No production root is generated until the contract interface and rules are final.
3. **Proof retrieval.** `GET /me/proof?phase=N` for the signed-in wallet only, never a bulk list.
4. **Mint phases** come from the contracts (`FWGMintController`), not this database.
