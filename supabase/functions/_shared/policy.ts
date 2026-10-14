// Campaign eligibility policy (spec §7): what it takes to apply, what must be proven
// before an application is eligible, and what puts a wallet on the final mint list.
//
// The live policy is the campaign row. Every change goes through updatePolicy(), which
// bumps campaigns.policy_version and appends the full snapshot to campaign_policies
// (append-only, enforced by a trigger) in one statement. Each eligibility check and
// registration records the version it was evaluated under, so history is traceable
// and a later policy change never rewrites an earlier result.

import type { Db } from "./db.ts";
import { HttpError } from "./errors.ts";

export type AccessMode = "open" | "invite_code" | "community" | "hybrid";

export type CampaignPolicy = {
  // Campaign registration status
  status: "draft" | "open" | "closed";
  opensAt: string | null;
  closesAt: string | null;
  // Registration requirements
  accessMode: AccessMode;
  ethBalanceCheckEnabled: boolean;
  minEthBalanceUsdCents: number;
  ethBalanceChainIds: number[];
  // Verification requirements
  xAuthRequired: boolean;
  xFollowRequired: boolean;
  requiredXAccounts: { id: string; username: string }[];
  allowProvisionalRegistration: boolean;
  // Community rule (access modes 'community' / 'hybrid')
  communityProvider: string;
  nftRule: "any" | "all" | "min_n";
  nftMinCollections: number;
  hybridRule: "code_or_community" | "code_and_community";
  // Mint eligibility
  finalExportIncludesUnverified: boolean;
  // Verification provider settings + budget
  xProvider: string;
  xVerificationCacheSeconds: number;
  xRetryCooldownSeconds: number;
  xBudgetDailyUnits: number;
  xBudgetTotalUnits: number;
};

/** Deferred integrations. Each needs an explicit ENABLED_INTEGRATIONS entry before it can be switched on. */
export const INTEGRATIONS = ["x_verification", "community_gating", "access_codes"] as const;
export type Integration = (typeof INTEGRATIONS)[number];

/** X providers implemented in code. Only 'none' exists until a paid X integration is approved (Phase C). */
export const X_PROVIDERS_IMPLEMENTED = ["none"] as const;
/** Community-rule providers implemented in code. */
export const COMMUNITY_PROVIDERS_IMPLEMENTED = ["nft_ownership"] as const;

const COLUMNS: Record<keyof CampaignPolicy, string> = {
  status: "status",
  opensAt: "opens_at",
  closesAt: "closes_at",
  accessMode: "access_mode",
  ethBalanceCheckEnabled: "eth_balance_check_enabled",
  minEthBalanceUsdCents: "min_eth_balance_usd_cents",
  ethBalanceChainIds: "eth_balance_chain_ids",
  xAuthRequired: "x_auth_required",
  xFollowRequired: "x_follow_required",
  requiredXAccounts: "required_x_accounts",
  allowProvisionalRegistration: "allow_provisional_registration",
  communityProvider: "community_provider",
  nftRule: "nft_rule",
  nftMinCollections: "nft_min_collections",
  hybridRule: "hybrid_rule",
  finalExportIncludesUnverified: "final_export_includes_unverified",
  xProvider: "x_provider",
  xVerificationCacheSeconds: "x_verification_cache_seconds",
  xRetryCooldownSeconds: "x_retry_cooldown_seconds",
  xBudgetDailyUnits: "x_budget_daily_units",
  xBudgetTotalUnits: "x_budget_total_units",
};

export const POLICY_KEYS = Object.keys(COLUMNS) as (keyof CampaignPolicy)[];

const asJson = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
const isoOrNull = (v: unknown) => (v === null || v === undefined ? null : (v instanceof Date ? v : new Date(String(v))).toISOString());

function intArray(v: unknown): number[] {
  if (Array.isArray(v)) return v.map(Number);
  return String(v ?? "").replace(/[{}]/g, "").split(",").filter(Boolean).map(Number);
}

export function rowToPolicy(r: Record<string, any>): CampaignPolicy {
  return {
    status: r.status,
    opensAt: isoOrNull(r.opens_at),
    closesAt: isoOrNull(r.closes_at),
    accessMode: r.access_mode,
    ethBalanceCheckEnabled: r.eth_balance_check_enabled,
    minEthBalanceUsdCents: Number(r.min_eth_balance_usd_cents),
    ethBalanceChainIds: intArray(r.eth_balance_chain_ids),
    xAuthRequired: r.x_auth_required,
    xFollowRequired: r.x_follow_required,
    requiredXAccounts: asJson(r.required_x_accounts) ?? [],
    allowProvisionalRegistration: r.allow_provisional_registration,
    communityProvider: r.community_provider,
    nftRule: r.nft_rule,
    nftMinCollections: Number(r.nft_min_collections),
    hybridRule: r.hybrid_rule,
    finalExportIncludesUnverified: r.final_export_includes_unverified,
    xProvider: r.x_provider,
    xVerificationCacheSeconds: Number(r.x_verification_cache_seconds),
    xRetryCooldownSeconds: Number(r.x_retry_cooldown_seconds),
    xBudgetDailyUnits: Number(r.x_budget_daily_units),
    xBudgetTotalUnits: Number(r.x_budget_total_units),
  };
}

export const POLICY_SELECT = `id, name, policy_version, ${Object.values(COLUMNS).join(", ")}`;

export function requiresAccessCode(p: Pick<CampaignPolicy, "accessMode" | "hybridRule">): boolean {
  return p.accessMode === "invite_code" || (p.accessMode === "hybrid" && p.hybridRule === "code_and_community");
}

export function requiresCommunity(p: Pick<CampaignPolicy, "accessMode" | "hybridRule">): boolean {
  return p.accessMode === "community" || (p.accessMode === "hybrid" && p.hybridRule === "code_and_community");
}

export function xVerificationRequired(p: Pick<CampaignPolicy, "xAuthRequired" | "xFollowRequired">): boolean {
  return p.xAuthRequired || p.xFollowRequired;
}

/** The policy grouped the way spec §7 describes it. Used by the admin API and docs. */
export function describePolicy(p: CampaignPolicy) {
  return {
    campaignStatus: { status: p.status, opensAt: p.opensAt, closesAt: p.closesAt },
    registration: {
      accessMode: p.accessMode,
      accessCodeRequired: requiresAccessCode(p),
      ethBalance: p.ethBalanceCheckEnabled
        ? { minUsdCents: p.minEthBalanceUsdCents, chainIds: p.ethBalanceChainIds, rule: "any_one_chain" }
        : null,
    },
    verification: {
      xAuthRequired: p.xAuthRequired,
      xFollowRequired: p.xFollowRequired,
      requiredXAccounts: p.requiredXAccounts,
      community:
        p.accessMode === "community" || p.accessMode === "hybrid"
          ? { provider: p.communityProvider, rule: p.nftRule, minCollections: p.nftMinCollections, hybridRule: p.accessMode === "hybrid" ? p.hybridRule : null }
          : null,
      allowProvisionalRegistration: p.allowProvisionalRegistration,
    },
    mintEligibility: {
      requiresAdminApproval: true,
      requiresCompletedVerification: !p.finalExportIncludesUnverified,
    },
    providers: {
      x: p.xProvider,
      xVerificationCacheSeconds: p.xVerificationCacheSeconds,
      xRetryCooldownSeconds: p.xRetryCooldownSeconds,
      xBudgetDailyUnits: p.xBudgetDailyUnits,
      xBudgetTotalUnits: p.xBudgetTotalUnits,
    },
  };
}

export type PolicyContext = {
  enabledIntegrations: ReadonlySet<string>;
  activeCollectionCount: number;
  supportedEthChainIds: number[];
};

const bad = (code: string, message: string) => new HttpError(400, code, message);
const refused = (code: string, message: string) => new HttpError(403, code, message);

function int(v: unknown, label: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad("INVALID_POLICY", `${label} must be a whole number from ${min} to ${max}.`);
  return v;
}
function bool(v: unknown, label: string): boolean {
  if (typeof v !== "boolean") throw bad("INVALID_POLICY", `${label} must be true or false.`);
  return v;
}
function oneOf<T extends string>(v: unknown, label: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw bad("INVALID_POLICY", `${label} must be one of: ${allowed.join(", ")}.`);
  return v as T;
}
function dateOrNull(v: unknown, label: string): string | null {
  if (v === null) return null;
  if (typeof v !== "string" || Number.isNaN(new Date(v).getTime())) throw bad("INVALID_POLICY", `${label} must be an ISO date-time or null.`);
  return new Date(v).toISOString();
}

/** Validates a partial policy update against the current policy and returns the merged result. */
export function applyPolicyPatch(current: CampaignPolicy, patch: Record<string, unknown>, ctx: PolicyContext): CampaignPolicy {
  const next: CampaignPolicy = { ...current, requiredXAccounts: [...current.requiredXAccounts], ethBalanceChainIds: [...current.ethBalanceChainIds] };
  for (const [key, v] of Object.entries(patch)) {
    switch (key as keyof CampaignPolicy) {
      case "status": next.status = oneOf(v, "Campaign status", ["draft", "open", "closed"] as const); break;
      case "opensAt": next.opensAt = dateOrNull(v, "Opens at"); break;
      case "closesAt": next.closesAt = dateOrNull(v, "Closes at"); break;
      case "accessMode": next.accessMode = oneOf(v, "Access mode", ["open", "invite_code", "community", "hybrid"] as const); break;
      case "ethBalanceCheckEnabled": next.ethBalanceCheckEnabled = bool(v, "ETH balance check"); break;
      case "minEthBalanceUsdCents": next.minEthBalanceUsdCents = int(v, "Minimum USD (cents)", 0, 100_000_000); break;
      case "ethBalanceChainIds": {
        if (!Array.isArray(v) || v.length === 0 || v.length > 10) throw bad("INVALID_POLICY", "ETH balance chains must be a list of 1 to 10 chain IDs.");
        const ids = [...new Set(v.map((x) => int(x, "Chain ID", 1, 2 ** 31 - 1)))];
        const unsupported = ids.filter((id) => !ctx.supportedEthChainIds.includes(id));
        if (unsupported.length) throw bad("UNSUPPORTED_CHAIN", `No RPC is configured for chain ${unsupported.join(", ")}. Add it to RPC_URLS first.`);
        next.ethBalanceChainIds = ids;
        break;
      }
      case "xAuthRequired": next.xAuthRequired = bool(v, "X account verification"); break;
      case "xFollowRequired": next.xFollowRequired = bool(v, "X follow verification"); break;
      case "requiredXAccounts": {
        if (!Array.isArray(v) || v.length > 10) throw bad("INVALID_POLICY", "Required X accounts must be a list of at most 10.");
        next.requiredXAccounts = v.map((a) => {
          const id = (a as any)?.id;
          const username = String((a as any)?.username ?? "").replace(/^@/, "");
          if (typeof id !== "string" || !/^[0-9]{1,25}$/.test(id)) throw bad("INVALID_POLICY", "Each required X account needs its numeric X user ID (usernames can change; IDs don't).");
          if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) throw bad("INVALID_POLICY", "Each required X account needs a valid username.");
          return { id, username };
        });
        break;
      }
      case "allowProvisionalRegistration": next.allowProvisionalRegistration = bool(v, "Provisional registration"); break;
      case "communityProvider": next.communityProvider = oneOf(v, "Community provider", COMMUNITY_PROVIDERS_IMPLEMENTED); break;
      case "nftRule": next.nftRule = oneOf(v, "NFT rule", ["any", "all", "min_n"] as const); break;
      case "nftMinCollections": next.nftMinCollections = int(v, "Minimum qualifying collections", 1, 50); break;
      case "hybridRule": next.hybridRule = oneOf(v, "Hybrid rule", ["code_or_community", "code_and_community"] as const); break;
      case "finalExportIncludesUnverified": next.finalExportIncludesUnverified = bool(v, "Final export includes unverified"); break;
      case "xProvider": {
        if (typeof v !== "string" || !(X_PROVIDERS_IMPLEMENTED as readonly string[]).includes(v)) {
          throw refused("PROVIDER_NOT_IMPLEMENTED", "That X verification provider isn't built. A paid X integration needs owner approval (Phase C).");
        }
        next.xProvider = v;
        break;
      }
      case "xVerificationCacheSeconds": next.xVerificationCacheSeconds = int(v, "X verification cache (seconds)", 0, 365 * 86400); break;
      case "xRetryCooldownSeconds": next.xRetryCooldownSeconds = int(v, "X retry cooldown (seconds)", 0, 86400); break;
      case "xBudgetDailyUnits": next.xBudgetDailyUnits = int(v, "Daily X budget", 0, 10_000_000); break;
      case "xBudgetTotalUnits": next.xBudgetTotalUnits = int(v, "Total X budget", 0, 100_000_000); break;
      default:
        throw bad("UNKNOWN_POLICY_FIELD", `Unknown policy field: ${key}.`);
    }
  }

  if (next.opensAt && next.closesAt && new Date(next.opensAt) >= new Date(next.closesAt)) throw bad("INVALID_POLICY", "Opens at must be before closes at.");

  // ---- deferred integrations: refused unless explicitly activated ----
  const on = (i: Integration) => ctx.enabledIntegrations.has(i);
  if (requiresAccessCode(next) || next.accessMode === "invite_code" || next.accessMode === "hybrid") {
    if (!on("access_codes")) throw refused("INTEGRATION_DISABLED", "Access-code gating is disabled. It needs owner approval and ENABLED_INTEGRATIONS=access_codes.");
  }
  if (next.accessMode === "community" || next.accessMode === "hybrid") {
    if (!on("community_gating")) throw refused("INTEGRATION_DISABLED", "Community (partner NFT) gating is disabled. It needs owner approval and ENABLED_INTEGRATIONS=community_gating.");
    if (ctx.activeCollectionCount === 0) throw bad("NO_COLLECTIONS", "Add at least one active partner collection before turning on community gating.");
    if (next.nftRule === "min_n" && next.nftMinCollections > ctx.activeCollectionCount) {
      throw bad("INVALID_POLICY", `The rule needs ${next.nftMinCollections} collections but only ${ctx.activeCollectionCount} are active.`);
    }
  }
  if (next.xProvider !== "none" && !on("x_verification")) {
    throw refused("INTEGRATION_DISABLED", "X verification is disabled. It needs owner approval and ENABLED_INTEGRATIONS=x_verification.");
  }
  if (next.xFollowRequired && next.requiredXAccounts.length === 0) throw bad("INVALID_POLICY", "List the X accounts applicants must follow first.");

  // An X requirement with no working provider and no provisional registration would refuse everyone.
  const xWorks = next.xProvider !== "none" && on("x_verification");
  if (xVerificationRequired(next) && !xWorks && !next.allowProvisionalRegistration) {
    throw bad(
      "WOULD_BLOCK_REGISTRATION",
      "X verification isn't available, so requiring it would block every applicant. Turn on provisional registration (applicants are recorded as pending verification) or leave X optional.",
    );
  }
  return next;
}

export function policyToRowValues(p: CampaignPolicy): unknown[] {
  return POLICY_KEYS.map((k) => {
    const v = p[k];
    if (k === "requiredXAccounts") return JSON.stringify(v);
    return v;
  });
}

const COLUMN_CASTS: Partial<Record<keyof CampaignPolicy, string>> = {
  opensAt: "::timestamptz",
  closesAt: "::timestamptz",
  ethBalanceChainIds: "::integer[]",
  requiredXAccounts: "::text::jsonb",
};

/**
 * Writes `next` as the campaign's new policy, bumping the version and appending the
 * snapshot to the append-only history, in a single statement. `expectedVersion`
 * guards against two admins editing at once (409 on conflict).
 */
export async function updatePolicy(
  db: Db,
  args: { campaignId: string; expectedVersion: number; next: CampaignPolicy; actor: string; reason: string | null; at: Date },
): Promise<{ version: number }> {
  const values = policyToRowValues(args.next);
  const sets = POLICY_KEYS.map((k, i) => `${COLUMNS[k]} = $${i + 1}${COLUMN_CASTS[k] ?? ""}`).join(", ");
  const n = POLICY_KEYS.length;
  const rows = await db.query<{ version: number }>(
    `with upd as (
       update allowlist.campaigns set ${sets},
         policy_version = policy_version + 1, policy_updated_at = $${n + 3}::timestamptz
       where id = $${n + 1} and policy_version = $${n + 2}
       returning id, policy_version
     ), hist as (
       insert into allowlist.campaign_policies (campaign_id, version, policy, created_at, created_by, reason)
       select id, policy_version, $${n + 4}::text::jsonb, $${n + 3}::timestamptz, $${n + 5}, $${n + 6} from upd
     )
     select policy_version as version from upd`,
    [...values, args.campaignId, args.expectedVersion, args.at.toISOString(), JSON.stringify(args.next), args.actor, args.reason],
  );
  if (rows.length === 0) throw new HttpError(409, "POLICY_CONFLICT", "The policy was changed by someone else. Reload and try again.");
  return { version: Number(rows[0].version) };
}
