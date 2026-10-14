// FLY WING GENESIS allowlist API. Runtime-agnostic: a plain (Request) => Response
// handler used by the Supabase Edge Function (Deno) and the local dev server / tests (Node).

import { getAddress, isAddress } from "viem";
import { parseSiweMessage } from "viem/siwe";
import type { AppConfig } from "./config.ts";
import { toCsv } from "./csv.ts";
import { attachRedemption, createAccessCodes, normalizeAccessCode, redeemAccessCode, releaseRedemption, revokeAccessCode, type AccessCodeRow } from "./accessCodes.ts";
import type { Db } from "./db.ts";
import { checkEthBalance, COINBASE_SPOT_URL, type Fetch } from "./eligibility.ts";
import { HttpError } from "./errors.ts";
import { type CommunityEligibilityProvider, createNftOwnershipProvider, type NftOwnershipResult, type PartnerCollection } from "./nft.ts";
import {
  applyPolicyPatch,
  type CampaignPolicy,
  describePolicy,
  INTEGRATIONS,
  POLICY_SELECT,
  requiresAccessCode,
  requiresCommunity,
  rowToPolicy,
  updatePolicy,
  xVerificationRequired,
} from "./policy.ts";
import { checkSiweMessage, CLOCK_SKEW_MS, type Purpose, SIWE_STATEMENTS, type SignatureVerifier } from "./siwe.ts";
import { parseTwitterHandle, twitterProfileUrl } from "./twitter.ts";
import { createXVerificationService, notConfiguredXProvider, publicXVerification, type XVerificationProvider, type XVerificationRow } from "./xverify.ts";

export type AppDeps = {
  db: Db;
  config: AppConfig;
  verifySignature: SignatureVerifier;
  now?: () => Date;
  /** Network seam for eligibility reads (RPC + price). Defaults to global fetch. */
  fetch?: Fetch;
  /**
   * X verification provider. Defaults to the 'none' provider (not configured). A real
   * provider is Phase C and still only runs when ENABLED_INTEGRATIONS has x_verification
   * and the campaign selects it. Tests inject a fake here.
   */
  xProvider?: XVerificationProvider;
  /** Community-rule provider. Defaults to on-chain NFT ownership over the eligibility RPCs. */
  communityProvider?: CommunityEligibilityProvider;
};

// Spec §7. `approved` is an admin decision and the only status in the final mint export.
export const REGISTRATION_STATUSES = ["registered", "pending_verification", "eligible", "ineligible", "approved", "rejected"] as const;
export const ELIGIBILITY_STATUSES = ["not_checked", "pending", "eligible", "ineligible"] as const;

export const CHAIN_NAMES: Record<number, string> = { 1: "Ethereum", 4663: "Robinhood Chain" };

export const CSV_COLUMNS = [
  "registration_id",
  "campaign_id",
  "wallet_address",
  "twitter_username",
  "twitter_url",
  "twitter_verification",
  "registration_status",
  "eligibility_status",
  "access_method",
  "registered_at_utc",
  "updated_at_utc",
  "eligibility_checked_at_utc",
  "eligibility_chain_id",
  "eth_balance_wei",
  "eth_balance_eth",
  "eth_usd_price",
  "eth_usd_price_source",
  "eth_usd_price_at_utc",
  "balance_usd_at_registration",
  "signin_chain_id",
  "policy_version",
  "verification_status",
  "x_auth_status",
  "x_verified_user_id",
  "x_follow_status",
  "nft_holder_status",
  "qualifying_collections",
  "access_code",
  "community_attribution",
  "approval_status",
  "admin_notes",
];

/**
 * Export presets. `final` is approved-only, and also excludes approved wallets whose
 * required verifications are incomplete unless the campaign policy explicitly allows it
 * (finalExportIncludesUnverified). Pending or merely eligible wallets never reach it.
 */
export const EXPORT_PRESETS: Record<string, { label: string; statuses: string[] | null; completedVerificationOnly?: boolean }> = {
  all: { label: "all", statuses: null },
  pending_verification: { label: "pending-verification", statuses: ["pending_verification"] },
  eligible: { label: "eligible-approved", statuses: ["eligible", "approved"] },
  final: { label: "final-mint-allowlist", statuses: ["approved"], completedVerificationOnly: true },
};

export const VERIFICATION_STATUSES = ["not_required", "pending", "verified", "failed"] as const;

const approvalStatus = (registrationStatus: string) =>
  registrationStatus === "approved" ? "approved" : registrationStatus === "rejected" ? "rejected" : "undecided";

// Registrations joined with their verification records, for the admin list and exports.
// Column names stay unique so filters can use them unqualified.
const REGISTRATION_VIEW = `(
  select r.*,
         xv.status as x_status, xv.x_user_id as x_verified_user_id, xv.x_username as x_verified_username,
         xv.follow_status as x_follow_status, xv.follows as x_follows,
         ac.code_prefix as access_code_prefix, ac.label as access_code_label,
         nc.result as nft_result, nc.snapshots as nft_snapshots
  from allowlist.registrations r
  left join allowlist.x_verifications xv on xv.campaign_id = r.campaign_id and xv.wallet_address_normalized = r.wallet_address_normalized
  left join allowlist.access_codes ac on ac.id = r.access_code_id
  left join allowlist.nft_ownership_checks nc on nc.id = r.nft_check_id
) r`;

// Requests per client IP per minute, by bucket.
const RATE_LIMITS: Record<string, number> = {
  campaign: 60,
  nonce: 20,
  verify: 20,
  me: 60,
  eligibility: 10,
  register: 10,
  verification: 20,
  admin: 300,
  export: 10,
  admin_test: 10,
};

/** Formats an integer with `decimals` implied decimals as a plain decimal string. */
export function formatUnits(value: bigint | string | null | undefined, decimals: number, maxFraction = decimals): string | null {
  if (value === null || value === undefined) return null;
  const v = BigInt(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = decimals === 0 ? "" : (abs % scale).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

const centsToUsd = (c: bigint | string | null | undefined) => {
  if (c === null || c === undefined) return null;
  const v = BigInt(c);
  return `${v / 100n}.${(v % 100n).toString().padStart(2, "0")}`;
};

const MAX_BODY_BYTES = 10_000;

type Session = {
  tokenHash: string;
  wallet: string; // normalized (lowercase)
  chainId: number;
  role: "registrant" | "admin";
  createdAt: Date;
};

type RegistrationRow = {
  id: string;
  campaign_id: string;
  wallet_address: string;
  wallet_address_normalized: string;
  twitter_username: string;
  twitter_username_normalized: string;
  twitter_verified: boolean;
  registration_status: string;
  registered_at: Date | string;
  updated_at: Date | string;
  verification_chain_id: number;
  verification_method: string;
  verification_timestamp: Date | string;
  eligibility_status: string;
  eligibility_checked_at: Date | string | null;
  admin_notes: string | null;
  access_method: string;
  eligibility_check_id: string | null;
  eth_balance_wei: string | null;
  eth_usd_price: string | null;
  eth_usd_price_decimals: number | null;
  eth_usd_price_source: string | null;
  eth_usd_price_at: Date | string | null;
  eth_balance_usd_cents: string | null;
  eligibility_chain_id: number | null;
  policy_version: number | null;
  verification_status: string;
  nft_status: string;
  nft_check_id: string | null;
  access_code_id: string | null;
  community_attribution: string | null;
  // Joined in REGISTRATION_VIEW (admin list / export only).
  x_status?: string | null;
  x_verified_user_id?: string | null;
  x_verified_username?: string | null;
  x_follow_status?: string | null;
  x_follows?: unknown;
  access_code_prefix?: string | null;
  access_code_label?: string | null;
  nft_result?: string | null;
  nft_snapshots?: unknown;
  handle_shared_count?: number | string;
};

type CheckRow = {
  id: string;
  wallet_address_normalized: string;
  checked_at: Date | string;
  expires_at: Date | string;
  result: "eligible" | "ineligible" | "unavailable";
  policy: unknown;
  eth_usd_price: string | null;
  eth_usd_price_decimals: number | null;
  eth_usd_price_source: string | null;
  eth_usd_price_at: Date | string | null;
  best_chain_id: number | null;
  best_balance_wei: string | null;
  best_balance_usd_cents: string | null;
  chains: unknown;
  error: string | null;
  policy_version: number | null;
  nft_check_id: string | null;
};

const asJson = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

type NftCheckRow = {
  id: string;
  result: NftOwnershipResult["result"];
  rule: string;
  min_collections: number;
  snapshots: unknown;
  checked_at: Date | string;
};

/** A registrant's own community (partner NFT) result: which collections qualified, nothing about anyone else. */
function publicCommunity(n: NftCheckRow | null) {
  if (!n) return null;
  const snaps = asJson(n.snapshots) as { displayName: string; chainId: number; result: string; quantity?: string }[];
  return {
    result: n.result,
    rule: n.rule,
    minCollections: Number(n.min_collections),
    collections: snaps.map((x) => ({ displayName: x.displayName, chainId: x.chainId, result: x.result, quantity: x.quantity ?? null })),
  };
}

/** What a registrant may see about their own eligibility check. Their own wallet's data only. */
function publicEligibility(c: CheckRow, minUsdCents: number, cached: boolean, nft: NftCheckRow | null = null) {
  const chains = (asJson(c.chains) as { chainId: number; status: string; balanceWei?: string; usdCents?: string; passed?: boolean }[]).map((x) => ({
    chainId: x.chainId,
    chainName: CHAIN_NAMES[x.chainId] ?? `Chain ${x.chainId}`,
    status: x.status,
    balanceEth: x.balanceWei ? formatUnits(x.balanceWei, 18, 6) : null,
    balanceUsd: x.usdCents ? centsToUsd(x.usdCents) : null,
    passed: x.passed ?? null,
  }));
  return {
    result: c.result,
    minBalanceUsd: centsToUsd(BigInt(minUsdCents)),
    ethUsdPrice: c.eth_usd_price ? formatUnits(c.eth_usd_price, c.eth_usd_price_decimals ?? 8, 2) : null,
    priceSource: c.eth_usd_price_source,
    priceAt: iso(c.eth_usd_price_at),
    checkedAt: iso(c.checked_at),
    chains,
    community: publicCommunity(nft),
    cached,
  };
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** Fields a registrant may see about their own registration. Never includes admin notes. */
function publicRegistration(r: RegistrationRow) {
  return {
    walletAddress: r.wallet_address,
    twitterUsername: r.twitter_username,
    twitterVerified: r.twitter_verified,
    registrationStatus: r.registration_status,
    eligibilityStatus: r.eligibility_status,
    verificationStatus: r.verification_status,
    registeredAt: iso(r.registered_at),
    updatedAt: iso(r.updated_at),
  };
}

function qualifyingCollections(r: RegistrationRow): string[] {
  if (!r.nft_snapshots) return [];
  return (asJson(r.nft_snapshots) as { displayName: string; chainId: number; result: string }[])
    .filter((x) => x.result === "qualified")
    .map((x) => `${x.displayName} (chain ${x.chainId})`);
}

function adminRegistration(r: RegistrationRow) {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    walletAddress: r.wallet_address,
    twitterUsername: r.twitter_username,
    twitterUsernameNormalized: r.twitter_username_normalized,
    twitterUrl: twitterProfileUrl(r.twitter_username_normalized),
    twitterVerified: r.twitter_verified,
    registrationStatus: r.registration_status,
    eligibilityStatus: r.eligibility_status,
    eligibilityCheckedAt: iso(r.eligibility_checked_at),
    registeredAt: iso(r.registered_at),
    updatedAt: iso(r.updated_at),
    verificationChainId: r.verification_chain_id,
    verificationMethod: r.verification_method,
    verificationTimestamp: iso(r.verification_timestamp),
    adminNotes: r.admin_notes,
    accessMethod: r.access_method,
    eligibilityChainId: r.eligibility_chain_id,
    ethBalanceWei: r.eth_balance_wei === null ? null : String(r.eth_balance_wei),
    ethBalanceEth: formatUnits(r.eth_balance_wei, 18),
    ethUsdPrice: r.eth_usd_price === null ? null : formatUnits(r.eth_usd_price, r.eth_usd_price_decimals ?? 8),
    ethUsdPriceSource: r.eth_usd_price_source,
    ethUsdPriceAt: iso(r.eth_usd_price_at),
    balanceUsd: centsToUsd(r.eth_balance_usd_cents),
    policyVersion: r.policy_version,
    verificationStatus: r.verification_status,
    approvalStatus: approvalStatus(r.registration_status),
    xAuthStatus: r.x_status ?? "not_started",
    xVerifiedUserId: r.x_status === "verified" ? (r.x_verified_user_id ?? null) : null,
    xVerifiedUsername: r.x_status === "verified" ? (r.x_verified_username ?? null) : null,
    xFollowStatus: r.x_follow_status ?? "not_required",
    xFollows: r.x_follows ? asJson(r.x_follows) : [],
    nftStatus: r.nft_status,
    qualifyingCollections: qualifyingCollections(r),
    accessCode: r.access_code_prefix ? { prefix: r.access_code_prefix, label: r.access_code_label ?? null } : null,
    communityAttribution: r.community_attribution,
    handleSharedCount: r.handle_shared_count === undefined ? undefined : Number(r.handle_shared_count),
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomAlphanumeric(length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const out: string[] = [];
  // Rejection sampling: 248 = 62 * 4, so bytes >= 248 are discarded to avoid modulo bias.
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < 248 && out.length < length) out.push(alphabet[b % 62]);
    }
  }
  return out.join("");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Prefer headers set by the hosting edge (Cloudflare fronts Supabase). For
// X-Forwarded-For take the LAST hop: proxies append, so earlier entries can be
// spoofed by the client.
function clientIp(req: Request): string {
  const direct = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip");
  if (direct) return direct.trim();
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",").pop()!.trim();
  return "unknown";
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function utcDate(value: string | null, label: string): Date | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, "INVALID_FILTER", `${label} must be YYYY-MM-DD.`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, "INVALID_FILTER", `${label} is not a valid date.`);
  return d;
}

export function createApp(deps: AppDeps) {
  const { db, config, verifySignature } = deps;
  const now = deps.now ?? (() => new Date());
  const fetchFn: Fetch = deps.fetch ?? ((...args) => fetch(...args));

  // ---------- plumbing ----------

  function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("origin");
    const headers: Record<string, string> = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Origin",
    };
    if (origin && config.allowedOrigins.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Headers"] = "authorization, content-type";
      headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, OPTIONS";
      headers["Access-Control-Expose-Headers"] = "content-disposition";
      headers["Access-Control-Max-Age"] = "600";
    }
    return headers;
  }

  function json(req: Request, status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8" },
    });
  }

  async function readJson(req: Request): Promise<Record<string, unknown>> {
    const type = req.headers.get("content-type") ?? "";
    // Requiring JSON forces a CORS preflight, so other sites cannot submit forms here.
    if (!type.toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Expected application/json.");
    }
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body too large.");
    try {
      const body = JSON.parse(text);
      if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
    } catch {
      // fall through
    }
    throw new HttpError(400, "INVALID_JSON", "Request body must be a JSON object.");
  }

  async function rateLimit(req: Request, bucket: string): Promise<void> {
    const limit = RATE_LIMITS[bucket];
    const t = now().getTime();
    const windowStart = new Date(t - (t % 60_000)).toISOString();
    const key = await sha256Hex(`${config.ipHashSalt}:${clientIp(req)}`);
    const rows = await db.query<{ count: number }>(
      `insert into allowlist.rate_limits (bucket, key, window_start, count)
       values ($1, $2, $3::timestamptz, 1)
       on conflict (bucket, key, window_start) do update set count = allowlist.rate_limits.count + 1
       returning count`,
      [bucket, key, windowStart],
    );
    if (Number(rows[0].count) > limit) {
      throw new HttpError(429, "RATE_LIMITED", "Too many requests. Please wait a minute and try again.");
    }
    // Opportunistic housekeeping (~1% of requests) so the small tables never grow unbounded.
    if (Math.random() < 0.01) await housekeeping();
  }

  async function housekeeping(): Promise<void> {
    const cutoff = new Date(now().getTime() - 24 * 3600_000).toISOString();
    await db.query(`delete from allowlist.rate_limits where window_start < $1::timestamptz`, [cutoff]);
    await db.query(`delete from allowlist.auth_nonces where expires_at < $1::timestamptz`, [cutoff]);
    await db.query(`delete from allowlist.sessions where expires_at < $1::timestamptz`, [cutoff]);
  }

  async function requireSession(req: Request): Promise<Session> {
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    if (!match) throw new HttpError(401, "UNAUTHENTICATED", "Please connect and verify your wallet.");
    const tokenHash = await sha256Hex(match[1]);
    const rows = await db.query<{
      wallet_address_normalized: string;
      chain_id: number;
      role: "registrant" | "admin";
      created_at: Date | string;
    }>(
      `select wallet_address_normalized, chain_id, role, created_at from allowlist.sessions
       where token_hash = $1 and revoked_at is null and expires_at > $2::timestamptz`,
      [tokenHash, now().toISOString()],
    );
    if (rows.length === 0) throw new HttpError(401, "SESSION_EXPIRED", "Your session has expired. Please verify your wallet again.");
    const r = rows[0];
    return {
      tokenHash,
      wallet: r.wallet_address_normalized,
      chainId: Number(r.chain_id),
      role: r.role,
      createdAt: new Date(iso(r.created_at)!),
    };
  }

  async function requireAdmin(req: Request): Promise<Session> {
    const session = await requireSession(req);
    // Re-check the configured admin list on every request, so removing a wallet
    // from ADMIN_WALLETS revokes access immediately.
    if (session.role !== "admin" || !config.adminWallets.includes(session.wallet)) {
      throw new HttpError(403, "FORBIDDEN", "This wallet is not an allowlist administrator.");
    }
    return session;
  }

  async function loadCampaignWithPolicy() {
    const rows = await db.query<Record<string, any>>(`select ${POLICY_SELECT} from allowlist.campaigns where id = $1`, [config.campaignId]);
    if (rows.length === 0) throw new HttpError(500, "CAMPAIGN_MISSING", "FLYLIST campaign is not configured.");
    const c = rows[0];
    const policy = rowToPolicy(c);
    const t = now().getTime();
    const isOpen =
      policy.status === "open" &&
      (!policy.opensAt || new Date(policy.opensAt).getTime() <= t) &&
      (!policy.closesAt || new Date(policy.closesAt).getTime() > t);
    return {
      campaign: { id: c.id as string, name: c.name as string, status: policy.status, opensAt: policy.opensAt, closesAt: policy.closesAt, isOpen },
      policy,
      policyVersion: Number(c.policy_version),
    };
  }

  async function loadCollections(activeOnly: boolean): Promise<PartnerCollection[]> {
    const rows = await db.query<{
      id: string;
      display_name: string;
      chain_id: number;
      contract_address: string;
      standard: PartnerCollection["standard"];
      min_quantity: number;
      token_ids: string[] | string;
      active: boolean;
    }>(
      `select * from allowlist.partner_collections where campaign_id = $1 ${activeOnly ? "and active" : ""} order by created_at, id`,
      [config.campaignId],
    );
    return rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      chainId: Number(r.chain_id),
      contractAddress: r.contract_address,
      standard: r.standard,
      minQuantity: Number(r.min_quantity),
      tokenIds: Array.isArray(r.token_ids) ? r.token_ids : String(r.token_ids).replace(/[{}]/g, "").split(",").filter(Boolean),
      active: r.active,
    }));
  }

  /** Public campaign info, including the rules an applicant must meet (rules, not data). */
  async function loadCampaign() {
    const { campaign, policy } = await loadCampaignWithPolicy();
    const community = requiresCommunity(policy) || policy.accessMode === "hybrid";
    const collections = community ? await loadCollections(true) : [];
    return {
      ...campaign,
      requirements: {
        accessMode: policy.accessMode,
        accessCodeRequired: requiresAccessCode(policy),
        accessCodeAccepted: policy.accessMode === "invite_code" || policy.accessMode === "hybrid",
        ethBalance: policy.ethBalanceCheckEnabled
          ? {
              minUsd: centsToUsd(BigInt(policy.minEthBalanceUsdCents)),
              chains: policy.ethBalanceChainIds.map((id) => ({ chainId: id, chainName: CHAIN_NAMES[id] ?? `Chain ${id}` })),
              rule: "any_one_chain",
            }
          : null,
        xAuthRequired: policy.xAuthRequired,
        xFollowRequired: policy.xFollowRequired,
        requiredXAccounts: policy.xFollowRequired ? policy.requiredXAccounts.map((a) => a.username) : [],
        community: community
          ? {
              rule: policy.nftRule,
              minCollections: policy.nftMinCollections,
              collections: collections.map((c) => ({ displayName: c.displayName, chainId: c.chainId, contractAddress: c.contractAddress, standard: c.standard })),
            }
          : null,
      },
    };
  }

  // ---------- eligibility ----------

  const providerConfig = {
    rpcUrls: config.eligibilityRpcUrls,
    priceChainId: 1,
    chainlinkFeed: config.chainlinkEthUsdFeed,
    priceMaxAgeSeconds: config.priceMaxAgeSeconds,
    coinbaseUrl: COINBASE_SPOT_URL,
    timeoutMs: config.providerTimeoutMs,
  };

  const communityProvider =
    deps.communityProvider ?? createNftOwnershipProvider({ fetch: fetchFn, rpcUrls: config.eligibilityRpcUrls, timeoutMs: config.providerTimeoutMs });

  const xService = createXVerificationService({
    db,
    campaignId: config.campaignId,
    provider: deps.xProvider ?? notConfiguredXProvider,
    enabledIntegrations: config.enabledIntegrations,
    now,
  });

  async function cachedCheck(wallet: string, policyVersion: number): Promise<CheckRow | null> {
    // A cached result only counts if it was computed under the policy in force now.
    const rows = await db.query<CheckRow>(
      `select * from allowlist.eligibility_checks
       where campaign_id = $1 and wallet_address_normalized = $2 and expires_at > $3::timestamptz
         and result in ('eligible', 'ineligible') and policy_version = $4
       order by checked_at desc limit 1`,
      [config.campaignId, wallet, now().toISOString(), policyVersion],
    );
    return rows[0] ?? null;
  }

  async function loadNftCheck(id: string | null): Promise<NftCheckRow | null> {
    if (!id) return null;
    const rows = await db.query<NftCheckRow>(`select * from allowlist.nft_ownership_checks where id = $1`, [id]);
    return rows[0] ?? null;
  }

  async function runCommunityCheck(wallet: string, policy: CampaignPolicy, policyVersion: number, purpose: "registration" | "admin_test"): Promise<NftCheckRow> {
    if (!config.enabledIntegrations.has("community_gating") && purpose === "registration") {
      // Defensive: policy validation already refuses this, but never run gating that wasn't activated.
      throw new HttpError(503, "ELIGIBILITY_UNAVAILABLE", "Community verification is not enabled.");
    }
    const collections = await loadCollections(true);
    const r = await communityProvider.evaluate({ wallet, collections, rule: policy.nftRule, minCollections: policy.nftMinCollections });
    const rows = await db.query<NftCheckRow>(
      `insert into allowlist.nft_ownership_checks (campaign_id, wallet_address_normalized, purpose, checked_at, policy_version, rule, min_collections, result, snapshots, error)
       values ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9::text::jsonb, $10) returning *`,
      [config.campaignId, wallet, purpose, now().toISOString(), policyVersion, r.rule, r.minCollections, r.result, JSON.stringify(r.snapshots), r.error ?? null],
    );
    return rows[0];
  }

  /**
   * Returns this wallet's eligibility under the campaign's current policy: a recent
   * server-computed result if one exists, otherwise a fresh evaluation (stored).
   * Checks run as a list: the ETH balance check, then (only when the access mode needs
   * it) the community rule. Any definitive "no" is ineligible; otherwise an outage is
   * unavailable, never ineligible.
   */
  async function evaluateEligibility(
    wallet: string,
    policy: CampaignPolicy,
    policyVersion: number,
  ): Promise<{ check: CheckRow; cached: boolean; nft: NftCheckRow | null }> {
    const hit = await cachedCheck(wallet, policyVersion);
    if (hit) return { check: hit, cached: true, nft: await loadNftCheck(hit.nft_check_id) };

    const recent = await db.query<{ n: string | number }>(
      `select count(*) as n from allowlist.eligibility_checks
       where campaign_id = $1 and wallet_address_normalized = $2 and checked_at > $3::timestamptz`,
      [config.campaignId, wallet, new Date(now().getTime() - 600_000).toISOString()],
    );
    if (Number(recent[0].n) >= config.eligibilityChecksPerWallet) {
      throw new HttpError(429, "RATE_LIMITED", "Too many eligibility checks for this wallet. Please wait a few minutes.");
    }

    const checkedAt = now();
    let ethResult: CheckRow["result"] = "eligible"; // no balance requirement in this campaign's policy
    let price = null as Awaited<ReturnType<typeof checkEthBalance>>["price"];
    let chains: unknown[] = [];
    let best = null as Awaited<ReturnType<typeof checkEthBalance>>["best"];
    const errors: string[] = [];
    if (policy.ethBalanceCheckEnabled) {
      const r = await checkEthBalance(fetchFn, providerConfig, policy, wallet, checkedAt);
      ({ price, chains, best } = r);
      ethResult = r.result;
      if (r.error) errors.push(r.error);
      if (r.result === "unavailable") console.warn("flylist: eligibility unavailable", r.error, JSON.stringify(r.chains));
    }

    // Community rule: required in 'community' and hybrid AND mode; informational in hybrid OR
    // mode (a code can stand in for it at registration).
    let nft: NftCheckRow | null = null;
    let communityResult: CheckRow["result"] = "eligible";
    if (policy.accessMode === "community" || policy.accessMode === "hybrid") {
      nft = await runCommunityCheck(wallet, policy, policyVersion, "registration");
      if (requiresCommunity(policy)) {
        communityResult = nft.result === "qualified" ? "eligible" : nft.result === "not_qualified" ? "ineligible" : "unavailable";
        if (nft.result !== "qualified") errors.push(`Community rule: ${nft.result}`);
      }
    }

    const results = [ethResult, communityResult];
    const result: CheckRow["result"] = results.includes("ineligible") ? "ineligible" : results.includes("unavailable") ? "unavailable" : "eligible";
    const expiresAt = new Date(checkedAt.getTime() + (result === "unavailable" ? 0 : config.eligibilityCacheSeconds * 1000));
    const rows = await db.query<CheckRow>(
      `insert into allowlist.eligibility_checks (
         campaign_id, wallet_address_normalized, checked_at, expires_at, result, policy,
         eth_usd_price, eth_usd_price_decimals, eth_usd_price_source, eth_usd_price_at,
         best_chain_id, best_balance_wei, best_balance_usd_cents, chains, error, policy_version, nft_check_id
       ) values ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6::text::jsonb, $7::numeric, $8, $9, $10::timestamptz,
                 $11, $12::numeric, $13::numeric, $14::text::jsonb, $15, $16, $17)
       returning *`,
      [
        config.campaignId,
        wallet,
        checkedAt.toISOString(),
        expiresAt.toISOString(),
        result,
        JSON.stringify(policy),
        price ? price.price.toString() : null,
        price ? price.decimals : null,
        price ? price.source : null,
        price ? price.at.toISOString() : null,
        best ? best.chainId : null,
        best ? best.balanceWei.toString() : null,
        best ? best.usdCents.toString() : null,
        JSON.stringify(chains),
        errors.length ? errors.join(" | ") : null,
        policyVersion,
        nft?.id ?? null,
      ],
    );
    return { check: rows[0], cached: false, nft };
  }

  /**
   * Maps the policy's verification requirements to the status a new registration gets.
   * Nothing is ever recorded as verified unless a real provider verified it. When a
   * required verification can't be completed yet, applicants are recorded as
   * pending_verification (if the admin allowed provisional registration) or refused.
   */
  function decideStatus(policy: CampaignPolicy, xRow: XVerificationRow | null): {
    registrationStatus: string;
    eligibilityStatus: string;
    verificationStatus: string;
  } {
    if (!xVerificationRequired(policy)) return { registrationStatus: "eligible", eligibilityStatus: "eligible", verificationStatus: "not_required" };
    if (xService.satisfied(xRow, policy)) return { registrationStatus: "eligible", eligibilityStatus: "eligible", verificationStatus: "verified" };
    if (xService.failed(xRow, policy)) {
      throw new HttpError(403, "X_REQUIREMENT_NOT_MET", policy.xFollowRequired
        ? "Your verified X account doesn't follow every required account yet. Follow them, then verify again."
        : "X account verification failed. Please try again.");
    }
    if (policy.allowProvisionalRegistration) {
      return { registrationStatus: "pending_verification", eligibilityStatus: "pending", verificationStatus: "pending" };
    }
    if (xService.isActive(policy)) {
      throw new HttpError(403, "X_VERIFICATION_REQUIRED", "Verify your X account first, then submit.");
    }
    throw new HttpError(403, "VERIFICATION_UNAVAILABLE", "X verification is required but not available yet. Please check back soon.");
  }

  async function checkEligibility(req: Request): Promise<Response> {
    await rateLimit(req, "eligibility");
    const session = await requireSession(req);
    const { campaign, policy, policyVersion } = await loadCampaignWithPolicy();
    const existing = await findOwnRegistration(session.wallet);
    if (existing) {
      // Already applied: nothing to evaluate, and no RPC calls spent.
      return json(req, 200, { walletAddress: getAddress(session.wallet), registration: publicRegistration(existing), eligibility: null });
    }
    if (!campaign.isOpen) throw new HttpError(403, "REGISTRATION_CLOSED", "FLYLIST registration is closed.", { campaign });
    const { check, cached, nft } = await evaluateEligibility(session.wallet, policy, policyVersion);
    return json(req, 200, {
      walletAddress: getAddress(session.wallet),
      registration: null,
      eligibility: publicEligibility(check, policy.minEthBalanceUsdCents, cached, nft),
      verification: { x: publicXVerification(await xService.load(session.wallet), policy, xService.isActive(policy)) },
    });
  }

  async function requireOpenCampaign() {
    const campaign = await loadCampaign();
    if (!campaign.isOpen) throw new HttpError(403, "REGISTRATION_CLOSED", "FLYLIST registration is closed.", { campaign });
    return campaign;
  }

  async function findOwnRegistration(wallet: string): Promise<RegistrationRow | null> {
    const rows = await db.query<RegistrationRow>(
      `select * from allowlist.registrations where campaign_id = $1 and wallet_address_normalized = $2`,
      [config.campaignId, wallet],
    );
    return rows[0] ?? null;
  }

  // ---------- auth ----------

  async function issueNonce(req: Request): Promise<Response> {
    await rateLimit(req, "nonce");
    const body = await readJson(req);
    const address = body.address;
    const chainId = body.chainId;
    const purpose = body.purpose ?? "register";
    if (typeof address !== "string" || !isAddress(address, { strict: false })) {
      throw new HttpError(400, "INVALID_ADDRESS", "A valid wallet address is required.");
    }
    if (typeof chainId !== "number" || !config.allowedChainIds.includes(chainId)) {
      throw new HttpError(400, "UNSUPPORTED_CHAIN", "Please switch your wallet to a supported network.", {
        allowedChainIds: config.allowedChainIds,
      });
    }
    if (purpose !== "register" && purpose !== "admin") throw new HttpError(400, "INVALID_PURPOSE", "Unknown sign-in purpose.");
    const wallet = address.toLowerCase();
    if (purpose === "admin" && !config.adminWallets.includes(wallet)) {
      throw new HttpError(403, "FORBIDDEN", "This wallet is not an allowlist administrator.");
    }

    const nonce = randomAlphanumeric(24);
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + config.nonceTtlSeconds * 1000);
    await db.query(
      `insert into allowlist.auth_nonces (nonce, wallet_address_normalized, chain_id, purpose, issued_at, expires_at)
       values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)`,
      [nonce, wallet, chainId, purpose, issuedAt.toISOString(), expiresAt.toISOString()],
    );
    return json(req, 200, {
      nonce,
      issuedAt: issuedAt.toISOString(),
      expirationTime: expiresAt.toISOString(),
      statement: SIWE_STATEMENTS[purpose as Purpose],
      chainId,
      purpose,
    });
  }

  async function verify(req: Request): Promise<Response> {
    await rateLimit(req, "verify");
    const body = await readJson(req);
    const message = body.message;
    const signature = body.signature;
    if (typeof message !== "string" || typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature) || signature.length > 20_000) {
      throw new HttpError(400, "INVALID_REQUEST", "A sign-in message and signature are required.");
    }

    // Find the nonce first so we know which statement/purpose to expect.
    let nonceValue: string | undefined;
    try {
      nonceValue = parseSiweMessage(message).nonce;
    } catch {
      nonceValue = undefined;
    }
    if (!nonceValue || !/^[A-Za-z0-9]{16,64}$/.test(nonceValue)) {
      throw new HttpError(400, "INVALID_MESSAGE", "Malformed sign-in message.");
    }
    const nonceRows = await db.query<{
      wallet_address_normalized: string;
      chain_id: number;
      purpose: Purpose;
      issued_at: Date | string;
      expires_at: Date | string;
      used_at: Date | string | null;
    }>(`select * from allowlist.auth_nonces where nonce = $1`, [nonceValue]);
    const nonceRow = nonceRows[0];
    if (!nonceRow) throw new HttpError(401, "INVALID_NONCE", "Sign-in request not recognised. Please try again.");
    if (nonceRow.used_at) throw new HttpError(401, "NONCE_USED", "This signature was already used. Please sign again.");
    if (new Date(iso(nonceRow.expires_at)!).getTime() <= now().getTime()) {
      throw new HttpError(401, "NONCE_EXPIRED", "Sign-in request expired. Please try again.");
    }

    const checked = checkSiweMessage({
      message,
      allowedOrigins: config.allowedOrigins,
      allowedChainIds: config.allowedChainIds,
      purpose: nonceRow.purpose,
      now: now(),
    });
    if (!checked.ok) throw new HttpError(401, "INVALID_MESSAGE", checked.error);
    const siwe = checked.siwe;

    if (siwe.address.toLowerCase() !== nonceRow.wallet_address_normalized) {
      throw new HttpError(401, "ADDRESS_MISMATCH", "Sign-in message address does not match the request.");
    }
    if (siwe.chainId !== Number(nonceRow.chain_id)) {
      throw new HttpError(401, "CHAIN_MISMATCH", "Sign-in message chain does not match the request.");
    }
    const nonceIssued = new Date(iso(nonceRow.issued_at)!).getTime();
    const nonceExpires = new Date(iso(nonceRow.expires_at)!).getTime();
    if (siwe.issuedAt.getTime() < nonceIssued - CLOCK_SKEW_MS || siwe.expirationTime.getTime() > nonceExpires + CLOCK_SKEW_MS) {
      throw new HttpError(401, "INVALID_MESSAGE", "Sign-in message times do not match the request.");
    }

    const valid = await verifySignature({
      address: siwe.address,
      message,
      signature: signature as `0x${string}`,
      chainId: siwe.chainId,
    });
    if (!valid) throw new HttpError(401, "INVALID_SIGNATURE", "Signature could not be verified for this wallet.");

    // Consume the nonce atomically. If two requests race, only one gets a row back.
    const consumed = await db.query(
      `update allowlist.auth_nonces set used_at = $2::timestamptz
       where nonce = $1 and used_at is null and expires_at > $2::timestamptz
       returning nonce`,
      [nonceValue, now().toISOString()],
    );
    if (consumed.length === 0) throw new HttpError(401, "NONCE_USED", "This signature was already used. Please sign again.");

    const wallet = siwe.address.toLowerCase();
    const isAdmin = nonceRow.purpose === "admin" && config.adminWallets.includes(wallet);
    if (nonceRow.purpose === "admin" && !isAdmin) throw new HttpError(403, "FORBIDDEN", "This wallet is not an allowlist administrator.");

    const token = randomToken();
    const createdAt = now();
    const ttl = isAdmin ? config.adminSessionTtlSeconds : config.sessionTtlSeconds;
    const expiresAt = new Date(createdAt.getTime() + ttl * 1000);
    await db.query(
      `insert into allowlist.sessions (token_hash, wallet_address_normalized, chain_id, role, created_at, expires_at)
       values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)`,
      [await sha256Hex(token), wallet, siwe.chainId, isAdmin ? "admin" : "registrant", createdAt.toISOString(), expiresAt.toISOString()],
    );
    return json(req, 200, {
      token,
      expiresAt: expiresAt.toISOString(),
      walletAddress: siwe.address,
      chainId: siwe.chainId,
      role: isAdmin ? "admin" : "registrant",
    });
  }

  async function logout(req: Request): Promise<Response> {
    const session = await requireSession(req);
    await db.query(`update allowlist.sessions set revoked_at = $2::timestamptz where token_hash = $1`, [
      session.tokenHash,
      now().toISOString(),
    ]);
    return json(req, 200, { ok: true });
  }

  // ---------- registrant ----------

  async function getOwnRegistration(req: Request): Promise<Response> {
    await rateLimit(req, "me");
    const session = await requireSession(req);
    const [campaign, row] = await Promise.all([loadCampaign(), findOwnRegistration(session.wallet)]);
    return json(req, 200, {
      walletAddress: getAddress(session.wallet),
      campaign,
      registration: row ? publicRegistration(row) : null,
    });
  }

  async function register(req: Request): Promise<Response> {
    await rateLimit(req, "register");
    const session = await requireSession(req);
    const body = await readJson(req);
    const handle = parseTwitterHandle(body.twitterUsername);
    if (!handle.ok) throw new HttpError(400, "INVALID_TWITTER_USERNAME", handle.error);

    const existing = await findOwnRegistration(session.wallet);
    if (existing) {
      throw new HttpError(409, "ALREADY_REGISTERED", "This wallet is already registered.", {
        registration: publicRegistration(existing),
      });
    }
    const { campaign, policy, policyVersion } = await loadCampaignWithPolicy();
    if (!campaign.isOpen) throw new HttpError(403, "REGISTRATION_CLOSED", "FLYLIST registration is closed.", { campaign: await loadCampaign() });

    // Eligibility is always the server's own result for this wallet (recent cached
    // check, or evaluated now). Nothing the browser sends can mark a wallet eligible.
    const { check, cached, nft } = await evaluateEligibility(session.wallet, policy, policyVersion);
    if (check.result === "ineligible") {
      throw new HttpError(403, "INELIGIBLE", "This wallet doesn't meet the FLYLIST requirements.", {
        eligibility: publicEligibility(check, policy.minEthBalanceUsdCents, cached, nft),
      });
    }
    if (check.result === "unavailable") {
      throw new HttpError(503, "ELIGIBILITY_UNAVAILABLE", "We couldn't check your eligibility right now. Please try again in a minute.", {
        eligibility: publicEligibility(check, policy.minEthBalanceUsdCents, cached, nft),
      });
    }

    // Access method actually used. In hybrid OR mode, community qualification or a code admits.
    let accessMethod: string = "open";
    let needCode = requiresAccessCode(policy);
    if (policy.accessMode === "community") accessMethod = "community";
    if (policy.accessMode === "hybrid") {
      if (policy.hybridRule === "code_and_community") accessMethod = "hybrid";
      else if (nft?.result === "qualified") accessMethod = "community";
      else if (nft?.result === "unavailable" && body.accessCode === undefined) {
        throw new HttpError(503, "ELIGIBILITY_UNAVAILABLE", "We couldn't check partner collections right now. Try again, or use an access code.");
      } else {
        needCode = true;
        accessMethod = "invite_code";
      }
    }
    if (policy.accessMode === "invite_code") accessMethod = "invite_code";
    if (needCode && normalizeAccessCode(body.accessCode) === null) {
      throw new HttpError(403, "ACCESS_CODE_REQUIRED", "This FLYLIST needs an access code.");
    }

    const decided = decideStatus(policy, await xService.load(session.wallet));
    const nftStatus = nft ? nft.result : "not_required";

    // Redeem before inserting; if the insert then loses a race, the redemption is released.
    const redemption = needCode
      ? await redeemAccessCode(db, { campaignId: config.campaignId, code: body.accessCode, wallet: session.wallet, pepper: config.accessCodePepper, at: now() })
      : null;

    const ts = now().toISOString();
    // The wallet comes from the verified session, never from the request body,
    // so a registration cannot be created for someone else's address.
    const rows = await db.query<RegistrationRow>(
      `with ins as (
         insert into allowlist.registrations (
           campaign_id, wallet_address, wallet_address_normalized,
           twitter_username, twitter_username_normalized,
           registered_at, updated_at,
           verification_chain_id, verification_method, verification_timestamp,
           registration_status, eligibility_status, eligibility_checked_at, access_method,
           eligibility_check_id, eth_balance_wei, eth_usd_price, eth_usd_price_decimals,
           eth_usd_price_source, eth_usd_price_at, eth_balance_usd_cents, eligibility_chain_id,
           policy_version, verification_status, nft_status, nft_check_id, access_code_id, community_attribution
         )
         select $1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz, $7, 'siwe_eip4361', $8::timestamptz,
                $9, $10, c.checked_at, $11,
                c.id, c.best_balance_wei, c.eth_usd_price, c.eth_usd_price_decimals,
                c.eth_usd_price_source, c.eth_usd_price_at, c.best_balance_usd_cents, c.best_chain_id,
                $13, $14, $15, c.nft_check_id, $16::uuid, $17
         from allowlist.eligibility_checks c
         where c.id = $12 and c.wallet_address_normalized = $3
         on conflict (campaign_id, wallet_address_normalized) do nothing
         returning *
       ), aud as (
         insert into allowlist.registration_audit (registration_id, actor_wallet, actor_role, action, changes, created_at)
         select id, wallet_address_normalized, 'registrant', 'registered',
                jsonb_build_object('twitter_username', twitter_username, 'registration_status', registration_status,
                                   'eligibility_check_id', eligibility_check_id, 'policy_version', policy_version,
                                   'access_method', access_method, 'verification_status', verification_status), $6::timestamptz
         from ins
       )
       select * from ins`,
      [
        config.campaignId,
        getAddress(session.wallet),
        session.wallet,
        handle.handle.display,
        handle.handle.normalized,
        ts,
        session.chainId,
        session.createdAt.toISOString(),
        decided.registrationStatus,
        decided.eligibilityStatus,
        accessMethod,
        check.id,
        policyVersion,
        decided.verificationStatus,
        nftStatus,
        redemption?.codeId ?? null,
        redemption?.communityAttribution ?? null,
      ],
    );
    if (rows.length === 0) {
      // Lost a race with a concurrent request for the same wallet.
      if (redemption) await releaseRedemption(db, { redemptionId: redemption.redemptionId, actor: session.wallet, at: now() });
      const row = await findOwnRegistration(session.wallet);
      throw new HttpError(409, "ALREADY_REGISTERED", "This wallet is already registered.", {
        registration: row ? publicRegistration(row) : null,
      });
    }
    if (redemption) await attachRedemption(db, redemption.redemptionId, rows[0].id);
    return json(req, 201, { registration: publicRegistration(rows[0]) });
  }

  // ---------- verification (registrant) ----------

  async function getOwnVerification(req: Request): Promise<Response> {
    await rateLimit(req, "me");
    const session = await requireSession(req);
    const { policy } = await loadCampaignWithPolicy();
    const [xRow, reg] = await Promise.all([xService.load(session.wallet), findOwnRegistration(session.wallet)]);
    return json(req, 200, {
      x: publicXVerification(xRow, policy, xService.isActive(policy)),
      nftStatus: reg?.nft_status ?? null,
      verificationStatus: reg?.verification_status ?? null,
    });
  }

  async function startXVerification(req: Request): Promise<Response> {
    await rateLimit(req, "verification");
    const session = await requireSession(req);
    const { policy, policyVersion } = await loadCampaignWithPolicy();
    const ipHash = await sha256Hex(`${config.ipHashSalt}:${clientIp(req)}`);
    const r = await xService.start({ wallet: session.wallet, policy, policyVersion, ipHash });
    return json(req, 200, r);
  }

  async function completeXVerification(req: Request): Promise<Response> {
    await rateLimit(req, "verification");
    const session = await requireSession(req);
    const body = await readJson(req);
    const { policy, policyVersion } = await loadCampaignWithPolicy();
    const ipHash = await sha256Hex(`${config.ipHashSalt}:${clientIp(req)}`);
    const r = await xService.complete({ wallet: session.wallet, policy, policyVersion, ipHash, state: body.state, code: body.code });

    // A pending registration whose requirements are now met moves to eligible (system, audited).
    // A definitive "no" moves it to verification_status 'failed' but never silently rejects it.
    const xRow = await xService.load(session.wallet);
    const satisfied = xService.satisfied(xRow, policy);
    const failed = xService.failed(xRow, policy);
    if (satisfied || failed) {
      await db.query(
        `with old as (
           select id, registration_status, verification_status from allowlist.registrations
           where campaign_id = $1 and wallet_address_normalized = $2 and verification_status = 'pending' for update
         ), upd as (
           update allowlist.registrations r set
             verification_status = $3,
             registration_status = case when $3 = 'verified' and r.registration_status = 'pending_verification' then 'eligible' else r.registration_status end,
             eligibility_status = case when $3 = 'verified' and r.eligibility_status = 'pending' then 'eligible' else r.eligibility_status end,
             updated_at = $4::timestamptz
           from old where r.id = old.id
           returning r.*
         )
         insert into allowlist.registration_audit (registration_id, actor_wallet, actor_role, action, changes, created_at)
         select upd.id, 'system', 'system', 'x_verification',
                jsonb_build_object('verification_status', jsonb_build_object('from', old.verification_status, 'to', upd.verification_status),
                                   'registration_status', jsonb_build_object('from', old.registration_status, 'to', upd.registration_status)),
                $4::timestamptz
         from upd join old on old.id = upd.id`,
        [config.campaignId, session.wallet, satisfied ? "verified" : "failed", now().toISOString()],
      );
    }
    return json(req, 200, { ...r, x: publicXVerification(xRow, policy, xService.isActive(policy)) });
  }

  async function updateOwnUsername(req: Request): Promise<Response> {
    await rateLimit(req, "register");
    const session = await requireSession(req);
    const body = await readJson(req);
    const handle = parseTwitterHandle(body.twitterUsername);
    if (!handle.ok) throw new HttpError(400, "INVALID_TWITTER_USERNAME", handle.error);
    await requireOpenCampaign();

    const rows = await db.query<RegistrationRow>(
      `with old as (
         select id, twitter_username from allowlist.registrations
         where campaign_id = $1 and wallet_address_normalized = $2
         for update
       ), upd as (
         update allowlist.registrations r
         set twitter_username = $3, twitter_username_normalized = $4, updated_at = $5::timestamptz
         from old where r.id = old.id and old.twitter_username is distinct from $3
         returning r.*
       ), aud as (
         insert into allowlist.registration_audit (registration_id, actor_wallet, actor_role, action, changes, created_at)
         select upd.id, $2, 'registrant', 'twitter_username_updated',
                jsonb_build_object('twitter_username', jsonb_build_object('from', old.twitter_username, 'to', upd.twitter_username)),
                $5::timestamptz
         from upd join old on old.id = upd.id
       )
       select * from upd`,
      [config.campaignId, session.wallet, handle.handle.display, handle.handle.normalized, now().toISOString()],
    );
    if (rows.length > 0) return json(req, 200, { registration: publicRegistration(rows[0]) });

    const existing = await findOwnRegistration(session.wallet);
    if (!existing) throw new HttpError(404, "NOT_REGISTERED", "This wallet is not registered yet.");
    return json(req, 200, { registration: publicRegistration(existing) }); // unchanged
  }

  // ---------- admin ----------

  function buildFilter(params: URLSearchParams, policy: CampaignPolicy): { where: string; values: unknown[] } {
    const conds = ["campaign_id = $1"];
    const values: unknown[] = [config.campaignId];
    const add = (sql: (n: number) => string, value: unknown) => {
      values.push(value);
      conds.push(sql(values.length));
    };

    const q = (params.get("q") ?? "").trim();
    if (q) {
      if (q.length > 100) throw new HttpError(400, "INVALID_FILTER", "Search is too long.");
      const term = `%${escapeLike(q.replace(/^@/, "").toLowerCase())}%`;
      add((n) => `(wallet_address_normalized like $${n} escape '\\' or twitter_username_normalized like $${n} escape '\\')`, term);
    }
    const status = params.get("registrationStatus");
    if (status) {
      if (!(REGISTRATION_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, "INVALID_FILTER", "Unknown registration status.");
      add((n) => `registration_status = $${n}`, status);
    }
    const eligibility = params.get("eligibilityStatus");
    if (eligibility) {
      if (!(ELIGIBILITY_STATUSES as readonly string[]).includes(eligibility)) throw new HttpError(400, "INVALID_FILTER", "Unknown eligibility status.");
      add((n) => `eligibility_status = $${n}`, eligibility);
    }
    const verification = params.get("verificationStatus");
    if (verification) {
      if (!(VERIFICATION_STATUSES as readonly string[]).includes(verification)) throw new HttpError(400, "INVALID_FILTER", "Unknown verification status.");
      add((n) => `verification_status = $${n}`, verification);
    }
    const preset = params.get("preset");
    if (preset) {
      const p = EXPORT_PRESETS[preset];
      if (!p) throw new HttpError(400, "INVALID_FILTER", "Unknown export preset.");
      if (p.statuses) add((n) => `registration_status = any($${n}::text[])`, p.statuses);
      // Final mint list: approved AND every required verification complete, unless the
      // campaign policy explicitly allows unverified approved wallets.
      if (p.completedVerificationOnly && !policy.finalExportIncludesUnverified) {
        add((n) => `verification_status = any($${n}::text[])`, ["not_required", "verified"]);
      }
    }
    const from = utcDate(params.get("from"), "From date");
    if (from) add((n) => `registered_at >= $${n}::timestamptz`, from.toISOString());
    const to = utcDate(params.get("to"), "To date");
    if (to) add((n) => `registered_at < $${n}::timestamptz`, new Date(to.getTime() + 86_400_000).toISOString()); // inclusive day
    return { where: conds.join(" and "), values };
  }

  const SORT_COLUMNS: Record<string, string> = {
    registeredAt: "registered_at",
    updatedAt: "updated_at",
    twitterUsername: "twitter_username_normalized",
    walletAddress: "wallet_address_normalized",
    registrationStatus: "registration_status",
    eligibilityStatus: "eligibility_status",
  };

  async function adminStats(req: Request): Promise<Response> {
    await rateLimit(req, "admin");
    await requireAdmin(req);
    const n = now();
    const startOfDay = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())).toISOString();
    const [totals, byStatus, byEligibility, campaign] = await Promise.all([
      db.query<{ total: string | number; today: string | number; wallets: string | number }>(
        `select count(*) as total,
                count(*) filter (where registered_at >= $2::timestamptz) as today,
                count(distinct wallet_address_normalized) as wallets
         from allowlist.registrations where campaign_id = $1`,
        [config.campaignId, startOfDay],
      ),
      db.query<{ registration_status: string; count: string | number }>(
        `select registration_status, count(*) as count from allowlist.registrations where campaign_id = $1 group by 1`,
        [config.campaignId],
      ),
      db.query<{ eligibility_status: string; count: string | number }>(
        `select eligibility_status, count(*) as count from allowlist.registrations where campaign_id = $1 group by 1`,
        [config.campaignId],
      ),
      loadCampaign(),
    ]);
    return json(req, 200, {
      campaign,
      total: Number(totals[0].total),
      today: Number(totals[0].today),
      uniqueWallets: Number(totals[0].wallets),
      todayStartsAt: startOfDay,
      byRegistrationStatus: Object.fromEntries(byStatus.map((r) => [r.registration_status, Number(r.count)])),
      byEligibilityStatus: Object.fromEntries(byEligibility.map((r) => [r.eligibility_status, Number(r.count)])),
    });
  }

  async function adminList(req: Request, url: URL): Promise<Response> {
    await rateLimit(req, "admin");
    await requireAdmin(req);
    const { policy } = await loadCampaignWithPolicy();
    const { where, values } = buildFilter(url.searchParams, policy);
    const sortKey = url.searchParams.get("sort") ?? "registeredAt";
    const sortColumn = SORT_COLUMNS[sortKey];
    if (!sortColumn) throw new HttpError(400, "INVALID_FILTER", "Unknown sort column.");
    const dir = url.searchParams.get("dir") === "asc" ? "asc" : "desc";
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") ?? "25", 10) || 25));

    const [countRows, rows] = await Promise.all([
      db.query<{ total: string | number }>(`select count(*) as total from allowlist.registrations where ${where}`, values),
      db.query<RegistrationRow>(
        `select r.*,
                (select count(*) from allowlist.registrations r2
                 where r2.campaign_id = r.campaign_id and r2.twitter_username_normalized = r.twitter_username_normalized) as handle_shared_count
         from ${REGISTRATION_VIEW}
         where ${where}
         order by ${sortColumn} ${dir}, id ${dir}
         limit ${pageSize} offset ${(page - 1) * pageSize}`,
        values,
      ),
    ]);
    const total = Number(countRows[0].total);
    return json(req, 200, {
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
      sort: sortKey,
      dir,
      registrations: rows.map(adminRegistration),
    });
  }

  async function adminUpdate(req: Request, id: string): Promise<Response> {
    await rateLimit(req, "admin");
    const session = await requireAdmin(req);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "NOT_FOUND", "Registration not found.");
    const body = await readJson(req);

    const status = body.registrationStatus;
    const eligibility = body.eligibilityStatus;
    const hasNotes = Object.prototype.hasOwnProperty.call(body, "adminNotes");
    const notes = body.adminNotes;
    if (status !== undefined && !(REGISTRATION_STATUSES as readonly unknown[]).includes(status)) {
      throw new HttpError(400, "INVALID_STATUS", "Unknown registration status.");
    }
    if (eligibility !== undefined && !(ELIGIBILITY_STATUSES as readonly unknown[]).includes(eligibility)) {
      throw new HttpError(400, "INVALID_STATUS", "Unknown eligibility status.");
    }
    if (hasNotes && notes !== null && (typeof notes !== "string" || notes.length > 2000)) {
      throw new HttpError(400, "INVALID_NOTES", "Notes must be text of at most 2000 characters.");
    }
    if (status === undefined && eligibility === undefined && !hasNotes) {
      throw new HttpError(400, "NOTHING_TO_UPDATE", "No changes supplied.");
    }

    const rows = await db.query<RegistrationRow>(
      `with old as (
         select * from allowlist.registrations where id = $1 and campaign_id = $2 for update
       ), upd as (
         update allowlist.registrations r set
           registration_status = coalesce($3, r.registration_status),
           eligibility_status = coalesce($4, r.eligibility_status),
           eligibility_checked_at = case when $4::text is not null then $7::timestamptz else r.eligibility_checked_at end,
           admin_notes = case when $5::boolean then $6 else r.admin_notes end,
           updated_at = $7::timestamptz
         from old where r.id = old.id
         returning r.*
       ), aud as (
         insert into allowlist.registration_audit (registration_id, actor_wallet, actor_role, action, changes, created_at)
         select upd.id, $8, 'admin', 'admin_update',
                -- Only changed fields are recorded; "from"/"to" keep explicit nulls.
                '{}'::jsonb
                || case when old.registration_status is distinct from upd.registration_status
                     then jsonb_build_object('registration_status', jsonb_build_object('from', old.registration_status, 'to', upd.registration_status))
                     else '{}'::jsonb end
                || case when old.eligibility_status is distinct from upd.eligibility_status
                     then jsonb_build_object('eligibility_status', jsonb_build_object('from', old.eligibility_status, 'to', upd.eligibility_status))
                     else '{}'::jsonb end
                || case when old.admin_notes is distinct from upd.admin_notes
                     then jsonb_build_object('admin_notes', jsonb_build_object('from', old.admin_notes, 'to', upd.admin_notes))
                     else '{}'::jsonb end,
                $7::timestamptz
         from upd join old on old.id = upd.id
       )
       select upd.*,
              (select count(*) from allowlist.registrations r2
               where r2.campaign_id = upd.campaign_id and r2.twitter_username_normalized = upd.twitter_username_normalized) as handle_shared_count
       from upd`,
      [
        id,
        config.campaignId,
        status ?? null,
        eligibility ?? null,
        hasNotes,
        hasNotes ? (notes as string | null) : null,
        now().toISOString(),
        session.wallet,
      ],
    );
    if (rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Registration not found.");
    const [full] = await db.query<RegistrationRow>(
      `select r.*,
              (select count(*) from allowlist.registrations r2
               where r2.campaign_id = r.campaign_id and r2.twitter_username_normalized = r.twitter_username_normalized) as handle_shared_count
       from ${REGISTRATION_VIEW} where r.id = $1`,
      [id],
    );
    return json(req, 200, { registration: adminRegistration(full ?? rows[0]) });
  }

  async function adminAudit(req: Request, id: string): Promise<Response> {
    await rateLimit(req, "admin");
    await requireAdmin(req);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "NOT_FOUND", "Registration not found.");
    const rows = await db.query<{
      id: string | number;
      actor_wallet: string;
      actor_role: string;
      action: string;
      changes: unknown;
      created_at: Date | string;
    }>(
      `select a.* from allowlist.registration_audit a
       join allowlist.registrations r on r.id = a.registration_id
       where a.registration_id = $1 and r.campaign_id = $2
       order by a.created_at desc, a.id desc limit 200`,
      [id, config.campaignId],
    );
    return json(req, 200, {
      entries: rows.map((r) => ({
        id: Number(r.id),
        actorWallet: r.actor_wallet,
        actorRole: r.actor_role,
        action: r.action,
        changes: typeof r.changes === "string" ? JSON.parse(r.changes) : r.changes,
        createdAt: iso(r.created_at),
      })),
    });
  }

  async function adminExport(req: Request, url: URL): Promise<Response> {
    await rateLimit(req, "export");
    await requireAdmin(req);
    const { policy } = await loadCampaignWithPolicy();
    const { where, values } = buildFilter(url.searchParams, policy);

    // Whole matching dataset (not one page), oldest first, fetched in keyset batches.
    const rows: unknown[][] = [];
    let cursor: { at: string; id: string } | null = null;
    const BATCH = 2000;
    for (;;) {
      const params = [...values];
      let keyset = "";
      if (cursor) {
        params.push(cursor.at, cursor.id);
        keyset = ` and (registered_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
      }
      const batch: RegistrationRow[] = await db.query<RegistrationRow>(
        `select * from ${REGISTRATION_VIEW} where ${where}${keyset} order by registered_at asc, id asc limit ${BATCH}`,
        params,
      );
      for (const r of batch) {
        rows.push([
          r.id,
          r.campaign_id,
          r.wallet_address,
          r.twitter_username_normalized,
          twitterProfileUrl(r.twitter_username_normalized),
          r.x_status === "verified" ? `verified via X (@${r.x_verified_username})` : "unverified (self-reported)",
          r.registration_status,
          r.eligibility_status,
          r.access_method,
          iso(r.registered_at),
          iso(r.updated_at),
          iso(r.eligibility_checked_at),
          r.eligibility_chain_id ?? "",
          r.eth_balance_wei ?? "",
          formatUnits(r.eth_balance_wei, 18) ?? "",
          r.eth_usd_price === null ? "" : formatUnits(r.eth_usd_price, r.eth_usd_price_decimals ?? 8),
          r.eth_usd_price_source ?? "",
          iso(r.eth_usd_price_at) ?? "",
          centsToUsd(r.eth_balance_usd_cents) ?? "",
          r.verification_chain_id,
          r.policy_version ?? "",
          r.verification_status,
          r.x_status ?? "not_started",
          r.x_status === "verified" ? (r.x_verified_user_id ?? "") : "",
          r.x_follow_status ?? "not_required",
          r.nft_status,
          qualifyingCollections(r).join("; "),
          r.access_code_prefix ? `${r.access_code_prefix}…${r.access_code_label ? ` (${r.access_code_label})` : ""}` : "",
          r.community_attribution ?? "",
          approvalStatus(r.registration_status),
          r.admin_notes ?? "",
        ]);
      }
      if (batch.length < BATCH) break;
      const last = batch[batch.length - 1];
      cursor = { at: iso(last.registered_at)!, id: last.id };
    }

    const preset = EXPORT_PRESETS[url.searchParams.get("preset") ?? "all"] ?? EXPORT_PRESETS.all;
    const filename = `flylist-${preset.label}-${now().toISOString().slice(0, 10)}.csv`;
    return new Response(toCsv(CSV_COLUMNS, rows), {
      status: 200,
      headers: {
        ...corsHeaders(req),
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  // ---------- admin: campaign policy & integrations ----------

  function integrationState(policy: CampaignPolicy) {
    const x = deps.xProvider ?? notConfiguredXProvider;
    return {
      x_verification: {
        activated: config.enabledIntegrations.has("x_verification"),
        providerImplemented: x.configured,
        provider: x.id,
        active: xService.isActive(policy),
      },
      community_gating: {
        activated: config.enabledIntegrations.has("community_gating"),
        provider: communityProvider.id,
        active: policy.accessMode === "community" || policy.accessMode === "hybrid",
      },
      access_codes: {
        activated: config.enabledIntegrations.has("access_codes"),
        active: policy.accessMode === "invite_code" || policy.accessMode === "hybrid",
      },
    };
  }

  async function adminGetPolicy(req: Request): Promise<Response> {
    await rateLimit(req, "admin");
    await requireAdmin(req);
    const { policy, policyVersion } = await loadCampaignWithPolicy();
    const history = await db.query<{ version: number; created_at: Date | string; created_by: string; reason: string | null; policy: unknown }>(
      `select version, created_at, created_by, reason, policy from allowlist.campaign_policies
       where campaign_id = $1 order by version desc limit 50`,
      [config.campaignId],
    );
    return json(req, 200, {
      version: policyVersion,
      policy,
      grouped: describePolicy(policy),
      integrations: integrationState(policy),
      knownIntegrations: INTEGRATIONS,
      ethChainsAvailable: Object.keys(config.eligibilityRpcUrls).map(Number),
      history: history.map((h) => ({ version: Number(h.version), createdAt: iso(h.created_at), createdBy: h.created_by, reason: h.reason, policy: asJson(h.policy) })),
    });
  }

  async function adminUpdatePolicy(req: Request): Promise<Response> {
    await rateLimit(req, "admin");
    const session = await requireAdmin(req);
    const body = await readJson(req);
    const { expectedVersion, reason, changes } = body as { expectedVersion?: unknown; reason?: unknown; changes?: unknown };
    if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion)) throw new HttpError(400, "INVALID_REQUEST", "expectedVersion is required.");
    if (!changes || typeof changes !== "object" || Array.isArray(changes) || Object.keys(changes).length === 0) {
      throw new HttpError(400, "NOTHING_TO_UPDATE", "No policy changes supplied.");
    }
    if (reason !== undefined && reason !== null && (typeof reason !== "string" || reason.length > 500)) {
      throw new HttpError(400, "INVALID_REQUEST", "Reason must be text of at most 500 characters.");
    }
    const { policy, policyVersion } = await loadCampaignWithPolicy();
    if (expectedVersion !== policyVersion) throw new HttpError(409, "POLICY_CONFLICT", "The policy was changed by someone else. Reload and try again.");
    const activeCollections = (await loadCollections(true)).length;
    const next = applyPolicyPatch(policy, changes as Record<string, unknown>, {
      enabledIntegrations: config.enabledIntegrations,
      activeCollectionCount: activeCollections,
      supportedEthChainIds: Object.keys(config.eligibilityRpcUrls).map(Number),
    });
    let version: number;
    try {
      ({ version } = await updatePolicy(db, {
        campaignId: config.campaignId,
        expectedVersion,
        next,
        actor: session.wallet,
        reason: typeof reason === "string" && reason.trim() ? reason.trim() : null,
        at: now(),
      }));
    } catch (e) {
      // D013: modes other than 'open' are also locked at the database until a migration lifts it.
      if (String((e as Error)?.message ?? "").includes("campaigns_access_mode_implemented")) {
        throw new HttpError(409, "ACCESS_MODE_LOCKED", "This access mode is locked at the database (decision D013). Lifting it needs an approved migration.");
      }
      throw e;
    }
    return json(req, 200, { version, policy: next, grouped: describePolicy(next), integrations: integrationState(next) });
  }

  // ---------- admin: partner collections ----------

  function adminCollection(r: PartnerCollection & { createdAt?: string | null; updatedAt?: string | null }) {
    return { ...r, chainName: CHAIN_NAMES[r.chainId] ?? `Chain ${r.chainId}` };
  }

  function parseCollectionInput(body: Record<string, unknown>, partial: boolean) {
    const out: Record<string, unknown> = {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
    const req = (k: string) => {
      if (!partial && !has(k)) throw new HttpError(400, "INVALID_COLLECTION", `${k} is required.`);
      return has(k);
    };
    if (req("displayName")) {
      const v = body.displayName;
      if (typeof v !== "string" || !v.trim() || v.trim().length > 80) throw new HttpError(400, "INVALID_COLLECTION", "Display name must be 1–80 characters.");
      out.display_name = v.trim();
    }
    if (!partial || has("chainId")) {
      if (partial) throw new HttpError(400, "INVALID_COLLECTION", "A collection's chain can't be changed. Add it again on the other chain.");
      const v = body.chainId;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new HttpError(400, "INVALID_COLLECTION", "chainId must be a positive integer.");
      if (!config.eligibilityRpcUrls[v]) throw new HttpError(400, "UNSUPPORTED_CHAIN", `No RPC is configured for chain ${v}. Add it to RPC_URLS first.`);
      out.chain_id = v;
    }
    if (!partial || has("contractAddress")) {
      if (partial) throw new HttpError(400, "INVALID_COLLECTION", "A collection's contract can't be changed. Add it as a new collection.");
      const v = body.contractAddress;
      if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new HttpError(400, "INVALID_COLLECTION", "contractAddress must be a valid address.");
      out.contract_address = v.toLowerCase();
    }
    if (!partial || has("standard")) {
      if (partial) throw new HttpError(400, "INVALID_COLLECTION", "A collection's token standard can't be changed.");
      if (body.standard !== "erc721" && body.standard !== "erc1155") throw new HttpError(400, "INVALID_COLLECTION", "standard must be erc721 or erc1155.");
      out.standard = body.standard;
    }
    if (has("minQuantity")) {
      const v = body.minQuantity;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 1_000_000) throw new HttpError(400, "INVALID_COLLECTION", "minQuantity must be a whole number ≥ 1.");
      out.min_quantity = v;
    }
    if (has("tokenIds")) {
      const v = body.tokenIds;
      if (!Array.isArray(v) || v.length > 50) throw new HttpError(400, "INVALID_COLLECTION", "tokenIds must be a list of at most 50 token IDs.");
      out.token_ids = v.map((id) => {
        const s = typeof id === "number" && Number.isSafeInteger(id) ? String(id) : id;
        if (typeof s !== "string" || !/^[0-9]{1,78}$/.test(s) || BigInt(s) >= 1n << 256n) throw new HttpError(400, "INVALID_COLLECTION", `Invalid token ID: ${String(id)}`);
        return BigInt(s).toString();
      });
    }
    if (has("active")) {
      if (typeof body.active !== "boolean") throw new HttpError(400, "INVALID_COLLECTION", "active must be true or false.");
      out.active = body.active;
    }
    return out;
  }

  async function adminListCollections(req: Request): Promise<Response> {
    await rateLimit(req, "admin");
    await requireAdmin(req);
    return json(req, 200, { collections: (await loadCollections(false)).map(adminCollection) });
  }

  async function adminCreateCollection(req: Request): Promise<Response> {
    await rateLimit(req, "admin");
    const session = await requireAdmin(req);
    const v = parseCollectionInput(await readJson(req), false);
    if (v.standard === "erc1155" && !(Array.isArray(v.token_ids) && v.token_ids.length > 0)) {
      throw new HttpError(400, "INVALID_COLLECTION", "ERC-1155 collections need at least one eligible token ID.");
    }
    const ts = now().toISOString();
    const rows = await db.query<{ id: string }>(
      `with ins as (
         insert into allowlist.partner_collections (campaign_id, display_name, chain_id, contract_address, standard, min_quantity, token_ids, active, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9::timestamptz, $9::timestamptz)
         on conflict (campaign_id, chain_id, contract_address) do nothing
         returning *
       ), aud as (
         insert into allowlist.partner_collection_audit (collection_id, actor_wallet, action, changes, created_at)
         select id, $10, 'created', to_jsonb(ins) - 'campaign_id', $9::timestamptz from ins
       )
       select id from ins`,
      [config.campaignId, v.display_name, v.chain_id, v.contract_address, v.standard, v.min_quantity ?? 1, v.token_ids ?? [], v.active ?? true, ts, session.wallet],
    );
    if (rows.length === 0) throw new HttpError(409, "COLLECTION_EXISTS", "That contract is already configured on this chain.");
    const created = (await loadCollections(false)).find((c) => c.id === rows[0].id)!;
    return json(req, 201, { collection: adminCollection(created) });
  }

  async function adminUpdateCollection(req: Request, id: string): Promise<Response> {
    await rateLimit(req, "admin");
    const session = await requireAdmin(req);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "NOT_FOUND", "Collection not found.");
    const v = parseCollectionInput(await readJson(req), true);
    if (Object.keys(v).length === 0) throw new HttpError(400, "NOTHING_TO_UPDATE", "No changes supplied.");
    const all = await loadCollections(false);
    const current = all.find((c) => c.id === id);
    if (!current) throw new HttpError(404, "NOT_FOUND", "Collection not found.");
    const tokenIds = (v.token_ids as string[] | undefined) ?? current.tokenIds;
    if (current.standard === "erc1155" && tokenIds.length === 0) throw new HttpError(400, "INVALID_COLLECTION", "ERC-1155 collections need at least one eligible token ID.");
    // Don't let a deactivation silently break an active community rule.
    const { policy } = await loadCampaignWithPolicy();
    if (v.active === false && current.active && (policy.accessMode === "community" || policy.accessMode === "hybrid")) {
      const remaining = all.filter((c) => c.active && c.id !== id).length;
      const need = policy.nftRule === "min_n" ? policy.nftMinCollections : 1;
      if (remaining < need) throw new HttpError(409, "COLLECTION_IN_USE", "Community gating needs this collection. Change the campaign rule first.");
    }
    const sets: string[] = [];
    const values: unknown[] = [id, config.campaignId, now().toISOString(), session.wallet];
    for (const [col, val] of Object.entries(v)) {
      values.push(val);
      sets.push(`${col} = $${values.length}${col === "token_ids" ? "::text[]" : ""}`);
    }
    await db.query(
      `with old as (select * from allowlist.partner_collections where id = $1 and campaign_id = $2 for update),
       upd as (
         update allowlist.partner_collections p set ${sets.join(", ")}, updated_at = $3::timestamptz
         from old where p.id = old.id returning p.*
       )
       insert into allowlist.partner_collection_audit (collection_id, actor_wallet, action, changes, created_at)
       select upd.id, $4, 'updated', jsonb_build_object('from', to_jsonb(old) - 'campaign_id', 'to', to_jsonb(upd) - 'campaign_id'), $3::timestamptz
       from upd join old on old.id = upd.id`,
      values,
    );
    const updated = (await loadCollections(false)).find((c) => c.id === id)!;
    return json(req, 200, { collection: adminCollection(updated) });
  }

  /** Read-only ownership test of any wallet against the configured collections (for checking config). */
  async function adminTestCollections(req: Request): Promise<Response> {
    await rateLimit(req, "admin_test");
    await requireAdmin(req);
    const body = await readJson(req);
    if (typeof body.walletAddress !== "string" || !isAddress(body.walletAddress, { strict: false })) {
      throw new HttpError(400, "INVALID_ADDRESS", "A valid wallet address is required.");
    }
    const { policy, policyVersion } = await loadCampaignWithPolicy();
    const row = await runCommunityCheck(body.walletAddress.toLowerCase(), policy, policyVersion, "admin_test");
    return json(req, 200, { check: { id: row.id, result: row.result, rule: row.rule, minCollections: Number(row.min_collections), snapshots: asJson(row.snapshots) } });
  }

  // ---------- admin: access codes ----------

  function adminAccessCode(r: AccessCodeRow) {
    return {
      id: r.id,
      prefix: r.code_prefix,
      label: r.label,
      communityAttribution: r.community_attribution,
      maxRedemptions: Number(r.max_redemptions),
      redemptionCount: Number(r.redemption_count),
      expiresAt: iso(r.expires_at),
      revokedAt: iso(r.revoked_at),
      createdBy: r.created_by,
      createdAt: iso(r.created_at),
      state: r.revoked_at
        ? "revoked"
        : r.expires_at && new Date(iso(r.expires_at)!).getTime() <= now().getTime()
          ? "expired"
          : Number(r.redemption_count) >= Number(r.max_redemptions)
            ? "used_up"
            : "active",
    };
  }

  async function adminListAccessCodes(req: Request): Promise<Response> {
    await rateLimit(req, "admin");
    await requireAdmin(req);
    const rows = await db.query<AccessCodeRow>(
      `select id, campaign_id, code_prefix, label, community_attribution, max_redemptions, redemption_count, expires_at, revoked_at, created_by, created_at
       from allowlist.access_codes where campaign_id = $1 order by created_at desc, id limit 500`,
      [config.campaignId],
    );
    const { policy } = await loadCampaignWithPolicy();
    return json(req, 200, { codes: rows.map(adminAccessCode), gatingActive: policy.accessMode === "invite_code" || policy.accessMode === "hybrid" });
  }

  async function adminCreateAccessCodes(req: Request): Promise<Response> {
    await rateLimit(req, "admin");
    const session = await requireAdmin(req);
    const body = await readJson(req);
    const count = body.count ?? 1;
    const maxRedemptions = body.maxRedemptions ?? 1;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 100) throw new HttpError(400, "INVALID_REQUEST", "count must be 1–100.");
    if (typeof maxRedemptions !== "number" || !Number.isInteger(maxRedemptions) || maxRedemptions < 1 || maxRedemptions > 100_000) {
      throw new HttpError(400, "INVALID_REQUEST", "maxRedemptions must be 1–100000.");
    }
    let expiresAt: string | null = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      if (typeof body.expiresAt !== "string" || Number.isNaN(new Date(body.expiresAt).getTime())) throw new HttpError(400, "INVALID_REQUEST", "expiresAt must be an ISO date-time.");
      expiresAt = new Date(body.expiresAt).toISOString();
      if (new Date(expiresAt).getTime() <= now().getTime()) throw new HttpError(400, "INVALID_REQUEST", "expiresAt must be in the future.");
    }
    const text = (v: unknown, label: string) => {
      if (v === undefined || v === null || v === "") return null;
      if (typeof v !== "string" || v.length > 80) throw new HttpError(400, "INVALID_REQUEST", `${label} must be text of at most 80 characters.`);
      return v.trim();
    };
    const created = await createAccessCodes(db, {
      campaignId: config.campaignId,
      count,
      maxRedemptions,
      expiresAt,
      label: text(body.label, "label"),
      communityAttribution: text(body.communityAttribution, "communityAttribution"),
      actor: session.wallet,
      pepper: config.accessCodePepper,
      at: now(),
    });
    // The plaintext codes are returned exactly once; only hashes are stored.
    return json(req, 201, { codes: created.map((c) => ({ code: c.code, ...adminAccessCode(c.row) })) });
  }

  async function adminRevokeAccessCode(req: Request, id: string): Promise<Response> {
    await rateLimit(req, "admin");
    const session = await requireAdmin(req);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "NOT_FOUND", "Access code not found.");
    const row = await revokeAccessCode(db, { campaignId: config.campaignId, id, actor: session.wallet, at: now() });
    return json(req, 200, { code: adminAccessCode(row) });
  }

  // ---------- admin: provider usage & budgets ----------

  async function adminUsage(req: Request): Promise<Response> {
    await rateLimit(req, "admin");
    await requireAdmin(req);
    const { policy } = await loadCampaignWithPolicy();
    const today = now().toISOString().slice(0, 10);
    const [budgets, recent, totals] = await Promise.all([
      db.query<{ provider: string; day: Date | string; used_today: number; used_total: number }>(
        `select provider, day, used_today, used_total from allowlist.provider_budgets where campaign_id = $1`,
        [config.campaignId],
      ),
      db.query<Record<string, unknown>>(
        `select id, provider, operation, wallet_address_normalized, x_user_id, estimated_units, actual_units, outcome, detail, created_at
         from allowlist.provider_usage where campaign_id = $1 order by created_at desc, id desc limit 50`,
        [config.campaignId],
      ),
      db.query<{ provider: string; outcome: string; n: string | number; estimated: string | number; actual: string | number }>(
        `select provider, outcome, count(*) as n, coalesce(sum(estimated_units), 0) as estimated, coalesce(sum(actual_units), 0) as actual
         from allowlist.provider_usage where campaign_id = $1 group by 1, 2`,
        [config.campaignId],
      ),
    ]);
    const x = budgets.find((b) => b.provider === (deps.xProvider ?? notConfiguredXProvider).id);
    const sameDay = x && String(iso(x.day as Date)).slice(0, 10) === today;
    return json(req, 200, {
      x: {
        provider: policy.xProvider,
        active: xService.isActive(policy),
        dailyBudgetUnits: policy.xBudgetDailyUnits,
        totalBudgetUnits: policy.xBudgetTotalUnits,
        usedTodayUnits: sameDay ? Number(x!.used_today) : 0,
        usedTotalUnits: x ? Number(x.used_total) : 0,
        cacheSeconds: policy.xVerificationCacheSeconds,
        retryCooldownSeconds: policy.xRetryCooldownSeconds,
      },
      totals: totals.map((t) => ({ provider: t.provider, outcome: t.outcome, count: Number(t.n), estimatedUnits: Number(t.estimated), actualUnits: Number(t.actual) })),
      recent: recent.map((r) => ({ ...r, id: Number(r.id), created_at: iso(r.created_at as Date) })),
    });
  }

  // ---------- router ----------

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Supabase serves this at /functions/v1/allowlist/...; Deno sees /allowlist/...
    const idx = url.pathname.indexOf("/allowlist");
    const path = (idx >= 0 ? url.pathname.slice(idx + "/allowlist".length) : url.pathname) || "/";
    const method = req.method.toUpperCase();

    const origin = req.headers.get("origin");
    if (origin && !config.allowedOrigins.includes(origin)) {
      throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "Requests from this website are not allowed.");
    }
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });

    if (method === "GET" && path === "/campaign") {
      await rateLimit(req, "campaign");
      return json(req, 200, { campaign: await loadCampaign() });
    }
    if (method === "POST" && path === "/auth/nonce") return issueNonce(req);
    if (method === "POST" && path === "/auth/verify") return verify(req);
    if (method === "POST" && path === "/auth/logout") return logout(req);
    if (method === "POST" && path === "/me/eligibility") return checkEligibility(req);
    if (method === "GET" && path === "/me/verification") return getOwnVerification(req);
    if (method === "POST" && path === "/me/verification/x/start") return startXVerification(req);
    if (method === "POST" && path === "/me/verification/x/complete") return completeXVerification(req);
    if (path === "/me/registration") {
      if (method === "GET") return getOwnRegistration(req);
      if (method === "POST") return register(req);
      if (method === "PATCH") return updateOwnUsername(req);
    }
    if (method === "GET" && path === "/admin/stats") return adminStats(req);
    if (method === "GET" && path === "/admin/registrations") return adminList(req, url);
    if (method === "GET" && path === "/admin/export.csv") return adminExport(req, url);
    if (path === "/admin/policy") {
      if (method === "GET") return adminGetPolicy(req);
      if (method === "PATCH") return adminUpdatePolicy(req);
    }
    if (path === "/admin/collections") {
      if (method === "GET") return adminListCollections(req);
      if (method === "POST") return adminCreateCollection(req);
    }
    if (method === "POST" && path === "/admin/collections/test") return adminTestCollections(req);
    const col = /^\/admin\/collections\/([^/]+)$/.exec(path);
    if (col && method === "PATCH") return adminUpdateCollection(req, col[1]);
    if (path === "/admin/access-codes") {
      if (method === "GET") return adminListAccessCodes(req);
      if (method === "POST") return adminCreateAccessCodes(req);
    }
    const code = /^\/admin\/access-codes\/([^/]+)\/revoke$/.exec(path);
    if (code && method === "POST") return adminRevokeAccessCode(req, code[1]);
    if (method === "GET" && path === "/admin/usage") return adminUsage(req);
    const one = /^\/admin\/registrations\/([^/]+)(\/audit)?$/.exec(path);
    if (one) {
      if (method === "PATCH" && !one[2]) return adminUpdate(req, one[1]);
      if (method === "GET" && one[2]) return adminAudit(req, one[1]);
    }
    throw new HttpError(404, "NOT_FOUND", "Not found.");
  }

  return async function handle(req: Request): Promise<Response> {
    try {
      return await route(req);
    } catch (err) {
      if (err instanceof HttpError) {
        return json(req, err.status, { error: { code: err.code, message: err.message, ...err.extra } });
      }
      console.error("allowlist: unhandled error", err);
      return json(req, 500, { error: { code: "INTERNAL", message: "Something went wrong. Please try again." } });
    }
  };
}
