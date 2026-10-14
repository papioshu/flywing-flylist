// X (Twitter) verification (spec §4). Two separate operations:
//   1. account authentication: OAuth 2.0 + PKCE proves the visitor controls an X account;
//   2. follow verification: does that verified account follow each required account?
//
// Only the 'none' provider ships. It reports `not_configured` and never calls anything.
// A real provider (paid X API) is Phase C and needs owner approval. The service below
// already enforces the cost controls a real provider must run under:
//   - activation: the provider is ignored unless ENABLED_INTEGRATIONS has x_verification
//     AND the campaign selected it;
//   - caching: a verified result is reused until verified_until (no re-check per visit);
//   - cooldown between attempts per wallet;
//   - rate limits per wallet, per X account and per IP (from the usage ledger);
//   - a daily and a total budget in provider units, reserved with one conditional UPDATE
//     before any billable call, and settled with the actual units afterwards;
//   - every billable call is recorded in provider_usage (estimated + actual units).
// A provider error is `unavailable`, never "does not follow".

import type { Db } from "./db.ts";
import { HttpError } from "./errors.ts";
import { type CampaignPolicy, xVerificationRequired } from "./policy.ts";

export const X_STATUSES = ["not_configured", "not_started", "pending", "verified", "failed", "unavailable"] as const;
export type XStatus = (typeof X_STATUSES)[number];
export type FollowStatus = XStatus | "not_required";

export class XProviderError extends Error {
  /** 'denied': the user refused or the grant is invalid (a real "no"). Everything else is 'unavailable'. */
  constructor(public kind: "denied" | "unavailable", message: string) {
    super(message);
  }
}

export interface XVerificationProvider {
  readonly id: string;
  /** False for the shipped 'none' provider. */
  readonly configured: boolean;
  /** Estimated billable units, used to reserve budget before calling. */
  readonly estimate: { auth: number; followCheckPerAccount: number };
  /** Builds the OAuth 2.0 authorize URL (PKCE S256). No API call, no cost. */
  authorizeUrl(args: { state: string; codeChallenge: string }): string;
  /** Exchanges the OAuth code and reads the authenticated user. Billable. */
  completeAuth(args: { code: string; codeVerifier: string }): Promise<{ userId: string; username: string; accessToken: string; actualUnits?: number }>;
  /** For each target account: true = follows, false = verifiably does not, null = could not tell. Billable. */
  checkFollows(args: { userId: string; accessToken: string; targetIds: string[] }): Promise<{ follows: Record<string, boolean | null>; actualUnits?: number }>;
}

/** The only provider shipped: X verification is not configured. Never makes a network call. */
export const notConfiguredXProvider: XVerificationProvider = {
  id: "none",
  configured: false,
  estimate: { auth: 0, followCheckPerAccount: 0 },
  authorizeUrl() {
    throw new XProviderError("unavailable", "X verification is not configured.");
  },
  async completeAuth() {
    throw new XProviderError("unavailable", "X verification is not configured.");
  },
  async checkFollows() {
    throw new XProviderError("unavailable", "X verification is not configured.");
  },
};

// Per-hour caps on billable X operations (on top of the budget).
export const X_RATE_LIMITS = { perWallet: 5, perXAccount: 5, perIp: 20 };
const OAUTH_STATE_TTL_MS = 10 * 60_000;

export type XVerificationRow = {
  campaign_id: string;
  wallet_address_normalized: string;
  provider: string;
  status: XStatus;
  x_user_id: string | null;
  x_username: string | null;
  authenticated_at: Date | string | null;
  follow_status: FollowStatus;
  follows: unknown;
  follow_checked_at: Date | string | null;
  verified_until: Date | string | null;
  last_attempt_at: Date | string | null;
  attempts: number;
  error: string | null;
  policy_version: number | null;
  updated_at: Date | string;
};

const iso = (v: Date | string | null | undefined) => (v === null || v === undefined ? null : (v instanceof Date ? v : new Date(v)).toISOString());
const asJson = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

export function publicXVerification(r: XVerificationRow | null, policy: CampaignPolicy, providerActive: boolean) {
  const required = xVerificationRequired(policy);
  if (!r) {
    return {
      required,
      status: (providerActive ? "not_started" : "not_configured") as XStatus,
      followStatus: (policy.xFollowRequired ? (providerActive ? "not_started" : "not_configured") : "not_required") as FollowStatus,
      xUsername: null,
      verifiedAt: null,
    };
  }
  return {
    required,
    status: r.status,
    followStatus: r.follow_status,
    xUsername: r.status === "verified" ? r.x_username : null,
    verifiedAt: iso(r.authenticated_at),
  };
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export function createXVerificationService(deps: {
  db: Db;
  campaignId: string;
  provider: XVerificationProvider;
  enabledIntegrations: ReadonlySet<string>;
  now: () => Date;
}) {
  const { db, campaignId, provider } = deps;

  /** The provider only counts when it's real, activated, and selected by the campaign. */
  function isActive(policy: CampaignPolicy): boolean {
    return provider.configured && deps.enabledIntegrations.has("x_verification") && policy.xProvider === provider.id && policy.xProvider !== "none";
  }

  async function load(wallet: string): Promise<XVerificationRow | null> {
    const rows = await db.query<XVerificationRow>(
      `select * from allowlist.x_verifications where campaign_id = $1 and wallet_address_normalized = $2`,
      [campaignId, wallet],
    );
    return rows[0] ?? null;
  }

  async function upsert(wallet: string, fields: Partial<Record<keyof XVerificationRow, unknown>>, policyVersion: number): Promise<XVerificationRow> {
    const cols = Object.keys(fields);
    const vals = Object.values(fields).map((v) => (v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v instanceof Date ? v.toISOString() : v));
    // jsonb values go in as text and are cast on the server, so every driver stores an
    // object (postgres.js would otherwise JSON-encode a pre-serialized string again).
    const isJson = (v: unknown) => v !== null && typeof v === "object" && !(v instanceof Date);
    const placeholders = cols.map((_, i) => `$${i + 6}${isJson(Object.values(fields)[i]) ? "::text::jsonb" : ""}`);
    const rows = await db.query<XVerificationRow>(
      `insert into allowlist.x_verifications (campaign_id, wallet_address_normalized, provider, policy_version, updated_at${cols.length ? ", " + cols.join(", ") : ""})
       values ($1, $2, $3, $4, $5::timestamptz${placeholders.length ? ", " + placeholders.join(", ") : ""})
       on conflict (campaign_id, wallet_address_normalized) do update set
         provider = excluded.provider, policy_version = excluded.policy_version, updated_at = excluded.updated_at
         ${cols.map((c) => `, ${c} = excluded.${c}`).join("")}
       returning *`,
      [campaignId, wallet, provider.id, policyVersion, deps.now().toISOString(), ...vals],
    );
    return rows[0];
  }

  async function recentCount(column: "wallet_address_normalized" | "x_user_id" | "ip_hash", value: string): Promise<number> {
    const rows = await db.query<{ n: string | number }>(
      `select count(*) as n from allowlist.provider_usage
       where provider = $1 and ${column} = $2 and created_at > $3::timestamptz and outcome <> 'refused'`,
      [provider.id, value, new Date(deps.now().getTime() - 3600_000).toISOString()],
    );
    return Number(rows[0].n);
  }

  /**
   * Reserves `units` of the campaign's X budget, or refuses. One conditional UPDATE on
   * the counter row: concurrent reservations serialize on the row lock and the limit
   * is re-checked against the latest value, so the budget can't be overshot.
   */
  async function reserve(policy: CampaignPolicy, units: number, meta: { operation: string; wallet: string; xUserId?: string | null; ipHash: string }): Promise<number> {
    const t = deps.now();
    const day = t.toISOString().slice(0, 10);
    await db.query(
      `insert into allowlist.provider_budgets (campaign_id, provider, day) values ($1, $2, $3::date) on conflict do nothing`,
      [campaignId, provider.id, day],
    );
    const ok = await db.query(
      `update allowlist.provider_budgets set
         used_today = (case when day = $3::date then used_today else 0 end) + $4,
         used_total = used_total + $4,
         day = $3::date
       where campaign_id = $1 and provider = $2
         and (case when day = $3::date then used_today else 0 end) + $4 <= $5
         and used_total + $4 <= $6
       returning used_today`,
      [campaignId, provider.id, day, units, policy.xBudgetDailyUnits, policy.xBudgetTotalUnits],
    );
    const outcome = ok.length ? "reserved" : "refused";
    const rows = await db.query<{ id: number | string }>(
      `insert into allowlist.provider_usage (campaign_id, provider, operation, wallet_address_normalized, x_user_id, ip_hash, estimated_units, outcome, detail, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz) returning id`,
      [campaignId, provider.id, meta.operation, meta.wallet, meta.xUserId ?? null, meta.ipHash, units, outcome, ok.length ? null : "budget_exhausted", t.toISOString()],
    );
    if (!ok.length) {
      throw new HttpError(503, "X_BUDGET_EXHAUSTED", "X verification is temporarily unavailable. Please try again later.", { xStatus: "unavailable" });
    }
    return Number(rows[0].id);
  }

  /** Records the actual units used and moves the budget counter by (actual - estimated). */
  async function settle(usageId: number, estimated: number, actual: number, outcome: "ok" | "error", detail: string | null): Promise<void> {
    await db.query(
      `update allowlist.provider_usage set actual_units = $2, outcome = $3, detail = $4, completed_at = $5::timestamptz where id = $1`,
      [usageId, actual, outcome, detail, deps.now().toISOString()],
    );
    if (actual !== estimated) {
      await db.query(
        `update allowlist.provider_budgets set used_today = greatest(0, used_today + $3), used_total = greatest(0, used_total + $3)
         where campaign_id = $1 and provider = $2`,
        [campaignId, provider.id, actual - estimated],
      );
    }
  }

  async function enforceLimits(policy: CampaignPolicy, row: XVerificationRow | null, wallet: string, ipHash: string, xUserId?: string | null) {
    if (row?.last_attempt_at) {
      const wait = new Date(iso(row.last_attempt_at)!).getTime() + policy.xRetryCooldownSeconds * 1000 - deps.now().getTime();
      if (wait > 0) throw new HttpError(429, "X_COOLDOWN", `Please wait ${Math.ceil(wait / 1000)}s before trying X verification again.`, { retryAfterSeconds: Math.ceil(wait / 1000) });
    }
    if ((await recentCount("wallet_address_normalized", wallet)) >= X_RATE_LIMITS.perWallet) throw new HttpError(429, "RATE_LIMITED", "Too many X verification attempts for this wallet. Try again later.");
    if ((await recentCount("ip_hash", ipHash)) >= X_RATE_LIMITS.perIp) throw new HttpError(429, "RATE_LIMITED", "Too many X verification attempts. Try again later.");
    if (xUserId && (await recentCount("x_user_id", xUserId)) >= X_RATE_LIMITS.perXAccount) throw new HttpError(429, "RATE_LIMITED", "Too many verification attempts for this X account. Try again later.");
  }

  function cachedVerified(row: XVerificationRow | null, policy: CampaignPolicy): boolean {
    if (!row || row.status !== "verified") return false;
    if (policy.xFollowRequired && row.follow_status !== "verified") return false;
    return !!row.verified_until && new Date(iso(row.verified_until)!).getTime() > deps.now().getTime();
  }

  return {
    isActive,
    load,

    /** Step 1: begin OAuth. Free (no API call). Returns the authorize URL, or the current status. */
    async start(args: { wallet: string; policy: CampaignPolicy; policyVersion: number; ipHash: string }) {
      const row = await load(args.wallet);
      if (!isActive(args.policy)) {
        const r = await upsert(args.wallet, { status: "not_configured", follow_status: args.policy.xFollowRequired ? "not_configured" : "not_required" }, args.policyVersion);
        return { status: r.status, authorizeUrl: null as string | null, cached: false };
      }
      if (cachedVerified(row, args.policy)) return { status: "verified" as XStatus, authorizeUrl: null, cached: true };
      await enforceLimits(args.policy, row, args.wallet, args.ipHash);

      const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
      const codeVerifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
      const codeChallenge = b64url(await sha256(codeVerifier));
      const t = deps.now();
      await db.query(
        `insert into allowlist.x_oauth_states (state_hash, campaign_id, wallet_address_normalized, code_verifier, created_at, expires_at)
         values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)`,
        [hex(await sha256(state)), campaignId, args.wallet, codeVerifier, t.toISOString(), new Date(t.getTime() + OAUTH_STATE_TTL_MS).toISOString()],
      );
      await upsert(args.wallet, { status: "pending", follow_status: args.policy.xFollowRequired ? "pending" : "not_required", error: null }, args.policyVersion);
      return { status: "pending" as XStatus, authorizeUrl: provider.authorizeUrl({ state, codeChallenge }), cached: false };
    },

    /** Step 2: OAuth callback. Authenticates the X account, then checks required follows. Billable. */
    async complete(args: { wallet: string; policy: CampaignPolicy; policyVersion: number; ipHash: string; state: unknown; code: unknown }) {
      if (!isActive(args.policy)) throw new HttpError(409, "X_NOT_CONFIGURED", "X verification is not configured for this campaign.", { xStatus: "not_configured" });
      if (typeof args.state !== "string" || typeof args.code !== "string" || args.state.length > 200 || args.code.length > 2000) {
        throw new HttpError(400, "INVALID_REQUEST", "Missing X authorization details.");
      }
      const t = deps.now();
      // Consume the state atomically: single use, unexpired, and bound to THIS wallet.
      const consumed = await db.query<{ code_verifier: string }>(
        `update allowlist.x_oauth_states set used_at = $3::timestamptz
         where state_hash = $1 and wallet_address_normalized = $2 and campaign_id = $4 and used_at is null and expires_at > $3::timestamptz
         returning code_verifier`,
        [hex(await sha256(args.state)), args.wallet, t.toISOString(), campaignId],
      );
      if (consumed.length === 0) throw new HttpError(400, "X_STATE_INVALID", "That X authorization expired or was already used. Please start again.");

      const row = await load(args.wallet);
      await enforceLimits({ ...args.policy, xRetryCooldownSeconds: 0 }, row, args.wallet, args.ipHash);
      const targets = args.policy.xFollowRequired ? args.policy.requiredXAccounts : [];
      const estimated = provider.estimate.auth + targets.length * provider.estimate.followCheckPerAccount;
      const usageId = await reserve(args.policy, estimated, { operation: "auth_and_follows", wallet: args.wallet, ipHash: args.ipHash });
      const attempt = { last_attempt_at: t, attempts: (row?.attempts ?? 0) + 1 };

      let user: Awaited<ReturnType<XVerificationProvider["completeAuth"]>>;
      let actual = 0;
      try {
        user = await provider.completeAuth({ code: args.code, codeVerifier: consumed[0].code_verifier });
        actual += user.actualUnits ?? provider.estimate.auth;
      } catch (e) {
        const kind = e instanceof XProviderError ? e.kind : "unavailable";
        await settle(usageId, estimated, provider.estimate.auth, "error", e instanceof Error ? e.message : String(e));
        const r = await upsert(args.wallet, { ...attempt, status: kind === "denied" ? "failed" : "unavailable", error: e instanceof Error ? e.message.slice(0, 300) : "error" }, args.policyVersion);
        return { status: r.status, followStatus: r.follow_status };
      }
      if (!/^[0-9]{1,25}$/.test(user.userId) || !/^[A-Za-z0-9_]{1,15}$/.test(user.username)) {
        await settle(usageId, estimated, actual, "error", "provider returned a malformed user");
        const r = await upsert(args.wallet, { ...attempt, status: "unavailable", error: "provider returned a malformed user" }, args.policyVersion);
        return { status: r.status, followStatus: r.follow_status };
      }
      if ((await recentCount("x_user_id", user.userId)) >= X_RATE_LIMITS.perXAccount) {
        await settle(usageId, estimated, actual, "error", "x account rate limited");
        throw new HttpError(429, "RATE_LIMITED", "Too many verification attempts for this X account. Try again later.");
      }
      await db.query(`update allowlist.provider_usage set x_user_id = $2 where id = $1`, [usageId, user.userId]);

      let followStatus: FollowStatus = "not_required";
      let follows: { accountId: string; username: string; following: boolean | null }[] = [];
      let error: string | null = null;
      if (targets.length) {
        try {
          const res = await provider.checkFollows({ userId: user.userId, accessToken: user.accessToken, targetIds: targets.map((a) => a.id) });
          actual += res.actualUnits ?? targets.length * provider.estimate.followCheckPerAccount;
          follows = targets.map((a) => ({ accountId: a.id, username: a.username, following: res.follows[a.id] ?? null }));
          // Only an explicit `false` is a "no". Unknown answers make the result unavailable, never failed.
          followStatus = follows.some((f) => f.following === null) ? "unavailable" : follows.every((f) => f.following) ? "verified" : "failed";
        } catch (e) {
          actual += targets.length * provider.estimate.followCheckPerAccount;
          followStatus = "unavailable";
          follows = targets.map((a) => ({ accountId: a.id, username: a.username, following: null }));
          error = e instanceof Error ? e.message.slice(0, 300) : "error";
        }
      }
      await settle(usageId, estimated, actual, error ? "error" : "ok", error);
      const fullyVerified = followStatus === "verified" || followStatus === "not_required";
      const r = await upsert(
        args.wallet,
        {
          ...attempt,
          status: "verified",
          x_user_id: user.userId,
          x_username: user.username,
          authenticated_at: t,
          follow_status: followStatus,
          follows,
          follow_checked_at: targets.length ? t : null,
          verified_until: fullyVerified ? new Date(t.getTime() + args.policy.xVerificationCacheSeconds * 1000) : null,
          error,
        },
        args.policyVersion,
      );
      return { status: r.status, followStatus: r.follow_status };
    },

    /** Does this wallet currently satisfy the campaign's X requirements? */
    satisfied(row: XVerificationRow | null, policy: CampaignPolicy): boolean {
      if (!xVerificationRequired(policy)) return true;
      if (!row || row.status !== "verified") return false;
      if (policy.xFollowRequired) {
        if (row.follow_status !== "verified") return false;
        const have = new Set((asJson(row.follows) as { accountId: string; following: boolean | null }[]).filter((f) => f.following).map((f) => f.accountId));
        if (!policy.requiredXAccounts.every((a) => have.has(a.id))) return false; // requirement changed since the check
      }
      return true;
    },

    /** Whether the X requirement is definitively failed (a verified "no"), as opposed to still pending. */
    failed(row: XVerificationRow | null, policy: CampaignPolicy): boolean {
      if (!xVerificationRequired(policy) || !row) return false;
      return row.status === "failed" || (policy.xFollowRequired && row.status === "verified" && row.follow_status === "failed");
    },
  };
}
