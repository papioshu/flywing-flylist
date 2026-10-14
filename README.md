# FLY WING GENESIS — Mint Site (FLYLIST registration)

Landing page + self-service **FLYLIST** (allowlist) registration for FLY WING GENESIS.

This repo is **only** the public FLYLIST landing page and its registration backend. The full FLY WING website
(RichFox's wireframe: story, gallery, Genesis Commitments, SQUAD, Phase 2) is a separate build in its own repo and is
not front-facing yet. The landing page is skinned with RichFox's art (cloud landing graphic, FLY WING logo + bird mark,
ChasingClouds brush type, red / black / white): see [docs/ASSETS.md](docs/ASSETS.md).

Nothing happens on page load or when a wallet connects. The only entry point is **APPLY 4 FLYLIST**:
connect (if needed) → sign a free SIWE message → server verifies → registration lookup (already registered? show a
compact status) → server-side eligibility check (**≥ $55 of native ETH on Ethereum OR Robinhood Chain**, each chain on
its own) → modal with the read-only verified **wallet address** and an **X username** field → **SUBMIT TO FLYLIST**.

Admins get `/admin/allowlist`: search, filters, sorting, pagination, status/notes editing with an audit trail, the
eligibility snapshot per registration (wei, ETH/USD price + source, USD value, chain), and server-generated **CSV
exports** (all / pending verification / eligible + approved / final mint allowlist = approved only).

No gas, no transactions, no token approvals; balances are only read. Free data sources only (public RPCs, Chainlink
read over RPC, Coinbase public spot as fallback).

**Phase B (verification architecture) is built but switched off:** a versioned campaign policy (admin **Campaign
policy** tab), an X verification provider interface with budget/cooldown/rate-limit controls (only the
`not_configured` provider ships, so nothing paid can run), on-chain partner-NFT ownership checks (ERC-721/1155, no
indexer, no collections configured), and hashed access codes. X follow / NFT holder / invite-code gating are **not**
active; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) § Campaign policy and
[docs/COST ASSESSMENT.md](<docs/COST ASSESSMENT.md>). Independent of the mint contracts
(`C:\Projectwork\FlyWingGenesis`).

| Part | Where | Runs on |
|---|---|---|
| Static site (Vite + React + wagmi/viem) | `web/` → `dist/` | HostGator (any static host) |
| API (one Edge Function) | `supabase/functions/allowlist/` + `_shared/` | Supabase Edge Functions (Deno) |
| Database (private `allowlist` schema) | `supabase/migrations/` | Supabase Postgres |

## Local development

```bash
npm install
cp .env.example .env            # set ADMIN_WALLETS to your wallet; VITE_API_URL=http://localhost:8787/allowlist
npm run dev                     # API on :8787 (PGlite, persisted in .data/pglite) + site on :5173
```

Open http://localhost:5173 and http://localhost:5173/admin/allowlist. The dev API reads **live** balances and prices.
To test without real ETH, start the API with `DEV_FAKE_CHAIN=1` (every wallet holds 1 ETH on Ethereum; set balances
via `POST http://127.0.0.1:8788/balance {wallet, chainId, wei}`). The Edge Function never loads the fake chain.

## Tests

```bash
npm test          # 94 API/unit tests (incl. landing supply facts vs the Nimbus config): real Postgres (PGlite), real wallet signatures, fake network at the fetch boundary
npm run typecheck
npm run build
npx tsx scripts/live-eligibility.ts [wallet]   # one live, read-only check against the real free endpoints
npx tsx scripts/live-nft.ts                    # live, read-only ERC-721 ownership read on mainnet (BAYC, sanity only)
npx tsx scripts/derive-assets.ts               # regenerate web art/logo/favicon from assets-src/richfox/ originals
```

End-to-end against the real Deno function and the production Postgres driver (postgres.js). Deno can be run with
`npx --yes deno` if it isn't installed:

```bash
npm run pg:server -- 55433                                   # Postgres wire protocol (PGlite)
cd supabase/functions/allowlist && DB_POOL_MAX=1 \
  SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres \
  ALLOWED_ORIGINS=http://localhost:5173 IP_HASH_SALT=local-test-salt-123 ADMIN_WALLETS=<throwaway admin address> \
  npx --yes deno run --config deno.json --allow-net --allow-env --allow-read --allow-sys index.ts
# 47 HTTP checks; live eligibility from the Deno runtime. SMOKE_DB_URL (LOCAL ONLY) unlocks the registration part.
SMOKE_DB_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres ADMIN_PRIVATE_KEY=<throwaway key> \
  API_URL=http://127.0.0.1:8000/allowlist npm run smoke
```

Browser e2e (55 checks, desktop + iPhone 13, incl. the admin policy/collections/codes/usage tabs) against the dev API with the fake chain:

```bash
DEV_FAKE_CHAIN=1 ADMIN_WALLETS=<throwaway admin address> npm run dev:api
VITE_API_URL=http://localhost:8787/allowlist npx vite
ADMIN_PRIVATE_KEY=<throwaway key> npm run e2e:ui            # screenshots in .data/ui-e2e/
```

The dev server sees every request as one IP, so back-to-back e2e runs can hit the per-IP rate limits; wait a minute
between runs. `DB_POOL_MAX=1` is only for the PGlite harness. Use throwaway keys only.

## Deploying

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
