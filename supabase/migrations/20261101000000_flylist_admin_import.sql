-- Admin CSV import: an admin can add wallets to the FLYLIST directly. Imported rows have no
-- SIWE proof, so the chain/timestamp of that proof become optional for verification_method = 'admin_import'.
alter table allowlist.registrations drop constraint registrations_verification_method_check;
alter table allowlist.registrations add constraint registrations_verification_method_check
  check (verification_method in ('siwe_eip4361', 'admin_import'));

alter table allowlist.registrations alter column verification_chain_id drop not null;
alter table allowlist.registrations alter column verification_timestamp drop not null;
alter table allowlist.registrations add constraint registrations_siwe_proof_present
  check (verification_method <> 'siwe_eip4361' or (verification_chain_id is not null and verification_timestamp is not null));
