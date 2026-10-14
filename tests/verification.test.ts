// FLYLIST Phase B: policy versioning, deferred-integration guards, X verification
// service (against a fake provider), on-chain NFT ownership, access codes, admin
// authorization and exports. Real Postgres (PGlite), real signatures, fake network.
import { describe, expect, it } from "vitest";
import { generateAccessCode, normalizeAccessCode, redeemAccessCode } from "../supabase/functions/_shared/accessCodes.ts";
import { CSV_COLUMNS } from "../supabase/functions/_shared/app.ts";
import { applyRule, createNftOwnershipProvider, type CollectionSnapshot } from "../supabase/functions/_shared/nft.ts";
import { XProviderError, type XVerificationProvider } from "../supabase/functions/_shared/xverify.ts";
import { parseCsv, setup } from "./helpers.ts";

const ETH = 10n ** 18n;
type T = Awaited<ReturnType<typeof setup>>;

async function applicant(t: T, balances: Record<number, bigint> = { 1: ETH }) {
  const w = t.newWallet();
  for (const [chain, wei] of Object.entries(balances)) t.net.setBalance(w.address, Number(chain), wei);
  const token = await t.signIn(w);
  return { w, token, wallet: w.address.toLowerCase() };
}

async function adminToken(t: T) {
  return t.signIn(t.admin, "admin");
}

async function patchPolicy(t: T, token: string, changes: Record<string, unknown>, reason?: string) {
  const cur = await t.call("GET", "/admin/policy", { token });
  return t.call("PATCH", "/admin/policy", { token, body: { expectedVersion: cur.json.version, changes, reason } });
}

/** Lifts the D013 database lock, as an approved migration would. */
async function liftAccessModeLock(t: T) {
  await t.db.query(`alter table allowlist.campaigns drop constraint campaigns_access_mode_implemented`);
}

// ---------- fake X provider (tests only; never shipped) ----------

function fakeX(opts: { follows?: Record<string, boolean | null>; failAuth?: "denied" | "unavailable"; failFollows?: boolean; userId?: string } = {}) {
  const calls: string[] = [];
  const provider: XVerificationProvider & { calls: string[]; users: Map<string, { userId: string; username: string }> } = {
    id: "fake",
    configured: true,
    estimate: { auth: 1, followCheckPerAccount: 1 },
    calls,
    users: new Map(),
    authorizeUrl: ({ state, codeChallenge }) => `https://x.example/oauth?state=${state}&challenge=${codeChallenge}`,
    async completeAuth({ code }) {
      calls.push(`auth:${code}`);
      if (opts.failAuth) throw new XProviderError(opts.failAuth, "provider said no");
      const u = provider.users.get(code) ?? { userId: opts.userId ?? "1001", username: "flyer" };
      return { ...u, accessToken: "tok" };
    },
    async checkFollows({ targetIds }) {
      calls.push(`follows:${targetIds.join(",")}`);
      if (opts.failFollows) throw new Error("503 from X");
      return { follows: Object.fromEntries(targetIds.map((id) => [id, opts.follows?.[id] ?? true])) };
    },
  };
  return provider;
}

async function xCampaign(t: T, extra = "") {
  await t.db.query(
    `update allowlist.campaigns set x_provider = 'fake', x_follow_required = true, allow_provisional_registration = true,
       required_x_accounts = '[{"id":"44196397","username":"flywing"}]', x_budget_daily_units = 100, x_budget_total_units = 1000,
       x_retry_cooldown_seconds = 60`,
  );
  if (extra) await t.db.query(`update allowlist.campaigns set ${extra.replace(/^\s*,/, "")}`);
}

async function verifyX(t: T, token: string, code = "code-1") {
  const start = await t.call("POST", "/me/verification/x/start", { token, body: {} });
  if (start.status !== 200 || !start.json.authorizeUrl) return { start, complete: null };
  const state = new URL(start.json.authorizeUrl).searchParams.get("state");
  const complete = await t.call("POST", "/me/verification/x/complete", { token, body: { state, code } });
  return { start, complete, state };
}

// =====================================================================

describe("campaign policy model", () => {
  it("starts at version 1 with every deferred integration off", async () => {
    const t = await setup();
    const token = await adminToken(t);
    const r = await t.call("GET", "/admin/policy", { token });
    expect(r.status).toBe(200);
    expect(r.json.version).toBe(1);
    expect(r.json.policy).toMatchObject({ accessMode: "open", xAuthRequired: false, xFollowRequired: false, xProvider: "none", xBudgetDailyUnits: 0 });
    expect(r.json.grouped.registration).toEqual({ accessMode: "open", accessCodeRequired: false, ethBalance: { minUsdCents: 5500, chainIds: [1, 4663], rule: "any_one_chain" } });
    expect(r.json.grouped.mintEligibility).toEqual({ requiresAdminApproval: true, requiresCompletedVerification: true });
    expect(r.json.integrations).toMatchObject({
      x_verification: { activated: false, providerImplemented: false, provider: "none", active: false },
      community_gating: { activated: false, active: false },
      access_codes: { activated: false, active: false },
    });
    expect(r.json.history).toHaveLength(1);
    expect(r.json.history[0]).toMatchObject({ version: 1, createdBy: "system" });
  });

  it("versions every change; history is append-only and old results keep their version", async () => {
    const t = await setup();
    const a = await applicant(t);
    await t.call("POST", "/me/eligibility", { token: a.token, body: {} });
    const token = await adminToken(t);
    const r = await patchPolicy(t, token, { minEthBalanceUsdCents: 10000 }, "raise to $100");
    expect(r.status).toBe(200);
    expect(r.json.version).toBe(2);

    const hist = await t.db.query<any>(`select version, created_by, reason, policy from allowlist.campaign_policies order by version`);
    expect(hist.map((h) => [h.version, h.policy.minEthBalanceUsdCents])).toEqual([[1, 5500], [2, 10000]]);
    expect(hist[1]).toMatchObject({ created_by: t.admin.address.toLowerCase(), reason: "raise to $100" });
    await expect(t.db.query(`update allowlist.campaign_policies set reason = 'x'`)).rejects.toThrow(/append-only/);
    await expect(t.db.query(`delete from allowlist.campaign_policies`)).rejects.toThrow(/append-only/);

    // The earlier check still says what it was evaluated under...
    const [old] = await t.db.query<any>(`select policy_version, policy from allowlist.eligibility_checks`);
    expect(old.policy_version).toBe(1);
    expect(old.policy.minEthBalanceUsdCents).toBe(5500);
    // ...and isn't reused under the new policy: the wallet is re-evaluated (and registers under v2).
    const reg = await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "v2" } });
    expect(reg.status).toBe(201);
    const checks = await t.db.query<any>(`select policy_version from allowlist.eligibility_checks order by checked_at, policy_version`);
    expect(checks.map((c) => c.policy_version)).toEqual([1, 2]);
    const [row] = await t.db.query<any>(`select policy_version from allowlist.registrations`);
    expect(row.policy_version).toBe(2);
  });

  it("rejects a stale version (two admins editing at once)", async () => {
    const t = await setup();
    const token = await adminToken(t);
    expect((await t.call("PATCH", "/admin/policy", { token, body: { expectedVersion: 1, changes: { minEthBalanceUsdCents: 6000 } } })).status).toBe(200);
    const stale = await t.call("PATCH", "/admin/policy", { token, body: { expectedVersion: 1, changes: { minEthBalanceUsdCents: 7000 } } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("POLICY_CONFLICT");
  });

  it("refuses deferred integrations unless explicitly activated, and validates input", async () => {
    const t = await setup();
    const token = await adminToken(t);
    const code = async (changes: Record<string, unknown>) => (await patchPolicy(t, token, changes)).json.error?.code ?? "OK";
    expect(await code({ accessMode: "invite_code" })).toBe("INTEGRATION_DISABLED");
    expect(await code({ accessMode: "community" })).toBe("INTEGRATION_DISABLED");
    expect(await code({ accessMode: "hybrid" })).toBe("INTEGRATION_DISABLED");
    expect(await code({ xProvider: "x_api_v2" })).toBe("PROVIDER_NOT_IMPLEMENTED");
    expect(await code({ xAuthRequired: true })).toBe("WOULD_BLOCK_REGISTRATION");
    expect(await code({ xFollowRequired: true, allowProvisionalRegistration: true })).toBe("INVALID_POLICY"); // no accounts listed
    expect(await code({ requiredXAccounts: [{ id: "flywing", username: "flywing" }] })).toBe("INVALID_POLICY"); // needs numeric ID
    expect(await code({ ethBalanceChainIds: [8453] })).toBe("UNSUPPORTED_CHAIN");
    expect(await code({ minEthBalanceUsdCents: -1 })).toBe("INVALID_POLICY");
    expect(await code({ surprise: true })).toBe("UNKNOWN_POLICY_FIELD");
    // Nothing above changed the policy.
    expect((await t.call("GET", "/admin/policy", { token })).json.version).toBe(1);

    // Provisional X (applicants recorded as pending) is a legitimate, free configuration.
    expect(await code({ xAuthRequired: true, allowProvisionalRegistration: true })).toBe("OK");
  });

  it("keeps the database lock on access modes even when the flag is set (D013)", async () => {
    const t = await setup({ env: { ENABLED_INTEGRATIONS: "access_codes" } });
    const token = await adminToken(t);
    const r = await patchPolicy(t, token, { accessMode: "invite_code" });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("ACCESS_MODE_LOCKED");
  });

  it("refuses unknown integration names in ENABLED_INTEGRATIONS", async () => {
    await expect(setup({ env: { ENABLED_INTEGRATIONS: "paid_everything" } })).rejects.toThrow(/unknown integration/);
  });
});

describe("disabled integrations never block the open campaign", () => {
  it("X reports not_configured, nothing is called or billed, and registration works", async () => {
    const t = await setup();
    const a = await applicant(t);
    const v = await t.call("GET", "/me/verification", { token: a.token });
    expect(v.json.x).toMatchObject({ required: false, status: "not_configured", followStatus: "not_required", xUsername: null });
    const start = await t.call("POST", "/me/verification/x/start", { token: a.token, body: {} });
    expect(start.json).toMatchObject({ status: "not_configured", authorizeUrl: null });
    const complete = await t.call("POST", "/me/verification/x/complete", { token: a.token, body: { state: "s", code: "c" } });
    expect(complete.status).toBe(409);
    expect(complete.json.error.code).toBe("X_NOT_CONFIGURED");

    const reg = await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "open_flyer" } });
    expect(reg.status).toBe(201);
    expect(reg.json.registration).toMatchObject({ registrationStatus: "eligible", verificationStatus: "not_required", twitterVerified: false });
    expect(await t.db.query(`select 1 from allowlist.provider_usage`)).toHaveLength(0);
    expect(await t.db.query(`select 1 from allowlist.nft_ownership_checks`)).toHaveLength(0);
    expect(t.net.state.calls.some((c) => c.includes("eth_call") && !c.startsWith("rpc:1:"))).toBe(false);
  });

  it("a configured X provider still does nothing without the activation flag", async () => {
    const x = fakeX();
    const t = await setup({ xProvider: x }); // no ENABLED_INTEGRATIONS
    await xCampaign(t);
    const a = await applicant(t);
    const start = await t.call("POST", "/me/verification/x/start", { token: a.token, body: {} });
    expect(start.json.status).toBe("not_configured");
    expect(x.calls).toHaveLength(0);
    // Provisional mode: recorded as pending, never as verified.
    const reg = await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "waiting" } });
    expect(reg.json.registration).toMatchObject({ registrationStatus: "pending_verification", verificationStatus: "pending" });
  });
});

describe("X verification service (fake provider)", () => {
  const env = { ENABLED_INTEGRATIONS: "x_verification" };

  it("authenticates, checks follows, and promotes a pending registration", async () => {
    const x = fakeX();
    const t = await setup({ env, xProvider: x });
    await xCampaign(t);
    const a = await applicant(t);
    const reg = await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "flyer" } });
    expect(reg.json.registration.registrationStatus).toBe("pending_verification");

    const { start, complete } = await verifyX(t, a.token);
    expect(start.json.status).toBe("pending");
    expect(start.json.authorizeUrl).toMatch(/^https:\/\/x\.example\/oauth\?state=[\w-]{43}&challenge=[\w-]{43}$/);
    expect(complete!.status).toBe(200);
    expect(complete!.json).toMatchObject({ status: "verified", followStatus: "verified", x: { status: "verified", xUsername: "flyer" } });
    expect(x.calls).toEqual(["auth:code-1", "follows:44196397"]);

    const [row] = await t.db.query<any>(`select registration_status, eligibility_status, verification_status from allowlist.registrations`);
    expect(row).toEqual({ registration_status: "eligible", eligibility_status: "eligible", verification_status: "verified" });
    const audit = await t.db.query<any>(`select action, actor_role from allowlist.registration_audit order by id`);
    expect(audit.map((r) => r.action)).toEqual(["registered", "x_verification"]);

    const [usage] = await t.db.query<any>(`select operation, estimated_units, actual_units, outcome, x_user_id from allowlist.provider_usage`);
    expect(usage).toEqual({ operation: "auth_and_follows", estimated_units: 2, actual_units: 2, outcome: "ok", x_user_id: "1001" });
    const [budget] = await t.db.query<any>(`select used_today, used_total from allowlist.provider_budgets`);
    expect(budget).toEqual({ used_today: 2, used_total: 2 });

    // Admin + CSV show the verified X user, not just the self-reported handle.
    const token = await adminToken(t);
    const list = await t.call("GET", "/admin/registrations", { token });
    expect(list.json.registrations[0]).toMatchObject({ xAuthStatus: "verified", xVerifiedUserId: "1001", xFollowStatus: "verified", verificationStatus: "verified" });
    const csv = parseCsv((await t.call("GET", "/admin/export.csv", { token })).text.slice(1));
    const c = (n: string) => csv[1][CSV_COLUMNS.indexOf(n)];
    expect(c("twitter_verification")).toBe("verified via X (@flyer)");
    expect(c("x_verified_user_id")).toBe("1001");
    expect(c("x_follow_status")).toBe("verified");
  });

  it("verifying before applying lets a wallet register straight to eligible", async () => {
    const t = await setup({ env, xProvider: fakeX() });
    await xCampaign(t, ", allow_provisional_registration = false");
    const a = await applicant(t);
    const early = await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "early" } });
    expect(early.json.error.code).toBe("X_VERIFICATION_REQUIRED");
    await verifyX(t, a.token);
    const reg = await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "early" } });
    expect(reg.status).toBe(201);
    expect(reg.json.registration).toMatchObject({ registrationStatus: "eligible", verificationStatus: "verified" });
  });

  it("a provider error is unavailable, never a 'no'", async () => {
    const t = await setup({ env, xProvider: fakeX({ failAuth: "unavailable" }) });
    await xCampaign(t);
    const a = await applicant(t);
    await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "flaky" } });
    const { complete } = await verifyX(t, a.token);
    expect(complete!.json).toMatchObject({ status: "unavailable" });
    const [row] = await t.db.query<any>(`select registration_status, verification_status from allowlist.registrations`);
    expect(row).toEqual({ registration_status: "pending_verification", verification_status: "pending" });
  });

  it("a follow-check outage is unavailable; an explicit 'not following' is failed but not rejected", async () => {
    const t1 = await setup({ env, xProvider: fakeX({ failFollows: true }) });
    await xCampaign(t1);
    const a = await applicant(t1);
    await t1.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "outage" } });
    const r1 = await verifyX(t1, a.token);
    expect(r1.complete!.json).toMatchObject({ status: "verified", followStatus: "unavailable" });
    const [x1] = await t1.db.query<any>(`select follows, verified_until from allowlist.x_verifications`);
    expect(x1.follows).toEqual([{ accountId: "44196397", username: "flywing", following: null }]);
    expect(x1.verified_until).toBeNull(); // not cached: it will be re-checked
    expect((await t1.db.query<any>(`select verification_status from allowlist.registrations`))[0].verification_status).toBe("pending");

    const t2 = await setup({ env, xProvider: fakeX({ follows: { "44196397": false } }) });
    await xCampaign(t2);
    const b = await applicant(t2);
    await t2.call("POST", "/me/registration", { token: b.token, body: { twitterUsername: "nofollow" } });
    const r2 = await verifyX(t2, b.token);
    expect(r2.complete!.json).toMatchObject({ status: "verified", followStatus: "failed" });
    const [row] = await t2.db.query<any>(`select registration_status, verification_status from allowlist.registrations`);
    expect(row).toEqual({ registration_status: "pending_verification", verification_status: "failed" });

    // A wallet that verified "not following" can't then register without fixing it.
    const c = await applicant(t2);
    await verifyX(t2, c.token);
    const refused = await t2.call("POST", "/me/registration", { token: c.token, body: { twitterUsername: "nofollow2" } });
    expect(refused.json.error.code).toBe("X_REQUIREMENT_NOT_MET");
  });

  it("stops paid calls when the budget is exhausted", async () => {
    const x = fakeX();
    const t = await setup({ env, xProvider: x });
    await xCampaign(t, ", x_budget_daily_units = 3"); // one full check costs 2
    const a = await applicant(t);
    const b = await applicant(t);
    expect((await verifyX(t, a.token)).complete!.json.status).toBe("verified");
    const second = await verifyX(t, b.token, "code-2");
    expect(second.complete!.status).toBe(503);
    expect(second.complete!.json.error).toMatchObject({ code: "X_BUDGET_EXHAUSTED", xStatus: "unavailable" });
    expect(x.calls).toEqual(["auth:code-1", "follows:44196397"]); // the second never reached the provider
    const refused = await t.db.query<any>(`select outcome, detail from allowlist.provider_usage where outcome = 'refused'`);
    expect(refused).toEqual([{ outcome: "refused", detail: "budget_exhausted" }]);

    // The daily counter resets the next UTC day; the total budget still applies.
    t.advance(24 * 3600_000);
    const b2 = await t.signIn(b.w);
    expect((await verifyX(t, b2, "code-3")).complete!.json.status).toBe("verified");
    await t.db.query(`update allowlist.campaigns set x_budget_total_units = 4`);
    const c = await applicant(t);
    expect((await verifyX(t, c.token, "code-4")).complete!.status).toBe(503);
  });

  it("concurrent reservations never overshoot the budget", async () => {
    const x = fakeX();
    const t = await setup({ env, xProvider: x });
    await xCampaign(t, ", x_budget_daily_units = 6"); // room for exactly 3 checks
    const wallets = await Promise.all(Array.from({ length: 6 }, () => applicant(t)));
    const starts = await Promise.all(wallets.map((w) => t.call("POST", "/me/verification/x/start", { token: w.token, body: {} })));
    const results = await Promise.all(
      wallets.map((w, i) =>
        t.call("POST", "/me/verification/x/complete", {
          token: w.token,
          body: { state: new URL(starts[i].json.authorizeUrl).searchParams.get("state"), code: `c${i}` },
        }),
      ),
    );
    x.users.clear();
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 503)).toHaveLength(3);
    const [budget] = await t.db.query<any>(`select used_today from allowlist.provider_budgets`);
    expect(budget.used_today).toBe(6);
  });

  it("reuses a verified result instead of re-checking, and applies a retry cooldown", async () => {
    const x = fakeX({ failAuth: "unavailable" });
    const t = await setup({ env, xProvider: x });
    await xCampaign(t);
    const a = await applicant(t);
    await verifyX(t, a.token);
    const again = await t.call("POST", "/me/verification/x/start", { token: a.token, body: {} });
    expect(again.status).toBe(429);
    expect(again.json.error.code).toBe("X_COOLDOWN");
    t.advance(61_000);
    expect((await t.call("POST", "/me/verification/x/start", { token: a.token, body: {} })).status).toBe(200);

    const ok = fakeX();
    const t2 = await setup({ env, xProvider: ok });
    await xCampaign(t2);
    const b = await applicant(t2);
    await verifyX(t2, b.token);
    t2.advance(3600_000);
    const cached = await t2.call("POST", "/me/verification/x/start", { token: b.token, body: {} });
    expect(cached.json).toMatchObject({ status: "verified", cached: true, authorizeUrl: null });
    expect(ok.calls).toHaveLength(2); // only the first auth + follow check
  });

  it("OAuth state is single-use and bound to the wallet that started it", async () => {
    const t = await setup({ env, xProvider: fakeX() });
    await xCampaign(t);
    const a = await applicant(t);
    const b = await applicant(t);
    const start = await t.call("POST", "/me/verification/x/start", { token: a.token, body: {} });
    const state = new URL(start.json.authorizeUrl).searchParams.get("state");
    const stolen = await t.call("POST", "/me/verification/x/complete", { token: b.token, body: { state, code: "c" } });
    expect(stolen.json.error.code).toBe("X_STATE_INVALID");
    expect((await t.call("POST", "/me/verification/x/complete", { token: a.token, body: { state, code: "c" } })).status).toBe(200);
    const replay = await t.call("POST", "/me/verification/x/complete", { token: a.token, body: { state, code: "c" } });
    expect(replay.json.error.code).toBe("X_STATE_INVALID");
    const [s] = await t.db.query<any>(`select count(*)::int as n from allowlist.x_oauth_states where state_hash = $1`, [state]);
    expect(s.n).toBe(0); // only the hash is stored, never the state itself
  });

  it("rate-limits per X account across wallets", async () => {
    const t = await setup({ env, xProvider: fakeX({ userId: "777" }) });
    await xCampaign(t, ", x_budget_daily_units = 1000");
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const w = await applicant(t);
      const r = await verifyX(t, w.token, `k${i}`);
      codes.push(r.complete!.status);
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe("NFT ownership provider (on-chain reads)", () => {
  const BASE_RPC = "https://base.test/rpc";
  const env = { RPC_URLS: `8453=${BASE_RPC}` };
  const holder = "0x00000000000000000000000000000000000000aa";
  const other = "0x00000000000000000000000000000000000000bb";
  const C721 = "0x1111111111111111111111111111111111111111";
  const C1155 = "0x2222222222222222222222222222222222222222";
  const col = (o: Partial<Parameters<ReturnType<typeof createNftOwnershipProvider>["evaluate"]>[0]["collections"][0]>) => ({
    id: o.id ?? "c1",
    displayName: o.displayName ?? "Partner",
    chainId: o.chainId ?? 1,
    contractAddress: o.contractAddress ?? C721,
    standard: o.standard ?? ("erc721" as const),
    minQuantity: o.minQuantity ?? 1,
    tokenIds: o.tokenIds ?? [],
    active: o.active ?? true,
  });

  async function provider() {
    const t = await setup({ env });
    const p = createNftOwnershipProvider({ fetch: t.net.fetch, rpcUrls: t.config.eligibilityRpcUrls, timeoutMs: 2000 });
    return { t, p };
  }

  it("ERC-721: collection-wide balanceOf with a minimum, and specific token IDs via ownerOf", async () => {
    const { t, p } = await provider();
    const n = t.net.nft(1, C721, "erc721");
    n.owners.set("1", holder).set("2", holder).set("3", other);
    const r1 = await p.evaluate({ wallet: holder, collections: [col({ minQuantity: 2 })], rule: "any", minCollections: 1 });
    expect(r1).toMatchObject({ result: "qualified", qualifying: ["c1"] });
    expect(r1.snapshots[0]).toMatchObject({ quantity: "2", blockNumber: "4660", source: "rpc", chainId: 1, contract: C721 });
    expect((await p.evaluate({ wallet: holder, collections: [col({ minQuantity: 3 })], rule: "any", minCollections: 1 })).result).toBe("not_qualified");

    // Only tokens 3 and 99 count: holder owns neither (99 doesn't exist: ownerOf reverts = not held).
    const r2 = await p.evaluate({ wallet: holder, collections: [col({ tokenIds: ["3", "99"] })], rule: "any", minCollections: 1 });
    expect(r2.result).toBe("not_qualified");
    expect(r2.snapshots[0].quantity).toBe("0");
    expect((await p.evaluate({ wallet: holder, collections: [col({ tokenIds: ["2", "3"] })], rule: "any", minCollections: 1 })).result).toBe("qualified");
  });

  it("ERC-1155: sums the configured token IDs against the minimum", async () => {
    const { t, p } = await provider();
    const n = t.net.nft(1, C1155, "erc1155");
    n.balances1155.set(`${holder}:7`, 2n).set(`${holder}:8`, 1n).set(`${holder}:9`, 50n);
    const c = col({ contractAddress: C1155, standard: "erc1155", tokenIds: ["7", "8"], minQuantity: 3 });
    const r = await p.evaluate({ wallet: holder, collections: [c], rule: "any", minCollections: 1 });
    expect(r).toMatchObject({ result: "qualified" });
    expect(r.snapshots[0].quantity).toBe("3"); // token 9 isn't configured, so it doesn't count
    expect((await p.evaluate({ wallet: holder, collections: [{ ...c, minQuantity: 4 }], rule: "any", minCollections: 1 })).result).toBe("not_qualified");
  });

  it("ownership on the wrong chain doesn't count, and a misconfigured RPC is unavailable", async () => {
    const { t, p } = await provider();
    t.net.nft(8453, C721, "erc721").owners.set("1", holder); // same address, but on Base
    t.net.nft(1, C721, "erc721");
    expect((await p.evaluate({ wallet: holder, collections: [col({ chainId: 1 })], rule: "any", minCollections: 1 })).result).toBe("not_qualified");
    expect((await p.evaluate({ wallet: holder, collections: [col({ chainId: 8453 })], rule: "any", minCollections: 1 })).result).toBe("qualified");

    t.net.state.wrongChainId.set(8453, 1); // the "Base" URL actually serves mainnet
    const r = await p.evaluate({ wallet: holder, collections: [col({ chainId: 8453 })], rule: "any", minCollections: 1 });
    expect(r.result).toBe("unavailable");
    expect(r.snapshots[0]).toMatchObject({ result: "error", error: "RPC is for chain 1, not 8453" });
  });

  it("a provider outage is unavailable unless the rule is already decided", async () => {
    const { t, p } = await provider();
    const A = "0x3333333333333333333333333333333333333333";
    t.net.nft(1, C721, "erc721").owners.set("1", holder);
    t.net.nft(1, A, "erc721").down = true;
    const both = [col({ id: "ok" }), col({ id: "down", contractAddress: A })];
    expect((await p.evaluate({ wallet: holder, collections: both, rule: "any", minCollections: 1 })).result).toBe("qualified");
    expect((await p.evaluate({ wallet: holder, collections: both, rule: "all", minCollections: 1 })).result).toBe("unavailable");
    expect((await p.evaluate({ wallet: other, collections: both, rule: "any", minCollections: 1 })).result).toBe("unavailable");
    t.net.state.chainDown.add(1);
    expect((await p.evaluate({ wallet: holder, collections: [col({})], rule: "any", minCollections: 1 })).result).toBe("unavailable");
  });

  it("applies any / all / min-N rules and supports multiple qualifying collections", () => {
    const s = (r: CollectionSnapshot["result"]): CollectionSnapshot => ({ collectionId: r, displayName: r, chainId: 1, contract: C721, standard: "erc721", minQuantity: 1, tokenIds: [], source: "rpc", result: r });
    const q = s("qualified");
    const n = s("not_qualified");
    const e = s("error");
    expect(applyRule([], "any", 1)).toBe("not_configured");
    expect(applyRule([n, q], "any", 1)).toBe("qualified");
    expect(applyRule([n, n], "any", 1)).toBe("not_qualified");
    expect(applyRule([q, n], "all", 1)).toBe("not_qualified");
    expect(applyRule([q, q], "all", 1)).toBe("qualified");
    expect(applyRule([q, q, n], "min_n", 2)).toBe("qualified");
    expect(applyRule([q, n, n], "min_n", 2)).toBe("not_qualified");
    expect(applyRule([q, e, n], "min_n", 2)).toBe("unavailable");
    expect(applyRule([q, q], "min_n", 3)).toBe("not_qualified");
  });
});

describe("community gating end to end (activated in this test only)", () => {
  const C = "0x4444444444444444444444444444444444444444";

  async function communityCampaign(extraEnv: Record<string, string> = {}) {
    const t = await setup({ env: { ENABLED_INTEGRATIONS: "community_gating,access_codes", ...extraEnv } });
    const token = await adminToken(t);
    await liftAccessModeLock(t);
    const created = await t.call("POST", "/admin/collections", { token, body: { displayName: "Test Partner", chainId: 1, contractAddress: C, standard: "erc721" } });
    expect(created.status).toBe(201);
    return { t, token, nft: t.net.nft(1, C, "erc721") };
  }

  it("needs an active collection, then admits holders and refuses non-holders", async () => {
    const t0 = await setup({ env: { ENABLED_INTEGRATIONS: "community_gating" } });
    await liftAccessModeLock(t0);
    expect((await patchPolicy(t0, await adminToken(t0), { accessMode: "community" })).json.error.code).toBe("NO_COLLECTIONS");

    const { t, token, nft } = await communityCampaign();
    expect((await patchPolicy(t, token, { accessMode: "community" })).status).toBe(200);
    const holder = await applicant(t);
    nft.owners.set("5", holder.wallet);
    const ok = await t.call("POST", "/me/registration", { token: holder.token, body: { twitterUsername: "holder" } });
    expect(ok.status).toBe(201);
    const [row] = await t.db.query<any>(`select access_method, nft_status, nft_check_id from allowlist.registrations`);
    expect(row).toMatchObject({ access_method: "community", nft_status: "qualified" });
    expect(row.nft_check_id).toBeTruthy();

    const outsider = await applicant(t);
    const no = await t.call("POST", "/me/registration", { token: outsider.token, body: { twitterUsername: "outsider" } });
    expect(no.status).toBe(403);
    expect(no.json.error.code).toBe("INELIGIBLE");
    expect(no.json.error.eligibility.community).toMatchObject({ result: "not_qualified", collections: [{ displayName: "Test Partner", result: "not_qualified", quantity: "0" }] });

    const list = await t.call("GET", "/admin/registrations", { token });
    expect(list.json.registrations[0]).toMatchObject({ nftStatus: "qualified", qualifyingCollections: ["Test Partner (chain 1)"], accessMethod: "community" });
    const csv = parseCsv((await t.call("GET", "/admin/export.csv", { token })).text.slice(1));
    expect(csv[1][CSV_COLUMNS.indexOf("qualifying_collections")]).toBe("Test Partner (chain 1)");

    // A registration is not silently revoked when the NFT moves later.
    nft.owners.set("5", "0x0000000000000000000000000000000000000001");
    expect((await t.db.query<any>(`select registration_status from allowlist.registrations`))[0].registration_status).toBe("eligible");
    // Deactivating the only collection while it's required is refused.
    const cols = await t.call("GET", "/admin/collections", { token });
    const deact = await t.call("PATCH", `/admin/collections/${cols.json.collections[0].id}`, { token, body: { active: false } });
    expect(deact.json.error.code).toBe("COLLECTION_IN_USE");
  });

  it("invite_code mode needs a valid code; hybrid OR admits holders or code holders", async () => {
    const { t, token, nft } = await communityCampaign();
    expect((await patchPolicy(t, token, { accessMode: "invite_code" })).status).toBe(200);
    const gen = await t.call("POST", "/admin/access-codes", { token, body: { count: 2, maxRedemptions: 1, label: "launch", communityAttribution: "Partner DAO" } });
    expect(gen.status).toBe(201);
    const [code1, code2] = gen.json.codes.map((c: any) => c.code as string);

    const a = await applicant(t);
    const none = await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "nocode" } });
    expect(none.json.error.code).toBe("ACCESS_CODE_REQUIRED");
    const bad = await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "badcode", accessCode: generateAccessCode() } });
    expect(bad.json.error.code).toBe("ACCESS_CODE_INVALID");
    const ok = await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "coded", accessCode: code1.toLowerCase().replace(/-/g, "") } });
    expect(ok.status).toBe(201);
    const [row] = await t.db.query<any>(`select access_method, community_attribution, access_code_id from allowlist.registrations`);
    expect(row).toMatchObject({ access_method: "invite_code", community_attribution: "Partner DAO" });
    const [red] = await t.db.query<any>(`select registration_id from allowlist.access_code_redemptions`);
    expect(red.registration_id).toBeTruthy();

    // Used up: a second wallet can't reuse code1.
    const b = await applicant(t);
    expect((await t.call("POST", "/me/registration", { token: b.token, body: { twitterUsername: "reuse", accessCode: code1 } })).json.error.code).toBe("ACCESS_CODE_INVALID");

    // Admin sees the prefix and label, never the full code.
    const csv = (await t.call("GET", "/admin/export.csv", { token })).text;
    expect(csv).not.toContain(code1);
    expect(csv).toContain(`${code1.slice(0, 9)}… (launch)`);

    // Hybrid OR: holders get in on the community rule, others with a code.
    expect((await patchPolicy(t, token, { accessMode: "hybrid", hybridRule: "code_or_community" })).status).toBe(200);
    const holder = await applicant(t);
    nft.owners.set("9", holder.wallet);
    const h = await t.call("POST", "/me/registration", { token: holder.token, body: { twitterUsername: "hybrid_holder" } });
    expect(h.status).toBe(201);
    const c = await applicant(t);
    expect((await t.call("POST", "/me/registration", { token: c.token, body: { twitterUsername: "hybrid_none" } })).json.error.code).toBe("ACCESS_CODE_REQUIRED");
    expect((await t.call("POST", "/me/registration", { token: c.token, body: { twitterUsername: "hybrid_code", accessCode: code2 } })).status).toBe(201);
    const methods = await t.db.query<any>(`select twitter_username, access_method from allowlist.registrations order by registered_at, twitter_username`);
    expect(Object.fromEntries(methods.map((m) => [m.twitter_username, m.access_method]))).toMatchObject({ hybrid_holder: "community", hybrid_code: "invite_code" });
  });
});

describe("access codes", () => {
  async function codes(t: T, body: Record<string, unknown>) {
    const token = await adminToken(t);
    const r = await t.call("POST", "/admin/access-codes", { token, body });
    expect(r.status).toBe(201);
    return { token, created: r.json.codes as any[] };
  }

  it("are random, shown once, and stored only as hashes", async () => {
    const t = await setup();
    const { token, created } = await codes(t, { count: 3, maxRedemptions: 5 });
    const plain = created.map((c) => c.code as string);
    expect(new Set(plain).size).toBe(3);
    for (const c of plain) expect(c).toMatch(/^FLY-[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    const rows = await t.db.query<any>(`select * from allowlist.access_codes`);
    const dump = JSON.stringify(rows);
    for (const c of plain) expect(dump).not.toContain(c);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.code_hash))).toBe(true);
    const list = await t.call("GET", "/admin/access-codes", { token });
    expect(JSON.stringify(list.json)).not.toContain(plain[0]);
    expect(list.json.codes[0]).toMatchObject({ maxRedemptions: 5, redemptionCount: 0, state: "active" });
    expect(list.json.gatingActive).toBe(false);
    expect(normalizeAccessCode(` ${plain[0].toLowerCase()} `)).toBe(plain[0]);
    expect(normalizeAccessCode("FLY-OOOOO-IIIII-LLLLL-UUUUU")).toBeNull(); // look-alike letters aren't in the alphabet
  });

  it("redeems atomically: concurrent redemptions of a 1-use code give exactly one success", async () => {
    const t = await setup();
    const { created } = await codes(t, { count: 1, maxRedemptions: 1 });
    const wallets = Array.from({ length: 10 }, () => t.newWallet().address.toLowerCase());
    const results = await Promise.allSettled(
      wallets.map((wallet) => redeemAccessCode(t.db, { campaignId: "fwg-genesis", code: created[0].code, wallet, pepper: t.config.accessCodePepper, at: new Date("2026-10-12T12:00:00Z") })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === "ACCESS_CODE_INVALID")).toBe(true);
    const [row] = await t.db.query<any>(`select redemption_count from allowlist.access_codes`);
    expect(row.redemption_count).toBe(1);
    expect(await t.db.query(`select 1 from allowlist.access_code_redemptions`)).toHaveLength(1);
    const refused = await t.db.query<any>(`select detail->>'reason' as reason from allowlist.access_code_audit where action = 'redemption_refused'`);
    expect(refused).toHaveLength(9);
    expect(refused.every((r) => r.reason === "used_up")).toBe(true);
  });

  it("honours max redemptions, expiry, revocation, campaign scope and one code per wallet", async () => {
    const t = await setup();
    const { token, created } = await codes(t, { count: 1, maxRedemptions: 2, expiresAt: "2026-10-13T00:00:00Z" });
    const code = created[0].code;
    const at = new Date("2026-10-12T12:00:00Z");
    const redeem = (wallet: string, o: Partial<{ code: string; at: Date; campaignId: string }> = {}) =>
      redeemAccessCode(t.db, { campaignId: o.campaignId ?? "fwg-genesis", code: o.code ?? code, wallet, pepper: t.config.accessCodePepper, at: o.at ?? at });
    const w = () => t.newWallet().address.toLowerCase();

    const first = w();
    await redeem(first);
    await expect(redeem(first)).rejects.toMatchObject({ code: "ACCESS_CODE_ALREADY_USED" });
    await t.db.query(`insert into allowlist.campaigns (id, name) values ('other', 'Other')`);
    await expect(redeem(w(), { campaignId: "other" })).rejects.toMatchObject({ code: "ACCESS_CODE_INVALID" });
    await expect(redeem(w(), { at: new Date("2026-10-13T00:00:01Z") })).rejects.toMatchObject({ code: "ACCESS_CODE_INVALID" }); // expired
    await t.call("POST", `/admin/access-codes/${created[0].id}/revoke`, { token });
    await expect(redeem(w())).rejects.toMatchObject({ code: "ACCESS_CODE_INVALID" }); // revoked
    const reasons = await t.db.query<any>(`select action, detail->>'reason' as reason from allowlist.access_code_audit order by id`);
    expect(reasons.map((r) => r.reason ?? r.action)).toEqual(["created", "redeemed", "wallet_already_redeemed", "wrong_campaign", "expired", "revoked", "revoked"]);
  });
});

describe("admin authorization on every Phase B endpoint", () => {
  it("refuses anonymous and non-admin sessions", async () => {
    const t = await setup();
    const a = await applicant(t);
    const endpoints: [string, string, unknown?][] = [
      ["GET", "/admin/policy"],
      ["PATCH", "/admin/policy", { expectedVersion: 1, changes: { minEthBalanceUsdCents: 1 } }],
      ["GET", "/admin/collections"],
      ["POST", "/admin/collections", { displayName: "x", chainId: 1, contractAddress: "0x4444444444444444444444444444444444444444", standard: "erc721" }],
      ["PATCH", "/admin/collections/00000000-0000-0000-0000-000000000000", { active: false }],
      ["POST", "/admin/collections/test", { walletAddress: a.w.address }],
      ["GET", "/admin/access-codes"],
      ["POST", "/admin/access-codes", { count: 1 }],
      ["POST", "/admin/access-codes/00000000-0000-0000-0000-000000000000/revoke", {}],
      ["GET", "/admin/usage"],
    ];
    for (const [method, path, body] of endpoints) {
      expect((await t.call(method, path, { body })).status, `${method} ${path} anon`).toBe(401);
      expect((await t.call(method, path, { body, token: a.token })).status, `${method} ${path} registrant`).toBe(403);
    }
    expect(await t.db.query(`select 1 from allowlist.access_codes`)).toHaveLength(0);
    expect(await t.db.query(`select 1 from allowlist.partner_collections`)).toHaveLength(0);
    expect((await t.db.query<any>(`select policy_version from allowlist.campaigns`))[0].policy_version).toBe(1);
  });

  it("validates collection config and audits changes", async () => {
    const t = await setup();
    const token = await adminToken(t);
    const post = (body: unknown) => t.call("POST", "/admin/collections", { token, body });
    expect((await post({ displayName: "x", chainId: 8453, contractAddress: "0x4444444444444444444444444444444444444444", standard: "erc721" })).json.error.code).toBe("UNSUPPORTED_CHAIN");
    expect((await post({ displayName: "x", chainId: 1, contractAddress: "0x123", standard: "erc721" })).json.error.code).toBe("INVALID_COLLECTION");
    expect((await post({ displayName: "x", chainId: 1, contractAddress: "0x4444444444444444444444444444444444444444", standard: "erc1155" })).json.error.code).toBe("INVALID_COLLECTION");
    const ok = await post({ displayName: "Partner", chainId: 1, contractAddress: "0x4444444444444444444444444444444444444444", standard: "erc1155", tokenIds: ["1", 2], minQuantity: 2 });
    expect(ok.status).toBe(201);
    expect(ok.json.collection).toMatchObject({ chainId: 1, contractAddress: "0x4444444444444444444444444444444444444444", standard: "erc1155", tokenIds: ["1", "2"], minQuantity: 2, active: true });
    expect((await post({ displayName: "Dup", chainId: 1, contractAddress: "0x4444444444444444444444444444444444444444", standard: "erc721" })).status).toBe(409);
    const id = ok.json.collection.id;
    expect((await t.call("PATCH", `/admin/collections/${id}`, { token, body: { chainId: 8453 } })).status).toBe(400);
    expect((await t.call("PATCH", `/admin/collections/${id}`, { token, body: { active: false } })).json.collection.active).toBe(false);
    const audit = await t.db.query<any>(`select action from allowlist.partner_collection_audit order by id`);
    expect(audit.map((a) => a.action)).toEqual(["created", "updated"]);
  });

  it("reports provider usage and budgets", async () => {
    const t = await setup();
    const token = await adminToken(t);
    const r = await t.call("GET", "/admin/usage", { token });
    expect(r.json.x).toMatchObject({ provider: "none", active: false, dailyBudgetUnits: 0, totalBudgetUnits: 0, usedTodayUnits: 0, usedTotalUnits: 0 });
    expect(r.json.recent).toEqual([]);
  });
});

describe("final mint export with verification requirements", () => {
  it("excludes approved-but-unverified wallets unless the policy explicitly allows them", async () => {
    const t = await setup();
    const token = await adminToken(t);
    await t.db.query(`update allowlist.campaigns set x_auth_required = true, allow_provisional_registration = true`);
    const a = await applicant(t);
    await t.call("POST", "/me/registration", { token: a.token, body: { twitterUsername: "pending_one" } });
    await t.db.query(`update allowlist.campaigns set x_auth_required = false`);
    const b = await applicant(t);
    await t.call("POST", "/me/registration", { token: b.token, body: { twitterUsername: "plain_one" } });
    await t.db.query(`update allowlist.registrations set registration_status = 'approved'`);

    const final = async () => {
      const rows = parseCsv((await t.call("GET", "/admin/export.csv?preset=final", { token })).text.slice(1)).slice(1);
      return rows.map((r) => r[CSV_COLUMNS.indexOf("twitter_username")]);
    };
    expect(await final()).toEqual(["plain_one"]);
    expect((await patchPolicy(t, token, { finalExportIncludesUnverified: true }, "owner approved provisional mint list")).status).toBe(200);
    expect((await final()).sort()).toEqual(["pending_one", "plain_one"]);

    const csv = parseCsv((await t.call("GET", "/admin/export.csv", { token })).text.slice(1));
    expect(csv[0]).toEqual(CSV_COLUMNS);
    const byName = Object.fromEntries(csv.slice(1).map((r) => [r[CSV_COLUMNS.indexOf("twitter_username")], r]));
    const col = (name: string, c: string) => byName[name][CSV_COLUMNS.indexOf(c)];
    expect(col("pending_one", "verification_status")).toBe("pending");
    expect(col("pending_one", "approval_status")).toBe("approved");
    expect(col("plain_one", "verification_status")).toBe("not_required");
    expect(col("plain_one", "x_auth_status")).toBe("not_started");
    expect(col("plain_one", "nft_holder_status")).toBe("not_required");
    expect(col("plain_one", "policy_version")).toBe("1");
  });
});
