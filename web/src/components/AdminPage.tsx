import { useCallback, useEffect, useState } from "react";
import { useAccount, useDisconnect, useSignMessage, useSwitchChain } from "wagmi";
import { api, ApiError, download } from "../lib/api";
import { clearToken, getToken, isUserRejection, shortAddress, signIn } from "../lib/session";
import { FALLBACK_CHAIN_ID, SUPPORTED_CHAIN_IDS } from "../lib/wagmi";
import { WalletPicker } from "./WalletPicker";

type Row = {
  id: string;
  walletAddress: string;
  twitterUsername: string;
  twitterUrl: string;
  twitterVerified: boolean;
  registrationStatus: string;
  eligibilityStatus: string;
  eligibilityCheckedAt: string | null;
  registeredAt: string;
  updatedAt: string;
  verificationChainId: number;
  adminNotes: string | null;
  accessMethod: string;
  eligibilityChainId: number | null;
  ethBalanceWei: string | null;
  ethBalanceEth: string | null;
  ethUsdPrice: string | null;
  ethUsdPriceSource: string | null;
  ethUsdPriceAt: string | null;
  balanceUsd: string | null;
  campaignId: string;
  handleSharedCount?: number;
};
type Stats = {
  total: number;
  today: number;
  uniqueWallets: number;
  byRegistrationStatus: Record<string, number>;
  byEligibilityStatus: Record<string, number>;
  campaign: { name: string; isOpen: boolean; status: string };
};
type Audit = { id: number; actorWallet: string; actorRole: string; action: string; changes: Record<string, { from: unknown; to: unknown }>; createdAt: string };

const REG = ["registered", "pending_verification", "eligible", "ineligible", "approved", "rejected"];
const ELIG = ["not_checked", "pending", "eligible", "ineligible"];
const CHAIN: Record<number, string> = { 1: "Ethereum", 4663: "Robinhood" };
const COLUMNS: { key: string; label: string; sortable: boolean }[] = [
  { key: "registeredAt", label: "Registered (UTC)", sortable: true },
  { key: "walletAddress", label: "Wallet", sortable: true },
  { key: "twitterUsername", label: "X username", sortable: true },
  { key: "registrationStatus", label: "Status", sortable: true },
  { key: "eligibilityStatus", label: "Eligibility", sortable: true },
  { key: "balance", label: "ETH at registration", sortable: false },
  { key: "notes", label: "Notes", sortable: false },
];
// Server-side presets. "Final mint allowlist" is approved-only; pending or merely eligible wallets never appear in it.
const EXPORTS: { preset: string; label: string }[] = [
  { preset: "pending_verification", label: "Pending verification" },
  { preset: "eligible", label: "Eligible + approved" },
  { preset: "final", label: "Final mint allowlist (approved only)" },
];

const fmt = (iso: string) => iso.replace("T", " ").slice(0, 16);

export function AdminPage() {
  const { address, chainId } = useAccount();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);

  useEffect(() => {
    setToken(address ? getToken("admin", address) : null);
    setError(null);
  }, [address]);

  async function adminSignIn() {
    if (!address) return;
    setError(null);
    setSigning(true);
    try {
      let id = chainId ?? FALLBACK_CHAIN_ID;
      if (!SUPPORTED_CHAIN_IDS.includes(id)) {
        await switchChainAsync({ chainId: FALLBACK_CHAIN_ID });
        id = FALLBACK_CHAIN_ID;
      }
      setToken(await signIn({ purpose: "admin", address, chainId: id, sign: (message) => signMessageAsync({ message }) }));
    } catch (e) {
      setError(isUserRejection(e) ? "Signature cancelled." : e instanceof ApiError ? e.message : "Sign-in failed.");
    } finally {
      setSigning(false);
    }
  }

  function signOut() {
    if (address && token) {
      api("/auth/logout", { method: "POST", token }).catch(() => undefined);
      clearToken("admin", address);
    }
    setToken(null);
  }

  return (
    <div className="page page--admin">
      <header className="topbar">
        <a className="wordmark" href="/">
          FLY WING <span>GENESIS</span>
        </a>
        <span className="pill pill--dark">FLYLIST admin</span>
        {address && (
          <span className="topbar__who mono">
            {shortAddress(address)}{" "}
            <button className="link link--light" onClick={() => (token ? signOut() : disconnect())}>
              {token ? "Sign out" : "Disconnect"}
            </button>
          </span>
        )}
      </header>

      <main className="admin">
        {!address && (
          <div className="panel panel--narrow">
            <h1 className="admin__title">Admin sign-in</h1>
            <p className="muted">Connect an administrator wallet. Access is checked on the server for every request.</p>
            <WalletPicker onError={setError} label="Connect admin wallet" />
          </div>
        )}
        {address && !token && (
          <div className="panel panel--narrow">
            <h1 className="admin__title">Admin sign-in</h1>
            <p className="muted">Sign a free message to prove this wallet is an administrator.</p>
            <button className="btn btn--primary" onClick={adminSignIn} disabled={signing}>
              {signing ? "Check your wallet…" : "Sign in"}
            </button>
          </div>
        )}
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {address && token && (
          <Dashboard
            token={token}
            onAuthLost={(msg) => {
              clearToken("admin", address);
              setToken(null);
              setError(msg);
            }}
          />
        )}
      </main>
    </div>
  );
}

function Dashboard({ token, onAuthLost }: { token: string; onAuthLost: (msg: string) => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<Row | null>(null);

  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [eligibility, setEligibility] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState("registeredAt");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => setPage(1), [search, status, eligibility, from, to, sort, dir]);

  const filterQuery = useCallback(() => {
    const p = new URLSearchParams();
    if (search) p.set("q", search);
    if (status) p.set("registrationStatus", status);
    if (eligibility) p.set("eligibilityStatus", eligibility);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    return p;
  }, [search, status, eligibility, from, to]);

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) onAuthLost(e.message);
      else setError(e instanceof ApiError ? e.message : "Request failed.");
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = filterQuery();
      p.set("sort", sort);
      p.set("dir", dir);
      p.set("page", String(page));
      p.set("pageSize", String(pageSize));
      const [s, list] = await Promise.all([
        api<Stats>("/admin/stats", { token }),
        api<{ registrations: Row[]; total: number; pageCount: number }>(`/admin/registrations?${p}`, { token }),
      ]);
      setStats(s);
      setRows(list.registrations);
      setTotal(list.total);
      setPageCount(list.pageCount);
    } catch (e) {
      handle(e);
    } finally {
      setLoading(false);
    }
  }, [filterQuery, sort, dir, page, token, handle]);

  useEffect(() => {
    load();
  }, [load]);

  async function exportCsv(preset?: string) {
    setExporting(true);
    setError(null);
    try {
      // Presets export the whole dataset for that status set; the main button respects the current filters.
      const q = preset ? new URLSearchParams({ preset }) : filterQuery();
      await download(`/admin/export.csv?${q}`, token, `flylist-${preset ?? "all"}-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (e) {
      handle(e);
    } finally {
      setExporting(false);
    }
  }

  function toggleSort(key: string) {
    if (sort === key) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSort(key);
      setDir(key === "registeredAt" ? "desc" : "asc");
    }
  }

  const filtered = search || status || eligibility || from || to;

  return (
    <>
      <div className="admin__head">
        <div>
          <h1 className="admin__title">{stats?.campaign.name ?? "FLYLIST"}</h1>
          {stats && <p className="muted">Registration is {stats.campaign.isOpen ? "open" : "closed"}.</p>}
        </div>
        <button className="btn btn--primary btn--export" onClick={() => exportCsv()} disabled={exporting}>
          {exporting ? "Exporting…" : filtered ? `Export CSV (${total} matching)` : "Export CSV"}
        </button>
      </div>
      <div className="exports">
        <span className="muted">Full-dataset exports:</span>
        {EXPORTS.map((x) => (
          <button key={x.preset} className="link" onClick={() => exportCsv(x.preset)} disabled={exporting}>
            {x.label}
          </button>
        ))}
      </div>

      {stats && (
        <div className="stats">
          <Stat label="Total registrations" value={stats.total} />
          <Stat label="Today (UTC)" value={stats.today} />
          <Stat label="Unique wallets" value={stats.uniqueWallets} />
          <Stat label="Eligible" value={stats.byRegistrationStatus.eligible ?? 0} />
          <Stat label="Pending verification" value={stats.byRegistrationStatus.pending_verification ?? 0} />
          <Stat label="Approved" value={stats.byRegistrationStatus.approved ?? 0} />
        </div>
      )}

      <div className="filters">
        <input className="field" placeholder="Search wallet or X username" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <select className="field" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Registration status">
          <option value="">All statuses</option>
          {REG.map((s) => (
            <option key={s} value={s}>
              {s.replace("_", " ")}
            </option>
          ))}
        </select>
        <select className="field" value={eligibility} onChange={(e) => setEligibility(e.target.value)} aria-label="Eligibility">
          <option value="">All eligibility</option>
          {ELIG.map((s) => (
            <option key={s} value={s}>
              {s.replace("_", " ")}
            </option>
          ))}
        </select>
        <label className="field field--date">
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field field--date">
          To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <div className="table-wrap" aria-busy={loading}>
        <table className="table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.key} aria-sort={sort === c.key ? (dir === "asc" ? "ascending" : "descending") : undefined}>
                  {c.sortable ? (
                    <button className="th-sort" onClick={() => toggleSort(c.key)}>
                      {c.label} {sort === c.key ? (dir === "asc" ? "▲" : "▼") : ""}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => setSelected(r)} className={selected?.id === r.id ? "is-selected" : ""}>
                <td className="mono" data-label="Registered">
                  {fmt(r.registeredAt)}
                </td>
                <td className="mono" data-label="Wallet" title={r.walletAddress}>
                  {r.walletAddress}
                </td>
                <td data-label="X">
                  <a href={r.twitterUrl} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
                    @{r.twitterUsername}
                  </a>
                  {(r.handleSharedCount ?? 1) > 1 && <span className="tag tag--warn" title="Same X username on multiple wallets">×{r.handleSharedCount}</span>}
                </td>
                <td data-label="Status">
                  <span className={`tag tag--${r.registrationStatus}`}>{r.registrationStatus.replace("_", " ")}</span>
                </td>
                <td data-label="Eligibility">
                  <span className={`tag tag--${r.eligibilityStatus}`}>{r.eligibilityStatus.replace("_", " ")}</span>
                </td>
                <td className="mono" data-label="ETH" title={r.ethBalanceWei ? `${r.ethBalanceWei} wei` : undefined}>
                  {r.balanceUsd ? `$${r.balanceUsd}` : "—"}
                  {r.eligibilityChainId && <span className="muted"> · {CHAIN[r.eligibilityChainId] ?? r.eligibilityChainId}</span>}
                </td>
                <td data-label="Notes" className="notes-cell">
                  {r.adminNotes}
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="empty">
                  No registrations {filtered ? "match these filters" : "yet"}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <span className="muted">
          {total} result{total === 1 ? "" : "s"} · page {page} of {pageCount}
        </span>
        <div>
          <button className="btn btn--ghost" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
            Prev
          </button>
          <button className="btn btn--ghost" disabled={page >= pageCount || loading} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      </div>

      {selected && <div className="drawer-backdrop" onClick={() => setSelected(null)} aria-hidden />}
      {selected && (
        <Editor
          key={selected.id}
          row={selected}
          token={token}
          onClose={() => setSelected(null)}
          onSaved={(r) => {
            setSelected(r);
            setRows((rs) => rs.map((x) => (x.id === r.id ? r : x)));
            api<Stats>("/admin/stats", { token }).then(setStats).catch(() => undefined);
          }}
          onError={handle}
        />
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <span className="stat__value">{value.toLocaleString()}</span>
      <span className="stat__label">{label}</span>
    </div>
  );
}

function Editor({
  row,
  token,
  onClose,
  onSaved,
  onError,
}: {
  row: Row;
  token: string;
  onClose: () => void;
  onSaved: (r: Row) => void;
  onError: (e: unknown) => void;
}) {
  const [status, setStatus] = useState(row.registrationStatus);
  const [eligibility, setEligibility] = useState(row.eligibilityStatus);
  const [notes, setNotes] = useState(row.adminNotes ?? "");
  const [saving, setSaving] = useState(false);
  const [audit, setAudit] = useState<Audit[] | null>(null);

  const loadAudit = useCallback(() => {
    api<{ entries: Audit[] }>(`/admin/registrations/${row.id}/audit`, { token })
      .then((r) => setAudit(r.entries))
      .catch(onError);
  }, [row.id, token, onError]);
  useEffect(loadAudit, [loadAudit]);

  async function save() {
    const body: Record<string, unknown> = {};
    if (status !== row.registrationStatus) body.registrationStatus = status;
    if (eligibility !== row.eligibilityStatus) body.eligibilityStatus = eligibility;
    if (notes !== (row.adminNotes ?? "")) body.adminNotes = notes.trim() ? notes : null;
    if (Object.keys(body).length === 0) return;
    setSaving(true);
    try {
      const r = await api<{ registration: Row }>(`/admin/registrations/${row.id}`, { method: "PATCH", token, body });
      onSaved(r.registration);
      loadAudit();
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className="drawer" role="dialog" aria-label="Edit registration">
      <div className="drawer__head">
        <h2>@{row.twitterUsername}</h2>
        <button className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <dl className="kv">
        <dt>Wallet</dt>
        <dd className="mono">{row.walletAddress}</dd>
        <dt>X profile</dt>
        <dd>
          <a href={row.twitterUrl} target="_blank" rel="noreferrer noopener">
            {row.twitterUrl}
          </a>{" "}
          <span className="muted">({row.twitterVerified ? "verified" : "self-reported, unverified"})</span>
        </dd>
        <dt>Registered</dt>
        <dd className="mono">{row.registeredAt}</dd>
        <dt>Campaign</dt>
        <dd className="mono">{row.campaignId}</dd>
        <dt>Access method</dt>
        <dd className="mono">{row.accessMethod}</dd>
        <dt>Signed in on chain</dt>
        <dd className="mono">{row.verificationChainId}</dd>
        <dt>ETH balance</dt>
        <dd className="mono">
          {row.ethBalanceEth ?? "—"} ETH{row.ethBalanceWei ? ` (${row.ethBalanceWei} wei)` : ""}
          {row.eligibilityChainId ? ` on chain ${row.eligibilityChainId}` : ""}
        </dd>
        <dt>ETH/USD used</dt>
        <dd className="mono">
          {row.ethUsdPrice ? `$${row.ethUsdPrice} (${row.ethUsdPriceSource}, ${row.ethUsdPriceAt})` : "—"}
        </dd>
        <dt>USD at registration</dt>
        <dd className="mono">{row.balanceUsd ? `$${row.balanceUsd}` : "—"}</dd>
      </dl>
      <label className="form__label">Registration status</label>
      <select className="field" value={status} onChange={(e) => setStatus(e.target.value)}>
        {REG.map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <label className="form__label">Eligibility</label>
      <select className="field" value={eligibility} onChange={(e) => setEligibility(e.target.value)}>
        {ELIG.map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <label className="form__label">Admin notes (private)</label>
      <textarea className="field" rows={4} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      <button className="btn btn--primary" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save changes"}
      </button>

      <h3 className="drawer__sub">History</h3>
      {!audit && <p className="muted">Loading…</p>}
      <ol className="audit">
        {audit?.map((a) => (
          <li key={a.id}>
            <span className="mono">{fmt(a.createdAt)}</span> · {a.action.replace(/_/g, " ")} by {a.actorRole}{" "}
            <span className="mono">{shortAddress(a.actorWallet)}</span>
            <ul>
              {Object.entries(a.changes).map(([k, v]) => (
                <li key={k}>
                  {k.replace(/_/g, " ")}:{" "}
                  {v && typeof v === "object" && "to" in v ? (
                    <>
                      <s>{String(v.from ?? "—")}</s> → {String(v.to ?? "—")}
                    </>
                  ) : (
                    String(v)
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </aside>
  );
}
