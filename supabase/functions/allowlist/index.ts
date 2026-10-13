// Supabase Edge Function entry point (Deno). All logic lives in ../_shared/app.ts.
import postgres from "postgres";
import { createApp } from "../_shared/app.ts";
import { loadConfig } from "../_shared/config.ts";
import type { Db } from "../_shared/db.ts";
import { createSignatureVerifier } from "../_shared/siwe.ts";

const config = loadConfig((name) => Deno.env.get(name));

// SUPABASE_DB_URL is provided to every Edge Function automatically. prepare:false
// keeps it compatible with Supabase's transaction-mode connection pooler.
// DB_POOL_MAX=1 is only for the local PGlite wire-protocol harness (single backend).
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, {
  prepare: false,
  max: Number(Deno.env.get("DB_POOL_MAX") ?? 3),
});
const db: Db = {
  query: (text, params = []) => sql.unsafe(text, params as never[]) as never,
};

const handle = createApp({ db, config, verifySignature: createSignatureVerifier(config.rpcUrls) });

Deno.serve(handle);
