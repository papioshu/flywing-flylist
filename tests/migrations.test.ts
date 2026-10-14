// Applies the migrations step by step on a real Postgres (PGlite) to check data repairs.
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

describe("migrations", () => {
  it("Phase B unwraps Phase A jsonb values that the production driver stored as strings", async () => {
    const pg = new PGlite();
    const phaseB = files.indexOf("20261014000000_flylist_verification.sql");
    expect(phaseB).toBeGreaterThan(0);
    for (const f of files.slice(0, phaseB)) await pg.exec(readFileSync(join(DIR, f), "utf8"));

    // What postgres.js produced: the serialized value wrapped in a JSON string.
    const policy = { minEthBalanceUsdCents: 5500, ethBalanceChainIds: [1, 4663] };
    const chains = [{ chainId: 1, status: "ok", balanceWei: "1" }];
    await pg.query(
      `insert into allowlist.eligibility_checks (campaign_id, wallet_address_normalized, checked_at, expires_at, result, policy, chains)
       values ('fwg-genesis', '0x00000000000000000000000000000000000000aa', now(), now(), 'eligible', to_jsonb($1::text), to_jsonb($2::text))`,
      [JSON.stringify(policy), JSON.stringify(chains)],
    );
    const before = await pg.query<{ p: string }>(`select jsonb_typeof(policy) as p from allowlist.eligibility_checks`);
    expect(before.rows[0].p).toBe("string");

    for (const f of files.slice(phaseB)) await pg.exec(readFileSync(join(DIR, f), "utf8"));
    const after = await pg.query<{ p: string; c: string; policy: unknown; chains: unknown; policy_version: number }>(
      `select jsonb_typeof(policy) as p, jsonb_typeof(chains) as c, policy, chains, policy_version from allowlist.eligibility_checks`,
    );
    expect(after.rows[0]).toEqual({ p: "object", c: "array", policy, chains, policy_version: 1 });

    // And the policy history was seeded with version 1.
    const hist = await pg.query<{ version: number; created_by: string }>(`select version, created_by from allowlist.campaign_policies`);
    expect(hist.rows).toEqual([{ version: 1, created_by: "system" }]);
  });
});
