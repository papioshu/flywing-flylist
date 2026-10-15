// Local development API: the exact same handler as the Edge Function, backed
// by PGlite (real Postgres in WASM) persisted to ./.data/pglite so registrations
// survive restarts. Run with `npm run dev:api`.
import { createServer } from "node:http";
import { createApp } from "../supabase/functions/_shared/app.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { createSignatureVerifier } from "../supabase/functions/_shared/siwe.ts";
import { parseEther } from "viem";
import { createFakeNet } from "../tests/fakeNet.ts";
import { openPglite } from "./pglite.ts";

const PORT = Number(process.env.API_PORT ?? 8787);

const env: Record<string, string | undefined> = {
  ALLOWED_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173",
  IP_HASH_SALT: "local-dev-salt-not-secret",
  ...process.env,
};

const config = loadConfig((name) => env[name]);
const db = await openPglite(process.env.PGLITE_DIR ?? ".data/pglite");
// DEV_FAKE_CHAIN=1 (local UI tests only): balances and prices come from an in-memory fake
// network instead of live RPCs, controlled via http://localhost:FAKE_CHAIN_PORT. Every wallet
// holds 1 ETH on Ethereum unless set otherwise. The Edge Function never loads this.
const fake = process.env.DEV_FAKE_CHAIN === "1" ? createFakeNet(config.eligibilityRpcUrls, () => Date.now()) : null;
// DEV_FAKE_ETH=0.01 (with DEV_FAKE_CHAIN=1): every wallet holds that much ETH on Ethereum instead
// of 1 ETH, e.g. to preview the "not eligible" screen ($25 at the fake $2,500/ETH).
if (fake && process.env.DEV_FAKE_ETH) fake.state.defaultWei = { 1: parseEther(process.env.DEV_FAKE_ETH) };
const handle = createApp({ db, config, verifySignature: createSignatureVerifier(config.rpcUrls), fetch: fake?.fetch });

if (fake) {
  const FAKE_PORT = Number(process.env.FAKE_CHAIN_PORT ?? 8788);
  createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (req.url === "/balance") fake.setBalance(body.wallet, Number(body.chainId), BigInt(body.wei));
      else if (req.url === "/state") Object.assign(fake.state, body);
      else throw new Error("unknown");
      res.writeHead(200).end("ok");
    } catch (e) {
      res.writeHead(400).end(String(e));
    }
  }).listen(FAKE_PORT, "127.0.0.1", () => console.log(`  FAKE CHAIN control on http://127.0.0.1:${FAKE_PORT}`));
}

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  headers.set("x-forwarded-for", req.socket.remoteAddress ?? "local");
  const response = await handle(
    new Request(`http://localhost:${PORT}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => {
  console.log(`allowlist API on http://localhost:${PORT}/allowlist`);
  console.log(`  origins: ${config.allowedOrigins.join(", ")}`);
  console.log(`  admins:  ${config.adminWallets.join(", ") || "(none — set ADMIN_WALLETS)"}`);
});
