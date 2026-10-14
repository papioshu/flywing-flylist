// One-off LIVE sanity check of the NFT ownership provider against public Ethereum
// mainnet RPC. Read-only, costs nothing. Uses the Bored Ape Yacht Club contract only as
// a well-known ERC-721 to prove the RPC path works. It is NOT a partner collection and
// is not configured anywhere.   npx tsx scripts/live-nft.ts
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { createNftOwnershipProvider, readCollectionQuantity } from "../supabase/functions/_shared/nft.ts";

const BAYC = "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d";
const config = loadConfig((n) => ({ ALLOWED_ORIGINS: "http://localhost:5173", IP_HASH_SALT: "live-check-salt-xx" })[n] ?? process.env[n]);
const url = config.eligibilityRpcUrls[1];

// Find the current owner of token #1 straight from the contract (ownerOf).
const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: BAYC, data: `0x6352211e${(1n).toString(16).padStart(64, "0")}` }, "latest"] }),
});
const owner = `0x${((await res.json()) as { result: string }).result.slice(-40)}`;
console.log("BAYC #1 ownerOf:", owner);

const collection = { id: "bayc-sanity", displayName: "BAYC (sanity check only)", chainId: 1, contractAddress: BAYC, standard: "erc721" as const, minQuantity: 1, tokenIds: [], active: true };
const raw = await readCollectionQuantity(fetch, url, collection, owner, 10_000);
console.log("balanceOf(owner) at block", raw.blockNumber.toString(), "=", raw.quantity.toString());

const p = createNftOwnershipProvider({ fetch, rpcUrls: config.eligibilityRpcUrls, timeoutMs: 10_000 });
for (const [label, wallet, c] of [
  ["owner, collection-wide", owner, collection],
  ["owner, token #1 only", owner, { ...collection, tokenIds: ["1"] }],
  ["unused address", "0x1111111111111111111111111111111111111bad", collection],
  ["owner, wrong chain (configured as Robinhood 4663)", owner, { ...collection, chainId: 4663 }],
] as const) {
  const r = await p.evaluate({ wallet, collections: [c], rule: "any", minCollections: 1 });
  console.log(`${label}:`, r.result, JSON.stringify(r.snapshots.map((s) => ({ quantity: s.quantity, block: s.blockNumber, result: s.result, error: s.error }))));
}
