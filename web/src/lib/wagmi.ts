import { createConfig, http } from "wagmi";
import { arbitrum, base, mainnet, optimism, polygon, robinhood, robinhoodTestnet } from "wagmi/chains";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import { WC_PROJECT_ID as wcProjectId } from "./wallets";

// Must match ALLOWED_CHAIN_IDS on the server (defaults are the same list).
export const chains = [mainnet, base, arbitrum, optimism, polygon, robinhood, robinhoodTestnet] as const;
export const SUPPORTED_CHAIN_IDS: number[] = chains.map((c) => c.id);
/** Chain to switch to if the wallet is on an unsupported network. Every wallet has Ethereum. */
export const FALLBACK_CHAIN_ID = mainnet.id;

export const wagmiConfig = createConfig({
  chains,
  connectors: [
    injected({ shimDisconnect: true }),
    ...(wcProjectId
      ? [
          walletConnect({
            projectId: wcProjectId,
            showQrModal: true,
            // Reown's QR / all-wallets modal, tinted to the FLY WING palette and stacked above our modal.
            qrModalOptions: {
              themeMode: "light",
              themeVariables: { "--w3m-accent": "#872e2c", "--w3m-z-index": "1000", "--w3m-border-radius-master": "2px" },
            } as never,
            metadata: {
              name: "FLY WING GENESIS",
              description: "FLY WING GENESIS FLYLIST",
              url: window.location.origin,
              icons: [`${window.location.origin}/favicon.png`],
            },
          }),
        ]
      : []),
    // Coinbase's own SDK: the Coinbase Wallet extension if installed, otherwise its QR / mobile app
    // and smart-wallet sign-in. (Coinbase renamed the Base app back to Coinbase Wallet in Sept 2026.)
    coinbaseWallet({ appName: "FLY WING GENESIS", appLogoUrl: `${window.location.origin}/favicon.png` }),
  ],
  transports: Object.fromEntries(chains.map((c) => [c.id, http()])) as never,
});
