// Local development API: the exact same handler as the Edge Function, backed
// by PGlite (real Postgres in WASM) persisted to ./.data/pglite so registrations
// survive restarts. Run with `npm run dev:api`.
import { createServer } from "node:http";
import { createApp } from "../supabase/functions/_shared/app.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { createSignatureVerifier } from "../supabase/functions/_shared/siwe.ts";
import { openPglite } from "./pglite.ts";

const PORT = Number(process.env.API_PORT ?? 8787);

const env: Record<string, string | undefined> = {
  ALLOWED_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173",
  IP_HASH_SALT: "local-dev-salt-not-secret",
  ...process.env,
};

const config = loadConfig((name) => env[name]);
const db = await openPglite(process.env.PGLITE_DIR ?? ".data/pglite");
const handle = createApp({ db, config, verifySignature: createSignatureVerifier(config.rpcUrls) });

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
