// PGlite-backed Db with all SQL migrations applied in order (idempotent per directory).
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../supabase/functions/_shared/db.ts";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "supabase", "migrations");

export async function openPglite(dataDir?: string): Promise<Db & { pg: PGlite }> {
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.exec(`create table if not exists public._migrations (name text primary key, applied_at timestamptz default now())`);
  const applied = new Set((await pg.query<{ name: string }>(`select name from public._migrations`)).rows.map((r) => r.name));
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    await pg.query(`insert into public._migrations (name) values ($1)`, [file]);
  }
  return {
    pg,
    async query(text, params = []) {
      return (await pg.query(text, params)).rows as never;
    },
  };
}
