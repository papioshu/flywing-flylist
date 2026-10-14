-- FLYLIST Phase B: verification architecture. Interfaces and data model only.
--
-- Nothing here switches a requirement on. The current campaign stays as the owner
-- decided (open mode, X not required, $55 ETH on Ethereum or Robinhood Chain):
--   * access_mode is still locked to 'open' by campaigns_access_mode_implemented (D013).
--   * X verification ships with the 'none' provider, so it reports not_configured.
--   * No partner collections are configured.
--   * Paid-call budgets default to 0, so even a configured provider could not spend.

-- ---------- campaign policy (live columns) ----------
alter table allowlist.campaigns
  -- Current policy version. Every policy change bumps it and writes campaign_policies.
  add column policy_version integer not null default 1 check (policy_version >= 1),
  -- Verification requirements (§7 "what must be proven before an application becomes eligible").
  add column x_auth_required boolean not null default false,
  -- [{ "id": "<numeric X user id>", "username": "<handle>" }]. Only used when x_follow_required.
  add column required_x_accounts jsonb not null default '[]'::jsonb check (jsonb_typeof(required_x_accounts) = 'array'),
  -- Which X verification provider is selected. Only 'none' is implemented (Phase C adds a real one).
  add column x_provider text not null default 'none' check (x_provider ~ '^[a-z0-9_]{1,32}$'),
  -- How long a successful X verification is reused before a re-check (default 30 days).
  add column x_verification_cache_seconds integer not null default 2592000 check (x_verification_cache_seconds >= 0),
  -- Minimum gap between X verification attempts by one wallet.
  add column x_retry_cooldown_seconds integer not null default 300 check (x_retry_cooldown_seconds >= 0),
  -- Paid X API budget, in provider-estimated units. 0 = no paid calls at all.
  add column x_budget_daily_units integer not null default 0 check (x_budget_daily_units >= 0),
  add column x_budget_total_units integer not null default 0 check (x_budget_total_units >= 0),
  -- Community rule (used by access_mode 'community' / 'hybrid'): partner NFT ownership.
  add column community_provider text not null default 'nft_ownership' check (community_provider ~ '^[a-z0-9_]{1,32}$'),
  add column nft_rule text not null default 'any' check (nft_rule in ('any', 'all', 'min_n')),
  add column nft_min_collections integer not null default 1 check (nft_min_collections >= 1),
  -- Hybrid: a valid code OR the community rule, or both.
  add column hybrid_rule text not null default 'code_or_community' check (hybrid_rule in ('code_or_community', 'code_and_community')),
  -- Mint eligibility (§7): the final export is always approved-only. This flag decides whether an
  -- approved wallet whose required verifications are still pending may be included. Default: no.
  add column final_export_includes_unverified boolean not null default false;

-- ---------- policy history (append-only) ----------
create table allowlist.campaign_policies (
  campaign_id  text not null references allowlist.campaigns (id),
  version      integer not null check (version >= 1),
  -- Full snapshot of every policy field at this version (camelCase keys, as the API uses).
  policy       jsonb not null,
  created_at   timestamptz not null default now(),
  -- Admin wallet, or 'system' for the migration seed.
  created_by   text not null,
  reason       text check (reason is null or char_length(reason) <= 500),
  primary key (campaign_id, version)
);

create function allowlist.campaign_policies_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'campaign_policies is append-only (% blocked)', tg_op;
end
$$;

create trigger campaign_policies_append_only
  before update or delete on allowlist.campaign_policies
  for each row execute function allowlist.campaign_policies_append_only();

insert into allowlist.campaign_policies (campaign_id, version, policy, created_by, reason)
select c.id, 1,
       jsonb_build_object(
         'status', c.status, 'opensAt', c.opens_at, 'closesAt', c.closes_at,
         'accessMode', c.access_mode,
         'ethBalanceCheckEnabled', c.eth_balance_check_enabled,
         'minEthBalanceUsdCents', c.min_eth_balance_usd_cents,
         'ethBalanceChainIds', to_jsonb(c.eth_balance_chain_ids),
         'xAuthRequired', c.x_auth_required,
         'xFollowRequired', c.x_follow_required,
         'requiredXAccounts', c.required_x_accounts,
         'allowProvisionalRegistration', c.allow_provisional_registration,
         'xProvider', c.x_provider,
         'xVerificationCacheSeconds', c.x_verification_cache_seconds,
         'xRetryCooldownSeconds', c.x_retry_cooldown_seconds,
         'xBudgetDailyUnits', c.x_budget_daily_units,
         'xBudgetTotalUnits', c.x_budget_total_units,
         'communityProvider', c.community_provider,
         'nftRule', c.nft_rule,
         'nftMinCollections', c.nft_min_collections,
         'hybridRule', c.hybrid_rule,
         'finalExportIncludesUnverified', c.final_export_includes_unverified
       ),
       'system', 'Phase B migration: snapshot of the policy in force'
from allowlist.campaigns c;

alter table allowlist.eligibility_checks add column policy_version integer;
update allowlist.eligibility_checks set policy_version = 1;

-- Repair: under postgres.js (the production driver) Phase A stored these two jsonb columns as
-- JSON *strings* holding the serialized value (the driver JSON-encoded an already-serialized
-- string). Values are unchanged; this unwraps them to real objects/arrays. The app now sends
-- every jsonb parameter as text cast on the server, so new rows are stored correctly.
update allowlist.eligibility_checks set policy = (policy #>> '{}')::jsonb where jsonb_typeof(policy) = 'string';
update allowlist.eligibility_checks set chains = (chains #>> '{}')::jsonb where jsonb_typeof(chains) = 'string';

-- ---------- partner collections (community rule) ----------
-- Identity is (chain_id, contract_address) within a campaign. None are configured:
-- the owner has not named any partner collections, and none may be invented.
create table allowlist.partner_collections (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       text not null references allowlist.campaigns (id),
  display_name      text not null check (char_length(display_name) between 1 and 80),
  chain_id          integer not null check (chain_id > 0),
  contract_address  text not null check (contract_address ~ '^0x[0-9a-f]{40}$'),
  standard          text not null check (standard in ('erc721', 'erc1155')),
  -- ERC-721: tokens held (collection-wide, or among token_ids). ERC-1155: summed balance of token_ids.
  min_quantity      integer not null default 1 check (min_quantity >= 1),
  -- Decimal token IDs. Empty = whole collection (ERC-721 only; ERC-1155 must list IDs).
  token_ids         text[] not null default '{}',
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint partner_collections_identity unique (campaign_id, chain_id, contract_address),
  constraint partner_collections_1155_ids check (standard <> 'erc1155' or cardinality(token_ids) > 0),
  constraint partner_collections_token_ids check (cardinality(token_ids) <= 50)
);

create table allowlist.partner_collection_audit (
  id             bigint generated always as identity primary key,
  collection_id  uuid not null references allowlist.partner_collections (id),
  actor_wallet   text not null,
  action         text not null,
  changes        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

-- One row per server-side ownership evaluation (registration-time; a mint-time
-- re-check would be a separate row with purpose 'mint').
create table allowlist.nft_ownership_checks (
  id                         uuid primary key default gen_random_uuid(),
  campaign_id                text not null references allowlist.campaigns (id),
  wallet_address_normalized  text not null check (wallet_address_normalized ~ '^0x[0-9a-f]{40}$'),
  purpose                    text not null default 'registration' check (purpose in ('registration', 'mint', 'admin_test')),
  checked_at                 timestamptz not null,
  policy_version             integer,
  rule                       text not null check (rule in ('any', 'all', 'min_n')),
  min_collections            integer not null,
  result                     text not null check (result in ('qualified', 'not_qualified', 'unavailable', 'not_configured')),
  -- [{collectionId, displayName, chainId, contract, standard, minQuantity, tokenIds,
  --   quantity, blockNumber, source: "rpc", result: "qualified"|"not_qualified"|"error", error}]
  snapshots                  jsonb not null default '[]'::jsonb,
  error                      text
);

create index nft_ownership_checks_wallet_idx
  on allowlist.nft_ownership_checks (campaign_id, wallet_address_normalized, checked_at desc);

alter table allowlist.eligibility_checks
  add column nft_check_id uuid references allowlist.nft_ownership_checks (id);

-- ---------- access codes ----------
-- Only a keyed SHA-256 of each code is stored; the plaintext is shown once at creation.
create table allowlist.access_codes (
  id                    uuid primary key default gen_random_uuid(),
  campaign_id           text not null references allowlist.campaigns (id),
  code_hash             text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  -- First characters of the code, so admins can tell codes apart without the secret.
  code_prefix           text not null check (code_prefix ~ '^[A-Z0-9-]{4,12}$'),
  label                 text check (label is null or char_length(label) <= 80),
  -- Optional: which community a code was issued to. Attribution only, never proof of NFT ownership.
  community_attribution text check (community_attribution is null or char_length(community_attribution) <= 80),
  max_redemptions       integer not null default 1 check (max_redemptions >= 1),
  redemption_count      integer not null default 0 check (redemption_count >= 0),
  expires_at            timestamptz,
  revoked_at            timestamptz,
  created_by            text not null,
  created_at            timestamptz not null default now(),
  constraint access_codes_within_max check (redemption_count <= max_redemptions)
);

create index access_codes_campaign_idx on allowlist.access_codes (campaign_id, created_at desc);

create table allowlist.access_code_redemptions (
  id                         uuid primary key default gen_random_uuid(),
  code_id                    uuid not null references allowlist.access_codes (id),
  campaign_id                text not null references allowlist.campaigns (id),
  wallet_address_normalized  text not null check (wallet_address_normalized ~ '^0x[0-9a-f]{40}$'),
  registration_id            uuid references allowlist.registrations (id),
  redeemed_at                timestamptz not null,
  -- One code redemption per wallet per campaign.
  constraint access_code_redemptions_wallet_unique unique (campaign_id, wallet_address_normalized)
);

-- Every code event, including refused redemptions (wrong, expired, revoked, used up).
create table allowlist.access_code_audit (
  id                         bigint generated always as identity primary key,
  campaign_id                text not null,
  code_id                    uuid references allowlist.access_codes (id),
  actor_wallet               text not null,
  action                     text not null check (action in ('created', 'revoked', 'redeemed', 'redemption_refused', 'redemption_released')),
  detail                     jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now()
);

-- ---------- X verification ----------
-- Account authentication (status) and follow verification (follow_status) are separate.
-- A provider error is 'unavailable', never "does not follow".
create table allowlist.x_verifications (
  campaign_id                text not null references allowlist.campaigns (id),
  wallet_address_normalized  text not null check (wallet_address_normalized ~ '^0x[0-9a-f]{40}$'),
  provider                   text not null,
  status                     text not null check (status in ('not_configured', 'not_started', 'pending', 'verified', 'failed', 'unavailable')),
  x_user_id                  text check (x_user_id is null or x_user_id ~ '^[0-9]{1,25}$'),
  x_username                 text check (x_username is null or x_username ~ '^[A-Za-z0-9_]{1,15}$'),
  authenticated_at           timestamptz,
  follow_status              text not null default 'not_started'
                               check (follow_status in ('not_required', 'not_configured', 'not_started', 'pending', 'verified', 'failed', 'unavailable')),
  -- [{accountId, username, following: true | false | null}]  (null = could not be determined)
  follows                    jsonb not null default '[]'::jsonb,
  follow_checked_at          timestamptz,
  -- A verified result is reused until this time (campaign x_verification_cache_seconds).
  verified_until             timestamptz,
  last_attempt_at            timestamptz,
  attempts                   integer not null default 0,
  error                      text,
  policy_version             integer,
  updated_at                 timestamptz not null,
  primary key (campaign_id, wallet_address_normalized),
  constraint x_verifications_verified_has_user check (status <> 'verified' or (x_user_id is not null and authenticated_at is not null))
);

create index x_verifications_user_idx on allowlist.x_verifications (campaign_id, x_user_id);

-- Pending OAuth (PKCE) handshakes. Only the state's hash is the key; the verifier never leaves the server.
create table allowlist.x_oauth_states (
  state_hash                 text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  campaign_id                text not null references allowlist.campaigns (id),
  wallet_address_normalized  text not null,
  code_verifier              text not null,
  created_at                 timestamptz not null,
  expires_at                 timestamptz not null,
  used_at                    timestamptz
);

-- ---------- paid-API budget + usage ledger ----------
-- One counter row per (campaign, provider). Reservations are a single conditional
-- UPDATE, so concurrent requests can never overshoot the budget.
create table allowlist.provider_budgets (
  campaign_id  text not null references allowlist.campaigns (id),
  provider     text not null,
  day          date not null,
  used_today   integer not null default 0 check (used_today >= 0),
  used_total   integer not null default 0 check (used_total >= 0),
  primary key (campaign_id, provider)
);

create table allowlist.provider_usage (
  id                         bigint generated always as identity primary key,
  campaign_id                text not null,
  provider                   text not null,
  operation                  text not null,
  wallet_address_normalized  text,
  x_user_id                  text,
  ip_hash                    text,
  estimated_units            integer not null default 0,
  actual_units               integer,
  outcome                    text not null check (outcome in ('reserved', 'ok', 'error', 'refused')),
  detail                     text,
  created_at                 timestamptz not null,
  completed_at               timestamptz
);

create index provider_usage_campaign_idx on allowlist.provider_usage (campaign_id, provider, created_at desc);
create index provider_usage_wallet_idx on allowlist.provider_usage (provider, wallet_address_normalized, created_at);
create index provider_usage_xuser_idx on allowlist.provider_usage (provider, x_user_id, created_at);
create index provider_usage_ip_idx on allowlist.provider_usage (provider, ip_hash, created_at);

-- ---------- registrations ----------
alter table allowlist.registrations
  add column policy_version integer,
  -- Rolled-up state of the verification requirements in force when it was evaluated.
  add column verification_status text not null default 'not_required'
    check (verification_status in ('not_required', 'pending', 'verified', 'failed')),
  add column nft_status text not null default 'not_required'
    check (nft_status in ('not_required', 'qualified', 'not_qualified', 'unavailable', 'not_configured')),
  add column nft_check_id uuid references allowlist.nft_ownership_checks (id),
  add column access_code_id uuid references allowlist.access_codes (id),
  add column community_attribution text;

update allowlist.registrations set policy_version = 1;

-- ---------- lock down ----------
alter table allowlist.campaign_policies         enable row level security;
alter table allowlist.partner_collections       enable row level security;
alter table allowlist.partner_collection_audit  enable row level security;
alter table allowlist.nft_ownership_checks      enable row level security;
alter table allowlist.access_codes              enable row level security;
alter table allowlist.access_code_redemptions   enable row level security;
alter table allowlist.access_code_audit         enable row level security;
alter table allowlist.x_verifications           enable row level security;
alter table allowlist.x_oauth_states            enable row level security;
alter table allowlist.provider_budgets          enable row level security;
alter table allowlist.provider_usage            enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema allowlist from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema allowlist from authenticated';
  end if;
end
$$;
