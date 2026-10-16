// FLYLIST export from the command line: signs in to the admin API with an admin wallet, downloads the
// same CSV as the dashboard's Export button, saves it, and prints it as a table. With --watch it
// re-downloads every N seconds so you can watch registrations come in.
//
//   API_URL=https://dkhblphayvcjvblgjxac.supabase.co/functions/v1/allowlist ORIGIN=https://<your-domain> \
//   ADMIN_PRIVATE_KEY=0x... npm run export -- [--preset all|eligible|pending_verification|final] [--watch 15]
//
// ADMIN_PRIVATE_KEY must belong to a wallet in the server's ADMIN_WALLETS. Use a wallet that exists
// only to sign in to the admin API (it never needs funds); never a wallet that holds anything.
// Read-only: it only calls GET /admin/stats and GET /admin/export.csv.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

const API = (process.env.API_URL ?? "http://localhost:8787/allowlist").replace(/\/$/, "");
const ORIGIN = process.env.ORIGIN ?? "http://localhost:5173";
const OUT = process.env.OUT_DIR ?? "exports";
const key = process.env.ADMIN_PRIVATE_KEY as `0x${string}` | undefined;

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const preset = arg("preset") ?? "all";
const watch = Number(arg("watch") ?? 0);

if (!key) {
  console.error("Set ADMIN_PRIVATE_KEY to the private key of an admin wallet (listed in ADMIN_WALLETS).");
  process.exit(1);
}
const admin = privateKeyToAccount(key);

async function call(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      origin: ORIGIN,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return { text, headers: res.headers };
}

async function signIn(): Promise<string> {
  const chainId = 1;
  const n = JSON.parse((await call("/auth/nonce", { method: "POST", body: { address: admin.address, chainId, purpose: "admin" } })).text);
  const message = createSiweMessage({
    domain: new URL(ORIGIN).host,
    uri: ORIGIN,
    address: admin.address,
    chainId,
    nonce: n.nonce,
    version: "1",
    statement: n.statement,
    issuedAt: new Date(n.issuedAt),
    expirationTime: new Date(n.expirationTime),
  });
  const v = JSON.parse((await call("/auth/verify", { method: "POST", body: { message, signature: await admin.signMessage({ message }) } })).text);
  if (v.role !== "admin") throw new Error(`${admin.address} signed in but is not an admin (check ADMIN_WALLETS).`);
  return v.token;
}

/** RFC 4180 parser for the server's CSV (quoted cells, doubled quotes, CRLF, leading BOM). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(cell), (cell = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows;
}

const SHOW = ["wallet_address", "twitter_username", "registration_status", "eligibility_status", "balance_usd_at_registration", "registered_at_utc"];

let token = "";
async function once() {
  if (!token) token = await signIn();
  let res;
  try {
    res = await call(`/admin/export.csv?preset=${encodeURIComponent(preset)}`, { token });
  } catch (e) {
    if (!String(e).includes("-> 401")) throw e;
    token = await signIn(); // admin session expired
    res = await call(`/admin/export.csv?preset=${encodeURIComponent(preset)}`, { token });
  }
  const stats = JSON.parse((await call("/admin/stats", { token })).text);
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `flylist-${preset}.csv`;
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, name);
  writeFileSync(file, res.text);

  const [header = [], ...rows] = parseCsv(res.text);
  const idx = SHOW.map((c) => header.indexOf(c));
  const table = rows.map((r) => Object.fromEntries(SHOW.map((c, i) => [c, idx[i] >= 0 ? r[idx[i]] : ""])));
  if (watch) console.clear();
  console.log(`FLYLIST export (${preset}) at ${new Date().toLocaleString()}: ${rows.length} rows. Saved ${file}`);
  const by = Object.entries(stats.byRegistrationStatus ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
  console.log(`Total ${stats.total} (today ${stats.today}) | ${by || "none yet"} | campaign ${stats.campaign?.status}`);
  if (table.length) console.table(table);
}

try {
  await once();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
if (watch > 0 && !process.exitCode) {
  console.log(`Refreshing every ${watch}s. Ctrl+C to stop.`);
  setInterval(() => once().catch((e) => console.error(String(e))), watch * 1000);
}
