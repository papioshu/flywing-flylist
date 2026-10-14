// Sign-In with Ethereum (EIP-4361) message checks and signature verification.
// The nonce lookup/consumption lives in app.ts because it needs the database.

import { createPublicClient, getAddress, http, isAddress, verifyMessage } from "viem";
import { arbitrum, base, mainnet, optimism, polygon, robinhood, robinhoodTestnet } from "viem/chains";
import { parseSiweMessage } from "viem/siwe";
import type { SiweMessage } from "viem/siwe";

export type Purpose = "register" | "admin";

export const SIWE_STATEMENTS: Record<Purpose, string> = {
  register:
    "Apply for the FLY WING GENESIS FLYLIST. This signature only proves you own this wallet. It is free, sends no transaction, and grants no token approvals.",
  admin: "Sign in to the FLY WING GENESIS FLYLIST admin dashboard. This signature is free and sends no transaction.",
};

/** Allowed clock skew between the signer's clock and the server, in ms. */
export const CLOCK_SKEW_MS = 60_000;

export type SiweCheckInput = {
  message: string;
  allowedOrigins: string[];
  allowedChainIds: number[];
  purpose: Purpose;
  now: Date;
};

export type ParsedSiwe = SiweMessage & { address: `0x${string}`; expirationTime: Date; issuedAt: Date };

export type SiweCheckResult = { ok: true; siwe: ParsedSiwe } | { ok: false; error: string };

/**
 * Validates every field of the SIWE message except the nonce's database state
 * and the signature. Pure and synchronous so it is easy to test exhaustively.
 */
export function checkSiweMessage(input: SiweCheckInput): SiweCheckResult {
  if (typeof input.message !== "string" || input.message.length > 4000) {
    return { ok: false, error: "Malformed sign-in message." };
  }
  let parsed: Partial<SiweMessage>;
  try {
    parsed = parseSiweMessage(input.message);
  } catch {
    return { ok: false, error: "Malformed sign-in message." };
  }

  if (parsed.version !== "1") return { ok: false, error: "Unsupported sign-in message version." };
  if (!parsed.address || !isAddress(parsed.address, { strict: false })) {
    return { ok: false, error: "Sign-in message has no valid address." };
  }

  const origin = input.allowedOrigins.find((o) => new URL(o).host === parsed.domain);
  if (!origin) return { ok: false, error: "Sign-in message is for a different website." };
  let uriOrigin: string;
  try {
    uriOrigin = new URL(parsed.uri ?? "").origin;
  } catch {
    return { ok: false, error: "Sign-in message has an invalid URI." };
  }
  if (uriOrigin !== origin) return { ok: false, error: "Sign-in message URI does not match the website." };

  if (!parsed.chainId || !input.allowedChainIds.includes(parsed.chainId)) {
    return { ok: false, error: "Sign-in message uses an unsupported chain." };
  }
  if (!parsed.nonce) return { ok: false, error: "Sign-in message has no nonce." };
  if (parsed.statement !== SIWE_STATEMENTS[input.purpose]) {
    return { ok: false, error: "Sign-in message statement is not recognised." };
  }

  const now = input.now.getTime();
  if (!parsed.issuedAt || !parsed.expirationTime) {
    return { ok: false, error: "Sign-in message must include issue and expiration times." };
  }
  if (parsed.issuedAt.getTime() > now + CLOCK_SKEW_MS) return { ok: false, error: "Sign-in message is dated in the future." };
  if (parsed.expirationTime.getTime() <= now) return { ok: false, error: "Sign-in message has expired. Please try again." };
  if (parsed.notBefore && parsed.notBefore.getTime() > now + CLOCK_SKEW_MS) {
    return { ok: false, error: "Sign-in message is not valid yet." };
  }

  return {
    ok: true,
    siwe: {
      ...(parsed as SiweMessage),
      address: getAddress(parsed.address),
      expirationTime: parsed.expirationTime,
      issuedAt: parsed.issuedAt,
    },
  };
}

export type SignatureVerifier = (args: {
  address: `0x${string}`;
  message: string;
  signature: `0x${string}`;
  chainId: number;
}) => Promise<boolean>;

/**
 * EOA signatures are checked offline (ecrecover). If that fails and an RPC URL
 * is configured for the chain, falls back to an on-chain check so smart-contract
 * wallets (ERC-1271, and undeployed ERC-6492 wallets like Coinbase Smart Wallet) work.
 */
// Public RPCs (rate-limited) used when RPC_URLS has no override for a chain.
const DEFAULT_RPC_URLS: Record<number, string> = Object.fromEntries(
  [mainnet, base, arbitrum, optimism, polygon, robinhood, robinhoodTestnet].map((c) => [c.id, c.rpcUrls.default.http[0]]),
);

export function createSignatureVerifier(overrides: Record<number, string>, useDefaults = true): SignatureVerifier {
  const rpcUrls = useDefaults ? { ...DEFAULT_RPC_URLS, ...overrides } : overrides;
  return async ({ address, message, signature, chainId }) => {
    try {
      if (await verifyMessage({ address, message, signature })) return true;
    } catch {
      // Not a plain ECDSA signature; may be a contract-wallet signature.
    }
    const rpcUrl = rpcUrls[chainId];
    if (!rpcUrl) return false;
    try {
      const client = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000 }) });
      return await client.verifyMessage({ address, message, signature });
    } catch {
      return false;
    }
  };
}
