// Minimal database seam: one parameterized-query function. Production uses
// postgres.js against SUPABASE_DB_URL; tests and local dev use PGlite (real
// Postgres compiled to WASM) with the same migrations.

export type Db = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};
