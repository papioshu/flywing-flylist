// One-off LIVE check of the eligibility path against the real free endpoints
// (public mainnet + Robinhood Chain RPCs, Chainlink ETH/USD, Coinbase spot).
// Read-only; costs nothing.  npx tsx scripts/live-eligibility.ts [wallet]
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { checkEthBalance, chainlinkPrice, coinbasePrice, COINBASE_SPOT_URL } from "../supabase/functions/_shared/eligibility.ts";

const wallet = (process.argv[2] ?? "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045").toLowerCase(); // vitalik.eth
const config = loadConfig((n) => ({ ALLOWED_ORIGINS: "http://localhost:5173", IP_HASH_SALT: "live-check-salt-xx" })[n] ?? process.env[n]);
const cfg = {
  rpcUrls: config.eligibilityRpcUrls,
  priceChainId: 1,
  chainlinkFeed: config.chainlinkEthUsdFeed,
  priceMaxAgeSeconds: config.priceMaxAgeSeconds,
  coinbaseUrl: COINBASE_SPOT_URL,
  timeoutMs: 10_000,
};
const now = new Date();
const cl = await chainlinkPrice(fetch, cfg, now);
console.log("chainlink:", cl.price.toString(), `(${Number(cl.price) / 1e8} USD)`, "updated", cl.at.toISOString(), `${Math.round((now.getTime() - cl.at.getTime()) / 1000)}s ago`);
const cb = await coinbasePrice(fetch, cfg, now);
console.log("coinbase: ", cb.price.toString(), `(${Number(cb.price) / 1e8} USD)`);
const r = await checkEthBalance(fetch, cfg, { minEthBalanceUsdCents: 5500, ethBalanceChainIds: [1, 4663] }, wallet, now);
console.log(JSON.stringify({ wallet, result: r.result, priceSource: r.price?.source, chains: r.chains, best: r.best && { ...r.best, balanceWei: r.best.balanceWei.toString(), usdCents: r.best.usdCents.toString() }, error: r.error }, null, 2));
const empty = await checkEthBalance(fetch, cfg, { minEthBalanceUsdCents: 5500, ethBalanceChainIds: [1, 4663] }, "0x000000000000000000000000000000000000dEaD".toLowerCase(), now);
console.log("0x…dEaD:", empty.result, empty.chains.map((c) => `${c.chainId}:${c.balanceWei}`).join(" "));
const fresh = await checkEthBalance(fetch, cfg, { minEthBalanceUsdCents: 5500, ethBalanceChainIds: [1, 4663] }, "0x1111111111111111111111111111111111111bad", now);
console.log("unused address:", fresh.result, fresh.chains.map((c) => `${c.chainId}:${c.status}:${c.balanceWei}`).join(" "));
