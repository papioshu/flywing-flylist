// Invite / access codes (spec §6). Built but not switched on: a code is only asked for
// when the campaign's access mode requires one, and access_mode is locked to 'open'
// at the database (D013) until the owner approves invite-only campaigns.
//
// - Codes are random (crypto.getRandomValues, ~100 bits) and shown once.
// - Only a keyed SHA-256 (HMAC-style: pepper + code) is stored.
// - Redemption is one SQL statement: the code row is locked, every rule (campaign,
//   not revoked, not expired, uses left) is re-checked on the locked row, and the
//   counter and redemption row are written together, so concurrent redemptions of a
//   1-use code produce exactly one success.
// - A code is attribution and access, never proof of NFT ownership.

import type { Db } from "./db.ts";
import { HttpError } from "./errors.ts";

// Crockford-style base32 without look-alikes (no I, L, O, U).
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateAccessCode(): string {
  const chars: string[] = [];
  for (const b of crypto.getRandomValues(new Uint8Array(20))) chars.push(ALPHABET[b & 31]); // 20 × 5 bits = 100 bits
  return `FLY-${chars.slice(0, 5).join("")}-${chars.slice(5, 10).join("")}-${chars.slice(10, 15).join("")}-${chars.slice(15).join("")}`;
}

/** Normalizes what a person typed: case, spaces and dashes don't matter. */
export function normalizeAccessCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.toUpperCase().replace(/[\s-]/g, "");
  const body = raw.startsWith("FLY") ? raw.slice(3) : raw;
  if (!/^[0-9A-Z]{20}$/.test(body)) return null;
  if ([...body].some((c) => !ALPHABET.includes(c))) return null;
  return `FLY-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}-${body.slice(15)}`;
}

export async function hashAccessCode(code: string, pepper: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${pepper}:access-code:${code}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type AccessCodeRow = {
  id: string;
  campaign_id: string;
  code_prefix: string;
  label: string | null;
  community_attribution: string | null;
  max_redemptions: number;
  redemption_count: number;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
};

export async function createAccessCodes(
  db: Db,
  args: {
    campaignId: string;
    count: number;
    maxRedemptions: number;
    expiresAt: string | null;
    label: string | null;
    communityAttribution: string | null;
    actor: string;
    pepper: string;
    at: Date;
  },
): Promise<{ code: string; row: AccessCodeRow }[]> {
  const out: { code: string; row: AccessCodeRow }[] = [];
  for (let i = 0; i < args.count; i++) {
    const code = generateAccessCode();
    const rows = await db.query<AccessCodeRow>(
      `with ins as (
         insert into allowlist.access_codes (campaign_id, code_hash, code_prefix, label, community_attribution, max_redemptions, expires_at, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9::timestamptz)
         returning *
       ), aud as (
         insert into allowlist.access_code_audit (campaign_id, code_id, actor_wallet, action, detail, created_at)
         select campaign_id, id, $8, 'created', jsonb_build_object('max_redemptions', max_redemptions, 'expires_at', expires_at, 'label', label), $9::timestamptz from ins
       )
       select id, campaign_id, code_prefix, label, community_attribution, max_redemptions, redemption_count, expires_at, revoked_at, created_by, created_at from ins`,
      [
        args.campaignId,
        await hashAccessCode(code, args.pepper),
        code.slice(0, 9), // "FLY-ABCDE"
        args.label,
        args.communityAttribution,
        args.maxRedemptions,
        args.expiresAt,
        args.actor,
        args.at.toISOString(),
      ],
    );
    out.push({ code, row: rows[0] });
  }
  return out;
}

export async function revokeAccessCode(db: Db, args: { campaignId: string; id: string; actor: string; at: Date }): Promise<AccessCodeRow> {
  const rows = await db.query<AccessCodeRow>(
    `with upd as (
       update allowlist.access_codes set revoked_at = coalesce(revoked_at, $3::timestamptz)
       where id = $1 and campaign_id = $2
       returning *
     ), aud as (
       insert into allowlist.access_code_audit (campaign_id, code_id, actor_wallet, action, created_at)
       select campaign_id, id, $4, 'revoked', $3::timestamptz from upd
     )
     select id, campaign_id, code_prefix, label, community_attribution, max_redemptions, redemption_count, expires_at, revoked_at, created_by, created_at from upd`,
    [args.id, args.campaignId, args.at.toISOString(), args.actor],
  );
  if (rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Access code not found.");
  return rows[0];
}

export type Redemption = { redemptionId: string; codeId: string; communityAttribution: string | null };

/**
 * Atomically redeems `code` for `wallet` in one statement. Throws ACCESS_CODE_INVALID
 * (same message for unknown / wrong-campaign / revoked / expired / used-up, so codes
 * can't be probed) and records the refusal reason in the audit log.
 */
export async function redeemAccessCode(
  db: Db,
  args: { campaignId: string; code: unknown; wallet: string; pepper: string; at: Date },
): Promise<Redemption> {
  const normalized = normalizeAccessCode(args.code);
  const invalid = new HttpError(403, "ACCESS_CODE_INVALID", "That access code isn't valid.");
  if (!normalized) throw invalid;
  const hash = await hashAccessCode(normalized, args.pepper);
  const ts = args.at.toISOString();
  const rows = await db.query<{ redemption_id: string; code_id: string; community_attribution: string | null }>(
    `with code as (
       select id, community_attribution from allowlist.access_codes
       where code_hash = $1 and campaign_id = $2 and revoked_at is null
         and (expires_at is null or expires_at > $4::timestamptz)
         and redemption_count < max_redemptions
       for update
     ), red as (
       insert into allowlist.access_code_redemptions (code_id, campaign_id, wallet_address_normalized, redeemed_at)
       select id, $2, $3, $4::timestamptz from code
       on conflict (campaign_id, wallet_address_normalized) do nothing
       returning id, code_id
     ), bump as (
       update allowlist.access_codes a set redemption_count = a.redemption_count + 1
       from red where a.id = red.code_id
     ), aud as (
       insert into allowlist.access_code_audit (campaign_id, code_id, actor_wallet, action, created_at)
       select $2, code_id, $3, 'redeemed', $4::timestamptz from red
     )
     select red.id as redemption_id, red.code_id, code.community_attribution from red join code on code.id = red.code_id`,
    [hash, args.campaignId, args.wallet, ts],
  );
  if (rows.length > 0) return { redemptionId: rows[0].redemption_id, codeId: rows[0].code_id, communityAttribution: rows[0].community_attribution };

  // Refused: work out why, for the audit log only (the caller gets one generic message).
  const [why] = await db.query<{ id: string; reason: string }>(
    `select id,
            case when campaign_id <> $2 then 'wrong_campaign'
                 when revoked_at is not null then 'revoked'
                 when expires_at is not null and expires_at <= $3::timestamptz then 'expired'
                 when redemption_count >= max_redemptions then 'used_up'
                 else 'already_redeemed_by_wallet' end as reason
     from allowlist.access_codes where code_hash = $1`,
    [hash, args.campaignId, ts],
  );
  const walletUsed = await db.query(
    `select 1 from allowlist.access_code_redemptions where campaign_id = $1 and wallet_address_normalized = $2`,
    [args.campaignId, args.wallet],
  );
  await db.query(
    `insert into allowlist.access_code_audit (campaign_id, code_id, actor_wallet, action, detail, created_at)
     values ($1, $2, $3, 'redemption_refused', jsonb_build_object('reason', $4::text), $5::timestamptz)`,
    [args.campaignId, why?.id ?? null, args.wallet, walletUsed.length ? "wallet_already_redeemed" : (why?.reason ?? "unknown_code"), ts],
  );
  if (walletUsed.length) throw new HttpError(409, "ACCESS_CODE_ALREADY_USED", "This wallet already redeemed an access code for this campaign.");
  throw invalid;
}

/** Links a redemption to the registration it admitted. */
export async function attachRedemption(db: Db, redemptionId: string, registrationId: string): Promise<void> {
  await db.query(`update allowlist.access_code_redemptions set registration_id = $2 where id = $1`, [redemptionId, registrationId]);
}

/**
 * Gives a redemption back when the registration it was taken for didn't happen (lost a
 * race with a concurrent request for the same wallet). Counter and row change together.
 */
export async function releaseRedemption(db: Db, args: { redemptionId: string; actor: string; at: Date }): Promise<void> {
  await db.query(
    `with del as (
       delete from allowlist.access_code_redemptions where id = $1 and registration_id is null returning code_id, campaign_id
     ), dec as (
       update allowlist.access_codes a set redemption_count = a.redemption_count - 1 from del where a.id = del.code_id
     )
     insert into allowlist.access_code_audit (campaign_id, code_id, actor_wallet, action, created_at)
     select campaign_id, code_id, $2, 'redemption_released', $3::timestamptz from del`,
    [args.redemptionId, args.actor, args.at.toISOString()],
  );
}
