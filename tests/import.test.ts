import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { parseImportCsv } from "../web/src/lib/csvImport.ts";
import { setup } from "./helpers.ts";

const A = "0x" + "a".repeat(40);
const B = "0x" + "B".repeat(40);

describe("admin CSV import", () => {
  it("parses headered and headerless CSVs, including a FLYLIST export", () => {
    expect(parseImportCsv(`${A},@one\n\n${B},two\n`)).toEqual([
      { line: 1, wallet: A, twitter: "@one" },
      { line: 3, wallet: B, twitter: "two" },
    ]);
    expect(parseImportCsv(`X Handle,Wallet Address\r\n"@one",${A}\r\n`)).toEqual([{ line: 2, wallet: A, twitter: "@one" }]);
    expect(parseImportCsv(`id,campaign_id,wallet_address,twitter_username,twitter_url\n1,fwg,${A},one,https://x.com/one\n`)).toEqual([
      { line: 2, wallet: A, twitter: "one" },
    ]);
  });

  it("adds valid rows as approved without an ETH check, skipping bad, duplicate and existing wallets", async () => {
    const t = await setup();
    const user = t.newWallet();
    const userToken = await t.signIn(user, "register");
    const rows = [
      { line: 2, wallet: A, twitter: "@one" },
      { line: 3, wallet: B, twitter: "two" },
      { line: 4, wallet: A.toUpperCase().replace("0X", "0x"), twitter: "dupe" },
      { line: 5, wallet: "0x123", twitter: "bad" },
      { line: 6, wallet: "0x" + "c".repeat(40), twitter: "" },
    ];
    expect((await t.call("POST", "/admin/import", { token: userToken, body: { rows } })).status).toBe(403);

    const token = await t.signIn(t.admin, "admin");
    const r = await t.call("POST", "/admin/import", { token, body: { rows } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ added: 2, alreadyOnList: 0, duplicateInFile: 1 });
    expect(r.json.invalid.map((x: any) => x.line)).toEqual([5, 6]);

    const db = await t.db.query<any>(
      `select wallet_address_normalized, twitter_username, registration_status, verification_method, verification_chain_id, eligibility_check_id
       from allowlist.registrations order by wallet_address_normalized`,
    );
    expect(db).toHaveLength(2);
    expect(db[0]).toMatchObject({ wallet_address_normalized: A, twitter_username: "one", registration_status: "approved", verification_method: "admin_import", verification_chain_id: null, eligibility_check_id: null });
    const audit = await t.db.query<any>(`select action, actor_role from allowlist.registration_audit`);
    expect(audit).toEqual([{ action: "admin_import", actor_role: "admin" }, { action: "admin_import", actor_role: "admin" }]);

    // Re-importing is a no-op; imported rows show up in the admin list.
    const again = await t.call("POST", "/admin/import", { token, body: { rows: rows.slice(0, 2) } });
    expect(again.json).toMatchObject({ added: 0, alreadyOnList: 2 });
    const list = await t.call("GET", "/admin/registrations", { token });
    expect(list.json.total).toBe(2);

    // An admin-added wallet that connects sees itself approved, with no ETH check.
    const added = privateKeyToAccount(generatePrivateKey());
    await t.call("POST", "/admin/import", { token, body: { rows: [{ wallet: added.address, twitter: "added" }] } });
    const addedToken = await t.signIn(added, "register");
    const el = await t.call("POST", "/me/eligibility", { token: addedToken, body: {} });
    expect(el.json.registration.registrationStatus).toBe("approved");
    expect(el.json.eligibility).toBeNull();

    // Admin-added rows can be removed; self-registered rows can't.
    const [imported] = await t.db.query<any>(`select id from allowlist.registrations where wallet_address_normalized = $1`, [A]);
    expect((await t.call("DELETE", `/admin/registrations/${imported.id}`, { token: userToken })).status).toBe(403);
    expect((await t.call("DELETE", `/admin/registrations/${imported.id}`, { token })).status).toBe(200);
    expect((await t.call("DELETE", `/admin/registrations/${imported.id}`, { token })).status).toBe(404);
    const [tomb] = await t.db.query<any>(`select * from allowlist.registration_removals`);
    expect(tomb).toMatchObject({ registration_id: imported.id, wallet_address_normalized: A, actor_wallet: t.admin.address.toLowerCase() });
    expect(tomb.audit[0].action).toBe("admin_import");
    await t.db.query(`update allowlist.registrations set verification_method = 'siwe_eip4361', verification_chain_id = 1, verification_timestamp = now() where wallet_address_normalized = $1`, [B.toLowerCase()]);
    const [selfReg] = await t.db.query<any>(`select id from allowlist.registrations where wallet_address_normalized = $1`, [B.toLowerCase()]);
    expect((await t.call("DELETE", `/admin/registrations/${selfReg.id}`, { token })).status).toBe(409);
  });
});
