-- FLYLIST Phase A: campaign eligibility policy, server-side ETH balance checks,
-- and the spec's registration states.
--
-- Registration (applied) is separate from mint eligibility: a row records what was
-- proven at registration time; `approved` is an admin decision and is the only
-- status that reaches the final mint allowlist export.

-- ---------- campaign policy ----------
-- Every rule that decides eligibility lives on the campaign row, and a copy of the
-- rules in force is stored with each eligibility check, so a later policy change
-- never rewrites how an earlier result was reached.
alter table allowlist.campaigns
  add column access_mode text not null default 'open'
    check (access_mode in ('open', 'invite_code', 'community', 'hybrid')),
  add column eth_balance_check_enabled boolean not null default true,
  -- USD cents, so $55.00 = 5500. Integer to keep the comparison exact.
  add column min_eth_balance_usd_cents integer not null default 5500 check (min_eth_balance_usd_cents >= 0),
  -- A wallet passes if ANY one of these chains individually holds enough native ETH.
  add column eth_balance_chain_ids integer[] not null default '{1,4663}',
  -- Future X verification (Phase B). Off for the current campaign by owner decision.
  add column x_follow_required boolean not null default false,
  -- When a required verification cannot run yet, may applicants be recorded as
  -- pending_verification? Only meaningful once something is required.
  add column allow_provisional_registration boolean not null default false,
  add column policy_updated_at timestamptz not null default now();

-- Only 'open' is implemented. The other modes exist in the data model so they can be
-- added later without restructuring, but must not be switched on until built.
alter table allowlist.campaigns
  add constraint campaigns_access_mode_implemented check (access_mode = 'open');

update allowlist.campaigns set name = 'FLY WING GENESIS FLYLIST' where id = 'fwg-genesis' and name = 'FLY WING GENESIS Allowlist';

-- ---------- eligibility checks ----------
-- One row per server-side evaluation. Rows are created only by the server; the
-- browser never submits a result. Short-lived rows double as the per-wallet cache.
create table allowlist.eligibility_checks (
  id                         uuid primary key default gen_random_uuid(),
  campaign_id                text not null references allowlist.campaigns (id),
  wallet_address_normalized  text not null check (wallet_address_normalized ~ '^0x[0-9a-f]{40}$'),
  checked_at                 timestamptz not null,
  expires_at                 timestamptz not null,
  result                     text not null check (result in ('eligible', 'ineligible', 'unavailable')),
  -- Rules in force at evaluation time (min USD, chains, access mode, ...).
  policy                     jsonb not null,
  -- ETH/USD price used, as an integer with price_decimals decimals (Chainlink: 8).
  eth_usd_price              numeric(40, 0),
  eth_usd_price_decimals     integer,
  eth_usd_price_source       text check (eth_usd_price_source is null or eth_usd_price_source in ('chainlink', 'coinbase')),
  eth_usd_price_at           timestamptz,
  -- Headline figures: the qualifying chain if any passed, else the largest USD value.
  best_chain_id              integer,
  best_balance_wei           numeric(78, 0),
  best_balance_usd_cents     numeric(40, 0),
  -- Per-chain snapshots: [{chainId, status, balanceWei, blockNumber, usdCents, passed, error}].
  chains                     jsonb not null default '[]'::jsonb,
  error                      text
);

create index eligibility_checks_wallet_idx
  on allowlist.eligibility_checks (campaign_id, wallet_address_normalized, checked_at desc);

alter table allowlist.eligibility_checks enable row level security;

-- ---------- registrations ----------
alter table allowlist.registrations drop constraint registrations_registration_status_check;
update allowlist.registrations set registration_status = 'pending_verification' where registration_status = 'waitlisted';
update allowlist.registrations set registration_status = 'rejected' where registration_status = 'removed';
alter table allowlist.registrations add constraint registrations_registration_status_check
  check (registration_status in ('registered', 'pending_verification', 'eligible', 'ineligible', 'approved', 'rejected'));

alter table allowlist.registrations drop constraint registrations_eligibility_status_check;
alter table allowlist.registrations add constraint registrations_eligibility_status_check
  check (eligibility_status in ('not_checked', 'pending', 'eligible', 'ineligible'));

alter table allowlist.registrations
  add column access_method text not null default 'open'
    check (access_method in ('open', 'invite_code', 'community', 'hybrid')),
  -- Snapshot of the eligibility check the registration was accepted on.
  add column eligibility_check_id uuid references allowlist.eligibility_checks (id),
  add column eth_balance_wei numeric(78, 0),
  add column eth_usd_price numeric(40, 0),
  add column eth_usd_price_decimals integer,
  add column eth_usd_price_source text,
  add column eth_usd_price_at timestamptz,
  add column eth_balance_usd_cents numeric(40, 0),
  add column eligibility_chain_id integer;

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
