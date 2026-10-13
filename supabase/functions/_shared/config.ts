// Runtime configuration, read from environment variables (Supabase function
// secrets in production, process.env in local dev/tests).

export type AppConfig = {
  campaignId: string;
  /** Exact browser origins allowed to call the API and to appear in SIWE messages, e.g. https://flywing.xyz */
  allowedOrigins: string[];
  /** Chain IDs a SIWE message may name. Signing is free on every chain; this just limits what we accept. */
  allowedChainIds: number[];
  /** Lowercased admin wallet addresses. Checked server-side on every admin request. */
  adminWallets: string[];
  /** Optional per-chain RPC URLs, used only to verify smart-contract-wallet (ERC-1271/6492) signatures. */
  rpcUrls: Record<number, string>;
  /** Secret salt for hashing client IPs in rate-limit keys (IPs are never stored raw). */
  ipHashSalt: string;
  nonceTtlSeconds: number;
  sessionTtlSeconds: number;
  adminSessionTtlSeconds: number;
};

export type EnvReader = (name: string) => string | undefined;

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Ethereum, Base, Arbitrum, Optimism, Polygon, Robinhood Chain mainnet + testnet.
const DEFAULT_CHAIN_IDS = [1, 8453, 42161, 10, 137, 4663, 46630];

export function loadConfig(env: EnvReader): AppConfig {
  const allowedOrigins = list(env("ALLOWED_ORIGINS")).map((o) => new URL(o).origin);
  if (allowedOrigins.length === 0) throw new Error("ALLOWED_ORIGINS must list at least one origin");

  const ipHashSalt = env("IP_HASH_SALT") ?? "";
  if (ipHashSalt.length < 16) throw new Error("IP_HASH_SALT must be at least 16 characters");

  const adminWallets = list(env("ADMIN_WALLETS")).map((a) => a.toLowerCase());
  for (const a of adminWallets) {
    if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`ADMIN_WALLETS contains an invalid address: ${a}`);
  }

  const chainIds = list(env("ALLOWED_CHAIN_IDS")).map((c) => Number.parseInt(c, 10)).filter((n) => n > 0);

  const rpcUrls: Record<number, string> = {};
  for (const pair of list(env("RPC_URLS"))) {
    // Format: "8453=https://...,1=https://..."
    const [id, ...rest] = pair.split("=");
    const url = rest.join("=");
    if (Number.parseInt(id, 10) > 0 && url) rpcUrls[Number.parseInt(id, 10)] = url;
  }

  return {
    campaignId: env("CAMPAIGN_ID") ?? "fwg-genesis",
    allowedOrigins,
    allowedChainIds: chainIds.length ? chainIds : DEFAULT_CHAIN_IDS,
    adminWallets,
    rpcUrls,
    ipHashSalt,
    nonceTtlSeconds: int(env("NONCE_TTL_SECONDS"), 600),
    sessionTtlSeconds: int(env("SESSION_TTL_SECONDS"), 7200),
    adminSessionTtlSeconds: int(env("ADMIN_SESSION_TTL_SECONDS"), 3600),
  };
}
