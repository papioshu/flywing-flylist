import { createConfig, http } from "wagmi";
import { arbitrum, base, mainnet, optimism, polygon, robinhood, robinhoodTestnet } from "wagmi/chains";
import { baseAccount, injected, walletConnect } from "wagmi/connectors";

const wcProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;

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
            metadata: {
              name: "FLY WING GENESIS",
              description: "FLY WING GENESIS allowlist",
              url: window.location.origin,
              icons: [`${window.location.origin}/favicon.png`],
            },
          }),
        ]
      : []),
    baseAccount({ appName: "FLY WING GENESIS" }),
  ],
  transports: Object.fromEntries(chains.map((c) => [c.id, http()])) as never,
});
