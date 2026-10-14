import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { openPglite } from "../server/pglite.ts";
import { createApp } from "../supabase/functions/_shared/app.ts";
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { createSignatureVerifier } from "../supabase/functions/_shared/siwe.ts";
import type { XVerificationProvider } from "../supabase/functions/_shared/xverify.ts";
import { createFakeNet } from "./fakeNet.ts";

export const ORIGIN = "https://flywing.test";

export async function setup(opts: { env?: Record<string, string>; dataDir?: string; xProvider?: XVerificationProvider } = {}) {
  const admin = privateKeyToAccount(generatePrivateKey());
  const env: Record<string, string> = {
    ALLOWED_ORIGINS: ORIGIN,
    IP_HASH_SALT: "test-salt-0123456789",
    ADMIN_WALLETS: admin.address,
    ...opts.env,
  };
  const config = loadConfig((n) => env[n]);
  const db = await openPglite(opts.dataDir);
  let clock = new Date("2026-10-12T12:00:00Z").getTime();
  const net = createFakeNet(config.eligibilityRpcUrls, () => clock);
  const app = createApp({
    fetch: net.fetch,
    xProvider: opts.xProvider,
    db,
    config,
    verifySignature: createSignatureVerifier({}, false), // offline only in tests
    now: () => new Date(clock),
  });
  let ipCounter = 0;

  async function call(
    method: string,
    path: string,
    { body, token, origin = ORIGIN, ip, headers = {} }: { body?: unknown; token?: string; origin?: string | null; ip?: string; headers?: Record<string, string> } = {},
  ) {
    const h = new Headers(headers);
    if (origin) h.set("origin", origin);
    // Distinct IP per call unless a test pins one, so rate limits don't interfere.
    h.set("x-forwarded-for", ip ?? `10.0.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}`);
    if (token) h.set("authorization", `Bearer ${token}`);
    if (body !== undefined && !h.has("content-type")) h.set("content-type", "application/json");
    const res = await app(
      new Request(`http://api.local/allowlist${path}`, {
        method,
        headers: h,
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, bytes, text, json };
  }

  async function challenge(account: PrivateKeyAccount, purpose: "register" | "admin" = "register", chainId = 8453) {
    const r = await call("POST", "/auth/nonce", { body: { address: account.address, chainId, purpose } });
    if (r.status !== 200) throw new Error(`nonce failed: ${r.text}`);
    const message = createSiweMessage({
      domain: new URL(ORIGIN).host,
      uri: ORIGIN,
      address: account.address,
      chainId,
      nonce: r.json.nonce,
      version: "1",
      statement: r.json.statement,
      issuedAt: new Date(r.json.issuedAt),
      expirationTime: new Date(r.json.expirationTime),
    });
    return { message, nonce: r.json.nonce as string };
  }

  async function signIn(account: PrivateKeyAccount, purpose: "register" | "admin" = "register") {
    const { message } = await challenge(account, purpose);
    const signature = await account.signMessage({ message });
    const r = await call("POST", "/auth/verify", { body: { message, signature } });
    if (r.status !== 200) throw new Error(`verify failed: ${r.text}`);
    return r.json.token as string;
  }

  return {
    app,
    db,
    net,
    config,
    admin,
    call,
    challenge,
    signIn,
    advance: (ms: number) => {
      clock += ms;
    },
    newWallet: () => privateKeyToAccount(generatePrivateKey()),
  };
}

/** Minimal RFC 4180 parser used to check the export round-trips. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
