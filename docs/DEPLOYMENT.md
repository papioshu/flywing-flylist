# Deployment — Supabase (API + DB) and HostGator (static site)

Nothing here has been deployed yet (as of 2026-10-13). You need: the new FLY WING Supabase account, the domain on HostGator, and the
admin wallet address(es).

## 1. Supabase project

1. Sign in to https://supabase.com with the FLY WING Google account and create a project (e.g. `flywing`). Save the
   database password. Note the **project ref** (the `xxxx` in `https://xxxx.supabase.co`).
2. Apply **both** migrations, in order. Pick one:
   - **Dashboard:** SQL Editor → paste `supabase/migrations/20261012000000_allowlist_registration.sql` → Run, then
     `supabase/migrations/20261013000000_flylist_eligibility.sql` → Run.
   - **CLI:** `npx supabase login` → `npx supabase link --project-ref <ref>` → `npx supabase db push`.
3. Check that **Settings → API → Exposed schemas** does **not** include `allowlist` (the default is `public, graphql_public`).

> Free-tier projects pause after about a week without traffic, which would take registration offline. For a live
> campaign, either upgrade to Pro (also adds daily backups) or make sure the site gets regular traffic. Download a CSV
> export regularly either way.

## 2. Function secrets

```bash
npx supabase secrets set --project-ref <ref> \
  ALLOWED_ORIGINS="https://<your-domain>,https://www.<your-domain>" \
  ADMIN_WALLETS="0xAdminWallet1,0xAdminWallet2" \
  IP_HASH_SALT="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
```

Optional:

| Secret | Default | Notes |
|---|---|---|
| `ALLOWED_CHAIN_IDS` | `1,8453,42161,10,137,4663,46630` | Chains a wallet may sign on. Must match `web/src/lib/wagmi.ts`. |
| `RPC_URLS` | viem public RPCs | `8453=https://...,1=https://...`. Only used for smart-contract-wallet signatures. Use a paid RPC (Alchemy etc.) if you see failures. |
| `CAMPAIGN_ID` | `fwg-genesis` | |
| `RPC_URLS` (eligibility) | `1=https://ethereum-rpc.publicnode.com`, `4663=https://rpc.mainnet.chain.robinhood.com` | The same `RPC_URLS` secret also overrides the RPCs used for the $55 balance check and the Chainlink read. The defaults are free public endpoints and are rate-limited; Robinhood's own docs say not to rely on its public RPC for production. At campaign scale set provider URLs (e.g. Alchemy/QuickNode free tiers). |
| `PRICE_MAX_AGE_SECONDS` | 4500 | Reject a Chainlink ETH/USD answer older than this (feed heartbeat is 3600 s), then fall back to Coinbase spot. |
| `CHAINLINK_ETH_USD_FEED` | `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` | Ethereum mainnet ETH/USD (resolves from `eth-usd.data.eth`). |
| `ELIGIBILITY_CACHE_SECONDS` | 300 | How long an eligible/ineligible result is reused per wallet. |
| `ELIGIBILITY_CHECKS_PER_WALLET` | 10 | Fresh checks per wallet per 10 minutes. |
| `PROVIDER_TIMEOUT_MS` | 8000 | Per RPC/price request. |
| `NONCE_TTL_SECONDS` / `SESSION_TTL_SECONDS` / `ADMIN_SESSION_TTL_SECONDS` | 600 / 7200 / 3600 | |

`SUPABASE_DB_URL` is provided to Edge Functions automatically. **Never put the service-role key or DB URL in the site.**

## 3. Deploy the function

```bash
npx supabase functions deploy allowlist --project-ref <ref> --no-verify-jwt --use-api
```

`--no-verify-jwt` is required: the function does its own wallet authentication (also set in `supabase/config.toml`).
`--use-api` bundles on Supabase's side so Docker isn't needed locally.

Smoke test (uses throwaway wallets):

```bash
curl -H "origin: https://<your-domain>" https://<ref>.supabase.co/functions/v1/allowlist/campaign
API_URL=https://<ref>.supabase.co/functions/v1/allowlist ORIGIN=https://<your-domain> npm run smoke
```

Against production, run it **without** `SMOKE_DB_URL`: it then checks auth, replay rejection and a LIVE eligibility
read from the deployed function (a fresh wallet must come back `ineligible`, priced by Chainlink, with both chains
read), and stops before registering anything. Never point `SMOKE_DB_URL` at production.

## 4. Build the site

1. (Recommended, for phones without a wallet browser) create a free WalletConnect/Reown project at
   https://cloud.reown.com and add your domain to its allowed domains.
2. Create `.env.production`:

   ```
   VITE_API_URL=https://<ref>.supabase.co/functions/v1/allowlist
   VITE_WALLETCONNECT_PROJECT_ID=<reown project id>
   ```
3. `npm run build`. This outputs `dist/`.

## 5. Upload to HostGator

1. cPanel → **SSL/TLS Status** → make sure AutoSSL has issued a certificate for the domain (and `www`).
2. cPanel → File Manager → `public_html/` (or the domain's document root). Turn on **Settings → Show Hidden Files**.
3. Upload **everything inside `dist/`**, including **`.htaccess`**. It redirects to HTTPS and routes
   `/admin/allowlist` to the app.
4. Once HTTPS works, uncomment the `Strict-Transport-Security` line in `.htaccess`.

## 6. Verify for real

- Open the site on desktop: confirm nothing opens on load or when the wallet connects. Click APPLY 4 FLYLIST with a
  wallet holding ≥ $55 of ETH on Ethereum or Robinhood Chain, submit, reload, click APPLY again and confirm "Wallet
  already registered". Try a near-empty wallet and confirm "Not eligible yet" with sensible numbers.
- Open it on a phone, inside the wallet app's browser and via WalletConnect.
- `/admin/allowlist`: sign in with an admin wallet, edit a status, Export CSV, and open the file in Excel or Google Sheets.
- After the first real traffic, check that rate limiting sees real client IPs: in the SQL editor,
  `select bucket, count(distinct key) from allowlist.rate_limits group by 1;` should show many keys, not one.
  If it shows one, every visitor shares a limit and the IP header handling in `clientIp()` needs adjusting.

## Operating

- **Close registration:** `update allowlist.campaigns set status = 'closed' where id = 'fwg-genesis';`
  (or set `closes_at`). Registered wallets can still check their status.
- **Add/remove admins:** update the `ADMIN_WALLETS` secret. Removal takes effect on the admin's next request.
- **Remove a registrant on request:** set status `rejected` with a note, or delete the row (its audit rows cascade).
- **Approve for the mint list:** set status `approved` in the dashboard. Only `approved` rows go in the
  "Final mint allowlist" export.
- **Change the balance rule:** `update allowlist.campaigns set min_eth_balance_usd_cents = 5500, eth_balance_chain_ids = '{1,4663}', policy_updated_at = now() where id = 'fwg-genesis';`
  Turn it off with `eth_balance_check_enabled = false`. Past registrations keep the rules they were checked under.
- **X / NFT / invite gating:** not built. `access_mode` is locked to `open` by a constraint; `x_follow_required` must
  stay false until a real X verification provider exists (true without `allow_provisional_registration` blocks all
  new registrations).
