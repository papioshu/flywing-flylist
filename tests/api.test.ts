import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSiweMessage } from "viem/siwe";
import { describe, expect, it } from "vitest";
import { CSV_COLUMNS } from "../supabase/functions/_shared/app.ts";
import { ORIGIN, parseCsv, setup } from "./helpers.ts";

describe("wallet verification (SIWE)", () => {
  it("registers a verified wallet end to end and stores no signature", async () => {
    const t = await setup();
    const w = t.newWallet();
    const token = await t.signIn(w);

    const status = await t.call("GET", "/me/registration", { token });
    expect(status.status).toBe(200);
    expect(status.json.registration).toBeNull();
    expect(status.json.campaign.isOpen).toBe(true);

    const reg = await t.call("POST", "/me/registration", { token, body: { twitterUsername: "@FlyWingFan" } });
    expect(reg.status).toBe(201);
    expect(reg.json.registration).toMatchObject({
      walletAddress: w.address,
      twitterUsername: "FlyWingFan",
      twitterVerified: false,
      registrationStatus: "eligible",
      eligibilityStatus: "eligible",
    });
    expect(reg.json.registration.adminNotes).toBeUndefined();

    const [row] = await t.db.query<any>(`select * from allowlist.registrations`);
    expect(row.wallet_address).toBe(w.address);
    expect(row.wallet_address_normalized).toBe(w.address.toLowerCase());
    expect(row.twitter_username_normalized).toBe("flywingfan");
    expect(row.verification_method).toBe("siwe_eip4361");
    expect(row.verification_chain_id).toBe(8453);
    expect(row.eligibility_status).toBe("eligible");
    expect(row.eth_balance_wei).toBe("1000000000000000000");
    expect(row.eth_usd_price_source).toBe("chainlink");
    expect(row.eligibility_chain_id).toBe(1);
    expect(JSON.stringify(row)).not.toMatch(/0x[0-9a-f]{130}/i); // no signature persisted
    const [sess] = await t.db.query<any>(`select * from allowlist.sessions`);
    expect(sess.token_hash).not.toBe(token); // only the hash is stored
  });

  it("rejects a signature from a different wallet", async () => {
    const t = await setup();
    const victim = t.newWallet();
    const attacker = t.newWallet();
    const { message } = await t.challenge(victim);
    const signature = await attacker.signMessage({ message });
    const r = await t.call("POST", "/auth/verify", { body: { message, signature } });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("INVALID_SIGNATURE");
  });

  it("rejects garbage signatures and malformed messages", async () => {
    const t = await setup();
    const w = t.newWallet();
    const { message } = await t.challenge(w);
    expect((await t.call("POST", "/auth/verify", { body: { message, signature: "0x1234" } })).status).toBe(401);
    expect((await t.call("POST", "/auth/verify", { body: { message: "hello", signature: "0x1234" } })).status).toBe(400);
    expect((await t.call("POST", "/auth/verify", { body: { message } })).status).toBe(400);
  });

  it("rejects an expired nonce", async () => {
    const t = await setup();
    const w = t.newWallet();
    const { message } = await t.challenge(w);
    const signature = await w.signMessage({ message });
    t.advance(11 * 60_000); // nonce TTL is 10 minutes
    const r = await t.call("POST", "/auth/verify", { body: { message, signature } });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("NONCE_EXPIRED");
  });

  it("rejects replaying a used signature", async () => {
    const t = await setup();
    const w = t.newWallet();
    const { message } = await t.challenge(w);
    const signature = await w.signMessage({ message });
    expect((await t.call("POST", "/auth/verify", { body: { message, signature } })).status).toBe(200);
    const replay = await t.call("POST", "/auth/verify", { body: { message, signature } });
    expect(replay.status).toBe(401);
    expect(replay.json.error.code).toBe("NONCE_USED");
  });

  it("rejects a made-up nonce", async () => {
    const t = await setup();
    const w = t.newWallet();
    const message = createSiweMessage({
      domain: new URL(ORIGIN).host,
      uri: ORIGIN,
      address: w.address,
      chainId: 8453,
      nonce: "AAAAAAAAAAAAAAAAAAAAAAAA",
      version: "1",
      issuedAt: new Date("2026-10-12T12:00:00Z"),
      expirationTime: new Date("2026-10-12T12:05:00Z"),
    });
    const r = await t.call("POST", "/auth/verify", { body: { message, signature: await w.signMessage({ message }) } });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("INVALID_NONCE");
  });

  async function tamper(field: "domain" | "uri" | "chainId" | "statement" | "address" | "expirationTime") {
    const t = await setup();
    const w = t.newWallet();
    const other = t.newWallet();
    const n = await t.call("POST", "/auth/nonce", { body: { address: w.address, chainId: 8453 } });
    const base = {
      domain: new URL(ORIGIN).host,
      uri: ORIGIN,
      address: w.address,
      chainId: 8453,
      nonce: n.json.nonce,
      version: "1" as const,
      statement: n.json.statement,
      issuedAt: new Date(n.json.issuedAt),
      expirationTime: new Date(n.json.expirationTime),
    };
    const changes = {
      domain: { domain: "evil.example", uri: "https://evil.example" },
      uri: { uri: "https://evil.example/login" },
      chainId: { chainId: 1 },
      statement: { statement: "Something else" },
      address: { address: other.address },
      expirationTime: { expirationTime: new Date(new Date(n.json.expirationTime).getTime() + 86_400_000) },
    }[field];
    const message = createSiweMessage({ ...base, ...changes });
    const signer = field === "address" ? other : w;
    return t.call("POST", "/auth/verify", { body: { message, signature: await signer.signMessage({ message }) } });
  }

  it.each(["domain", "uri", "chainId", "statement", "address", "expirationTime"] as const)(
    "rejects a message whose %s does not match the issued challenge",
    async (field) => {
      const r = await tamper(field);
      expect(r.status).toBe(401);
    },
  );

  it("rejects unsupported chains and requests from other websites", async () => {
    const t = await setup();
    const w = t.newWallet();
    const bad = await t.call("POST", "/auth/nonce", { body: { address: w.address, chainId: 999999 } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("UNSUPPORTED_CHAIN");
    const evil = await t.call("POST", "/auth/nonce", { origin: "https://evil.example", body: { address: w.address, chainId: 8453 } });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("requires JSON bodies (blocks cross-site form posts)", async () => {
    const t = await setup();
    const r = await t.call("POST", "/auth/nonce", {
      body: "address=0x0000000000000000000000000000000000000001&chainId=1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(r.status).toBe(415);
  });

  it("expires sessions", async () => {
    const t = await setup();
    const token = await t.signIn(t.newWallet());
    t.advance(2 * 3600_000 + 1000);
    const r = await t.call("GET", "/me/registration", { token });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("SESSION_EXPIRED");
  });

  it("logout revokes the session", async () => {
    const t = await setup();
    const token = await t.signIn(t.newWallet());
    expect((await t.call("POST", "/auth/logout", { token })).status).toBe(200);
    expect((await t.call("GET", "/me/registration", { token })).status).toBe(401);
  });
});

describe("registration rules", () => {
  it("prevents duplicate registrations and shows the existing status", async () => {
    const t = await setup();
    const w = t.newWallet();
    const token = await t.signIn(w);
    expect((await t.call("POST", "/me/registration", { token, body: { twitterUsername: "first" } })).status).toBe(201);
    const again = await t.call("POST", "/me/registration", { token, body: { twitterUsername: "second" } });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("ALREADY_REGISTERED");
    expect(again.json.error.registration.twitterUsername).toBe("first");

    // A fresh sign-in by the same wallet still can't create a second row.
    const token2 = await t.signIn(w);
    expect((await t.call("POST", "/me/registration", { token: token2, body: { twitterUsername: "third" } })).status).toBe(409);
    const [{ count }] = await t.db.query<any>(`select count(*)::int as count from allowlist.registrations`);
    expect(count).toBe(1);
  });

  it("enforces one wallet per campaign at the database level", async () => {
    const t = await setup();
    const insert = `insert into allowlist.registrations (campaign_id, wallet_address, wallet_address_normalized, twitter_username,
      twitter_username_normalized, verification_chain_id, verification_method, verification_timestamp)
      values ('fwg-genesis', $1, $2, 'a', 'a', 1, 'siwe_eip4361', now())`;
    const addr = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    await t.db.query(insert, [addr, addr.toLowerCase()]);
    await expect(t.db.query(insert, [addr.toLowerCase(), addr.toLowerCase()])).rejects.toThrow(/unique/i);
  });

  it("validates the X username server-side", async () => {
    const t = await setup();
    const token = await t.signIn(t.newWallet());
    for (const bad of ["", "way_too_long_handle", "bad-char", "@"]) {
      const r = await t.call("POST", "/me/registration", { token, body: { twitterUsername: bad } });
      expect(r.status, bad).toBe(400);
      expect(r.json.error.code).toBe("INVALID_TWITTER_USERNAME");
    }
  });

  it("requires a verified session; a wallet address in the body is ignored", async () => {
    const t = await setup();
    const victim = t.newWallet();
    const attacker = t.newWallet();
    expect((await t.call("POST", "/me/registration", { body: { twitterUsername: "x", walletAddress: victim.address } })).status).toBe(401);
    expect((await t.call("POST", "/me/registration", { token: "not-a-real-token", body: { twitterUsername: "x" } })).status).toBe(401);

    const token = await t.signIn(attacker);
    const r = await t.call("POST", "/me/registration", { token, body: { twitterUsername: "x", walletAddress: victim.address } });
    expect(r.status).toBe(201);
    expect(r.json.registration.walletAddress).toBe(attacker.address);
  });

  it("lets only the wallet owner update their X username, with an audit trail", async () => {
    const t = await setup();
    const owner = t.newWallet();
    const other = t.newWallet();
    const ownerToken = await t.signIn(owner);
    await t.call("POST", "/me/registration", { token: ownerToken, body: { twitterUsername: "oldname" } });

    // Another wallet's session can only ever touch its own (non-existent) row.
    const otherToken = await t.signIn(other);
    const hijack = await t.call("PATCH", "/me/registration", { token: otherToken, body: { twitterUsername: "hijacked" } });
    expect(hijack.status).toBe(404);
    expect((await t.call("PATCH", "/me/registration", { body: { twitterUsername: "hijacked" } })).status).toBe(401);

    const upd = await t.call("PATCH", "/me/registration", { token: ownerToken, body: { twitterUsername: "@NewName" } });
    expect(upd.status).toBe(200);
    expect(upd.json.registration.twitterUsername).toBe("NewName");
    const rows = await t.db.query<any>(`select * from allowlist.registrations`);
    expect(rows).toHaveLength(1);
    expect(rows[0].twitter_username_normalized).toBe("newname");
    const audit = await t.db.query<any>(`select action, changes from allowlist.registration_audit order by id`);
    expect(audit.map((a: any) => a.action)).toEqual(["registered", "twitter_username_updated"]);
    expect(audit[1].changes.twitter_username).toEqual({ from: "oldname", to: "NewName" });
  });

  it("shows a returning wallet its existing registration", async () => {
    const t = await setup();
    const w = t.newWallet();
    await t.call("POST", "/me/registration", { token: await t.signIn(w), body: { twitterUsername: "returning" } });
    const later = await t.signIn(w);
    const r = await t.call("GET", "/me/registration", { token: later });
    expect(r.json.registration).toMatchObject({ twitterUsername: "returning", registrationStatus: "eligible" });
  });

  it("refuses new registrations when the campaign is closed", async () => {
    const t = await setup();
    const early = t.newWallet();
    const earlyToken = await t.signIn(early);
    await t.call("POST", "/me/registration", { token: earlyToken, body: { twitterUsername: "early" } });
    await t.db.query(`update allowlist.campaigns set status = 'closed'`);

    const late = await t.call("POST", "/me/registration", { token: await t.signIn(t.newWallet()), body: { twitterUsername: "late" } });
    expect(late.status).toBe(403);
    expect(late.json.error.code).toBe("REGISTRATION_CLOSED");
    // Already-registered wallets still see their status.
    const again = await t.call("POST", "/me/registration", { token: earlyToken, body: { twitterUsername: "early" } });
    expect(again.json.error.code).toBe("ALREADY_REGISTERED");
    expect((await t.call("GET", "/campaign")).json.campaign.isOpen).toBe(false);
  });

  it("persists registrations across a restart (fresh process, same database)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fwg-pglite-"));
    try {
      const w = (await setup()).newWallet();
      const a = await setup({ dataDir: dir });
      await a.call("POST", "/me/registration", { token: await a.signIn(w), body: { twitterUsername: "persisted" } });
      await (a.db as any).pg.close();

      const b = await setup({ dataDir: dir });
      const r = await b.call("GET", "/me/registration", { token: await b.signIn(w) });
      expect(r.json.registration.twitterUsername).toBe("persisted");
      await (b.db as any).pg.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rate-limits a single client", async () => {
    const t = await setup();
    const w = t.newWallet();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      statuses.push((await t.call("POST", "/auth/nonce", { ip: "203.0.113.9", body: { address: w.address, chainId: 8453 } })).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });
});

describe("admin", () => {
  async function seeded(n: number) {
    const t = await setup();
    // Bulk rows straight into the DB (registration path is covered above).
    await t.db.query(
      `insert into allowlist.registrations (campaign_id, wallet_address, wallet_address_normalized, twitter_username,
         twitter_username_normalized, registered_at, updated_at, verification_chain_id, verification_method, verification_timestamp)
       select 'fwg-genesis', w, w, 'user' || g, 'user' || g,
              timestamptz '2026-10-01T00:00:00Z' + (g || ' minutes')::interval,
              timestamptz '2026-10-01T00:00:00Z' + (g || ' minutes')::interval, 8453, 'siwe_eip4361', now()
       from generate_series(1, $1::int) g, lateral (select '0x' || lpad(to_hex(g), 40, '0') as w) x`,
      [n],
    );
    return t;
  }

  it("rejects unauthenticated and non-admin access to every admin endpoint", async () => {
    const t = await seeded(3);
    const user = t.newWallet();
    const userToken = await t.signIn(user);
    const endpoints: [string, string, unknown?][] = [
      ["GET", "/admin/stats"],
      ["GET", "/admin/registrations"],
      ["GET", "/admin/export.csv"],
      ["PATCH", "/admin/registrations/00000000-0000-0000-0000-000000000000", { registrationStatus: "approved" }],
      ["GET", "/admin/registrations/00000000-0000-0000-0000-000000000000/audit"],
    ];
    for (const [m, p, body] of endpoints) {
      expect((await t.call(m, p, { body })).status, `${m} ${p} anon`).toBe(401);
      expect((await t.call(m, p, { body, token: userToken })).status, `${m} ${p} user`).toBe(403);
    }
    // A non-admin can't even get an admin challenge.
    expect((await t.call("POST", "/auth/nonce", { body: { address: user.address, chainId: 8453, purpose: "admin" } })).status).toBe(403);
    // The admin's own wallet signing in through the *registration* flow doesn't get admin rights either.
    const adminAsRegistrant = await t.signIn(t.admin, "register");
    expect((await t.call("GET", "/admin/stats", { token: adminAsRegistrant })).status).toBe(403);
  });

  it("drops admin access as soon as the wallet leaves ADMIN_WALLETS", async () => {
    const t = await seeded(1);
    const token = await t.signIn(t.admin, "admin");
    expect((await t.call("GET", "/admin/stats", { token })).status).toBe(200);
    t.config.adminWallets = [];
    expect((await t.call("GET", "/admin/stats", { token })).status).toBe(403);
  });

  it("reports stats, and searches/filters/sorts/paginates", async () => {
    const t = await seeded(30);
    const token = await t.signIn(t.admin, "admin");
    const stats = await t.call("GET", "/admin/stats", { token });
    expect(stats.json).toMatchObject({ total: 30, uniqueWallets: 30, byRegistrationStatus: { registered: 30 } });

    const p1 = await t.call("GET", "/admin/registrations?pageSize=10&sort=registeredAt&dir=asc", { token });
    expect(p1.json).toMatchObject({ total: 30, pageCount: 3, page: 1 });
    expect(p1.json.registrations[0].twitterUsername).toBe("user1");
    const p3 = await t.call("GET", "/admin/registrations?pageSize=10&page=3&sort=registeredAt&dir=asc", { token });
    expect(p3.json.registrations.at(-1).twitterUsername).toBe("user30");

    const byHandle = await t.call("GET", "/admin/registrations?q=%40USER2", { token }); // "@USER2" → user2, user20..29
    expect(byHandle.json.total).toBe(11);
    const byWallet = await t.call("GET", `/admin/registrations?q=${"0".repeat(38)}1e`, { token });
    expect(byWallet.json.total).toBe(1);
    expect(byWallet.json.registrations[0].twitterUsername).toBe("user30");
    // LIKE wildcards in search are treated literally.
    expect((await t.call("GET", "/admin/registrations?q=%25", { token })).json.total).toBe(0);

    const ids = p1.json.registrations.slice(0, 2).map((r: any) => r.id);
    await t.call("PATCH", `/admin/registrations/${ids[0]}`, { token, body: { registrationStatus: "approved" } });
    await t.call("PATCH", `/admin/registrations/${ids[1]}`, { token, body: { registrationStatus: "rejected", eligibilityStatus: "ineligible" } });
    expect((await t.call("GET", "/admin/registrations?registrationStatus=approved", { token })).json.total).toBe(1);
    expect((await t.call("GET", "/admin/registrations?eligibilityStatus=ineligible", { token })).json.total).toBe(1);
    expect((await t.call("GET", "/admin/registrations?registrationStatus=bogus", { token })).status).toBe(400);

    // Date filter is inclusive by UTC day: all 30 rows are on 2026-10-01.
    expect((await t.call("GET", "/admin/registrations?from=2026-10-01&to=2026-10-01", { token })).json.total).toBe(30);
    expect((await t.call("GET", "/admin/registrations?from=2026-10-02", { token })).json.total).toBe(0);

    const sorted = await t.call("GET", "/admin/registrations?sort=twitterUsername&dir=desc&pageSize=3", { token });
    expect(sorted.json.registrations.map((r: any) => r.twitterUsername)).toEqual(["user9", "user8", "user7"]);
    expect((await t.call("GET", "/admin/registrations?sort=password", { token })).status).toBe(400);
  });

  it("updates status/notes with an audit trail", async () => {
    const t = await seeded(1);
    const token = await t.signIn(t.admin, "admin");
    const [{ id }] = await t.db.query<any>(`select id from allowlist.registrations`);
    const r = await t.call("PATCH", `/admin/registrations/${id}`, {
      token,
      body: { registrationStatus: "approved", eligibilityStatus: "ineligible", adminNotes: "Holder of 2 BOMBSQUAD" },
    });
    expect(r.status).toBe(200);
    expect(r.json.registration).toMatchObject({ registrationStatus: "approved", eligibilityStatus: "ineligible", adminNotes: "Holder of 2 BOMBSQUAD" });
    expect(r.json.registration.eligibilityCheckedAt).toBe("2026-10-12T12:00:00.000Z");

    await t.call("PATCH", `/admin/registrations/${id}`, { token, body: { adminNotes: null } });
    const audit = await t.call("GET", `/admin/registrations/${id}/audit`, { token });
    expect(audit.json.entries).toHaveLength(2);
    expect(audit.json.entries[1]).toMatchObject({
      actorWallet: t.admin.address.toLowerCase(),
      actorRole: "admin",
      changes: {
        registration_status: { from: "registered", to: "approved" },
        eligibility_status: { from: "not_checked", to: "ineligible" },
        admin_notes: { from: null, to: "Holder of 2 BOMBSQUAD" },
      },
    });
    expect(audit.json.entries[0].changes).toEqual({ admin_notes: { from: "Holder of 2 BOMBSQUAD", to: null } });

    expect((await t.call("PATCH", `/admin/registrations/${id}`, { token, body: { registrationStatus: "vip" } })).status).toBe(400);
    expect((await t.call("PATCH", `/admin/registrations/${id}`, { token, body: {} })).status).toBe(400);
  });

  it("never exposes admin notes to the registrant", async () => {
    const t = await setup();
    const w = t.newWallet();
    const userToken = await t.signIn(w);
    await t.call("POST", "/me/registration", { token: userToken, body: { twitterUsername: "someone" } });
    const adminToken = await t.signIn(t.admin, "admin");
    const [{ id }] = await t.db.query<any>(`select id from allowlist.registrations`);
    await t.call("PATCH", `/admin/registrations/${id}`, { token: adminToken, body: { adminNotes: "SECRET-NOTE" } });
    const mine = await t.call("GET", "/me/registration", { token: userToken });
    expect(mine.text).not.toContain("SECRET-NOTE");
    expect(mine.text).not.toMatch(/adminNotes|eligibility_check|ethBalanceWei/);
  });

  it("exports the full dataset across pagination, oldest first, with safe escaping", async () => {
    const t = await seeded(2105); // > one 2000-row export batch, and far more than one UI page
    const token = await t.signIn(t.admin, "admin");
    const [first] = await t.db.query<any>(`select id from allowlist.registrations order by registered_at limit 1`);
    const nasty = '=HYPERLINK("http://evil.example","click"), with comma\nand "quotes"';
    await t.call("PATCH", `/admin/registrations/${first.id}`, { token, body: { adminNotes: nasty } });

    const r = await t.call("GET", "/admin/export.csv", { token });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="flylist-all-2026-10-12.csv"');
    expect([...r.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM for Excel

    const rows = parseCsv(r.text.slice(1));
    expect(rows[0]).toEqual(CSV_COLUMNS);
    expect(rows).toHaveLength(2106);
    expect(rows[1][3]).toBe("user1");
    expect(rows[2105][3]).toBe("user2105");
    const col = (name: string) => CSV_COLUMNS.indexOf(name);
    const at = rows.slice(1).map((row) => row[col("registered_at_utc")]);
    expect([...at].sort()).toEqual(at); // oldest first
    expect(at[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(rows[1][col("twitter_url")]).toBe("https://x.com/user1");
    expect(rows[1][col("twitter_verification")]).toBe("unverified (self-reported)");
    expect(rows[1][col("signin_chain_id")]).toBe("8453");
    expect(rows[1][col("admin_notes")]).toBe(`'${nasty}`); // neutralized + round-trips intact
    expect(new Set(rows.slice(1).map((row) => row[0])).size).toBe(2105); // no duplicates across batches

    const filtered = parseCsv((await t.call("GET", "/admin/export.csv?q=user210", { token })).text.slice(1));
    expect(filtered.length - 1).toBe(7); // user210 + user2100..user2105
  }, 60_000);
});
