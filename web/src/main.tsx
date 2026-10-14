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
const isAdmin = window.location.pathname.replace(/\/+$/, "") === "/admin/allowlist";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{isAdmin ? <AdminPage /> : <LandingPage />}</QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
