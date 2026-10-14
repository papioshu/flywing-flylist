import { describe, expect, it } from "vitest";
import { CSV_COLUMNS } from "../supabase/functions/_shared/app.ts";
import { meetsUsdThreshold, parseDecimal, weiToUsdCents } from "../supabase/functions/_shared/eligibility.ts";
import { parseCsv, setup } from "./helpers.ts";

const ETH = 10n ** 18n;
// At $2,500.00 (Chainlink default in the fake net) $55 is exactly 0.022 ETH.
const BOUNDARY_WEI = 22n * 10n ** 15n;

async function applicant(t: Awaited<ReturnType<typeof setup>>, balances: Record<number, bigint>) {
  const w = t.newWallet();
  for (const [chain, wei] of Object.entries(balances)) t.net.setBalance(w.address, Number(chain), wei);
  if (!(1 in balances)) t.net.setBalance(w.address, 1, 0n);
  const token = await t.signIn(w);
  return { w, token };
}

const eligibility = (t: Awaited<ReturnType<typeof setup>>, token: string) => t.call("POST", "/me/eligibility", { token, body: {} });

describe("money math (integer only)", () => {
  it("converts and compares exactly at the $55 boundary", () => {
    const price = 2500_00000000n;
    expect(meetsUsdThreshold(BOUNDARY_WEI, price, 8, 5500n)).toBe(true);
    expect(meetsUsdThreshold(BOUNDARY_WEI - 1n, price, 8, 5500n)).toBe(false);
    expect(weiToUsdCents(BOUNDARY_WEI, price, 8)).toBe(5500n);
    expect(weiToUsdCents(BOUNDARY_WEI - 1n, price, 8)).toBe(5499n); // floors, never rounds up
    // $55 is NOT 0.055 ETH: at $2,500 that would be $137.50.
    expect(weiToUsdCents(55n * 10n ** 15n, price, 8)).toBe(13750n);
  });

  it("parses decimal price strings without floating point", () => {
    expect(parseDecimal("2509.21", 8)).toBe(250921000000n);
    expect(parseDecimal("0.1", 8)).toBe(10000000n);
    expect(parseDecimal("2509.123456789", 8)).toBe(250912345678n); // truncated past 8 decimals
    for (const bad of ["", "-1", "1e3", "abc", "1.2.3"]) expect(parseDecimal(bad, 8)).toBeNull();
  });
});

describe("ETH balance eligibility ($55 on Ethereum OR Robinhood Chain)", () => {
  it("passes at exactly $55 and fails one wei below", async () => {
    const t = await setup();
    const ok = await applicant(t, { 1: BOUNDARY_WEI });
    const r1 = await eligibility(t, ok.token);
    expect(r1.status).toBe(200);
    expect(r1.json.eligibility).toMatchObject({ result: "eligible", minBalanceUsd: "55.00", ethUsdPrice: "2500", priceSource: "chainlink", cached: false });
    expect(r1.json.eligibility.chains[0]).toMatchObject({ chainId: 1, chainName: "Ethereum", balanceEth: "0.022", balanceUsd: "55.00", passed: true });

    const poor = await applicant(t, { 1: BOUNDARY_WEI - 1n });
    const r2 = await eligibility(t, poor.token);
    expect(r2.json.eligibility.result).toBe("ineligible");
    expect(r2.json.eligibility.chains[0]).toMatchObject({ balanceUsd: "54.99", passed: false });
  });

  it("qualifies on Robinhood Chain alone", async () => {
    const t = await setup();
    const a = await applicant(t, { 1: 0n, 4663: 30n * 10n ** 15n });
    const r = await eligibility(t, a.token);
    expect(r.json.eligibility.result).toBe("eligible");
    const rh = r.json.eligibility.chains.find((c: any) => c.chainId === 4663);
    expect(rh).toMatchObject({ chainName: "Robinhood Chain", passed: true, balanceUsd: "75.00" });
    const reg = await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "rh_holder" } });
    expect(reg.status).toBe(201);
    const [row] = await t.db.query<any>(`select * from allowlist.registrations`);
    expect(row.eligibility_chain_id).toBe(4663);
    expect(row.eth_balance_wei).toBe(String(30n * 10n ** 15n));
    expect(row.eth_balance_usd_cents).toBe("7500");
  });

  it("judges each chain on its own: balances are never summed", async () => {
    const t = await setup();
    const half = BOUNDARY_WEI / 2n;
    const a = await applicant(t, { 1: half, 4663: half }); // $27.50 + $27.50
    const r = await eligibility(t, a.token);
    expect(r.json.eligibility.result).toBe("ineligible");
  });

  it("falls back to Coinbase when Chainlink is stale or invalid, and records the source", async () => {
    const t = await setup();
    t.net.state.chainlinkUpdatedAgoSeconds = 2 * 3600; // older than PRICE_MAX_AGE_SECONDS (4500)
    const a = await applicant(t, { 1: ETH });
    const r = await eligibility(t, a.token);
    expect(r.json.eligibility).toMatchObject({ result: "eligible", priceSource: "coinbase", ethUsdPrice: "2400" });

    const t2 = await setup();
    t2.net.state.chainlinkAnswer = 0n;
    const b = await applicant(t2, { 1: ETH });
    expect((await eligibility(t2, b.token)).json.eligibility.priceSource).toBe("coinbase");

    const t3 = await setup();
    t3.net.state.chainlinkAnswer = -5n;
    const c = await applicant(t3, { 1: ETH });
    expect((await eligibility(t3, c.token)).json.eligibility.priceSource).toBe("coinbase");
  });

  it("reports unavailable (not ineligible) when no price can be trusted, and does not cache it", async () => {
    const t = await setup();
    t.net.state.chainlinkDown = true;
    t.net.state.coinbaseDown = true;
    const a = await applicant(t, { 1: ETH });
    const r = await eligibility(t, a.token);
    expect(r.json.eligibility.result).toBe("unavailable");
    const reg = await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "waiting" } });
    expect(reg.status).toBe(503);
    expect(reg.json.error.code).toBe("ELIGIBILITY_UNAVAILABLE");
    expect(await t.db.query(`select 1 from allowlist.registrations`)).toHaveLength(0);

    // Price comes back: a fresh check runs (the unavailable result wasn't cached).
    t.net.state.chainlinkDown = false;
    expect((await eligibility(t, a.token)).json.eligibility).toMatchObject({ result: "eligible", cached: false });
  });

  it("treats an unreadable chain as unavailable unless another chain already passes", async () => {
    const t = await setup();
    t.net.state.chainDown.add(4663);
    const poor = await applicant(t, { 1: 0n });
    expect((await eligibility(t, poor.token)).json.eligibility.result).toBe("unavailable");
    const rich = await applicant(t, { 1: ETH });
    expect((await eligibility(t, rich.token)).json.eligibility.result).toBe("eligible");

    const t2 = await setup();
    t2.net.state.wrongChainId.set(4663, 1); // misconfigured RPC URL answering for another chain
    const p2 = await applicant(t2, { 1: 0n });
    const r = await eligibility(t2, p2.token);
    expect(r.json.eligibility.result).toBe("unavailable");
    expect(r.json.eligibility.chains.find((c: any) => c.chainId === 4663).status).toBe("error");
  });

  it("refuses to register an ineligible wallet, with the figures used", async () => {
    const t = await setup();
    const a = await applicant(t, { 1: 10n ** 15n }); // $2.50
    const reg = await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "toolow" } });
    expect(reg.status).toBe(403);
    expect(reg.json.error.code).toBe("INELIGIBLE");
    expect(reg.json.error.eligibility.chains[0].balanceUsd).toBe("2.50");
    expect(await t.db.query(`select 1 from allowlist.registrations`)).toHaveLength(0);
  });

  it("caches a wallet's result briefly, then re-checks", async () => {
    const t = await setup();
    const a = await applicant(t, { 1: ETH });
    await eligibility(t, a.token);
    const callsAfterFirst = t.net.state.calls.length;
    const second = await eligibility(t, a.token);
    expect(second.json.eligibility.cached).toBe(true);
    // Registering inside the cache window reuses the same server-side check: no new RPC traffic.
    expect((await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "cached" } })).status).toBe(201);
    expect(t.net.state.calls.length).toBe(callsAfterFirst);

    const b = await applicant(t, { 1: 0n });
    await eligibility(t, b.token);
    t.advance(301_000); // ELIGIBILITY_CACHE_SECONDS = 300
    const token2 = await t.signIn(b.w);
    expect((await eligibility(t, token2)).json.eligibility.cached).toBe(false);
  });

  it("re-reads the balance when the cache expired before submitting", async () => {
    const t = await setup();
    const a = await applicant(t, { 1: ETH });
    expect((await eligibility(t, a.token)).json.eligibility.result).toBe("eligible");
    t.advance(301_000);
    t.net.setBalance(a.w.address, 1, 0n); // moved their ETH out after the check
    const reg = await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "emptied" } });
    expect(reg.status).toBe(403);
    expect(reg.json.error.code).toBe("INELIGIBLE");
  });

  it("limits fresh checks per wallet", async () => {
    const t = await setup({ env: { ELIGIBILITY_CHECKS_PER_WALLET: "3" } });
    t.net.state.chainlinkDown = true;
    t.net.state.coinbaseDown = true; // unavailable results aren't cached, so every call is fresh
    const a = await applicant(t, { 1: ETH });
    for (let i = 0; i < 3; i++) expect((await eligibility(t, a.token)).status).toBe(200);
    const r = await eligibility(t, a.token);
    expect(r.status).toBe(429);
  });

  it("skips RPC calls entirely for an already registered wallet", async () => {
    const t = await setup();
    const a = await applicant(t, { 1: ETH });
    await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "early" } });
    const before = t.net.state.calls.length;
    t.advance(400_000);
    const token2 = await t.signIn(a.w);
    const r = await eligibility(t, token2);
    expect(r.json.registration).toMatchObject({ twitterUsername: "early", registrationStatus: "eligible" });
    expect(r.json.eligibility).toBeNull();
    expect(t.net.state.calls.length).toBe(before);
  });

  it("requires a session and refuses when the campaign is closed", async () => {
    const t = await setup();
    expect((await t.call("POST", "/me/eligibility", { body: {} })).status).toBe(401);
    const a = await applicant(t, { 1: ETH });
    await t.db.query(`update allowlist.campaigns set status = 'closed'`);
    const r = await eligibility(t, a.token);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("REGISTRATION_CLOSED");
  });

  it("stores the rules in force with each check; later policy changes don't rewrite history", async () => {
    const t = await setup();
    const a = await applicant(t, { 1: ETH });
    await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "history" } });
    await t.db.query(`update allowlist.campaigns set min_eth_balance_usd_cents = 1000000`);
    const [check] = await t.db.query<any>(`select policy from allowlist.eligibility_checks`);
    expect(check.policy).toMatchObject({ minEthBalanceUsdCents: 5500, ethBalanceChainIds: [1, 4663], accessMode: "open", xFollowRequired: false });
    const [row] = await t.db.query<any>(`select registration_status, eth_balance_usd_cents from allowlist.registrations`);
    expect(row).toEqual({ registration_status: "eligible", eth_balance_usd_cents: "250000" });
  });

  it("needs no RPC when the campaign turns the balance check off", async () => {
    const t = await setup();
    await t.db.query(`update allowlist.campaigns set eth_balance_check_enabled = false`);
    const a = await applicant(t, { 1: 0n });
    const r = await eligibility(t, a.token);
    expect(r.json.eligibility.result).toBe("eligible");
    expect(t.net.state.calls).toHaveLength(0);
  });
});

describe("campaign policy", () => {
  it("only implements the open access mode", async () => {
    const t = await setup();
    await expect(t.db.query(`update allowlist.campaigns set access_mode = 'invite_code'`)).rejects.toThrow();
    const r = await t.call("GET", "/campaign");
    expect(r.json.campaign.requirements).toEqual({
      accessMode: "open",
      ethBalance: { minUsd: "55.00", chains: [{ chainId: 1, chainName: "Ethereum" }, { chainId: 4663, chainName: "Robinhood Chain" }], rule: "any_one_chain" },
      xFollowRequired: false,
    });
  });

  it("never fakes X verification: required X without provisional mode refuses; with it, records pending_verification", async () => {
    const t = await setup();
    await t.db.query(`update allowlist.campaigns set x_follow_required = true`);
    const a = await applicant(t, { 1: ETH });
    const r = await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "needs_x" } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("VERIFICATION_UNAVAILABLE");

    await t.db.query(`update allowlist.campaigns set allow_provisional_registration = true`);
    const r2 = await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "needs_x" } });
    expect(r2.status).toBe(201);
    expect(r2.json.registration).toMatchObject({ registrationStatus: "pending_verification", eligibilityStatus: "pending", twitterVerified: false });
  });
});

describe("registration identity and idempotency", () => {
  it("parallel submissions from one session create exactly one registration", async () => {
    const t = await setup();
    const a = await applicant(t, { 1: ETH });
    await eligibility(t, a.token);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: `dup${i}` } })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.json.error.code === "ALREADY_REGISTERED")).toBe(true);
    expect(results.filter((r) => r.status === 409)).toHaveLength(11);
    expect(await t.db.query(`select 1 from allowlist.registrations`)).toHaveLength(1);
  });

  it("parallel submissions from separate sessions (other browser) of the same wallet create one row", async () => {
    const t = await setup();
    const a = await applicant(t, { 1: ETH });
    const tokens = [a.token, await t.signIn(a.w), await t.signIn(a.w)];
    const results = await Promise.all(tokens.map((token, i) => t.call("POST", "/me/registration", { token, body: { twitterUsername: `tab${i}` } })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await t.db.query(`select 1 from allowlist.registrations`)).toHaveLength(1);
  });

  it("wallet switching: each wallet is judged independently and a body address is ignored", async () => {
    const t = await setup();
    const a = await applicant(t, { 1: ETH });
    const b = await applicant(t, { 1: 0n });
    await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "wallet_a" } });

    // B is not "registered" just because A is; B's own balance decides.
    const rb = await t.call("POST", "/me/eligibility", { token: b.token, body: { walletAddress: a.w.address } });
    expect(rb.json.walletAddress).toBe(b.w.address);
    expect(rb.json.registration).toBeNull();
    expect(rb.json.eligibility.result).toBe("ineligible");

    // A forged walletAddress in the body can't register B as A (or A as anything else).
    const forged = await t.call("POST", "/me/registration", { token: b.token, body: { twitterUsername: "forged", walletAddress: a.w.address } });
    expect(forged.status).toBe(403);
    const rows = await t.db.query<any>(`select wallet_address from allowlist.registrations`);
    expect(rows).toEqual([{ wallet_address: a.w.address }]);
  });
});

describe("admin exports", () => {
  it("serves all / pending / eligible / final presets; final is approved-only", async () => {
    const t = await setup();
    const statuses = ["eligible", "approved", "pending_verification", "rejected", "eligible"];
    for (const [i, s] of statuses.entries()) {
      const a = await applicant(t, { 1: ETH });
      await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: `p${i}` } });
      if (s !== "eligible") await t.db.query(`update allowlist.registrations set registration_status = $1 where twitter_username = $2`, [s, `p${i}`]);
    }
    const token = await t.signIn(t.admin, "admin");
    const get = async (preset: string) => {
      const r = await t.call("GET", `/admin/export.csv?preset=${preset}`, { token });
      expect(r.status).toBe(200);
      const rows = parseCsv(r.text.slice(1));
      expect(rows[0]).toEqual(CSV_COLUMNS);
      return { rows: rows.slice(1), disposition: r.headers.get("content-disposition") };
    };
    const status = CSV_COLUMNS.indexOf("registration_status");
    expect((await get("all")).rows).toHaveLength(5);
    expect((await get("pending_verification")).rows.map((r) => r[status])).toEqual(["pending_verification"]);
    expect((await get("eligible")).rows.map((r) => r[status]).sort()).toEqual(["approved", "eligible", "eligible"]);
    const final = await get("final");
    expect(final.rows.map((r) => r[status])).toEqual(["approved"]);
    expect(final.disposition).toContain("flylist-final-mint-allowlist-");

    const all = (await get("all")).rows[0];
    const c = (n: string) => all[CSV_COLUMNS.indexOf(n)];
    expect(c("eth_balance_wei")).toBe(String(ETH));
    expect(c("eth_balance_eth")).toBe("1");
    expect(c("eth_usd_price")).toBe("2500");
    expect(c("eth_usd_price_source")).toBe("chainlink");
    expect(c("balance_usd_at_registration")).toBe("2500.00");
    expect(c("eligibility_chain_id")).toBe("1");
    expect(c("access_method")).toBe("open");

    expect((await t.call("GET", "/admin/export.csv?preset=everyone", { token })).status).toBe(400);
  });

  it("refuses every export preset without an admin session", async () => {
    const t = await setup();
    const a = await applicant(t, { 1: ETH });
    for (const preset of ["all", "pending_verification", "eligible", "final"]) {
      expect((await t.call("GET", `/admin/export.csv?preset=${preset}`)).status).toBe(401);
      expect((await t.call("GET", `/admin/export.csv?preset=${preset}`, { token: a.token })).status).toBe(403);
    }
  });

  it("shows admins the eligibility snapshot on each registration", async () => {
    const t = await setup();
    const a = await applicant(t, { 1: 0n, 4663: ETH / 10n });
    await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "snap" } });
    const token = await t.signIn(t.admin, "admin");
    const r = await t.call("GET", "/admin/registrations", { token });
    expect(r.json.registrations[0]).toMatchObject({
      registrationStatus: "eligible",
      eligibilityStatus: "eligible",
      accessMethod: "open",
      eligibilityChainId: 4663,
      ethBalanceWei: String(ETH / 10n),
      ethBalanceEth: "0.1",
      ethUsdPrice: "2500",
      ethUsdPriceSource: "chainlink",
      balanceUsd: "250.00",
    });
  });
});
