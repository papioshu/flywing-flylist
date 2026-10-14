// Fake network at the fetch boundary for eligibility tests: JSON-RPC nodes per chain
// (eth_chainId, eth_blockNumber, eth_getBalance, Chainlink eth_call) and Coinbase spot.
// The real eligibility code (ABI decoding, staleness, bigint math) runs unmodified.
import { COINBASE_SPOT_URL } from "../supabase/functions/_shared/eligibility.ts";

export type FakeNet = ReturnType<typeof createFakeNet>;

export function createFakeNet(rpcUrls: Record<number, string>, nowMs: () => number) {
  const state = {
    /** wallet (lowercase) -> chainId -> wei */
    balances: new Map<string, Map<number, bigint>>(),
    /** Default balance for wallets not set explicitly (1 ETH on mainnet), so ordinary tests pass the check. */
    defaultWei: { 1: 10n ** 18n } as Record<number, bigint>,
    chainlinkAnswer: 2500_00000000n as bigint, // $2,500.00000000
    chainlinkUpdatedAgoSeconds: 60,
    chainlinkDown: false,
    coinbaseAmount: "2400.00" as string | null,
    coinbaseDown: false,
    chainDown: new Set<number>(),
    /** If set, an RPC answers with this chain ID instead of its own (misconfigured URL). */
    wrongChainId: new Map<number, number>(),
    calls: [] as string[],
  };
  const urlToChain = new Map(Object.entries(rpcUrls).map(([id, url]) => [url, Number(id)]));
  const word = (v: bigint) => (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, "0");

  function rpc(chainId: number, method: string, params: any[]): unknown {
    switch (method) {
      case "eth_chainId":
        return `0x${(state.wrongChainId.get(chainId) ?? chainId).toString(16)}`;
      case "eth_blockNumber":
        return "0x1234";
      case "eth_getBalance": {
        const wallet = String(params[0]).toLowerCase();
        const wei = state.balances.get(wallet)?.get(chainId) ?? state.defaultWei[chainId] ?? 0n;
        return `0x${wei.toString(16)}`;
      }
      case "eth_call": {
        if (state.chainlinkDown) throw new Error("execution reverted");
        const data = params[0].data as string;
        if (data === "0x313ce567") return `0x${word(8n)}`;
        if (data === "0xfeaf968c") {
          const updatedAt = BigInt(Math.floor(nowMs() / 1000) - state.chainlinkUpdatedAgoSeconds);
          return `0x${word(100n)}${word(state.chainlinkAnswer)}${word(updatedAt)}${word(updatedAt)}${word(100n)}`;
        }
        throw new Error("unknown call");
      }
    }
    throw new Error(`unsupported ${method}`);
  }

  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === COINBASE_SPOT_URL) {
      state.calls.push("coinbase");
      if (state.coinbaseDown || state.coinbaseAmount === null) return new Response("down", { status: 503 });
      return Response.json({ data: { amount: state.coinbaseAmount, base: "ETH", currency: "USD" } });
    }
    const chainId = urlToChain.get(url);
    if (chainId === undefined) throw new TypeError(`fakeNet: unexpected fetch ${url}`);
    if (state.chainDown.has(chainId)) {
      state.calls.push(`rpc:${chainId}:down`);
      throw new TypeError("fetch failed");
    }
    const batch = JSON.parse(String(init?.body)) as { id: number; method: string; params: any[] }[];
    const out = batch.map((c) => {
      state.calls.push(`rpc:${chainId}:${c.method}`);
      try {
        return { jsonrpc: "2.0", id: c.id, result: rpc(chainId, c.method, c.params) };
      } catch (e) {
        return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: (e as Error).message } };
      }
    });
    return Response.json(out);
  };

  return {
    state,
    fetch: fetchFn,
    setBalance(wallet: string, chainId: number, wei: bigint) {
      const w = wallet.toLowerCase();
      if (!state.balances.has(w)) state.balances.set(w, new Map());
      state.balances.get(w)!.set(chainId, wei);
    },
  };
}
