// Server-side FLYLIST eligibility. Runtime-agnostic (fetch only), so the same code
// runs in the Deno Edge Function, the local Node server, and tests (which inject a
// fake fetch at the network boundary).
//
// The only check today is "native ETH worth at least $X on ANY ONE configured chain"
// (owner decision: Ethereum mainnet or Robinhood Chain, each judged on its own, never
// summed). Nothing is transferred, approved or locked: these are read-only RPC calls.
//
// Money math is integer-only: balance (wei, 1e-18 ETH) x price (1e-8 USD per ETH)
// gives value in 1e-26 USD, compared against the threshold in cents (1e-2 USD).

export type Fetch = typeof fetch;

export type EligibilityPolicy = {
  accessMode: "open" | "invite_code" | "community" | "hybrid";
  ethBalanceCheckEnabled: boolean;
  minEthBalanceUsdCents: number;
  ethBalanceChainIds: number[];
  xFollowRequired: boolean;
  allowProvisionalRegistration: boolean;
};

export type EthUsdPrice = {
  /** Integer price with `decimals` decimals. */
  price: bigint;
  decimals: number;
  source: "chainlink" | "coinbase";
  /** When the price was published (Chainlink updatedAt) or fetched (Coinbase spot has no timestamp). */
  at: Date;
};

export type ChainSnapshot = {
  chainId: number;
  status: "ok" | "error" | "not_configured";
  balanceWei?: string;
  blockNumber?: string;
  usdCents?: string;
  passed?: boolean;
  error?: string;
};

export type EthBalanceResult = {
  result: "eligible" | "ineligible" | "unavailable";
  price: EthUsdPrice | null;
  chains: ChainSnapshot[];
  best: { chainId: number; balanceWei: bigint; usdCents: bigint } | null;
  error?: string;
};

export type EligibilityProviderConfig = {
  rpcUrls: Record<number, string>;
  /** Chain whose Chainlink feed is read, and the feed address. */
  priceChainId: number;
  chainlinkFeed: `0x${string}`;
  /** Reject a Chainlink answer older than this. ETH/USD heartbeat on mainnet is 1 hour. */
  priceMaxAgeSeconds: number;
  coinbaseUrl: string;
  timeoutMs: number;
};

// Chainlink ETH / USD on Ethereum mainnet. Verified 2026-10-13 by resolving Chainlink's
// own ENS name eth-usd.data.eth and reading description() = "ETH / USD", decimals() = 8.
export const CHAINLINK_ETH_USD_MAINNET = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" as const;

// Free public RPCs (rate-limited; set RPC_URLS for production). Robinhood Chain's is the
// official endpoint from docs.robinhood.com/chain/connecting (chain ID 4663).
export const DEFAULT_ELIGIBILITY_RPC_URLS: Record<number, string> = {
  1: "https://ethereum-rpc.publicnode.com",
  4663: "https://rpc.mainnet.chain.robinhood.com",
};

export const COINBASE_SPOT_URL = "https://api.coinbase.com/v2/prices/ETH-USD/spot";

const PRICE_DECIMALS = 8;
// Sanity bounds for any ETH/USD price, in whole dollars. Outside these, treat as invalid.
const MIN_SANE_USD = 10n;
const MAX_SANE_USD = 1_000_000n;

export class ProviderError extends Error {}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

async function rpcBatch(fetchFn: Fetch, url: string, calls: { method: string; params: unknown[] }[], timeoutMs: number): Promise<string[]> {
  const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params }));
  const res = await withTimeout(timeoutMs, (signal) =>
    fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal }),
  );
  if (!res.ok) throw new ProviderError(`RPC HTTP ${res.status}`);
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) throw new ProviderError("RPC returned a non-batch response");
  return calls.map((_, i) => {
    const item = data.find((d: any) => d && d.id === i + 1) as { result?: unknown; error?: { message?: string } } | undefined;
    if (!item) throw new ProviderError("RPC response missing an item");
    if (item.error) throw new ProviderError(`RPC error: ${item.error.message ?? "unknown"}`);
    if (typeof item.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(item.result)) throw new ProviderError("RPC returned a malformed result");
    return item.result;
  });
}

const hexToBig = (h: string) => (h === "0x" ? 0n : BigInt(h));

/** Parses a positive decimal string like "2509.21" into an integer with `decimals` decimals. */
export function parseDecimal(value: string, decimals: number): bigint | null {
  const m = /^(\d{1,12})(?:\.(\d{1,30}))?$/.exec(value.trim());
  if (!m) return null;
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

function saneUsd(price: bigint, decimals: number): boolean {
  const scale = 10n ** BigInt(decimals);
  return price > 0n && price >= MIN_SANE_USD * scale && price <= MAX_SANE_USD * scale;
}

/** Value of `wei` at `price` (with `decimals` decimals), in whole US cents, rounded down. */
export function weiToUsdCents(wei: bigint, price: bigint, decimals: number): bigint {
  // wei * price is in 1e-(18+decimals) USD; cents are 1e-2 USD.
  return (wei * price) / 10n ** BigInt(18 + decimals - 2);
}

/** Exact comparison: does `wei` at `price` meet `minUsdCents`? No rounding involved. */
export function meetsUsdThreshold(wei: bigint, price: bigint, decimals: number, minUsdCents: bigint): boolean {
  return wei * price >= minUsdCents * 10n ** BigInt(18 + decimals - 2);
}

// latestRoundData() selector, and decimals() selector.
const SEL_LATEST_ROUND = "0xfeaf968c";
const SEL_DECIMALS = "0x313ce567";

export async function chainlinkPrice(fetchFn: Fetch, cfg: EligibilityProviderConfig, now: Date): Promise<EthUsdPrice> {
  const url = cfg.rpcUrls[cfg.priceChainId];
  if (!url) throw new ProviderError("No RPC URL for the price chain");
  const [round, dec] = await rpcBatch(
    fetchFn,
    url,
    [
      { method: "eth_call", params: [{ to: cfg.chainlinkFeed, data: SEL_LATEST_ROUND }, "latest"] },
      { method: "eth_call", params: [{ to: cfg.chainlinkFeed, data: SEL_DECIMALS }, "latest"] },
    ],
    cfg.timeoutMs,
  );
  const hex = round.slice(2);
  if (hex.length < 64 * 5) throw new ProviderError("Chainlink returned a short response");
  const word = (i: number) => BigInt(`0x${hex.slice(i * 64, (i + 1) * 64)}`);
  const roundId = word(0);
  let answer = word(1);
  if (answer >> 255n) answer -= 1n << 256n; // int256
  const updatedAt = word(3);
  const answeredInRound = word(4);
  const decimals = Number(hexToBig(dec));
  if (decimals !== PRICE_DECIMALS) throw new ProviderError(`Unexpected Chainlink decimals ${decimals}`);
  if (answer <= 0n || !saneUsd(answer, decimals)) throw new ProviderError("Chainlink answer is invalid");
  if (answeredInRound < roundId) throw new ProviderError("Chainlink round is incomplete");
  const at = new Date(Number(updatedAt) * 1000);
  const age = (now.getTime() - at.getTime()) / 1000;
  if (updatedAt === 0n || age > cfg.priceMaxAgeSeconds) throw new ProviderError(`Chainlink price is stale (${Math.round(age)}s old)`);
  if (age < -300) throw new ProviderError("Chainlink price is dated in the future");
  return { price: answer, decimals, source: "chainlink", at };
}

export async function coinbasePrice(fetchFn: Fetch, cfg: EligibilityProviderConfig, now: Date): Promise<EthUsdPrice> {
  const res = await withTimeout(cfg.timeoutMs, (signal) => fetchFn(cfg.coinbaseUrl, { headers: { accept: "application/json" }, signal }));
  if (!res.ok) throw new ProviderError(`Coinbase HTTP ${res.status}`);
  const data = (await res.json()) as { data?: { amount?: unknown; base?: unknown; currency?: unknown } };
  if (data?.data?.base !== "ETH" || data?.data?.currency !== "USD" || typeof data.data.amount !== "string") {
    throw new ProviderError("Coinbase returned an unexpected payload");
  }
  const price = parseDecimal(data.data.amount, PRICE_DECIMALS);
  if (price === null || !saneUsd(price, PRICE_DECIMALS)) throw new ProviderError("Coinbase price is invalid");
  return { price, decimals: PRICE_DECIMALS, source: "coinbase", at: now };
}

/** Chainlink first; Coinbase spot only if Chainlink is unavailable, stale or invalid. */
export async function ethUsdPrice(fetchFn: Fetch, cfg: EligibilityProviderConfig, now: Date): Promise<{ price: EthUsdPrice | null; errors: string[] }> {
  const errors: string[] = [];
  for (const source of [chainlinkPrice, coinbasePrice]) {
    try {
      return { price: await source(fetchFn, cfg, now), errors };
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { price: null, errors };
}

async function chainBalance(fetchFn: Fetch, cfg: EligibilityProviderConfig, chainId: number, wallet: string) {
  const url = cfg.rpcUrls[chainId];
  if (!url) return null;
  // Read the block number first, then the balance AT that block, so the snapshot is exact.
  const [block] = await rpcBatch(fetchFn, url, [{ method: "eth_blockNumber", params: [] }], cfg.timeoutMs);
  const [chainIdHex, bal] = await rpcBatch(
    fetchFn,
    url,
    [
      { method: "eth_chainId", params: [] },
      { method: "eth_getBalance", params: [wallet, block] },
    ],
    cfg.timeoutMs,
  );
  if (Number(hexToBig(chainIdHex)) !== chainId) throw new ProviderError(`RPC is for chain ${Number(hexToBig(chainIdHex))}, not ${chainId}`);
  return { balanceWei: hexToBig(bal), blockNumber: hexToBig(block) };
}

export async function checkEthBalance(
  fetchFn: Fetch,
  cfg: EligibilityProviderConfig,
  policy: Pick<EligibilityPolicy, "minEthBalanceUsdCents" | "ethBalanceChainIds">,
  wallet: string,
  now: Date,
): Promise<EthBalanceResult> {
  const minCents = BigInt(policy.minEthBalanceUsdCents);
  const [{ price, errors: priceErrors }, balances] = await Promise.all([
    ethUsdPrice(fetchFn, cfg, now),
    Promise.all(
      policy.ethBalanceChainIds.map(async (chainId) => {
        try {
          return { chainId, value: await chainBalance(fetchFn, cfg, chainId, wallet) };
        } catch (e) {
          return { chainId, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    ),
  ]);

  const chains: ChainSnapshot[] = balances.map((b) => {
    if ("error" in b) return { chainId: b.chainId, status: "error", error: b.error };
    if (!b.value) return { chainId: b.chainId, status: "not_configured" };
    const snap: ChainSnapshot = {
      chainId: b.chainId,
      status: "ok",
      balanceWei: b.value.balanceWei.toString(),
      blockNumber: b.value.blockNumber.toString(),
    };
    if (price) {
      snap.usdCents = weiToUsdCents(b.value.balanceWei, price.price, price.decimals).toString();
      snap.passed = meetsUsdThreshold(b.value.balanceWei, price.price, price.decimals, minCents);
    }
    return snap;
  });

  if (!price) {
    return { result: "unavailable", price: null, chains, best: null, error: `ETH/USD price unavailable: ${priceErrors.join("; ")}` };
  }
  const ok = chains.filter((c) => c.status === "ok");
  const passed = ok.find((c) => c.passed);
  const best = (passed ? [passed] : [...ok].sort((a, b) => (BigInt(b.usdCents!) > BigInt(a.usdCents!) ? 1 : -1)))[0];
  const bestOut = best ? { chainId: best.chainId, balanceWei: BigInt(best.balanceWei!), usdCents: BigInt(best.usdCents!) } : null;

  if (passed) return { result: "eligible", price, chains, best: bestOut };
  // A chain we couldn't read might have passed, so an RPC failure is never a "no".
  if (chains.some((c) => c.status === "error")) {
    return { result: "unavailable", price, chains, best: bestOut, error: "Could not read every configured chain." };
  }
  if (ok.length === 0) return { result: "unavailable", price, chains, best: null, error: "No eligibility chain is configured." };
  return { result: "ineligible", price, chains, best: bestOut };
}
