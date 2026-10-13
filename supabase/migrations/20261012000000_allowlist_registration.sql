-- FLY WING GENESIS allowlist registration (MVP).
--
-- Everything lives in a private `allowlist` schema. Supabase only exposes
-- `public` (and `graphql_public`) through its auto-generated REST API, so these
-- tables are unreachable with the anon key. RLS is also enabled with no
-- policies as a second lock. The only reader/writer is the `allowlist` Edge
-- Function, which connects with SUPABASE_DB_URL (table owner).

create schema if not exists allowlist;
revoke all on schema allowlist from public;

-- One row per allowlist campaign. Registration is open only while status = 'open'
-- and now() is inside [opens_at, closes_at) when those are set.
create table allowlist.campaigns (
  id          text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name        text not null,
  status      text not null default 'open' check (status in ('draft', 'open', 'closed')),
  opens_at    timestamptz,
  closes_at   timestamptz,
  created_at  timestamptz not null default now(),
  check (opens_at is null or closes_at is null or opens_at < closes_at)
);

insert into allowlist.campaigns (id, name, status)
values ('fwg-genesis', 'FLY WING GENESIS Allowlist', 'open')
on conflict (id) do nothing;

create table allowlist.registrations (
  id                            uuid primary key default gen_random_uuid(),
  campaign_id                   text not null references allowlist.campaigns (id),

  -- Wallet (proven by a server-verified SIWE signature before the row is written).
  wallet_address                text not null check (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
  wallet_address_normalized     text not null check (
                                  wallet_address_normalized ~ '^0x[0-9a-f]{40}$'
                                  and wallet_address_normalized = lower(wallet_address)
                                ),

  -- X / Twitter: SELF-REPORTED. twitter_verified stays false until a real
  -- verification flow (e.g. X OAuth) exists and fills the twitter_* columns below.
  twitter_username              text not null check (twitter_username ~ '^[A-Za-z0-9_]{1,15}$'),
  twitter_username_normalized   text not null check (twitter_username_normalized = lower(twitter_username)),
  twitter_verified              boolean not null default false,
  twitter_user_id               text,
  twitter_verified_at           timestamptz,
  twitter_verification_method   text,

  registration_status           text not null default 'registered'
                                  check (registration_status in ('registered', 'approved', 'waitlisted', 'rejected', 'removed')),
  registered_at                 timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),

  -- How the wallet was proven. The signature itself is NOT stored.
  verification_chain_id         integer not null check (verification_chain_id > 0),
  verification_method           text not null check (verification_method in ('siwe_eip4361')),
  verification_timestamp        timestamptz not null,

  eligibility_status            text not null default 'not_checked'
                                  check (eligibility_status in ('not_checked', 'eligible', 'ineligible')),
  eligibility_checked_at        timestamptz,
  admin_notes                   text check (admin_notes is null or char_length(admin_notes) <= 2000),

  constraint registrations_campaign_wallet_unique unique (campaign_id, wallet_address_normalized),
  constraint registrations_twitter_verified_consistent check (
    twitter_verified = false or (twitter_user_id is not null and twitter_verified_at is not null)
  )
);

create index registrations_campaign_registered_idx on allowlist.registrations (campaign_id, registered_at, id);
create index registrations_campaign_twitter_idx on allowlist.registrations (campaign_id, twitter_username_normalized);
create index registrations_campaign_status_idx on allowlist.registrations (campaign_id, registration_status, eligibility_status);

-- Append-only history of every change to a registration (who, what, when).
create table allowlist.registration_audit (
  id               bigint generated always as identity primary key,
  registration_id  uuid not null references allowlist.registrations (id) on delete cascade,
  actor_wallet     text not null,
  actor_role       text not null check (actor_role in ('registrant', 'admin', 'system')),
  action           text not null,
  changes          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index registration_audit_registration_idx on allowlist.registration_audit (registration_id, created_at);

-- Single-use SIWE nonces. A nonce is consumed atomically on successful verify;
-- reuse or expiry is rejected.
create table allowlist.auth_nonces (
  nonce                      text primary key check (nonce ~ '^[A-Za-z0-9]{16,64}$'),
  wallet_address_normalized  text not null check (wallet_address_normalized ~ '^0x[0-9a-f]{40}$'),
  chain_id                   integer not null,
  purpose                    text not null check (purpose in ('register', 'admin')),
  issued_at                  timestamptz not null,
  expires_at                 timestamptz not null,
  used_at                    timestamptz
);

create index auth_nonces_expires_idx on allowlist.auth_nonces (expires_at);

-- Server-side sessions. Only a SHA-256 hash of the bearer token is stored.
create table allowlist.sessions (
  token_hash                 text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  wallet_address_normalized  text not null,
  chain_id                   integer not null,
  role                       text not null check (role in ('registrant', 'admin')),
  created_at                 timestamptz not null,
  expires_at                 timestamptz not null,
  revoked_at                 timestamptz
);

create index sessions_expires_idx on allowlist.sessions (expires_at);

-- Fixed-window rate-limit counters, keyed by bucket + hashed client key.
create table allowlist.rate_limits (
  bucket        text not null,
  key           text not null,
  window_start  timestamptz not null,
  count         integer not null default 0,
  primary key (bucket, key, window_start)
);

alter table allowlist.campaigns          enable row level security;
alter table allowlist.registrations      enable row level security;
alter table allowlist.registration_audit enable row level security;
alter table allowlist.auth_nonces        enable row level security;
alter table allowlist.sessions           enable row level security;
alter table allowlist.rate_limits        enable row level security;

-- Belt and braces on Supabase: make sure the API roles have nothing here.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema allowlist from anon';
    execute 'revoke all on all tables in schema allowlist from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema allowlist from authenticated';
    execute 'revoke all on all tables in schema allowlist from authenticated';
  end if;
end
$$;
