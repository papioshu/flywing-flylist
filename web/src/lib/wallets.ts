// Wallet catalogue for the icon-first picker. Logos are never drawn or approximated here; each one
// comes from an official source:
//   1. MetaMask, Rabby, WalletConnect: the symbol from each brand's own logo pack (owner-supplied,
//      2026-10-14), served from web/public/wallets/. Originals in assets-src/wallets/.
//   2. Coinbase Wallet: the mark bundled in Coinbase's own SDK (@coinbase/wallet-sdk). The supplied
//      Coinbase pack only has the wordmark, no symbol.
//   3. Any other installed wallet: the icon it announces about itself over EIP-6963 (connector.icon).
import { walletLogo } from "@coinbase/wallet-sdk/dist/assets/wallet-logo.js";

export const WC_PROJECT_ID = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) || "";

export type Featured = {
  key: string;
  name: string;
  /** Brand symbol used for the button, whether or not the wallet is installed. */
  symbol: string;
  /** EIP-6963 reverse-DNS ids that mean "this wallet is installed". */
  rdns: string[];
  install?: string;
  /** Mobile: open this page inside the wallet's own browser. */
  mobileBrowser?: (pageUrl: URL) => string;
};

/** Coinbase Wallet's official mark, from Coinbase's SDK. */
export const COINBASE_ICON = walletLogo("standard", 96);

/** WalletConnect logomark (blue), from WalletConnect's logo pack. */
export const WALLETCONNECT_ICON = "/wallets/walletconnect-logomark-blue.svg";

export const FEATURED: Featured[] = [
  {
    key: "metamask",
    name: "MetaMask",
    symbol: "/wallets/metamask-fox.svg",
    rdns: ["io.metamask", "io.metamask.mobile"],
    install: "https://metamask.io/download/",
    mobileBrowser: (u) => `https://metamask.app.link/dapp/${u.host}${u.pathname}`,
  },
  {
    key: "coinbase",
    name: "Coinbase Wallet",
    symbol: COINBASE_ICON,
    rdns: ["com.coinbase.wallet"],
  },
  {
    key: "rabby",
    name: "Rabby",
    symbol: "/wallets/rabby-symbol.svg",
    rdns: ["io.rabby"],
    install: "https://rabby.io/",
  },
];

export const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
