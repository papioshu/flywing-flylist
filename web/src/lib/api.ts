// Thin client for the allowlist Edge Function.

export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";

export type Campaign = { id: string; name: string; status: string; opensAt: string | null; closesAt: string | null; isOpen: boolean };
export type PublicRegistration = {
  walletAddress: string;
  twitterUsername: string;
  twitterVerified: boolean;
  registrationStatus: string;
  registeredAt: string;
  updatedAt: string;
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
  if (!API_URL) throw new ApiError(0, "NOT_CONFIGURED", "The allowlist API is not configured (VITE_API_URL).");
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
    throw new ApiError(0, "NETWORK", "Couldn't reach the allowlist server. Check your connection and try again.");
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
