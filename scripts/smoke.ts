// End-to-end smoke test against a RUNNING API over HTTP (local Deno function or
// the deployed Supabase function). Uses throwaway wallets; never real keys.
//
//   API_URL=http://127.0.0.1:8000/allowlist ORIGIN=http://localhost:5173 \
//   ADMIN_PRIVATE_KEY=0x... npx tsx scripts/smoke.ts
//
// ADMIN_PRIVATE_KEY must belong to a wallet listed in the server's ADMIN_WALLETS.
// Only use a throwaway key generated for testing.
//
// The eligibility check runs LIVE (real mainnet + Robinhood Chain RPCs, Chainlink, Coinbase):
// fresh throwaway wallets hold no ETH, so they must come back ineligible. To exercise the
// registration path locally, set SMOKE_DB_URL to the LOCAL test database: the script turns
// the campaign's balance check off for that part and restores it afterwards. Never point
// SMOKE_DB_URL at production.
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import postgres from "postgres";

const dbUrl = process.env.SMOKE_DB_URL;
const API = process.env.API_URL ?? "http://127.0.0.1:8000/allowlist";
const ORIGIN = process.env.ORIGIN ?? "http://localhost:5173";
const adminKey = process.env.ADMIN_PRIVATE_KEY as `0x${string}` | undefined;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // CSV or empty
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function challenge(account: PrivateKeyAccount, purpose: "register" | "admin", chainId = 8453) {
  const n = await call("POST", "/auth/nonce", { address: account.address, chainId, purpose });
  if (n.status !== 200) throw new Error(`nonce ${n.status} ${n.text}`);
  const message = createSiweMessage({
    domain: new URL(ORIGIN).host,
    uri: ORIGIN,
    address: account.address,
    chainId,
    nonce: n.json.nonce,
    version: "1",
    statement: n.json.statement,
    issuedAt: new Date(n.json.issuedAt),
    expirationTime: new Date(n.json.expirationTime),
  });
  return { message, signature: await account.signMessage({ message }) };
}

const user = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

const campaign = await call("GET", "/campaign");
check("GET /campaign", campaign.status === 200 && campaign.json.campaign.id, campaign.json);

const c1 = await challenge(user, "register");
const v1 = await call("POST", "/auth/verify", c1);
check("verify valid signature", v1.status === 200 && !!v1.json.token, v1.json);
const token = v1.json?.token as string;

check("replayed signature rejected", (await call("POST", "/auth/verify", c1)).status === 401);
const forged = await challenge(user, "register");
forged.signature = await stranger.signMessage({ message: forged.message });
check("signature from another wallet rejected", (await call("POST", "/auth/verify", forged)).status === 401);

check("register without session -> 401", (await call("POST", "/me/registration", { twitterUsername: "x" })).status === 401);
check("invalid handle -> 400", (await call("POST", "/me/registration", { twitterUsername: "bad-handle!" }, token)).status === 400);

// LIVE eligibility from the function's own runtime: an empty wallet must be ineligible, priced by Chainlink.
const el = await call("POST", "/me/eligibility", {}, token);
check("live eligibility: empty wallet -> ineligible", el.status === 200 && el.json?.eligibility?.result === "ineligible", el.json);
check("live eligibility: priced by Chainlink", el.json?.eligibility?.priceSource === "chainlink", el.json?.eligibility);
check(
  "live eligibility: read Ethereum + Robinhood Chain",
  JSON.stringify(el.json?.eligibility?.chains?.map((c: any) => [c.chainId, c.status])) === JSON.stringify([[1, "ok"], [4663, "ok"]]),
  el.json?.eligibility?.chains,
);
console.log(`      ETH/USD ${el.json?.eligibility?.ethUsdPrice} (${el.json?.eligibility?.priceSource}, ${el.json?.eligibility?.priceAt})`);
const refused = await call("POST", "/me/registration", { twitterUsername: "@Smoke_Test" }, token);
check("ineligible wallet cannot register -> 403 INELIGIBLE", refused.status === 403 && refused.json?.error?.code === "INELIGIBLE", refused.json);

if (!dbUrl) {
  console.log("SKIP  registration path (set SMOKE_DB_URL to the local test DB to run it)");
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
}
const sql = postgres(dbUrl, { max: 1 });
await sql`update allowlist.campaigns set eth_balance_check_enabled = false`;
await sql`delete from allowlist.eligibility_checks where wallet_address_normalized = ${user.address.toLowerCase()}`;

const reg = await call("POST", "/me/registration", { twitterUsername: "@Smoke_Test" }, token);
check("register -> 201", reg.status === 201 && reg.json.registration.twitterUsername === "Smoke_Test", reg.json);
const dup = await call("POST", "/me/registration", { twitterUsername: "other" }, token);
check("duplicate -> 409 ALREADY_REGISTERED", dup.status === 409 && dup.json.error.code === "ALREADY_REGISTERED", dup.json);
const me = await call("GET", "/me/registration", undefined, token);
check("status lookup", me.json?.registration?.registrationStatus === "eligible", me.json);
const upd = await call("PATCH", "/me/registration", { twitterUsername: "Smoke_Renamed" }, token);
check("username update", upd.status === 200 && upd.json.registration.twitterUsername === "Smoke_Renamed", upd.json);
check("non-admin blocked from admin API", (await call("GET", "/admin/registrations", undefined, token)).status === 403);
check("anonymous blocked from export", (await call("GET", "/admin/export.csv")).status === 401);
check("anonymous blocked from final export", (await call("GET", "/admin/export.csv?preset=final")).status === 401);

// Parallel submissions over the real driver: exactly one row.
const racer = privateKeyToAccount(generatePrivateKey());
const rv = await call("POST", "/auth/verify", await challenge(racer, "register"));
const rt = rv.json?.token as string;
const race = await Promise.all(Array.from({ length: 8 }, (_, i) => call("POST", "/me/registration", { twitterUsername: `racer${i}` }, rt)));
// Losers get 409 (already registered) or 429 (the per-IP register limit, 10/min, which this script also exercises).
check(
  "8 parallel submissions -> exactly one 201, rest 409/429",
  race.filter((r) => r.status === 201).length === 1 && race.every((r) => [201, 409, 429].includes(r.status)),
  race.map((r) => r.status),
);
const rows = await sql`select count(*)::int as n from allowlist.registrations where wallet_address_normalized = ${racer.address.toLowerCase()}`;
check("database holds exactly one row for the raced wallet", rows[0].n === 1, rows);

if (adminKey) {
  const admin = privateKeyToAccount(adminKey);
  const av = await call("POST", "/auth/verify", await challenge(admin, "admin"));
  check("admin sign-in", av.status === 200 && av.json.role === "admin", av.json);
  const at = av.json?.token as string;
  const stats = await call("GET", "/admin/stats", undefined, at);
  check("admin stats", stats.status === 200 && stats.json.total >= 1, stats.json);
  const list = await call("GET", `/admin/registrations?q=${user.address.slice(2, 12)}`, undefined, at);
  check("admin search by wallet", list.json?.total === 1, list.json);
  const id = list.json?.registrations?.[0]?.id;
  const nasty = '=cmd|" /C calc"!A0, "quoted"\nnext line';
  const patch = await call("PATCH", `/admin/registrations/${id}`, { registrationStatus: "approved", adminNotes: nasty }, at);
  check("admin update", patch.status === 200 && patch.json.registration.registrationStatus === "approved", patch.json);
  const audit = await call("GET", `/admin/registrations/${id}/audit`, undefined, at);
  check("audit trail has 3 entries", audit.json?.entries?.length === 3, audit.json);
  const csv = await call("GET", `/admin/export.csv?q=${user.address.slice(2, 12)}`, undefined, at);
  check("export content-type", csv.headers.get("content-type") === "text/csv; charset=utf-8", csv.headers.get("content-type"));
  check("export filename", /flylist-all-\d{4}-\d{2}-\d{2}\.csv/.test(csv.headers.get("content-disposition") ?? ""));
  check("export formula neutralized", csv.text.includes(`"'=cmd|"" /C calc""!A0, ""quoted""\nnext line"`), csv.text);
  const mine = await call("GET", "/me/registration", undefined, token);
  check("admin notes hidden from registrant", !mine.text.includes("calc"), mine.text);
  const fin = await call("GET", "/admin/export.csv?preset=final", undefined, at);
  const finLines = fin.text.trim().split("\r\n").slice(1);
  check("final export: approved only", fin.status === 200 && finLines.length >= 1 && finLines.every((l) => l.includes('"approved"')), fin.text.slice(0, 300));
} else {
  console.log("SKIP  admin checks (set ADMIN_PRIVATE_KEY to a throwaway admin key)");
}

await sql`update allowlist.campaigns set eth_balance_check_enabled = true`;
await sql.end();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
