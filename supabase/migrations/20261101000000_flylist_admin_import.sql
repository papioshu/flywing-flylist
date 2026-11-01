-- Admin CSV import: an admin can add wallets to the FLYLIST directly. Imported rows have no
-- SIWE proof, so the chain/timestamp of that proof become optional for verification_method = 'admin_import'.
alter table allowlist.registrations drop constraint registrations_verification_method_check;
alter table allowlist.registrations add constraint registrations_verification_method_check
  check (verification_method in ('siwe_eip4361', 'admin_import'));

alter table allowlist.registrations alter column verification_chain_id drop not null;
alter table allowlist.registrations alter column verification_timestamp drop not null;
alter table allowlist.registrations add constraint registrations_siwe_proof_present
  check (verification_method <> 'siwe_eip4361' or (verification_chain_id is not null and verification_timestamp is not null));

-- Removal record: removing an admin-added wallet hard-deletes the row (its audit cascades away),
-- so who removed what, and the row's history, is kept here first. No FK, so it survives the delete.
create table allowlist.registration_removals (
  id                         bigint generated always as identity primary key,
  registration_id            uuid not null,
  campaign_id                text not null,
  wallet_address_normalized  text not null,
  twitter_username           text not null,
  actor_wallet               text not null,
  registration               jsonb not null,
  audit                      jsonb not null,
  removed_at                 timestamptz not null default now()
);
alter table allowlist.registration_removals enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on allowlist.registration_removals from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on allowlist.registration_removals from authenticated';
  end if;
end $$;
