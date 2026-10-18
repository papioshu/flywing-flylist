import "@fontsource/oswald/latin-500.css";
import "@fontsource/oswald/latin-600.css";
import "@fontsource/oswald/latin-700.css";
import "@fontsource/zen-kaku-gothic-new/latin-400.css";
import "@fontsource/zen-kaku-gothic-new/latin-700.css";
import "@fontsource/dm-mono/latin-400.css";
import "@fontsource/dm-mono/latin-500.css";
import "./styles.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { AdminPage } from "./components/AdminPage";
import { LandingPage } from "./components/LandingPage";
import { wagmiConfig } from "./lib/wagmi";

const queryClient = new QueryClient();
// Two routes, no router. "/" is the FLYLIST landing page, which is the public front door of chasingclouds.xyz
// until the launch switch moves the domain to the full website (docs/DEPLOYMENT.md § 8). "/admin/allowlist" is
// the admin dashboard; the admin API itself is protected by wallet sign-in, so this check only picks the screen.
const isAdmin = window.location.pathname.replace(/\/+$/, "") === "/admin/allowlist";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{isAdmin ? <AdminPage /> : <LandingPage />}</QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
