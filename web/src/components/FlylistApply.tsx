import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAccount, useDisconnect, useSignMessage, useSwitchChain } from "wagmi";
import { api, ApiError, type Campaign, type Eligibility, type PublicRegistration } from "../lib/api";
import { clearToken, getToken, isUserRejection, parseHandle, shortAddress, signIn } from "../lib/session";
import { FALLBACK_CHAIN_ID, SUPPORTED_CHAIN_IDS } from "../lib/wagmi";
import { Barcode } from "./Barcode";
import { WalletPicker } from "./WalletPicker";

// The FLYLIST flow. Nothing here runs on page load, wallet connect or wallet change:
// the only entry point is the FLY LIST button ("APPLY 4 FLYLIST" in the spec). Order (spec §1):
// connect → sign (nonce SIWE) → server verifies → registration lookup → eligibility → form.
type Step =
  | { k: "connect" }
  | { k: "signature" }
  | { k: "verifying" }
  | { k: "eligibility" }
  | { k: "ready"; wallet: string; eligibility: Eligibility }
  | { k: "submitting"; wallet: string; eligibility: Eligibility }
  | { k: "submitted"; registration: PublicRegistration }
  | { k: "already"; registration: PublicRegistration }
  | { k: "ineligible"; eligibility: Eligibility }
  | { k: "unavailable"; message: string }
  | { k: "failed"; message: string; retry: "flow" | "submit"; wallet?: string; eligibility?: Eligibility }
  | { k: "closed" }
  | { k: "switched"; to: string | null };

export const STATUS_LABEL: Record<string, string> = {
  registered: "Registered",
  pending_verification: "Pending verification",
  eligible: "Eligible",
  ineligible: "Ineligible",
  approved: "Approved",
  rejected: "Not approved",
};

const TITLES: Record<Step["k"], string> = {
  connect: "Connect wallet",
  signature: "Check your wallet",
  verifying: "Verifying",
  eligibility: "Checking eligibility",
  ready: "Boarding pass",
  submitting: "Boarding pass",
  submitted: "You're on the FLYLIST",
  already: "Wallet already registered",
  ineligible: "Not eligible yet",
  unavailable: "Check unavailable",
  failed: "Registration failed",
  closed: "Registration closed",
  switched: "Wallet changed",
};

const BUSY: Step["k"][] = ["signature", "verifying", "eligibility", "submitting"];

export function FlylistApply({ campaign }: { campaign: Campaign | null }) {
  const { address, chainId, status: accountStatus } = useAccount();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>({ k: "connect" });
  // Each flow run gets an id; anything that finishes after a newer run started (or the
  // wallet changed, or the modal closed) is ignored.
  const runRef = useRef(0);
  const flowWallet = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const closed = campaign !== null && !campaign.isOpen;

  const run = useCallback(
    async (addr: `0x${string}`) => {
      const id = ++runRef.current;
      const alive = () => id === runRef.current;
      flowWallet.current = addr.toLowerCase();

      async function session(fresh: boolean): Promise<string> {
        if (fresh) clearToken("register", addr);
        const existing = getToken("register", addr);
        if (existing) return existing;
        let cid = chainId ?? FALLBACK_CHAIN_ID;
        if (!SUPPORTED_CHAIN_IDS.includes(cid)) {
          await switchChainAsync({ chainId: FALLBACK_CHAIN_ID });
          cid = FALLBACK_CHAIN_ID;
        }
        setStep({ k: "signature" });
        return signIn({
          purpose: "register",
          address: addr,
          chainId: cid,
          sign: async (message) => {
            const sig = await signMessageAsync({ message });
            if (alive()) setStep({ k: "verifying" });
            return sig;
          },
        });
      }

      try {
        let token = await session(false);
        if (!alive()) return;
        setStep({ k: "verifying" });
        type Me = { walletAddress: string; campaign: Campaign; registration: PublicRegistration | null };
        let me: Me;
        try {
          me = await api<Me>("/me/registration", { token });
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 401)) throw e;
          token = await session(true); // stored session expired server-side
          if (!alive()) return;
          setStep({ k: "verifying" });
          me = await api<Me>("/me/registration", { token });
        }
        if (!alive()) return;
        // The server's session wallet is the identity; never trust the browser's.
        if (me.walletAddress.toLowerCase() !== addr.toLowerCase()) throw new Error("Session wallet mismatch");
        if (me.registration) return setStep({ k: "already", registration: me.registration });
        if (!me.campaign.isOpen) return setStep({ k: "closed" });

        setStep({ k: "eligibility" });
        const r = await api<{ walletAddress: string; registration: PublicRegistration | null; eligibility: Eligibility | null }>("/me/eligibility", {
          method: "POST",
          token,
          body: {},
        });
        if (!alive()) return;
        if (r.registration) return setStep({ k: "already", registration: r.registration });
        const el = r.eligibility!;
        if (el.result === "eligible") setStep({ k: "ready", wallet: r.walletAddress, eligibility: el });
        else if (el.result === "ineligible") setStep({ k: "ineligible", eligibility: el });
        else setStep({ k: "unavailable", message: "We couldn't read your balance right now. Nothing was charged. Please try again in a minute." });
      } catch (e) {
        if (!alive()) return;
        if (isUserRejection(e)) return setStep({ k: "failed", message: "Signature cancelled. Nothing was sent or charged.", retry: "flow" });
        if (e instanceof ApiError && e.code === "REGISTRATION_CLOSED") return setStep({ k: "closed" });
        setStep({ k: "failed", message: e instanceof ApiError ? e.message : "Something went wrong. Please try again.", retry: "flow" });
      }
    },
    [chainId, signMessageAsync, switchChainAsync],
  );

  function start() {
    setOpen(true);
    if (address) run(address);
    else {
      runRef.current++;
      flowWallet.current = null;
      setStep({ k: "connect" });
    }
  }

  function close() {
    runRef.current++; // abandon anything in flight
    flowWallet.current = null;
    setOpen(false);
  }

  // Wallet connected from inside the modal: continue the flow the visitor started.
  useEffect(() => {
    if (open && step.k === "connect" && address && accountStatus === "connected") run(address);
  }, [open, step.k, address, accountStatus, run]);

  // Wallet switched or disconnected mid-flow: stop, and let the visitor restart for the new wallet.
  useEffect(() => {
    if (!open || step.k === "connect" || step.k === "switched") return;
    const current = address?.toLowerCase() ?? null;
    if (flowWallet.current && current !== flowWallet.current) {
      runRef.current++;
      flowWallet.current = null;
      setStep({ k: "switched", to: address ?? null });
    }
  }, [address, open, step.k]);

  // Modal plumbing: Esc to close (not mid-signature), scroll lock, initial focus.
  const busy = BUSY.includes(step.k);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) close();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, busy]);
  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open, step.k]);

  return (
    <div className="gate">
      {/* Visible label is the wireframe's "FLY LIST"; the hidden prefix gives screen readers the action. */}
      <button type="button" className="btn--apply" onClick={start}>
        <span className="visually-hidden">{closed ? "Check status: " : "Apply 4 "}</span>
        <span className="btn--apply__label">FLY LIST</span>
      </button>
      {closed && <p className="gate__fine">Registration is closed. Tap to check your status.</p>}

      {/* Portal: keeps the modal out of any transformed/filtered ancestor, which would trap position:fixed. */}
      {open &&
        createPortal(
        <div className="modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !busy && close()}>
          <div className="pass pass--modal" role="dialog" aria-modal="true" aria-labelledby="flylist-title" data-step={step.k} ref={dialogRef} tabIndex={-1}>
            <div className="pass__main">
              <header className="pass__head">
                <span className="pass__brand">FLY WING GENESIS · FLYLIST</span>
                <button type="button" className="link modal__close" onClick={close} disabled={busy} aria-label="Close">
                  Close
                </button>
              </header>
              <h2 id="flylist-title" className="pass__title">
                {TITLES[step.k]}
              </h2>
              {(step.k === "submitted" || step.k === "already") && (
                <div className="stamp" aria-hidden>
                  {step.k === "submitted" ? "BOARDED" : "ON THE LIST"}
                </div>
              )}
              <div className="pass__body" aria-live="polite">
                <StepBody
                  step={step}
                  setStep={setStep}
                  address={address}
                  campaign={campaign}
                  restart={start}
                  disconnect={() => {
                    disconnect();
                    runRef.current++;
                    flowWallet.current = null;
                    setStep({ k: "connect" });
                  }}
                />
              </div>
            </div>
            <aside className="pass__stub" aria-hidden>
              <img src="/brand/fly-wing-mark-white.svg" alt="" width={44} height={51} />
              <Barcode className="stub__barcode" value="FLYLIST" />
            </aside>
          </div>
        </div>,
          document.body,
        )}
    </div>
  );
}

function StepBody({
  step,
  setStep,
  address,
  campaign,
  restart,
  disconnect,
}: {
  step: Step;
  setStep: (s: Step) => void;
  address: `0x${string}` | undefined;
  campaign: Campaign | null;
  restart: () => void;
  disconnect: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  switch (step.k) {
    case "connect":
      return (
        <>
          <p className="muted">Wallet connection requested. Pick the wallet you want on the FLYLIST.</p>
          <WalletPicker onError={setError} label="Choose your wallet" />
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          <Terms />
        </>
      );
    case "signature":
      return (
        <div className="waiting">
          <p className="waiting__title">Signature requested</p>
          <p className="muted">Approve the message in your wallet. It's free and only proves you own this wallet.</p>
        </div>
      );
    case "verifying":
      return <p className="muted pulse">Verifying your wallet…</p>;
    case "eligibility":
      return <p className="muted pulse">Checking your ETH balance on Ethereum and Robinhood Chain…</p>;
    case "ready":
    case "submitting":
      return <ApplyForm step={step} setStep={setStep} address={address} />;
    case "submitted":
    case "already":
      return <Registered step={step} campaign={campaign} disconnect={disconnect} />;
    case "ineligible":
      return (
        <div className="done">
          <p>
            FLYLIST applicants need at least <strong>${step.eligibility.minBalanceUsd}</strong> in native ETH on any one of these
            chains. Balances on different chains aren't added together.
          </p>
          <BalanceTable eligibility={step.eligibility} />
          <p className="muted">Nothing was charged. Top up, then apply again.</p>
          <div className="form__row">
            <button type="button" className="btn btn--ghost" onClick={restart}>
              Check again
            </button>
            <button type="button" className="link" onClick={disconnect}>
              Use another wallet
            </button>
          </div>
        </div>
      );
    case "unavailable":
    case "failed":
      return (
        <div className="done">
          <p className="alert" role="alert">
            {step.message}
          </p>
          <div className="form__row">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() =>
                step.k === "failed" && step.retry === "submit" && step.wallet && step.eligibility
                  ? setStep({ k: "ready", wallet: step.wallet, eligibility: step.eligibility })
                  : restart()
              }
            >
              Try again
            </button>
            <button type="button" className="link" onClick={disconnect}>
              Use another wallet
            </button>
          </div>
        </div>
      );
    case "closed":
      return (
        <div className="done">
          <p>FLYLIST registration is closed. This wallet didn't apply while it was open.</p>
          <button type="button" className="link" onClick={disconnect}>
            Check another wallet
          </button>
        </div>
      );
    case "switched":
      return (
        <div className="done">
          <p>
            Your wallet changed{step.to ? ` to ${shortAddress(step.to)}` : ""}. We stopped so nothing is filed under the wrong
            wallet.
          </p>
          <button type="button" className="btn btn--primary" onClick={restart}>
            {step.to ? `Continue with ${shortAddress(step.to)}` : "Connect a wallet"}
          </button>
        </div>
      );
  }
}

function BalanceTable({ eligibility }: { eligibility: Eligibility }) {
  return (
    <>
      <table className="balances">
        <thead>
          <tr>
            <th>Chain</th>
            <th>ETH</th>
            <th>USD</th>
          </tr>
        </thead>
        <tbody>
          {eligibility.chains.map((c) => (
            <tr key={c.chainId}>
              <td>{c.chainName}</td>
              <td className="mono">{c.status === "ok" ? c.balanceEth : "—"}</td>
              <td className="mono">{c.status === "ok" ? `$${c.balanceUsd}` : c.status === "error" ? "unreadable" : "not checked"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="form__fine">
        ETH/USD ${eligibility.ethUsdPrice} via {eligibility.priceSource === "chainlink" ? "Chainlink" : "Coinbase"}, checked{" "}
        {new Date(eligibility.checkedAt).toLocaleTimeString()}.
      </p>
    </>
  );
}

function ApplyForm({
  step,
  setStep,
  address,
}: {
  step: Extract<Step, { k: "ready" | "submitting" }>;
  setStep: (s: Step) => void;
  address: `0x${string}` | undefined;
}) {
  const [handle, setHandle] = useState("");
  const [handleError, setHandleError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inFlight = useRef(false);
  const submitting = step.k === "submitting";

  async function submit() {
    if (inFlight.current) return; // double-click / double-submit guard
    const parsed = parseHandle(handle);
    if (!parsed.ok) return setHandleError(parsed.error);
    if (!address || address.toLowerCase() !== step.wallet.toLowerCase()) return setStep({ k: "switched", to: address ?? null });
    const token = getToken("register", step.wallet);
    if (!token) return setStep({ k: "failed", message: "Your session expired. Please apply again.", retry: "flow" });
    inFlight.current = true;
    setHandleError(null);
    setStep({ k: "submitting", wallet: step.wallet, eligibility: step.eligibility });
    try {
      const r = await api<{ registration: PublicRegistration }>("/me/registration", { method: "POST", token, body: { twitterUsername: parsed.value } });
      setStep({ k: "submitted", registration: r.registration });
    } catch (e) {
      if (e instanceof ApiError && e.code === "ALREADY_REGISTERED" && e.data.registration) setStep({ k: "already", registration: e.data.registration });
      else if (e instanceof ApiError && e.code === "INELIGIBLE" && e.data.eligibility) setStep({ k: "ineligible", eligibility: e.data.eligibility });
      else if (e instanceof ApiError && e.code === "REGISTRATION_CLOSED") setStep({ k: "closed" });
      else if (e instanceof ApiError && e.status === 401) setStep({ k: "failed", message: "Your session expired. Please apply again.", retry: "flow" });
      else
        setStep({
          k: "failed",
          message: e instanceof ApiError ? e.message : "Couldn't submit. Please try again.",
          retry: "submit",
          wallet: step.wallet,
          eligibility: step.eligibility,
        });
    } finally {
      inFlight.current = false;
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(step.wallet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked: the full address is still in the title attribute
    }
  }

  const best = step.eligibility.chains.find((c) => c.passed);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      noValidate
    >
      <p className="eligible-note">
        <span className="tag tag--eligible">Eligible</span> ${best?.balanceUsd} in ETH on {best?.chainName}. Ready to submit.
      </p>
      <div className="flyfields">
        <div>
          <label htmlFor="fl-wallet" className="form__label">
            Wallet address
          </label>
          <div className="input input--locked" title={step.wallet}>
            <input id="fl-wallet" className="mono" value={shortAddress(step.wallet)} readOnly aria-readonly="true" tabIndex={-1} aria-describedby="fl-wallet-hint" />
            <button type="button" className="copy" onClick={copy} aria-label={`Copy wallet address ${step.wallet}`}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p id="fl-wallet-hint" className="form__hint">
            Verified by your signature. Can't be edited.
          </p>
        </div>
        <div>
          <label htmlFor="fl-handle" className="form__label">
            X / Twitter username
          </label>
          <div className={`input ${handleError ? "input--error" : ""}`}>
            <span className="input__at" aria-hidden>
              @
            </span>
            <input
              id="fl-handle"
              name="handle"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={16}
              placeholder="yourhandle"
              value={handle}
              autoFocus
              onChange={(e) => {
                setHandle(e.target.value);
                setHandleError(null);
              }}
              aria-invalid={!!handleError}
              aria-describedby={handleError ? "fl-handle-error" : "fl-handle-hint"}
              disabled={submitting}
            />
          </div>
          {handleError ? (
            <p id="fl-handle-error" className="form__error">
              {handleError}
            </p>
          ) : (
            <p id="fl-handle-hint" className="form__hint">
              Self-reported, not verified. We don't log in to X.
            </p>
          )}
        </div>
      </div>
      <button className="btn btn--primary" type="submit" disabled={submitting}>
        {submitting ? "Submitting…" : "SUBMIT TO FLYLIST"}
      </button>
      <p className="form__fine">Applying doesn't guarantee a mint spot. The team reviews every application.</p>
    </form>
  );
}

function Registered({
  step,
  campaign,
  disconnect,
}: {
  step: Extract<Step, { k: "submitted" | "already" }>;
  campaign: Campaign | null;
  disconnect: () => void;
}) {
  const [registration, setRegistration] = useState(step.registration);
  const [editing, setEditing] = useState(false);
  const [handle, setHandle] = useState(registration.twitterUsername);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    const parsed = parseHandle(handle);
    if (!parsed.ok) return setError(parsed.error);
    const token = getToken("register", registration.walletAddress);
    if (!token) return setError("Your session expired. Close and apply again to change your username.");
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ registration: PublicRegistration }>("/me/registration", { method: "PATCH", token, body: { twitterUsername: parsed.value } });
      setRegistration(r.registration);
      setEditing(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't update. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="done">
      <dl className="pass__fields">
        <div>
          <dt>Passenger</dt>
          <dd className="mono">{shortAddress(registration.walletAddress)}</dd>
        </div>
        <div>
          <dt>Callsign</dt>
          <dd className="mono">@{registration.twitterUsername}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd className="mono">{STATUS_LABEL[registration.registrationStatus] ?? registration.registrationStatus}</dd>
        </div>
      </dl>
      <p>
        {step.k === "submitted" ? "Your application is saved to this wallet." : `Applied ${new Date(registration.registeredAt).toLocaleDateString()}.`} Applying
        doesn't guarantee a mint spot. Watch FLY WING's official channels for approvals.
      </p>
      {editing ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          noValidate
        >
          <label htmlFor="fl-edit" className="form__label">
            Correct your X username
          </label>
          <div className={`input ${error ? "input--error" : ""}`}>
            <span className="input__at" aria-hidden>
              @
            </span>
            <input id="fl-edit" value={handle} maxLength={16} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(e) => setHandle(e.target.value)} disabled={saving} />
          </div>
          {error && <p className="form__error">{error}</p>}
          <div className="form__row">
            <button className="btn btn--ghost" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save username"}
            </button>
            <button type="button" className="link" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="form__row">
          {campaign?.isOpen && (
            <button type="button" className="link" onClick={() => setEditing(true)}>
              Change X username
            </button>
          )}
          <button type="button" className="link" onClick={disconnect}>
            Check another wallet
          </button>
        </div>
      )}
    </div>
  );
}

// Registration terms + privacy notice (moved off the landing page, which is art + button only).
// Shown on the connect step, before any wallet connects or signs.
function Terms() {
  return (
    <details className="terms">
      <summary>Free · no gas · no approvals. What joining means &amp; privacy</summary>
      <p>
        <strong>What joining means.</strong> Applying puts your wallet on the FLYLIST registration list. It does{" "}
        <strong>not</strong> guarantee a mint spot or an NFT. A wallet must hold at least $55 worth of ETH on Ethereum or
        Robinhood Chain; we read the balance once and never move, charge or lock it. The team reviews registrations, and
        approvals and mint details will be announced on FLY WING's official channels. Nobody from FLY WING will ever DM
        you a mint link or ask for your recovery phrase.
      </p>
      <p>
        <strong>Privacy.</strong> We collect your public wallet address, the X username you type in, the network you
        signed on, when you registered, and the ETH balance and ETH/USD price we read when you applied, to run the FLY
        WING GENESIS FLYLIST, review registrations and later build the mint list. Your wallet and X username are linked
        together and visible only to the FLY WING team. We don't publish the list, sell it, or share it. Your signature is
        checked once and not stored. To be removed, contact FLY WING on X.
      </p>
    </details>
  );
}
