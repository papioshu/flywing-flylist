# FLY WING GENESIS — Mint Site (Allowlist Registration MVP)

Landing page + self-service allowlist registration for FLY WING GENESIS.

Visitor flow: **Connect Wallet → enter X username → Join Allowlist → sign a free SIWE message → saved**. Returning
wallets see their existing status. Admins get `/admin/allowlist` with search, filters, sorting, pagination, status/notes
editing with an audit trail, and a full-dataset **CSV export**.

No gas, no transactions, no token approvals. This is independent of the mint contracts
(`C:\Projectwork\FlyWingGenesis`). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it will feed them later.

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

Open http://localhost:5173 and http://localhost:5173/admin/allowlist.

## Tests

```bash
npm test          # 36 API/unit tests against real Postgres (PGlite) with real wallet signatures
npm run typecheck
npm run build
```

End-to-end against the real Deno function and the production Postgres driver (postgres.js):

```bash
npm run pg:server -- 55433                                   # Postgres wire protocol (PGlite)
cd supabase/functions/allowlist && DB_POOL_MAX=1 \
  SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres \
  ALLOWED_ORIGINS=http://localhost:5173 IP_HASH_SALT=local-test-salt-123 ADMIN_WALLETS=<throwaway admin address> \
  deno run --config deno.json --allow-net --allow-env --allow-read --allow-sys index.ts
VITE_API_URL=http://127.0.0.1:8000/allowlist npx vite         # site
ADMIN_PRIVATE_KEY=<throwaway key> API_URL=http://127.0.0.1:8000/allowlist npm run smoke   # 21 HTTP checks
ADMIN_PRIVATE_KEY=<throwaway key> npm run e2e:ui                                          # 19 browser checks, desktop + iPhone
```

`DB_POOL_MAX=1` is only for the PGlite harness (one backend). Use throwaway keys only.

## Deploying

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
