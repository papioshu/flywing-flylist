import { useCallback, useEffect, useState } from "react";
import { useAccount, useDisconnect, useSignMessage, useSwitchChain } from "wagmi";
import { api, ApiError, type Campaign, type PublicRegistration } from "../lib/api";
import { clearToken, getToken, isUserRejection, parseHandle, shortAddress, signIn } from "../lib/session";
import { FALLBACK_CHAIN_ID, SUPPORTED_CHAIN_IDS } from "../lib/wagmi";
import { WalletPicker } from "./WalletPicker";

type Phase = "idle" | "signing" | "submitting" | "checking";
type View =
  | "loading"
  | "disconnected"
  | "connecting"
  | "connected"
  | "signing"
  | "submitting"
  | "registered"
  | "already"
  | "closed";

const STATUS_LABEL: Record<string, string> = {
  registered: "Registered",
  approved: "Approved",
  waitlisted: "Waitlisted",
  rejected: "Not approved",
  removed: "Removed",
};

export function BoardingPass({ onCampaign }: { onCampaign?: (c: Campaign) => void } = {}) {
  const { address, chainId, status: accountStatus } = useAccount();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [registration, setRegistration] = useState<PublicRegistration | null>(null);
  const [already, setAlready] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [handle, setHandle] = useState("");
  const [handleError, setHandleError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (campaign) onCampaign?.(campaign);
  }, [campaign, onCampaign]);

  useEffect(() => {
    api<{ campaign: Campaign }>("/campaign")
      .then((r) => setCampaign(r.campaign))
      .catch((e: ApiError) => {
        setError(e.message);
        setCampaign({ id: "", name: "", status: "unknown", opensAt: null, closesAt: null, isOpen: false });
      });
  }, []);

  // Returning visitor in the same tab: reuse the session to show their status without re-signing.
  useEffect(() => {
    setRegistration(null);
    setAlready(false);
    setEditing(false);
    setError(null);
    if (!address) return;
    const token = getToken("register", address);
    if (!token) return;
    setPhase("checking");
    api<{ registration: PublicRegistration | null }>("/me/registration", { token })
      .then((r) => {
        setRegistration(r.registration);
        setAlready(!!r.registration);
      })
      .catch(() => clearToken("register", address))
      .finally(() => setPhase("idle"));
  }, [address]);

  const session = useCallback(
    async (fresh = false): Promise<string> => {
      if (!address) throw new Error("No wallet connected");
      if (fresh) clearToken("register", address);
      const existing = getToken("register", address);
      if (existing) return existing;
      let id = chainId ?? FALLBACK_CHAIN_ID;
      if (!SUPPORTED_CHAIN_IDS.includes(id)) {
        await switchChainAsync({ chainId: FALLBACK_CHAIN_ID });
        id = FALLBACK_CHAIN_ID;
      }
      setPhase("signing");
      return signIn({ purpose: "register", address, chainId: id, sign: (message) => signMessageAsync({ message }) });
    },
    [address, chainId, signMessageAsync, switchChainAsync],
  );

  // Runs fn with a session, re-signing once if the stored session expired server-side.
  async function withSession<T>(fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await session());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return fn(await session(true));
      throw e;
    }
  }

  function explain(e: unknown) {
    if (isUserRejection(e)) return "Signature cancelled. Nothing was sent or charged.";
    if (e instanceof ApiError) return e.message;
    return "Something went wrong. Please try again.";
  }

  async function join() {
    const parsed = parseHandle(handle);
    if (!parsed.ok) {
      setHandleError(parsed.error);
      return;
    }
    setHandleError(null);
    setError(null);
    try {
      const r = await withSession(async (token) => {
        setPhase("submitting");
        return api<{ registration: PublicRegistration }>("/me/registration", {
          method: "POST",
          token,
          body: { twitterUsername: parsed.value },
        });
      });
      setRegistration(r.registration);
      setAlready(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === "ALREADY_REGISTERED") {
        setRegistration(e.data.registration ?? null);
        setAlready(true);
      } else if (e instanceof ApiError && e.code === "REGISTRATION_CLOSED") {
        setCampaign((c) => (c ? { ...c, isOpen: false } : c));
        setError(e.message);
      } else setError(explain(e));
    } finally {
      setPhase("idle");
    }
  }

  async function checkStatus() {
    setError(null);
    try {
      const r = await withSession(async (token) => {
        setPhase("checking");
        return api<{ registration: PublicRegistration | null }>("/me/registration", { token });
      });
      setRegistration(r.registration);
      setAlready(!!r.registration);
      if (!r.registration) setError("This wallet isn't on the allowlist yet.");
    } catch (e) {
      setError(explain(e));
    } finally {
      setPhase("idle");
    }
  }

  async function updateHandle() {
    const parsed = parseHandle(handle);
    if (!parsed.ok) {
      setHandleError(parsed.error);
      return;
    }
    setHandleError(null);
    setError(null);
    try {
      const r = await withSession(async (token) => {
        setPhase("submitting");
        return api<{ registration: PublicRegistration }>("/me/registration", {
          method: "PATCH",
          token,
          body: { twitterUsername: parsed.value },
        });
      });
      setRegistration(r.registration);
      setEditing(false);
    } catch (e) {
      setError(explain(e));
    } finally {
      setPhase("idle");
    }
  }

  const view: View = !campaign
    ? "loading"
    : accountStatus === "connecting" || accountStatus === "reconnecting"
      ? "connecting"
      : !address
        ? "disconnected"
        : phase === "signing"
          ? "signing"
          : phase === "submitting" || phase === "checking"
            ? "submitting"
            : registration && !editing
              ? already
                ? "already"
                : "registered"
              : !campaign.isOpen && !editing
                ? "closed"
                : "connected";

  const busy = phase !== "idle";
  const stamp = view === "registered" ? "BOARDED" : view === "already" ? "ON THE LIST" : view === "closed" ? "GATE CLOSED" : null;

  return (
    <section className="pass" aria-labelledby="pass-title" data-view={view}>
      <div className="pass__main">
        <header className="pass__head">
          <span className="pass__brand">FLY WING GENESIS</span>
          <h2 id="pass-title" className="pass__title">
            Boarding Pass
          </h2>
        </header>

        <dl className="pass__fields">
          <div>
            <dt>Passenger</dt>
            <dd className="mono">{address ? shortAddress(address) : "— — —"}</dd>
          </div>
          <div>
            <dt>Callsign</dt>
            <dd className="mono">{registration && !editing ? `@${registration.twitterUsername}` : handle ? `@${handle.replace(/^@/, "")}` : "— — —"}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd className="mono">{registration ? STATUS_LABEL[registration.registrationStatus] ?? registration.registrationStatus : campaign?.isOpen === false ? "Closed" : "Not boarded"}</dd>
          </div>
        </dl>

        {stamp && (
          <div className={`stamp stamp--${view}`} aria-hidden>
            {stamp}
          </div>
        )}

        <div className="pass__body" aria-live="polite">
          {view === "loading" && <p className="muted">Checking the gate…</p>}

          {view === "disconnected" && (
            <>
              {campaign && !campaign.isOpen && (
                <p className="notice">Registration is closed. Already joined? Connect to check your status.</p>
              )}
              <WalletPicker onError={setError} />
            </>
          )}

          {view === "connecting" && <p className="muted pulse">Waiting for your wallet…</p>}

          {view === "connected" && (
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                if (editing) updateHandle();
                else join();
              }}
              noValidate
            >
              <label htmlFor="handle" className="form__label">
                X / Twitter Username
              </label>
              <div className={`input ${handleError ? "input--error" : ""}`}>
                <span className="input__at" aria-hidden>
                  @
                </span>
                <input
                  id="handle"
                  name="handle"
                  inputMode="text"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={16}
                  placeholder="yourhandle"
                  value={handle}
                  onChange={(e) => {
                    setHandle(e.target.value);
                    setHandleError(null);
                  }}
                  aria-invalid={!!handleError}
                  aria-describedby={handleError ? "handle-error" : "handle-hint"}
                  disabled={busy}
                />
              </div>
              {handleError ? (
                <p id="handle-error" className="form__error">
                  {handleError}
                </p>
              ) : (
                <p id="handle-hint" className="form__hint">
                  Self-reported. We don't log in to X or verify the account.
                </p>
              )}
              <button className="btn btn--primary" type="submit" disabled={busy}>
                {editing ? "Update Username" : "Join Allowlist"}
              </button>
              <p className="form__fine">
                You'll sign a free message to prove you own this wallet. No gas, no transaction, no token approvals.
              </p>
              <div className="form__row">
                {editing ? (
                  <button type="button" className="link" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                ) : (
                  <button type="button" className="link" onClick={checkStatus} disabled={busy}>
                    Already joined? Check status
                  </button>
                )}
                <button type="button" className="link" onClick={() => disconnect()}>
                  Switch wallet
                </button>
              </div>
            </form>
          )}

          {view === "signing" && (
            <div className="waiting">
              <p className="waiting__title">Check your wallet</p>
              <p className="muted">Approve the signature request. It's free and only proves you own this wallet.</p>
            </div>
          )}

          {view === "submitting" && (
            <p className="muted pulse">{phase === "checking" ? "Checking your pass…" : "Stamping your pass…"}</p>
          )}

          {(view === "registered" || view === "already") && registration && (
            <div className="done">
              <p className="done__title">{view === "registered" ? "You're on the list." : "Wallet Already Registered"}</p>
              <p>
                {view === "registered"
                  ? "Your registration is saved. "
                  : `Registered ${new Date(registration.registeredAt).toLocaleDateString()}. `}
                Status: <strong>{STATUS_LABEL[registration.registrationStatus] ?? registration.registrationStatus}</strong>.
              </p>
              <p className="muted">
                Registering doesn't guarantee a mint spot. Watch FLY WING's official channels for approvals and mint details.
              </p>
              <div className="form__row">
                {campaign?.isOpen && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      setHandle(registration.twitterUsername);
                      setEditing(true);
                    }}
                  >
                    Change X username
                  </button>
                )}
                <button type="button" className="link" onClick={() => disconnect()}>
                  Disconnect
                </button>
              </div>
            </div>
          )}

          {view === "closed" && (
            <div className="done">
              <p className="done__title">Registration is closed.</p>
              <p className="muted">If you joined earlier, check your status below.</p>
              <div className="form__row">
                <button type="button" className="btn btn--ghost" onClick={checkStatus} disabled={busy}>
                  Check my status
                </button>
                <button type="button" className="link" onClick={() => disconnect()}>
                  Disconnect
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>

      <aside className="pass__stub" aria-hidden>
        <div>
          <span className="stub__label">Gate</span>
          <span className="stub__value">AL</span>
        </div>
        <div>
          <span className="stub__label">Flock</span>
          <span className="stub__value">5,555</span>
        </div>
        <div className="barcode" />
      </aside>
    </section>
  );
}
