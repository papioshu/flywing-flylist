// Admin configuration panels (FLYLIST Phase B): campaign policy, partner collections,
// access codes, provider usage/budgets. Every change is authorized, validated and
// audited on the server; deferred integrations are refused there unless activated.
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { shortAddress } from "../lib/session";

type OnError = (e: unknown) => void;

type Policy = {
  status: "draft" | "open" | "closed";
  opensAt: string | null;
  closesAt: string | null;
  accessMode: "open" | "invite_code" | "community" | "hybrid";
  ethBalanceCheckEnabled: boolean;
  minEthBalanceUsdCents: number;
  ethBalanceChainIds: number[];
  xAuthRequired: boolean;
  xFollowRequired: boolean;
  requiredXAccounts: { id: string; username: string }[];
  allowProvisionalRegistration: boolean;
  communityProvider: string;
  nftRule: "any" | "all" | "min_n";
  nftMinCollections: number;
  hybridRule: "code_or_community" | "code_and_community";
  finalExportIncludesUnverified: boolean;
  xProvider: string;
  xVerificationCacheSeconds: number;
  xRetryCooldownSeconds: number;
  xBudgetDailyUnits: number;
  xBudgetTotalUnits: number;
};
type Integrations = Record<"x_verification" | "community_gating" | "access_codes", { activated: boolean; active: boolean; provider?: string; providerImplemented?: boolean }>;
type PolicyResponse = {
  version: number;
  policy: Policy;
  integrations: Integrations;
  ethChainsAvailable: number[];
  history: { version: number; createdAt: string; createdBy: string; reason: string | null }[];
};

const CHAIN: Record<number, string> = { 1: "Ethereum", 4663: "Robinhood Chain", 8453: "Base", 42161: "Arbitrum", 10: "Optimism", 137: "Polygon" };
const chainName = (id: number) => CHAIN[id] ?? `Chain ${id}`;
const fmt = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) : "—");
const toLocalInput = (iso: string | null) => (iso ? iso.slice(0, 16) : "");
const fromLocalInput = (v: string) => (v ? new Date(`${v}:00Z`).toISOString() : null);

function message(e: unknown) {
  return e instanceof ApiError ? e.message : "Request failed.";
}

function Flag({ on, label }: { on: boolean; label: string }) {
  return <span className={`chip ${on ? "chip--on" : "chip--off"}`}>{label}: {on ? "on" : "off"}</span>;
}

// ---------------------------------------------------------------- policy

export function PolicyPanel({ token, onError }: { token: string; onError: OnError }) {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [accountsText, setAccountsText] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(() => {
    api<PolicyResponse>("/admin/policy", { token })
      .then((r) => {
        setData(r);
        setDraft(r.policy);
        setAccountsText(r.policy.requiredXAccounts.map((a) => `${a.id} ${a.username}`).join("\n"));
      })
      .catch(onError);
  }, [token, onError]);
  useEffect(load, [load]);

  if (!data || !draft) return <p className="admin-note">Loading policy…</p>;
  const set = <K extends keyof Policy>(k: K, v: Policy[K]) => setDraft({ ...draft, [k]: v });

  function parseAccounts(): Policy["requiredXAccounts"] {
    return accountsText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [id, username = ""] = l.split(/[\s,]+/);
        return { id, username: username.replace(/^@/, "") };
      });
  }

  async function save() {
    if (!data || !draft) return;
    const next = { ...draft, requiredXAccounts: parseAccounts() };
    const changes: Record<string, unknown> = {};
    for (const k of Object.keys(next) as (keyof Policy)[]) {
      if (JSON.stringify(next[k]) !== JSON.stringify(data.policy[k])) changes[k] = next[k];
    }
    if (Object.keys(changes).length === 0) {
      setProblem("Nothing changed.");
      return;
    }
    setSaving(true);
    setProblem(null);
    setSaved(null);
    try {
      const r = await api<{ version: number }>("/admin/policy", { method: "PATCH", token, body: { expectedVersion: data.version, changes, reason: reason || null } });
      setSaved(`Saved as policy version ${r.version}.`);
      setReason("");
      load();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403) && !["INTEGRATION_DISABLED", "PROVIDER_NOT_IMPLEMENTED"].includes(e.code)) onError(e);
      else setProblem(message(e));
    } finally {
      setSaving(false);
    }
  }

  const i = data.integrations;
  return (
    <div className="settings">
      <section className="panel settings__card settings__card--wide">
        <h2 className="settings__title">Policy version {data.version}</h2>
        <p className="admin-hint">
          Every save creates a new version. Earlier checks and registrations keep the version they were evaluated under. Deferred
          integrations stay off until the owner approves them and they are listed in <code>ENABLED_INTEGRATIONS</code>.
        </p>
        <div className="chips">
          <Flag on={i.x_verification.activated} label="X verification activated" />
          <Flag on={i.x_verification.providerImplemented ?? false} label={`X provider built (${i.x_verification.provider})`} />
          <Flag on={i.community_gating.activated} label="Community gating activated" />
          <Flag on={i.access_codes.activated} label="Access codes activated" />
        </div>
      </section>

      <section className="panel settings__card">
        <h3 className="settings__sub">Campaign status</h3>
        <label className="form__label">Registration</label>
        <select className="field" value={draft.status} onChange={(e) => set("status", e.target.value as Policy["status"])}>
          <option value="open">open</option>
          <option value="closed">closed</option>
          <option value="draft">draft</option>
        </select>
        <label className="form__label">Opens at (UTC, optional)</label>
        <input className="field" type="datetime-local" value={toLocalInput(draft.opensAt)} onChange={(e) => set("opensAt", fromLocalInput(e.target.value))} />
        <label className="form__label">Closes at (UTC, optional)</label>
        <input className="field" type="datetime-local" value={toLocalInput(draft.closesAt)} onChange={(e) => set("closesAt", fromLocalInput(e.target.value))} />
      </section>

      <section className="panel settings__card">
        <h3 className="settings__sub">Registration requirements</h3>
        <label className="form__label">Access mode</label>
        <select className="field" value={draft.accessMode} onChange={(e) => set("accessMode", e.target.value as Policy["accessMode"])}>
          <option value="open">open: anyone meeting the requirements</option>
          <option value="invite_code" disabled={!i.access_codes.activated}>invite code{i.access_codes.activated ? "" : " (not activated)"}</option>
          <option value="community" disabled={!i.community_gating.activated}>community (partner NFT){i.community_gating.activated ? "" : " (not activated)"}</option>
          <option value="hybrid" disabled={!i.access_codes.activated || !i.community_gating.activated}>hybrid (code + community)</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={draft.ethBalanceCheckEnabled} onChange={(e) => set("ethBalanceCheckEnabled", e.target.checked)} /> Require a native ETH balance
        </label>
        <label className="form__label">Minimum (USD)</label>
        <input
          className="field"
          type="number"
          min={0}
          step="0.01"
          value={(draft.minEthBalanceUsdCents / 100).toFixed(2)}
          onChange={(e) => set("minEthBalanceUsdCents", Math.round(Number(e.target.value) * 100))}
        />
        <span className="form__label">Qualifies on any one of</span>
        {data.ethChainsAvailable.map((id) => (
          <label className="check" key={id}>
            <input
              type="checkbox"
              checked={draft.ethBalanceChainIds.includes(id)}
              onChange={(e) => set("ethBalanceChainIds", e.target.checked ? [...draft.ethBalanceChainIds, id] : draft.ethBalanceChainIds.filter((c) => c !== id))}
            />{" "}
            {chainName(id)} ({id})
          </label>
        ))}
      </section>

      <section className="panel settings__card">
        <h3 className="settings__sub">Verification requirements</h3>
        <label className="check">
          <input type="checkbox" checked={draft.xAuthRequired} onChange={(e) => set("xAuthRequired", e.target.checked)} /> Verify X account ownership (OAuth)
        </label>
        <label className="check">
          <input type="checkbox" checked={draft.xFollowRequired} onChange={(e) => set("xFollowRequired", e.target.checked)} /> Require following these X accounts
        </label>
        <label className="form__label">Required X accounts: one per line, "numeric-id username"</label>
        <textarea className="field" rows={3} value={accountsText} onChange={(e) => setAccountsText(e.target.value)} placeholder="44196397 flywing" />
        <label className="check">
          <input type="checkbox" checked={draft.allowProvisionalRegistration} onChange={(e) => set("allowProvisionalRegistration", e.target.checked)} /> Allow provisional
          registration while verification is unavailable (recorded as pending verification)
        </label>
        <h3 className="settings__sub">Community rule</h3>
        <label className="form__label">Partner collections rule</label>
        <select className="field" value={draft.nftRule} onChange={(e) => set("nftRule", e.target.value as Policy["nftRule"])}>
          <option value="any">any one collection</option>
          <option value="all">all collections</option>
          <option value="min_n">at least N collections</option>
        </select>
        {draft.nftRule === "min_n" && (
          <input className="field" type="number" min={1} value={draft.nftMinCollections} onChange={(e) => set("nftMinCollections", Number(e.target.value))} aria-label="Minimum collections" />
        )}
        <label className="form__label">Hybrid rule</label>
        <select className="field" value={draft.hybridRule} onChange={(e) => set("hybridRule", e.target.value as Policy["hybridRule"])}>
          <option value="code_or_community">code OR community</option>
          <option value="code_and_community">code AND community</option>
        </select>
      </section>

      <section className="panel settings__card">
        <h3 className="settings__sub">Mint eligibility</h3>
        <p className="admin-hint">The final mint allowlist export only ever contains approved wallets.</p>
        <label className="check">
          <input type="checkbox" checked={draft.finalExportIncludesUnverified} onChange={(e) => set("finalExportIncludesUnverified", e.target.checked)} /> Include approved
          wallets whose required verifications are still pending
        </label>
        <h3 className="settings__sub">X provider &amp; budget</h3>
        <label className="form__label">Provider</label>
        <select className="field" value={draft.xProvider} onChange={(e) => set("xProvider", e.target.value)}>
          <option value="none">none: X verification not configured</option>
        </select>
        <div className="settings__pair">
          <label>
            <span className="form__label">Daily budget (units)</span>
            <input className="field" type="number" min={0} value={draft.xBudgetDailyUnits} onChange={(e) => set("xBudgetDailyUnits", Number(e.target.value))} />
          </label>
          <label>
            <span className="form__label">Total budget (units)</span>
            <input className="field" type="number" min={0} value={draft.xBudgetTotalUnits} onChange={(e) => set("xBudgetTotalUnits", Number(e.target.value))} />
          </label>
          <label>
            <span className="form__label">Reuse verified for (s)</span>
            <input className="field" type="number" min={0} value={draft.xVerificationCacheSeconds} onChange={(e) => set("xVerificationCacheSeconds", Number(e.target.value))} />
          </label>
          <label>
            <span className="form__label">Retry cooldown (s)</span>
            <input className="field" type="number" min={0} value={draft.xRetryCooldownSeconds} onChange={(e) => set("xRetryCooldownSeconds", Number(e.target.value))} />
          </label>
        </div>
      </section>

      <section className="panel settings__card settings__card--wide">
        <label className="form__label">Reason for this change (kept in the policy history)</label>
        <input className="field" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. owner approved raising the minimum" />
        {problem && (
          <p className="alert" role="alert">
            {problem}
          </p>
        )}
        {saved && <p className="admin-ok">{saved}</p>}
        <div className="settings__actions">
          <button className="btn btn--primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save policy"}
          </button>
          <button className="btn btn--ghost" onClick={load} disabled={saving}>
            Discard changes
          </button>
        </div>
        <h3 className="settings__sub">History</h3>
        <ol className="audit">
          {data.history.map((h) => (
            <li key={h.version}>
              <span className="mono">v{h.version}</span> · {fmt(h.createdAt)} · {h.createdBy === "system" ? "system" : <span className="mono">{shortAddress(h.createdBy)}</span>}
              {h.reason && <> · {h.reason}</>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- collections

type Collection = {
  id: string;
  displayName: string;
  chainId: number;
  chainName: string;
  contractAddress: string;
  standard: "erc721" | "erc1155";
  minQuantity: number;
  tokenIds: string[];
  active: boolean;
};

export function CollectionsPanel({ token, onError }: { token: string; onError: OnError }) {
  const [rows, setRows] = useState<Collection[] | null>(null);
  const [form, setForm] = useState({ displayName: "", chainId: "1", contractAddress: "", standard: "erc721", minQuantity: "1", tokenIds: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const [testWallet, setTestWallet] = useState("");
  const [test, setTest] = useState<{ result: string; snapshots: { displayName: string; quantity?: string; result: string; error?: string; blockNumber?: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ collections: Collection[] }>("/admin/collections", { token })
      .then((r) => setRows(r.collections))
      .catch(onError);
  }, [token, onError]);
  useEffect(load, [load]);

  async function add() {
    setProblem(null);
    setBusy(true);
    try {
      await api("/admin/collections", {
        method: "POST",
        token,
        body: {
          displayName: form.displayName,
          chainId: Number(form.chainId),
          contractAddress: form.contractAddress.trim(),
          standard: form.standard,
          minQuantity: Number(form.minQuantity),
          tokenIds: form.tokenIds.split(/[\s,]+/).filter(Boolean),
        },
      });
      setForm({ ...form, displayName: "", contractAddress: "", tokenIds: "" });
      load();
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(c: Collection) {
    setProblem(null);
    try {
      await api(`/admin/collections/${c.id}`, { method: "PATCH", token, body: { active: !c.active } });
      load();
    } catch (e) {
      setProblem(message(e));
    }
  }

  async function runTest() {
    setProblem(null);
    setTest(null);
    setBusy(true);
    try {
      const r = await api<{ check: typeof test }>("/admin/collections/test", { method: "POST", token, body: { walletAddress: testWallet.trim() } });
      setTest(r.check);
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings">
      <section className="panel settings__card settings__card--wide">
        <h2 className="settings__title">Partner collections</h2>
        <p className="admin-hint">
          Used only by the community rule (access modes community / hybrid), which is off. Ownership is read on-chain with standard RPC calls, no paid
          indexer. Only add collections the owner has approved, with their real contract addresses.
        </p>
        <div className="table-wrap">
          <table className="table table--static">
            <thead>
              <tr>
                <th>Community</th>
                <th>Chain</th>
                <th>Contract</th>
                <th>Standard</th>
                <th>Min</th>
                <th>Token IDs</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows?.map((c) => (
                <tr key={c.id}>
                  <td>{c.displayName}</td>
                  <td>{c.chainName}</td>
                  <td className="mono">{c.contractAddress}</td>
                  <td className="mono">{c.standard.toUpperCase()}</td>
                  <td className="mono">{c.minQuantity}</td>
                  <td className="mono">{c.tokenIds.length ? c.tokenIds.join(", ") : "any"}</td>
                  <td>
                    <button className="link" onClick={() => toggle(c)}>
                      {c.active ? "active · deactivate" : "inactive · activate"}
                    </button>
                  </td>
                </tr>
              ))}
              {rows && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">
                    No partner collections configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel settings__card">
        <h3 className="settings__sub">Add a collection</h3>
        <label className="form__label">Community display name</label>
        <input className="field" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        <div className="settings__pair">
          <label>
            <span className="form__label">Chain ID</span>
            <input className="field" type="number" min={1} value={form.chainId} onChange={(e) => setForm({ ...form, chainId: e.target.value })} />
          </label>
          <label>
            <span className="form__label">Standard</span>
            <select className="field" value={form.standard} onChange={(e) => setForm({ ...form, standard: e.target.value })}>
              <option value="erc721">ERC-721</option>
              <option value="erc1155">ERC-1155</option>
            </select>
          </label>
        </div>
        <label className="form__label">Contract address</label>
        <input className="field mono" value={form.contractAddress} onChange={(e) => setForm({ ...form, contractAddress: e.target.value })} placeholder="0x…" />
        <div className="settings__pair">
          <label>
            <span className="form__label">Minimum held</span>
            <input className="field" type="number" min={1} value={form.minQuantity} onChange={(e) => setForm({ ...form, minQuantity: e.target.value })} />
          </label>
          <label>
            <span className="form__label">Token IDs (optional for 721)</span>
            <input className="field mono" value={form.tokenIds} onChange={(e) => setForm({ ...form, tokenIds: e.target.value })} placeholder="1, 2, 3" />
          </label>
        </div>
        <button className="btn btn--primary" onClick={add} disabled={busy || !form.displayName || !form.contractAddress}>
          Add collection
        </button>
      </section>

      <section className="panel settings__card">
        <h3 className="settings__sub">Test a wallet</h3>
        <p className="admin-hint">Read-only check of any wallet against the active collections. Nothing is changed.</p>
        <input className="field mono" value={testWallet} onChange={(e) => setTestWallet(e.target.value)} placeholder="0x…" aria-label="Wallet to test" />
        <button className="btn btn--ghost" onClick={runTest} disabled={busy || !testWallet}>
          Check ownership
        </button>
        {test && (
          <div className="admin-result">
            <span className={`tag tag--${test.result === "qualified" ? "eligible" : test.result === "not_qualified" ? "ineligible" : "pending"}`}>{test.result.replace("_", " ")}</span>
            <ul>
              {test.snapshots.map((s, n) => (
                <li key={n}>
                  {s.displayName}: {s.result === "error" ? s.error : `${s.quantity} held at block ${s.blockNumber}`}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      {problem && (
        <p className="alert settings__card--wide" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- access codes

type Code = {
  id: string;
  prefix: string;
  label: string | null;
  communityAttribution: string | null;
  maxRedemptions: number;
  redemptionCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  state: "active" | "expired" | "used_up" | "revoked";
  code?: string;
};

export function AccessCodesPanel({ token, onError }: { token: string; onError: OnError }) {
  const [codes, setCodes] = useState<Code[] | null>(null);
  const [gatingActive, setGatingActive] = useState(false);
  const [fresh, setFresh] = useState<Code[]>([]);
  const [form, setForm] = useState({ count: "1", maxRedemptions: "1", expiresAt: "", label: "", communityAttribution: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    api<{ codes: Code[]; gatingActive: boolean }>("/admin/access-codes", { token })
      .then((r) => {
        setCodes(r.codes);
        setGatingActive(r.gatingActive);
      })
      .catch(onError);
  }, [token, onError]);
  useEffect(load, [load]);

  async function generate() {
    setProblem(null);
    setBusy(true);
    try {
      const r = await api<{ codes: Code[] }>("/admin/access-codes", {
        method: "POST",
        token,
        body: {
          count: Number(form.count),
          maxRedemptions: Number(form.maxRedemptions),
          expiresAt: fromLocalInput(form.expiresAt),
          label: form.label || null,
          communityAttribution: form.communityAttribution || null,
        },
      });
      setFresh(r.codes);
      setCopied(false);
      load();
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(c: Code) {
    setProblem(null);
    try {
      await api(`/admin/access-codes/${c.id}/revoke`, { method: "POST", token, body: {} });
      load();
    } catch (e) {
      setProblem(message(e));
    }
  }

  return (
    <div className="settings">
      <section className="panel settings__card settings__card--wide">
        <h2 className="settings__title">Access codes</h2>
        <p className="admin-hint">
          Codes only matter when the access mode needs one ({gatingActive ? "it does right now" : "it doesn't: the campaign is open"}). Only a hash is stored, so a
          code is shown once, right after it's created. A code never counts as proof of NFT ownership.
        </p>
        {fresh.length > 0 && (
          <div className="codes-once" role="status">
            <strong>Copy these now. They won't be shown again.</strong>
            <pre className="mono">{fresh.map((c) => c.code).join("\n")}</pre>
            <button
              className="btn btn--ghost"
              onClick={() => {
                navigator.clipboard?.writeText(fresh.map((c) => c.code).join("\n")).then(() => setCopied(true), () => undefined);
              }}
            >
              {copied ? "Copied" : "Copy all"}
            </button>
          </div>
        )}
        <div className="table-wrap">
          <table className="table table--static">
            <thead>
              <tr>
                <th>Code</th>
                <th>Label</th>
                <th>Community</th>
                <th>Used</th>
                <th>Expires</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {codes?.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.prefix}…</td>
                  <td>{c.label ?? "—"}</td>
                  <td>{c.communityAttribution ?? "—"}</td>
                  <td className="mono">
                    {c.redemptionCount}/{c.maxRedemptions}
                  </td>
                  <td className="mono">{fmt(c.expiresAt)}</td>
                  <td>
                    <span className={`tag tag--${c.state === "active" ? "eligible" : c.state === "revoked" ? "rejected" : "pending"}`}>{c.state.replace("_", " ")}</span>
                  </td>
                  <td>
                    {c.state !== "revoked" && (
                      <button className="link" onClick={() => revoke(c)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {codes && codes.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">
                    No access codes yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel settings__card">
        <h3 className="settings__sub">Generate codes</h3>
        <div className="settings__pair">
          <label>
            <span className="form__label">How many</span>
            <input className="field" type="number" min={1} max={100} value={form.count} onChange={(e) => setForm({ ...form, count: e.target.value })} />
          </label>
          <label>
            <span className="form__label">Uses per code</span>
            <input className="field" type="number" min={1} value={form.maxRedemptions} onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value })} />
          </label>
        </div>
        <label className="form__label">Expires (UTC, optional)</label>
        <input className="field" type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
        <label className="form__label">Label (optional)</label>
        <input className="field" maxLength={80} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        <label className="form__label">Community attribution (optional)</label>
        <input className="field" maxLength={80} value={form.communityAttribution} onChange={(e) => setForm({ ...form, communityAttribution: e.target.value })} />
        <button className="btn btn--primary" onClick={generate} disabled={busy}>
          Generate
        </button>
      </section>
      {problem && (
        <p className="alert settings__card--wide" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- usage

type Usage = {
  x: { provider: string; active: boolean; dailyBudgetUnits: number; totalBudgetUnits: number; usedTodayUnits: number; usedTotalUnits: number; cacheSeconds: number; retryCooldownSeconds: number };
  totals: { provider: string; outcome: string; count: number; estimatedUnits: number; actualUnits: number }[];
  recent: { id: number; provider: string; operation: string; wallet_address_normalized: string | null; estimated_units: number; actual_units: number | null; outcome: string; detail: string | null; created_at: string }[];
};

export function UsagePanel({ token, onError }: { token: string; onError: OnError }) {
  const [u, setU] = useState<Usage | null>(null);
  useEffect(() => {
    api<Usage>("/admin/usage", { token }).then(setU).catch(onError);
  }, [token, onError]);
  if (!u) return <p className="admin-note">Loading usage…</p>;
  return (
    <div className="settings">
      <section className="panel settings__card settings__card--wide">
        <h2 className="settings__title">Paid API usage &amp; budget</h2>
        <p className="admin-hint">
          X provider: <strong>{u.x.provider}</strong> ({u.x.active ? "active" : "not active, so no paid calls can be made"}). Budgets are in provider units and are reserved
          before every billable call. When a budget runs out, new verification requests are refused.
        </p>
        <div className="stats">
          <div className="stat">
            <span className="stat__value">
              {u.x.usedTodayUnits}/{u.x.dailyBudgetUnits}
            </span>
            <span className="stat__label">X units today</span>
          </div>
          <div className="stat">
            <span className="stat__value">
              {u.x.usedTotalUnits}/{u.x.totalBudgetUnits}
            </span>
            <span className="stat__label">X units total</span>
          </div>
          <div className="stat">
            <span className="stat__value">{Math.round(u.x.cacheSeconds / 86400)}d</span>
            <span className="stat__label">Verified result reused</span>
          </div>
          <div className="stat">
            <span className="stat__value">{u.x.retryCooldownSeconds}s</span>
            <span className="stat__label">Retry cooldown</span>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table table--static">
            <thead>
              <tr>
                <th>When (UTC)</th>
                <th>Provider</th>
                <th>Operation</th>
                <th>Wallet</th>
                <th>Units est / actual</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {u.recent.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{fmt(r.created_at)}</td>
                  <td className="mono">{r.provider}</td>
                  <td>{r.operation.replace(/_/g, " ")}</td>
                  <td className="mono">{r.wallet_address_normalized ? shortAddress(r.wallet_address_normalized) : "—"}</td>
                  <td className="mono">
                    {r.estimated_units} / {r.actual_units ?? "—"}
                  </td>
                  <td>
                    {r.outcome}
                    {r.detail ? ` · ${r.detail}` : ""}
                  </td>
                </tr>
              ))}
              {u.recent.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No paid API calls have been made.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
