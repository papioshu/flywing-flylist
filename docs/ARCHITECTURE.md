# Architecture — FLY WING GENESIS Allowlist Registration

## Components

```
Browser (HostGator static site)                Supabase
┌──────────────────────────────┐   HTTPS   ┌─────────────────────────────┐   SQL   ┌──────────────────────┐
│ Vite + React + wagmi/viem    │ ────────▶ │ Edge Function "allowlist"   │ ──────▶ │ Postgres, private    │
│ "/" boarding-pass register   │  Bearer   │ (Deno) _shared/app.ts       │ postgres│ schema "allowlist"   │
│ "/admin/allowlist" dashboard │  token    │ SIWE verify, sessions, CSV  │   .js   │ (not exposed by API) │
└──────────────────────────────┘           └─────────────────────────────┘         └──────────────────────┘
```

- The browser never talks to the database. There is no Supabase client or anon key in the front end.
- The `allowlist` schema is not in Supabase's exposed schemas, RLS is on with no policies, and `anon`/`authenticated` are revoked. The function connects with `SUPABASE_DB_URL` (owner role).
- `_shared/app.ts` is a runtime-agnostic `(Request) => Response` handler. It is the same code in Deno (production), the Node dev server, and the tests.

## Database schema (`supabase/migrations/20261012000000_allowlist_registration.sql`)

| Table | Purpose |
|---|---|
| `allowlist.campaigns` | One row per campaign (`fwg-genesis` seeded). `status` draft/open/closed + optional `opens_at`/`closes_at`. |
| `allowlist.registrations` | One row per wallet per campaign. **Unique (`campaign_id`, `wallet_address_normalized`).** |
| `allowlist.registration_audit` | Append-only history: who (wallet + role), what (`changes` jsonb from/to), when. |
| `allowlist.auth_nonces` | Single-use SIWE nonces bound to wallet, chain, purpose, expiry. |
| `allowlist.sessions` | Bearer sessions; only SHA-256 of the token is stored. |
| `allowlist.rate_limits` | Fixed one-minute windows per bucket + salted-hash of client IP. |

`registrations` columns: `id`, `campaign_id`, `wallet_address` (EIP-55 checksummed), `wallet_address_normalized` (lowercase),
`twitter_username` (as typed, no `@`), `twitter_username_normalized` (lowercase), `twitter_verified` (default false),
`twitter_user_id` / `twitter_verified_at` / `twitter_verification_method` (empty until X verification exists),
`registration_status` (registered/approved/waitlisted/rejected/removed), `registered_at`, `updated_at`,
`verification_chain_id`, `verification_method` (`siwe_eip4361`), `verification_timestamp`,
`eligibility_status` (not_checked/eligible/ineligible), `eligibility_checked_at`, `admin_notes` (≤2000 chars).

Check constraints enforce address/handle formats, lowercase consistency, enum values, and that
`twitter_verified = true` requires `twitter_user_id` and `twitter_verified_at`.

**Not stored:** signatures, private keys, seed phrases, raw IP addresses, raw session tokens.

## Authentication flow (SIWE / EIP-4361)

1. `POST /auth/nonce {address, chainId, purpose}` → server stores a random 24-char nonce (10 min TTL) bound to that
   wallet, chain and purpose (`register` or `admin`; admin nonces are only issued to `ADMIN_WALLETS`). Returns nonce,
   issuedAt, expirationTime and the exact statement text.
2. The browser builds the SIWE message with `domain = window.location.host`, `uri = window.location.origin`, and the
   wallet signs it (`personal_sign`). This is free and sends no transaction.
3. `POST /auth/verify {message, signature}` → server checks: nonce exists, unused, unexpired; message version 1;
   domain matches an `ALLOWED_ORIGINS` host and URI matches that origin; chain is allowed and equals the nonce's chain;
   address equals the nonce's address; statement is the expected one for the purpose; issuedAt/expirationTime/notBefore
   are sane and inside the nonce's window. Then it verifies the signature: ecrecover offline first, then an on-chain
   ERC-1271/ERC-6492 check over RPC for smart-contract wallets (e.g. Coinbase/Base Smart Wallet). Only then is the
   nonce consumed **atomically** (`update … where used_at is null … returning`). A replay gets `NONCE_USED`.
4. Server issues a 256-bit random bearer token (2 h for registrants, 1 h for admins) and stores its SHA-256.
   The browser keeps it in `sessionStorage` (per wallet, per purpose).

The wallet used for a registration always comes from the verified session, **never from the request body**.

CSRF: no cookies are used. Auth is an `Authorization: Bearer` header, state-changing endpoints require
`Content-Type: application/json` (forces a CORS preflight), and requests with an `Origin` outside `ALLOWED_ORIGINS`
are rejected with 403.

## API (`/functions/v1/allowlist/...`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/campaign` | none | Campaign name/status/isOpen (no counts, no registrant data) |
| POST | `/auth/nonce` | none | Wallet challenge |
| POST | `/auth/verify` | none | Signature verification → session token |
| POST | `/auth/logout` | session | Revoke session |
| GET | `/me/registration` | session | Own registration status (no admin notes, no eligibility) |
| POST | `/me/registration` | session | Register `{twitterUsername}` → 201, or 409 `ALREADY_REGISTERED` with existing record, or 403 `REGISTRATION_CLOSED` |
| PATCH | `/me/registration` | session | Update own X username (while open) |
| GET | `/admin/stats` | admin | Totals, today (UTC), unique wallets, counts by status |
| GET | `/admin/registrations` | admin | `q`, `registrationStatus`, `eligibilityStatus`, `from`, `to` (UTC dates, inclusive), `sort`, `dir`, `page`, `pageSize≤100` |
| PATCH | `/admin/registrations/:id` | admin | `{registrationStatus?, eligibilityStatus?, adminNotes?}` + audit row, in one SQL statement |
| GET | `/admin/registrations/:id/audit` | admin | History |
| GET | `/admin/export.csv` | admin | Full matching dataset as CSV (same filters as the list) |

Admin = session created through an **admin** SIWE sign-in **and** wallet currently in `ADMIN_WALLETS`. This is re-checked
on every request, so removing a wallet from the secret revokes access immediately.

Rate limits (per client IP per minute): campaign 60, nonce 20, verify 20, me 60, register/update 10, admin 300, export 10.

## Admin route

`/admin/allowlist`: connect an admin wallet, then **Sign in**, then the dashboard. Stats cards, search (wallet or X
handle), status/eligibility/date filters, sortable columns, 25 per page, a row drawer to edit status, eligibility and
private notes with history, and a prominent **Export CSV** button that exports everything matching the current filters.
A "×N" tag flags X handles registered by more than one wallet (handles are self-reported, so this is a review hint,
not a block).

## CSV format

`flywing-allowlist-YYYY-MM-DD.csv` (UTC date), UTF-8 with BOM, CRLF, header row, every cell quoted, oldest first
(`registered_at`, then `id`), fetched in 2,000-row keyset batches so it is never limited to a page.

| Column | Meaning |
|---|---|
| registration_id | Internal UUID |
| campaign_id | e.g. `fwg-genesis` |
| wallet_address | Full checksummed address |
| twitter_username | Normalized (lowercase) handle |
| twitter_url | `https://x.com/<handle>` |
| twitter_verified | `true`/`false` (always `false` in the MVP: handles are self-reported) |
| registration_status | registered / approved / waitlisted / rejected / removed |
| eligibility_status | not_checked / eligible / ineligible |
| registered_at_utc | ISO 8601 UTC, e.g. `2026-10-12T21:04:05.123Z` |
| updated_at_utc | ISO 8601 UTC |
| verification_chain_id | Chain the wallet signed on |
| admin_notes | Private notes |

Formula-injection protection: any cell starting with `=`, `+`, `-`, `@`, tab, CR or LF (or full-width `＝＋－＠`)
is prefixed with `'`.

## Future mint integration (not built yet)

The registration data is deliberately contract-agnostic. Planned integration points:

1. **Holdings-based eligibility.** A server job reads `registrations`, checks on-chain holdings (e.g. BOMBSQUAD
   collections), and writes `eligibility_status` + `eligibility_checked_at` (+ audit rows with `actor_role = 'system'`).
2. **Snapshots.** New table `allowlist.snapshots (id, campaign_id, phase, created_at, created_by, merkle_root, rules jsonb)`
   + `allowlist.snapshot_entries (snapshot_id, wallet_address, allowed_quantity, proof jsonb)`. A snapshot freezes
   "approved and eligible" wallets at a point in time, so later registry edits never change a published root.
3. **Per-wallet allowances.** `allowed_quantity` lives on snapshot entries (not registrations), set by phase rules.
4. **Merkle tree for `FWGAllowlist.sol`.** The contract's leaf is
   `keccak256(abi.encodePacked(address wallet, uint256 allowedQuantity, uint8 phase))` and it verifies with
   OpenZeppelin `MerkleProof.verifyCalldata` (sorted-pair hashing). **This is not OpenZeppelin `StandardMerkleTree`'s
   format** (that double-hashes `abi.encode`); the generator must hash leaves exactly as above with viem
   `keccak256(encodePacked(['address','uint256','uint8'], [...]))` and build a sorted-pair tree. Publish the root
   via `setMerkleRoot(phase, root)` (CONFIG_ROLE).
5. **Proof retrieval.** A new session-authenticated endpoint `GET /me/proof?phase=N` returns
   `{allowedQuantity, proof}` from the published snapshot for the signed-in wallet only, never a bulk list.
6. **Mint phases** come from the contracts (`FWGMintController`), not this database.

Registration never implies eligibility: nothing here makes a wallet mint-eligible until an admin/job approves it
and it is included in a published snapshot.
