// FLY WING GENESIS allowlist API. Runtime-agnostic: a plain (Request) => Response
// handler used by the Supabase Edge Function (Deno) and the local dev server / tests (Node).

import { getAddress, isAddress } from "viem";
import { parseSiweMessage } from "viem/siwe";
import type { AppConfig } from "./config.ts";
import { toCsv } from "./csv.ts";
import type { Db } from "./db.ts";
import { checkEthBalance, COINBASE_SPOT_URL, type EligibilityPolicy, type Fetch } from "./eligibility.ts";
import { checkSiweMessage, CLOCK_SKEW_MS, type Purpose, SIWE_STATEMENTS, type SignatureVerifier } from "./siwe.ts";
import { parseTwitterHandle, twitterProfileUrl } from "./twitter.ts";

export type AppDeps = {
  db: Db;
  config: AppConfig;
  verifySignature: SignatureVerifier;
  now?: () => Date;
  /** Network seam for eligibility reads (RPC + price). Defaults to global fetch. */
  fetch?: Fetch;
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
  "admin_notes",
];

/** Export presets. `final` is approved-only: pending or merely eligible wallets never reach it. */
export const EXPORT_PRESETS: Record<string, { label: string; statuses: string[] | null }> = {
  all: { label: "all", statuses: null },
  pending_verification: { label: "pending-verification", statuses: ["pending_verification"] },
  eligible: { label: "eligible-approved", statuses: ["eligible", "approved"] },
  final: { label: "final-mint-allowlist", statuses: ["approved"] },
};

// Requests per client IP per minute, by bucket.
const RATE_LIMITS: Record<string, number> = {
  campaign: 60,
  nonce: 20,
  verify: 20,
  me: 60,
  eligibility: 10,
  register: 10,
  admin: 300,
  export: 10,
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
};

const asJson = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

/** What a registrant may see about their own eligibility check. Their own wallet's data only. */
function publicEligibility(c: CheckRow, minUsdCents: number, cached: boolean) {
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
    cached,
  };
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
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
    registeredAt: iso(r.registered_at),
    updatedAt: iso(r.updated_at),
  };
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
    const rows = await db.query<{
      id: string;
      name: string;
      status: string;
      opens_at: Date | string | null;
      closes_at: Date | string | null;
      access_mode: EligibilityPolicy["accessMode"];
      eth_balance_check_enabled: boolean;
      min_eth_balance_usd_cents: number;
      eth_balance_chain_ids: number[] | string;
      x_follow_required: boolean;
      allow_provisional_registration: boolean;
    }>(
      `select id, name, status, opens_at, closes_at, access_mode, eth_balance_check_enabled, min_eth_balance_usd_cents,
              eth_balance_chain_ids, x_follow_required, allow_provisional_registration
       from allowlist.campaigns where id = $1`,
      [config.campaignId],
    );
    if (rows.length === 0) throw new HttpError(500, "CAMPAIGN_MISSING", "FLYLIST campaign is not configured.");
    const c = rows[0];
    const t = now().getTime();
    const opensAt = iso(c.opens_at);
    const closesAt = iso(c.closes_at);
    const isOpen =
      c.status === "open" &&
      (!opensAt || new Date(opensAt).getTime() <= t) &&
      (!closesAt || new Date(closesAt).getTime() > t);
    const chainIds = Array.isArray(c.eth_balance_chain_ids)
      ? c.eth_balance_chain_ids.map(Number)
      : String(c.eth_balance_chain_ids).replace(/[{}]/g, "").split(",").filter(Boolean).map(Number);
    const policy: EligibilityPolicy = {
      accessMode: c.access_mode,
      ethBalanceCheckEnabled: c.eth_balance_check_enabled,
      minEthBalanceUsdCents: Number(c.min_eth_balance_usd_cents),
      ethBalanceChainIds: chainIds,
      xFollowRequired: c.x_follow_required,
      allowProvisionalRegistration: c.allow_provisional_registration,
    };
    return { campaign: { id: c.id, name: c.name, status: c.status, opensAt, closesAt, isOpen }, policy };
  }

  /** Public campaign info, including the rules an applicant must meet (rules, not data). */
  async function loadCampaign() {
    const { campaign, policy } = await loadCampaignWithPolicy();
    return {
      ...campaign,
      requirements: {
        accessMode: policy.accessMode,
        ethBalance: policy.ethBalanceCheckEnabled
          ? {
              minUsd: centsToUsd(BigInt(policy.minEthBalanceUsdCents)),
              chains: policy.ethBalanceChainIds.map((id) => ({ chainId: id, chainName: CHAIN_NAMES[id] ?? `Chain ${id}` })),
              rule: "any_one_chain",
            }
          : null,
        xFollowRequired: policy.xFollowRequired,
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

  async function cachedCheck(wallet: string): Promise<CheckRow | null> {
    const rows = await db.query<CheckRow>(
      `select * from allowlist.eligibility_checks
       where campaign_id = $1 and wallet_address_normalized = $2 and expires_at > $3::timestamptz
         and result in ('eligible', 'ineligible')
       order by checked_at desc limit 1`,
      [config.campaignId, wallet, now().toISOString()],
    );
    return rows[0] ?? null;
  }

  /**
   * Returns this wallet's eligibility under the campaign's current policy: a recent
   * server-computed result if one exists, otherwise a fresh evaluation (stored).
   */
  async function evaluateEligibility(wallet: string, policy: EligibilityPolicy): Promise<{ check: CheckRow; cached: boolean }> {
    const hit = await cachedCheck(wallet);
    if (hit) return { check: hit, cached: true };

    const recent = await db.query<{ n: string | number }>(
      `select count(*) as n from allowlist.eligibility_checks
       where campaign_id = $1 and wallet_address_normalized = $2 and checked_at > $3::timestamptz`,
      [config.campaignId, wallet, new Date(now().getTime() - 600_000).toISOString()],
    );
    if (Number(recent[0].n) >= config.eligibilityChecksPerWallet) {
      throw new HttpError(429, "RATE_LIMITED", "Too many eligibility checks for this wallet. Please wait a few minutes.");
    }

    const checkedAt = now();
    let result: CheckRow["result"];
    let price = null as Awaited<ReturnType<typeof checkEthBalance>>["price"];
    let chains: unknown[] = [];
    let best = null as Awaited<ReturnType<typeof checkEthBalance>>["best"];
    let error: string | null = null;
    if (policy.ethBalanceCheckEnabled) {
      const r = await checkEthBalance(fetchFn, providerConfig, policy, wallet, checkedAt);
      ({ result, price, chains, best } = r);
      error = r.error ?? null;
      if (r.result === "unavailable") console.warn("flylist: eligibility unavailable", r.error, JSON.stringify(r.chains));
    } else {
      result = "eligible"; // no balance requirement in this campaign's policy
    }
    const expiresAt = new Date(checkedAt.getTime() + (result === "unavailable" ? 0 : config.eligibilityCacheSeconds * 1000));
    const rows = await db.query<CheckRow>(
      `insert into allowlist.eligibility_checks (
         campaign_id, wallet_address_normalized, checked_at, expires_at, result, policy,
         eth_usd_price, eth_usd_price_decimals, eth_usd_price_source, eth_usd_price_at,
         best_chain_id, best_balance_wei, best_balance_usd_cents, chains, error
       ) values ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6::jsonb, $7::numeric, $8, $9, $10::timestamptz,
                 $11, $12::numeric, $13::numeric, $14::jsonb, $15)
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
        error,
      ],
    );
    return { check: rows[0], cached: false };
  }

  /**
   * Maps the eligibility outcome + policy to the status a new registration gets.
   * X follow verification is not built yet: if a campaign requires it, applicants are
   * either recorded as pending_verification (when provisional registration is allowed)
   * or refused. They are never marked as having followed anyone.
   */
  function decideStatus(policy: EligibilityPolicy): { registrationStatus: string; eligibilityStatus: string } {
    if (policy.xFollowRequired) {
      if (!policy.allowProvisionalRegistration) {
        throw new HttpError(403, "VERIFICATION_UNAVAILABLE", "X verification is required but not available yet. Please check back soon.");
      }
      return { registrationStatus: "pending_verification", eligibilityStatus: "pending" };
    }
    return { registrationStatus: "eligible", eligibilityStatus: "eligible" };
  }

  async function checkEligibility(req: Request): Promise<Response> {
    await rateLimit(req, "eligibility");
    const session = await requireSession(req);
    const { campaign, policy } = await loadCampaignWithPolicy();
    const existing = await findOwnRegistration(session.wallet);
    if (existing) {
      // Already applied: nothing to evaluate, and no RPC calls spent.
      return json(req, 200, { walletAddress: getAddress(session.wallet), registration: publicRegistration(existing), eligibility: null });
    }
    if (!campaign.isOpen) throw new HttpError(403, "REGISTRATION_CLOSED", "FLYLIST registration is closed.", { campaign });
    const { check, cached } = await evaluateEligibility(session.wallet, policy);
    return json(req, 200, {
      walletAddress: getAddress(session.wallet),
      registration: null,
      eligibility: publicEligibility(check, policy.minEthBalanceUsdCents, cached),
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
    const { campaign, policy } = await loadCampaignWithPolicy();
    if (!campaign.isOpen) throw new HttpError(403, "REGISTRATION_CLOSED", "FLYLIST registration is closed.", { campaign: await loadCampaign() });

    // Eligibility is always the server's own result for this wallet (recent cached
    // check, or evaluated now). Nothing the browser sends can mark a wallet eligible.
    const { check, cached } = await evaluateEligibility(session.wallet, policy);
    if (check.result === "ineligible") {
      throw new HttpError(403, "INELIGIBLE", "This wallet doesn't meet the FLYLIST requirements.", {
        eligibility: publicEligibility(check, policy.minEthBalanceUsdCents, cached),
      });
    }
    if (check.result === "unavailable") {
      throw new HttpError(503, "ELIGIBILITY_UNAVAILABLE", "We couldn't check your balance right now. Please try again in a minute.", {
        eligibility: publicEligibility(check, policy.minEthBalanceUsdCents, cached),
      });
    }
    const decided = decideStatus(policy);

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
           eth_usd_price_source, eth_usd_price_at, eth_balance_usd_cents, eligibility_chain_id
         )
         select $1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz, $7, 'siwe_eip4361', $8::timestamptz,
                $9, $10, c.checked_at, $11,
                c.id, c.best_balance_wei, c.eth_usd_price, c.eth_usd_price_decimals,
                c.eth_usd_price_source, c.eth_usd_price_at, c.best_balance_usd_cents, c.best_chain_id
         from allowlist.eligibility_checks c
         where c.id = $12 and c.wallet_address_normalized = $3
         on conflict (campaign_id, wallet_address_normalized) do nothing
         returning *
       ), aud as (
         insert into allowlist.registration_audit (registration_id, actor_wallet, actor_role, action, changes, created_at)
         select id, wallet_address_normalized, 'registrant', 'registered',
                jsonb_build_object('twitter_username', twitter_username, 'registration_status', registration_status,
                                   'eligibility_check_id', eligibility_check_id), $6::timestamptz
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
        policy.accessMode,
        check.id,
      ],
    );
    if (rows.length === 0) {
      // Lost a race with a concurrent request for the same wallet.
      const row = await findOwnRegistration(session.wallet);
      throw new HttpError(409, "ALREADY_REGISTERED", "This wallet is already registered.", {
        registration: row ? publicRegistration(row) : null,
      });
    }
    return json(req, 201, { registration: publicRegistration(rows[0]) });
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

  function buildFilter(params: URLSearchParams): { where: string; values: unknown[] } {
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
    const preset = params.get("preset");
    if (preset) {
      const p = EXPORT_PRESETS[preset];
      if (!p) throw new HttpError(400, "INVALID_FILTER", "Unknown export preset.");
      if (p.statuses) add((n) => `registration_status = any($${n}::text[])`, p.statuses);
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
    const { where, values } = buildFilter(url.searchParams);
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
         from allowlist.registrations r
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
    return json(req, 200, { registration: adminRegistration(rows[0]) });
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
    const { where, values } = buildFilter(url.searchParams);

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
        `select * from allowlist.registrations where ${where}${keyset} order by registered_at asc, id asc limit ${BATCH}`,
        params,
      );
      for (const r of batch) {
        rows.push([
          r.id,
          r.campaign_id,
          r.wallet_address,
          r.twitter_username_normalized,
          twitterProfileUrl(r.twitter_username_normalized),
          r.twitter_verified ? "verified" : "unverified (self-reported)",
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
    if (path === "/me/registration") {
      if (method === "GET") return getOwnRegistration(req);
      if (method === "POST") return register(req);
      if (method === "PATCH") return updateOwnUsername(req);
    }
    if (method === "GET" && path === "/admin/stats") return adminStats(req);
    if (method === "GET" && path === "/admin/registrations") return adminList(req, url);
    if (method === "GET" && path === "/admin/export.csv") return adminExport(req, url);
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
