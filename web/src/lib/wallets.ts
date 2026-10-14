// Wallet catalogue for the icon-first picker. Logos are never drawn or approximated here; each one
// comes from an official source:
//   1. Installed wallets: the icon the wallet itself announces over EIP-6963 (connector.icon).
//   2. Coinbase Wallet: the logo bundled in Coinbase's own SDK (@coinbase/wallet-sdk).
//   3. WalletConnect: the mark bundled in Reown's AppKit UI package (copied verbatim below).
//   4. Featured wallets that aren't installed (MetaMask, Rabby): the image published in the
//      WalletConnect wallet registry, fetched with the project ID. No project ID → name-only tile.
import { useEffect, useState } from "react";
import { walletLogo } from "@coinbase/wallet-sdk/dist/assets/wallet-logo.js";

export const WC_PROJECT_ID = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) || "";

export type Featured = {
  key: string;
  name: string;
  /** EIP-6963 reverse-DNS ids that mean "this wallet is installed". */
  rdns: string[];
  /** WalletConnect registry id (for the official logo when the wallet isn't installed). */
  registryId?: string;
  install?: string;
  /** Mobile: open this page inside the wallet's own browser. */
  mobileBrowser?: (pageUrl: URL) => string;
};

export const FEATURED: Featured[] = [
  {
    key: "metamask",
    name: "MetaMask",
    rdns: ["io.metamask", "io.metamask.mobile"],
    registryId: "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96",
    install: "https://metamask.io/download/",
    mobileBrowser: (u) => `https://metamask.app.link/dapp/${u.host}${u.pathname}`,
  },
  {
    key: "coinbase",
    name: "Coinbase Wallet",
    rdns: ["com.coinbase.wallet"],
    registryId: "fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa",
  },
  {
    key: "rabby",
    name: "Rabby",
    rdns: ["io.rabby"],
    registryId: "18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1",
    install: "https://rabby.io/",
  },
];

/** Coinbase Wallet's official logo, from Coinbase's SDK. */
export const COINBASE_ICON = walletLogo("standard", 96);

/** WalletConnect mark, verbatim paths from @reown/appkit-ui (assets/svg/walletconnect.js). */
export const WALLETCONNECT_ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="89" height="89" viewBox="0 0 89 89" fill="none"><path d="M60.0468 39.2502L65.9116 33.3854C52.6562 20.13 36.1858 20.13 22.9304 33.3854L28.7952 39.2502C38.8764 29.169 49.9725 29.169 60.0536 39.2502H60.0468Z" fill="#202020"/><path d="M58.0927 52.9146L44.415 39.2369L30.7373 52.9146L17.0596 39.2369L11.2017 45.0949L30.7373 64.6374L44.415 50.9597L58.0927 64.6374L77.6284 45.0949L71.7704 39.2369L58.0927 52.9146Z" fill="#202020"/></svg>`,
  );

// WalletConnect registry (the same public API AppKit uses for its wallet list and logos).
const REGISTRY = "https://api.web3modal.org";
const SDK = { st: "appkit", sv: "html-wagmi-1.8.19" };

function registryUrl(path: string, extra: Record<string, string> = {}) {
  const u = new URL(REGISTRY + path);
  for (const [k, v] of Object.entries({ projectId: WC_PROJECT_ID, ...SDK, ...extra })) u.searchParams.set(k, v);
  return u.toString();
}

let registryCache: Promise<Record<string, string>> | null = null;

/** Official registry logos for the featured wallets, keyed by Featured.key. Empty without a project ID. */
export function useRegistryIcons(): Record<string, string> {
  const [icons, setIcons] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!WC_PROJECT_ID) return;
    registryCache ??= (async () => {
      const ids = FEATURED.flatMap((f) => (f.registryId ? [f.registryId] : []));
      const r = await fetch(registryUrl("/getWallets", { page: "1", entries: String(ids.length), include: ids.join(",") }));
      if (!r.ok) throw new Error(`registry ${r.status}`);
      const { data } = (await r.json()) as { data: { id: string; image_id?: string }[] };
      const out: Record<string, string> = {};
      for (const f of FEATURED) {
        let w = data.find((x) => x.id === f.registryId);
        if (!w) {
          // id not in this registry version: fall back to an exact-name search
          const s = await fetch(registryUrl("/getWallets", { page: "1", entries: "5", search: f.name }));
          const found = s.ok ? ((await s.json()) as { data: { id: string; name?: string; image_id?: string }[] }).data : [];
          w = found.find((x) => x.name?.toLowerCase() === f.name.toLowerCase());
        }
        if (w?.image_id) out[f.key] = registryUrl(`/getWalletImage/${w.image_id}`);
      }
      return out;
    })().catch(() => {
      registryCache = null;
      return {};
    });
    let live = true;
    registryCache.then((v) => live && setIcons(v));
    return () => {
      live = false;
    };
  }, []);
  return icons;
}

export const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
