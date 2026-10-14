// Partner-community eligibility: NFT ownership from approved collections, read on-chain
// with standard eth_call reads over the same RPC configuration as the ETH check. No paid
// indexer, no transfers or approvals, and nothing the browser sends is trusted.
//
// ERC-721: collection-wide balanceOf(owner), or ownerOf(id) for each configured token ID.
// ERC-1155: balanceOf(owner, id) for each configured token ID, summed.
// Every collection read is pinned to one block number, and the RPC's chain ID is checked,
// so ownership on the wrong chain never counts.

import { type Fetch, ProviderError } from "./eligibility.ts";

export type PartnerCollection = {
  id: string;
  displayName: string;
  chainId: number;
  contractAddress: string; // lowercase
  standard: "erc721" | "erc1155";
  minQuantity: number;
  tokenIds: string[]; // decimal strings
  active: boolean;
};

export type CollectionSnapshot = {
  collectionId: string;
  displayName: string;
  chainId: number;
  contract: string;
  standard: PartnerCollection["standard"];
  minQuantity: number;
  tokenIds: string[];
  quantity?: string;
  blockNumber?: string;
  source: "rpc";
  result: "qualified" | "not_qualified" | "error";
  error?: string;
};

export type NftRule = "any" | "all" | "min_n";

export type NftOwnershipResult = {
  result: "qualified" | "not_qualified" | "unavailable" | "not_configured";
  rule: NftRule;
  minCollections: number;
  snapshots: CollectionSnapshot[];
  qualifying: string[]; // collection IDs
  error?: string;
};

/** A pluggable community-eligibility provider (spec prompt 1: "pluggable eligibility providers"). */
export interface CommunityEligibilityProvider {
  readonly id: string;
  evaluate(args: { wallet: string; collections: PartnerCollection[]; rule: NftRule; minCollections: number }): Promise<NftOwnershipResult>;
}

const SEL_BALANCE_OF_721 = "0x70a08231"; // balanceOf(address)
const SEL_OWNER_OF = "0x6352211e"; // ownerOf(uint256)
const SEL_BALANCE_OF_1155 = "0x00fdd58e"; // balanceOf(address,uint256)

const word = (v: bigint) => v.toString(16).padStart(64, "0");
const addrWord = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

type RpcResult = { result?: string; error?: { message?: string; code?: number } };

async function rpc(fetchFn: Fetch, url: string, calls: { method: string; params: unknown[] }[], timeoutMs: number): Promise<RpcResult[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params }));
    const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) throw new ProviderError(`RPC HTTP ${res.status}`);
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) throw new ProviderError("RPC returned a non-batch response");
    return calls.map((_, i) => {
      const item = data.find((d: any) => d && d.id === i + 1) as RpcResult | undefined;
      if (!item) throw new ProviderError("RPC response missing an item");
      return item;
    });
  } finally {
    clearTimeout(t);
  }
}

function hexResult(r: RpcResult, chainId?: number): string {
  if (r.error) throw new ProviderError(`RPC error: ${r.error.message ?? "unknown"}`);
  if (typeof r.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(r.result)) throw new ProviderError("RPC returned a malformed result");
  // An eth_call to an address with no code returns empty data: the contract isn't on this chain.
  if (r.result === "0x" && chainId !== undefined) throw new ProviderError(`No contract at this address on chain ${chainId}`);
  return r.result;
}

const toBig = (h: string) => (h === "0x" ? 0n : BigInt(h));

/** Reads how many qualifying tokens `wallet` holds in one collection, at one block. */
export async function readCollectionQuantity(
  fetchFn: Fetch,
  rpcUrl: string,
  c: PartnerCollection,
  wallet: string,
  timeoutMs: number,
): Promise<{ quantity: bigint; blockNumber: bigint }> {
  const [blockRes, chainRes] = await rpc(fetchFn, rpcUrl, [{ method: "eth_blockNumber", params: [] }, { method: "eth_chainId", params: [] }], timeoutMs);
  const block = hexResult(blockRes);
  const chainId = Number(toBig(hexResult(chainRes)));
  if (chainId !== c.chainId) throw new ProviderError(`RPC is for chain ${chainId}, not ${c.chainId}`);

  const call = (data: string) => ({ method: "eth_call", params: [{ to: c.contractAddress, data }, block] });
  if (c.standard === "erc721" && c.tokenIds.length === 0) {
    const [r] = await rpc(fetchFn, rpcUrl, [call(SEL_BALANCE_OF_721 + addrWord(wallet))], timeoutMs);
    const out = hexResult(r, c.chainId);
    if (out.length !== 66) throw new ProviderError("balanceOf returned an unexpected value (not an ERC-721?)");
    return { quantity: toBig(out), blockNumber: toBig(block) };
  }
  if (c.standard === "erc721") {
    const results = await rpc(fetchFn, rpcUrl, c.tokenIds.map((id) => call(SEL_OWNER_OF + word(BigInt(id)))), timeoutMs);
    let held = 0n;
    for (const r of results) {
      // ownerOf reverts for burned / never-minted tokens: that token is simply not held.
      if (r.error && /revert/i.test(r.error.message ?? "")) continue;
      const out = hexResult(r, c.chainId);
      if (out.length !== 66) throw new ProviderError("ownerOf returned an unexpected value");
      if (`0x${out.slice(-40)}`.toLowerCase() === wallet.toLowerCase()) held += 1n;
    }
    return { quantity: held, blockNumber: toBig(block) };
  }
  const results = await rpc(fetchFn, rpcUrl, c.tokenIds.map((id) => call(SEL_BALANCE_OF_1155 + addrWord(wallet) + word(BigInt(id)))), timeoutMs);
  let total = 0n;
  for (const r of results) {
    const out = hexResult(r, c.chainId);
    if (out.length !== 66) throw new ProviderError("ERC-1155 balanceOf returned an unexpected value");
    total += toBig(out);
  }
  return { quantity: total, blockNumber: toBig(block) };
}

/** Applies the any / all / min-N rule. An unreadable collection that could change the answer gives 'unavailable'. */
export function applyRule(snapshots: CollectionSnapshot[], rule: NftRule, minCollections: number): NftOwnershipResult["result"] {
  if (snapshots.length === 0) return "not_configured";
  const qualified = snapshots.filter((s) => s.result === "qualified").length;
  const errors = snapshots.filter((s) => s.result === "error").length;
  const need = rule === "any" ? 1 : rule === "all" ? snapshots.length : Math.min(minCollections, snapshots.length);
  if (rule === "min_n" && minCollections > snapshots.length) return errors ? "unavailable" : "not_qualified";
  if (qualified >= need) return "qualified";
  if (qualified + errors >= need) return "unavailable"; // the unread ones might have qualified
  return "not_qualified";
}

export function createNftOwnershipProvider(opts: { fetch: Fetch; rpcUrls: Record<number, string>; timeoutMs: number }): CommunityEligibilityProvider {
  return {
    id: "nft_ownership",
    async evaluate({ wallet, collections, rule, minCollections }) {
      const active = collections.filter((c) => c.active);
      const snapshots = await Promise.all(
        active.map(async (c): Promise<CollectionSnapshot> => {
          const base = {
            collectionId: c.id,
            displayName: c.displayName,
            chainId: c.chainId,
            contract: c.contractAddress,
            standard: c.standard,
            minQuantity: c.minQuantity,
            tokenIds: c.tokenIds,
            source: "rpc" as const,
          };
          const url = opts.rpcUrls[c.chainId];
          if (!url) return { ...base, result: "error", error: `No RPC configured for chain ${c.chainId}` };
          try {
            const { quantity, blockNumber } = await readCollectionQuantity(opts.fetch, url, c, wallet, opts.timeoutMs);
            return {
              ...base,
              quantity: quantity.toString(),
              blockNumber: blockNumber.toString(),
              result: quantity >= BigInt(c.minQuantity) ? "qualified" : "not_qualified",
            };
          } catch (e) {
            return { ...base, result: "error", error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      const result = applyRule(snapshots, rule, minCollections);
      return {
        result,
        rule,
        minCollections,
        snapshots,
        qualifying: snapshots.filter((s) => s.result === "qualified").map((s) => s.collectionId),
        error: result === "unavailable" ? "Could not read every partner collection." : undefined,
      };
    },
  };
}
