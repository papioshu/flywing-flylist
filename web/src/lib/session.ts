// Session tokens live in sessionStorage (cleared when the tab closes), keyed by
// wallet + purpose so switching wallets never reuses another wallet's session.
import { createSiweMessage } from "viem/siwe";
import { api } from "./api";

type Purpose = "register" | "admin";
type Stored = { token: string; expiresAt: string };

const key = (purpose: Purpose, address: string) => `fwg:${purpose}:${address.toLowerCase()}`;

export function getToken(purpose: Purpose, address: string): string | null {
  try {
    const raw = sessionStorage.getItem(key(purpose, address));
    if (!raw) return null;
    const s = JSON.parse(raw) as Stored;
    if (new Date(s.expiresAt).getTime() - 30_000 < Date.now()) {
      sessionStorage.removeItem(key(purpose, address));
      return null;
    }
    return s.token;
  } catch {
    return null;
  }
}

export function clearToken(purpose: Purpose, address: string) {
  sessionStorage.removeItem(key(purpose, address));
}

/** Full SIWE flow: server nonce, wallet signs, server verifies, session token returned. */
export async function signIn(opts: {
  purpose: Purpose;
  address: `0x${string}`;
  chainId: number;
  sign: (message: string) => Promise<`0x${string}`>;
}): Promise<string> {
  const challenge = await api<{ nonce: string; issuedAt: string; expirationTime: string; statement: string }>("/auth/nonce", {
    method: "POST",
    body: { address: opts.address, chainId: opts.chainId, purpose: opts.purpose },
  });
  const message = createSiweMessage({
    domain: window.location.host,
    uri: window.location.origin,
    address: opts.address,
    chainId: opts.chainId,
    nonce: challenge.nonce,
    version: "1",
    statement: challenge.statement,
    issuedAt: new Date(challenge.issuedAt),
    expirationTime: new Date(challenge.expirationTime),
  });
  const signature = await opts.sign(message);
  const res = await api<{ token: string; expiresAt: string }>("/auth/verify", {
    method: "POST",
    body: { message, signature },
  });
  sessionStorage.setItem(key(opts.purpose, opts.address), JSON.stringify({ token: res.token, expiresAt: res.expiresAt }));
  return res.token;
}

export function isUserRejection(err: unknown): boolean {
  const e = err as { name?: string; code?: number; message?: string; cause?: unknown } | undefined;
  if (!e) return false;
  if (e.name === "UserRejectedRequestError" || e.code === 4001) return true;
  if (/user (rejected|denied|cancel)/i.test(e.message ?? "")) return true;
  return e.cause ? isUserRejection(e.cause) : false;
}

export function parseHandle(input: string): { ok: true; value: string } | { ok: false; error: string } {
  let v = input.trim();
  if (v.startsWith("@")) v = v.slice(1);
  if (!v) return { ok: false, error: "Enter your X username." };
  if (v.length > 15) return { ok: false, error: "X usernames are at most 15 characters." };
  if (!/^[A-Za-z0-9_]+$/.test(v)) return { ok: false, error: "Letters, numbers and underscores only." };
  return { ok: true, value: v };
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
