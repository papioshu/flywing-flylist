# Deployment — Supabase (API + DB) and Cloudflare Pages (static site)

**State as of 2026-10-18:**
- **API + DB: live.** Supabase project `dkhblphayvcjvblgjxac`. Migrations, secrets and function were deployed
  2026-10-15 (sections 1–3), and the production smoke test passed.
- **Site: Cloudflare Pages**, building from the public GitHub repo `papioshu/flywing-flylist` (branch `master`), for
  **chasingclouds.xyz** (Mint Site D044/D045). HostGator was dropped as the host on 2026-10-15. Sections 5b and 6 are
  kept only as a fallback.
- **Front door:** this FLYLIST page is what the domain serves for now. The full FLY WING website (`../website`) stays
  hidden until the owner flips the launch switch (section 8).

## 1. Supabase project

1. **Done 2026-10-14.** The FLY WING Supabase project is `https://dkhblphayvcjvblgjxac.supabase.co`, ref
   `dkhblphayvcjvblgjxac`, on the FLY WING account (separate from BMBSQD). Its publishable key is
   `sb_publishable_7YnoZqWgFrSyhJwoW9cTEQ_FirmqQN0`. That key is public by design, but this site doesn't use it,
   because the browser only talks to the Edge Function. This **one project is shared by the FLYLIST page and the
   future mint**. Never commit the secret key or the database password. They belong only in Supabase secrets or a
   git-ignored `.env`.
2. Apply **all three** migrations, in order. Pick one:
   - **Dashboard:** SQL Editor → paste `supabase/migrations/20261012000000_allowlist_registration.sql` → Run, then
     `20261013000000_flylist_eligibility.sql` → Run, then `20261014000000_flylist_verification.sql` → Run.
   - **CLI:** `npx supabase login` → `npx supabase link --project-ref dkhblphayvcjvblgjxac` → `npx supabase db push`.
3. Check that **Settings → API → Exposed schemas** does **not** include `allowlist` (the default is `public, graphql_public`).

> Free-tier projects pause after about a week without traffic, which would take registration offline. For a live
> campaign, either upgrade to Pro (also adds daily backups) or make sure the site gets regular traffic. Download a CSV
> export regularly either way.

## 2. Function secrets

```bash
npx supabase secrets set --project-ref dkhblphayvcjvblgjxac \
  ALLOWED_ORIGINS="https://chasingclouds.xyz,https://www.chasingclouds.xyz" \
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
| `PROVIDER_TIMEOUT_MS` | 8000 | Per RPC/price request (and per partner-NFT read). |
| `ENABLED_INTEGRATIONS` | *(empty)* | Deferred integrations explicitly switched on: `x_verification`, `community_gating`, `access_codes`. **Leave empty** until the owner approves one. Unknown names stop the function at startup. Listing one only allows the admin to select it; it still has to be chosen in the policy (and invite/community modes also need the D013 DB lock lifted by a migration). |
| `ACCESS_CODE_PEPPER` | `IP_HASH_SALT` | Secret mixed into access-code hashes (≥ 16 chars). Set it once and never change it, or existing codes stop working. |
| `NONCE_TTL_SECONDS` / `SESSION_TTL_SECONDS` / `ADMIN_SESSION_TTL_SECONDS` | 600 / 7200 / 3600 | |

`SUPABASE_DB_URL` is provided to Edge Functions automatically. **Never put the service-role key or DB URL in the site.**

## 3. Deploy the function

```bash
npx supabase functions deploy allowlist --project-ref dkhblphayvcjvblgjxac --no-verify-jwt --use-api
```

`--no-verify-jwt` is required: the function does its own wallet authentication (also set in `supabase/config.toml`).
`--use-api` bundles on Supabase's side so Docker isn't needed locally.

Smoke test (uses throwaway wallets):

```bash
curl -H "origin: https://chasingclouds.xyz" https://dkhblphayvcjvblgjxac.supabase.co/functions/v1/allowlist/campaign
API_URL=https://dkhblphayvcjvblgjxac.supabase.co/functions/v1/allowlist ORIGIN=https://chasingclouds.xyz npm run smoke
```

Against production, run it **without** `SMOKE_DB_URL`: it then checks auth, replay rejection and a LIVE eligibility
read from the deployed function (a fresh wallet must come back `ineligible`, priced by Chainlink, with both chains
read), and stops before registering anything. Never point `SMOKE_DB_URL` at production.

## 4. Build the site

1. Create a free WalletConnect/Reown project (no paid plan needed) at https://dashboard.reown.com
   (formerly cloud.reown.com): New project → type "AppKit" → copy the **Project ID**. Under the project's
   allowed domains add the production domain (and `http://localhost:5173` for local testing).
   The wallet picker needs it for the WalletConnect tile (QR on desktop, deep links into mobile wallets).
   The picker is exactly MetaMask, Coinbase Wallet, Rabby and WalletConnect (D042); there is no All Wallets list.
   Without the ID the other three tiles still work. (Wallet logos are bundled; none are fetched.)
2. `.env.production` is **tracked in git** (D045). It holds only the two public values, so the Cloudflare build picks
   them up without any dashboard variables:

   ```
   VITE_API_URL=https://dkhblphayvcjvblgjxac.supabase.co/functions/v1/allowlist
   VITE_WALLETCONNECT_PROJECT_ID=<reown project id>
   ```
   Never put a secret in a `VITE_` variable: everything in one ships in the browser bundle.
3. `npm run build`. This outputs `dist/`.
4. **Lockfile:** Cloudflare runs `npm ci` with npm 10 (Node 22, from `.nvmrc`). Whenever dependencies change,
   regenerate the lockfile with `npx npm@10 install` so npm 10 accepts it (the fix was `25f79f1`).

## 5. Cloudflare Pages (current host)

1. Workers & Pages → Create → Pages → Connect to Git → `papioshu/flywing-flylist`, production branch `master`.
2. Build settings:
   - framework **None** (or Vite);
   - build command `npm run build`;
   - output directory `dist`;
   - root `/`.

   Node comes from `.nvmrc` (22).
3. Every push to `master` builds and deploys. **Retry deployment** rebuilds the **same** commit, so to pick up a fix,
   push a new commit or use **Create deployment**.
4. Custom domains: add `chasingclouds.xyz` and `www.chasingclouds.xyz`. DNS is already on Cloudflare, so the records
   are created automatically.
5. Response headers come from `web/public/_headers`; `.htaccess` is ignored on Pages. Unknown paths, such as
   `/admin/allowlist`, fall back to `index.html` because there is no `404.html`.
6. The API only answers origins listed in `ALLOWED_ORIGINS`. The `*.pages.dev` preview URL is **not** listed, so the
   page loads there but its API calls get 403. Test on the real domain, or temporarily add the preview origin.

## 5b. (Fallback only) Domain: Cloudflare DNS in front of HostGator

1. Cloudflare: add `chasingclouds.xyz`, set Cloudflare's two nameservers at the registrar, wait for **Active**.
2. HostGator cPanel: add the domain (Addon Domain if the account already has a primary one); note its document root
   and the **Shared IP Address**.
3. Cloudflare DNS: `A @ -> <HostGator IP>` and `CNAME www -> chasingclouds.xyz`, both **DNS only (grey)** at first.
   (HostGator email only: add its MX/mail records, grey.)
4. cPanel → SSL/TLS Status → run AutoSSL until the domain and `www` have certificates. Then Cloudflare **SSL/TLS =
   Full (strict)**, then switch both records to **Proxied (orange)**. Never "Flexible": the `.htaccess` HTTPS redirect
   would loop. Turn **Rocket Loader off**.
5. The API is on Supabase, not behind Cloudflare, so the proxy doesn't affect the API's client-IP rate limiting.

## 6. (Fallback only) Upload to HostGator

1. cPanel → **SSL/TLS Status** → make sure AutoSSL has issued a certificate for the domain (and `www`).
2. cPanel → File Manager → `public_html/` (or the domain's document root). Turn on **Settings → Show Hidden Files**.
3. Upload **everything inside `dist/`**, including **`.htaccess`**. It redirects to HTTPS and routes
   `/admin/allowlist` to the app.
4. Once HTTPS works, uncomment the `Strict-Transport-Security` line in `.htaccess`.

## 7. Verify for real

- Open the site on desktop: confirm nothing opens on load or when the wallet connects. Click FLY LIST with a
  wallet holding ≥ $55 of ETH on Ethereum or Robinhood Chain, submit, reload, click FLY LIST again and confirm "Wallet
  already registered". Try a near-empty wallet and confirm "Not eligible yet" with sensible numbers.
- Wallets (owner brief: test before deploying). Desktop: MetaMask, Rabby and Coinbase Wallet extensions, plus
  WalletConnect QR from a phone. Phone: MetaMask tile in Safari/Chrome (deep link into MetaMask's browser),
  WalletConnect into another wallet app, and inside a wallet app's own browser. Switch accounts/wallets
  mid-flow, and re-open FLY LIST with a registered wallet ("Wallet already registered"). The automated
  versions are `npm run e2e:wallets`, `npm run e2e:ui` and `npm run e2e:mobile` (iPhone/WebKit + Android/Chromium
  layouts). They use mock wallets and emulated phones, so they don't replace real devices.
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
- **Change any rule** (balance minimum/chains, campaign status/window, X requirements, provisional mode, final-export
  policy, budgets): admin dashboard → **Campaign policy** tab. Every save is a new policy version with a reason in the
  history; past checks and registrations keep the version they were evaluated under. **Don't edit the campaign row with
  SQL**: that bypasses versioning and the safety checks.
- **Partner collections / access codes:** their own tabs. Neither does anything while the access mode is `open`.
- **Deferred integrations** (paid X verification, partner-NFT gating, invite codes): off. See
  `docs/COST ASSESSMENT.md` for what each needs and what could cost money. `access_mode` stays locked to `open` by a
  DB constraint (D013) until an approved migration lifts it.

## 8. Launch switch: FLYLIST → full website (planned, not built; owner decides when)

Today **chasingclouds.xyz serves this FLYLIST page**. The full site (`C:\Projectwork\FlyWingGenesis\website`: story,
gallery, Genesis Commitments, SQUAD, Phase II roadmap, mint status) is built through Stage 2 but **hidden**: it has no
remote, no Pages project, and `noindex`. There is no in-code flag. The switch is a hosting change, so this app, its
API and the registrations already in the database are untouched. Proposal: Website DECISIONS D009. Confirm with the
owner before doing any step.

1. Push `website` to its own GitHub repo, create a second Pages project for it, and review it on its `*.pages.dev`
   URL.
2. Give FLYLIST its own address, e.g. `flylist.chasingclouds.xyz`:
   - Add it as a custom domain on **this** Pages project.
   - Append its origin to `ALLOWED_ORIGINS`, keeping the old origins during the change. Sign-in checks the SIWE domain
     against this list (`_shared/siwe.ts`), so a missing origin breaks sign-in.
   - Add it to the Reown project's allowed domains.
3. In the website build:
   - set `VITE_FLYLIST_URL=https://flylist.chasingclouds.xyz/`;
   - remove `<meta name="robots" content="noindex">` from `index.html`.
4. Move the `chasingclouds.xyz` and `www` custom domains from this Pages project to the website project.
5. Run the live checks again:
   - the website loads;
   - APPLY 4 FLYLIST opens this page;
   - register and already-registered both work;
   - `/admin/allowlist` works;
   - `npm run export` works with `ORIGIN=<new FLYLIST origin>`.
6. Registrations are keyed by wallet in Supabase, so nothing moves or is lost. To roll back, move the domains back.
