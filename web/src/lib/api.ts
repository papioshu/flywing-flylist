// Thin client for the FLYLIST (allowlist) Edge Function.

// Dev falls back to the local API started by `npm run dev` (server/dev.ts), reached through Vite's
// same-origin proxy so it also works from a phone; production builds must set VITE_API_URL.
export const API_URL = (
  (import.meta.env.VITE_API_URL as string | undefined) || (import.meta.env.DEV ? "/allowlist" : "")
).replace(/\/$/, "");

export type Campaign = {
  id: string;
  name: string;
  status: string;
  opensAt: string | null;
  closesAt: string | null;
  isOpen: boolean;
  requirements?: {
    accessMode: string;
    ethBalance: { minUsd: string; chains: { chainId: number; chainName: string }[]; rule: string } | null;
    xFollowRequired: boolean;
  };
};
export type PublicRegistration = {
  walletAddress: string;
  twitterUsername: string;
  twitterVerified: boolean;
  registrationStatus: string;
  eligibilityStatus: string;
  registeredAt: string;
  updatedAt: string;
};
/** The server's eligibility result for the signed-in wallet. Display only: the server re-checks on submit. */
export type Eligibility = {
  result: "eligible" | "ineligible" | "unavailable";
  minBalanceUsd: string;
  ethUsdPrice: string | null;
  priceSource: "chainlink" | "coinbase" | null;
  priceAt: string | null;
  checkedAt: string;
  cached: boolean;
  chains: { chainId: number; chainName: string; status: string; balanceEth: string | null; balanceUsd: string | null; passed: boolean | null }[];
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public data: Record<string, any> = {}) {
    super(message);
  }
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<T> {
  if (!API_URL) throw new ApiError(0, "NOT_CONFIGURED", "The FLYLIST API is not configured (VITE_API_URL).");
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Couldn't reach the FLYLIST server. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? "UNKNOWN", e.message ?? `Request failed (${res.status}).`, e);
  }
  return data as T;
}

/** Downloads a server-generated file (admin CSV export) using the bearer token. */
export async function download(path: string, token: string, fallbackName: string): Promise<void> {
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data?.error?.code ?? "UNKNOWN", data?.error?.message ?? "Export failed.");
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
