// Serves a migrated PGlite database over the real Postgres wire protocol, so the
// Deno Edge Function can be run locally with its production driver (postgres.js).
// Usage: npx tsx scripts/pg-server.ts [port]
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { openPglite } from "../server/pglite.ts";

const port = Number(process.argv[2] ?? 55433);
const { pg } = await openPglite(process.env.PGLITE_DIR);
const server = new PGLiteSocketServer({ db: pg, port, host: "127.0.0.1", maxConnections: 10 });
await server.start();
console.log(`postgres://postgres@127.0.0.1:${port}/postgres (PGlite, migrations applied)`);
