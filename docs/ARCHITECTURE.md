# Architecture — FLY WING GENESIS FLYLIST Registration

## Components

```
Browser (HostGator static site)                Supabase
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

## The FLYLIST interaction (`web/src/components/FlylistApply.tsx`)

The page renders the gate card and nothing else wallet-related. **No wallet dialog, signature request or modal is
triggered by page load, wagmi's silent reconnect, or `accountsChanged`.** Only the APPLY 4 FLYLIST click starts a flow:

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

## Access policy (campaign row)

`allowlist.campaigns` holds the rules; each eligibility check stores a copy (`policy` jsonb), so later edits never
rewrite how a historical result was reached.

| Column | Current | Meaning |
|---|---|---|
| `access_mode` | `open` | `open` / `invite_code` / `community` / `hybrid`. **Only `open` is implemented**; a CHECK constraint (`campaigns_access_mode_implemented`) blocks the others until they are built. |
| `eth_balance_check_enabled` | true | The $55 check. Off → everyone passes with no RPC calls. |
| `min_eth_balance_usd_cents` | 5500 | |
| `eth_balance_chain_ids` | `{1,4663}` | Any one chain qualifies. |
| `x_follow_required` | false | Owner decision: X is not required for this campaign. |
| `allow_provisional_registration` | false | Only matters when something required can't be verified yet. |

Status decision (`decideStatus`): if X follow is required and not verifiable (always, today), the applicant is refused
(`VERIFICATION_UNAVAILABLE`) unless provisional registration is allowed, in which case they're recorded as
`pending_verification` / eligibility `pending`. Otherwise a passing wallet is `eligible`. Nothing ever marks an X handle
verified or claims a follow.

Deferred (Phase B/C, not built): X OAuth + follow provider, NFT ownership provider + partner collections, invite codes,
admin policy UI, API budgets. See the vault spec (`Mint Site/FLYLIST SPEC.md`).

## Database schema

Migrations: `20261012000000_allowlist_registration.sql` (base), `20261013000000_flylist_eligibility.sql` (FLYLIST).

| Table | Purpose |
|---|---|
| `allowlist.campaigns` | One row per campaign (`fwg-genesis`, "FLY WING GENESIS FLYLIST"). Status + window + access policy (above). |
| `allowlist.registrations` | One row per wallet per campaign. **Unique (`campaign_id`, `wallet_address_normalized`).** |
| `allowlist.eligibility_checks` | Server-side evaluations: result, policy copy, price/source/time, best chain + wei + cents, per-chain snapshots (`chains` jsonb: chainId, status, balanceWei, blockNumber, usdCents, passed, error), expiry (cache). |
| `allowlist.registration_audit` | Append-only history: who (wallet + role), what (`changes` jsonb from/to), when. |
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
`verification_method`, `verification_timestamp`), `admin_notes`, timestamps.

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
| POST | `/me/eligibility` | session | Own eligibility: `{walletAddress, registration, eligibility}`. Registered → no check. Closed → 403. |
| POST | `/me/registration` | session | `{twitterUsername}` → 201; 409 `ALREADY_REGISTERED`; 403 `INELIGIBLE` (with figures); 503 `ELIGIBILITY_UNAVAILABLE`; 403 `REGISTRATION_CLOSED` / `VERIFICATION_UNAVAILABLE` |
| PATCH | `/me/registration` | session | Correct own X username (while open) |
| GET | `/admin/stats` | admin | Totals, today, unique wallets, counts by status |
| GET | `/admin/registrations` | admin | `q`, `registrationStatus`, `eligibilityStatus`, `from`, `to`, `sort`, `dir`, `page`, `pageSize≤100` |
| PATCH | `/admin/registrations/:id` | admin | `{registrationStatus?, eligibilityStatus?, adminNotes?}` + audit row |
| GET | `/admin/registrations/:id/audit` | admin | History |
| GET | `/admin/export.csv` | admin | Full dataset CSV; same filters as the list, plus `preset` |

There is no public endpoint that lists registrations or wallet→X pairs. Admin = admin-purpose SIWE session **and**
wallet currently in `ADMIN_WALLETS`, re-checked every request.

Rate limits (per client IP per minute): campaign 60, nonce 20, verify 20, me 60, eligibility 10, register/update 10,
admin 300, export 10.

## CSV exports

Server-generated from the database (the source of truth; no live CSV file), UTF-8 with BOM, CRLF, every cell quoted,
oldest first, fetched in 2,000-row keyset batches (never limited to a page). Formula-injection protection: cells
starting with `=`, `+`, `-`, `@`, tab, CR, LF (or full-width `＝＋－＠`) get a leading `'`.

| `preset` | Rows | File |
|---|---|---|
| `all` (default) | everything matching the filters | `flylist-all-YYYY-MM-DD.csv` |
| `pending_verification` | status `pending_verification` | `flylist-pending-verification-…` |
| `eligible` | status `eligible` or `approved` | `flylist-eligible-approved-…` |
| `final` | status **`approved` only** (admin decision) | `flylist-final-mint-allowlist-…` |

Pending or merely eligible wallets never appear in the final export.

Columns: `registration_id, campaign_id, wallet_address, twitter_username, twitter_url, twitter_verification`
(`unverified (self-reported)`), `registration_status, eligibility_status, access_method, registered_at_utc,
updated_at_utc, eligibility_checked_at_utc, eligibility_chain_id, eth_balance_wei, eth_balance_eth, eth_usd_price,
eth_usd_price_source, eth_usd_price_at_utc, balance_usd_at_registration, signin_chain_id, admin_notes`.

## Future mint integration (not built yet)

1. **Snapshots.** `allowlist.snapshots (id, campaign_id, phase, created_at, created_by, merkle_root, rules jsonb)` +
   `allowlist.snapshot_entries (snapshot_id, wallet_address, allowed_quantity, proof jsonb)`, built from **approved**
   wallets only, so later registry edits never change a published root.
2. **Merkle tree for `FWGAllowlist.sol`.** Leaf = `keccak256(abi.encodePacked(address wallet, uint256 allowedQuantity,
   uint8 phase))`, verified with OpenZeppelin `MerkleProof` (sorted pairs). **Not** `StandardMerkleTree`'s format.
   Publish via `setMerkleRoot(phase, root)`. No production root is generated until the contract interface and rules are final.
3. **Proof retrieval.** `GET /me/proof?phase=N` for the signed-in wallet only, never a bulk list.
4. **Mint phases** come from the contracts (`FWGMintController`), not this database.
