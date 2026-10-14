import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAccount, useDisconnect } from "wagmi";
import { shortAddress } from "../lib/session";
import { Barcode } from "./Barcode";
import { WalletPicker } from "./WalletPicker";

// Standalone CONNECT WALLET. It only connects (or disconnects) a wallet: it never starts the
// FLYLIST flow, which begins only from the FLY LIST button.
export function ConnectWallet() {
  const { address, isConnected, connector } = useAccount();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openedConnected = useRef(false);
  const last = useRef(`${address}|${connector?.uid}`);

  // Close once a wallet connects, or the account / wallet app changes, from inside this dialog.
  useEffect(() => {
    const now = `${address}|${connector?.uid}`;
    if (open && isConnected && (!openedConnected.current || now !== last.current)) setOpen(false);
    last.current = now;
  }, [open, isConnected, address, connector?.uid]);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  function show() {
    openedConnected.current = isConnected;
    setError(null);
    setOpen(true);
  }

  return (
    <>
      <button type="button" className={`wconnect${isConnected ? " wconnect--on" : ""}`} onClick={show}>
        {isConnected && address ? (
          <>
            {connector?.icon && <img src={connector.icon} alt="" width={20} height={20} />}
            <span className="mono">{shortAddress(address)}</span>
          </>
        ) : (
          "Connect wallet"
        )}
      </button>
      {open &&
        createPortal(
          <div className="modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
            <div className="pass pass--modal pass--wallet" role="dialog" aria-modal="true" aria-labelledby="wallet-title" ref={dialogRef} tabIndex={-1}>
              <div className="pass__main">
                <header className="pass__head">
                  <span className="pass__brand">FLY WING GENESIS · Wallet</span>
                  <button type="button" className="link modal__close" onClick={() => setOpen(false)} aria-label="Close">
                    Close
                  </button>
                </header>
                <h2 id="wallet-title" className="pass__title">
                  {isConnected ? "Your wallet" : "Connect wallet"}
                </h2>
                <div className="pass__body">
                  {isConnected && address && (
                    <div className="wconnected">
                      <p>
                        Connected{connector ? ` with ${connector.name}` : ""}: <span className="mono">{shortAddress(address)}</span>
                      </p>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => {
                          disconnect();
                          setOpen(false);
                        }}
                      >
                        Disconnect
                      </button>
                    </div>
                  )}
                  <WalletPicker onError={setError} label={isConnected ? "Switch wallet" : "Choose your wallet"} />
                  {error && (
                    <p className="alert" role="alert">
                      {error}
                    </p>
                  )}
                </div>
              </div>
              <aside className="pass__stub" aria-hidden>
                <img src="/brand/fly-wing-mark-white.svg" alt="" width={44} height={51} />
                <Barcode className="stub__barcode" value="FLYWING" />
              </aside>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
