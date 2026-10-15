import { useState } from "react";
import { useAccount, useConnect, type Connector } from "wagmi";
import { isUserRejection } from "../lib/session";
import { FEATURED, isMobile, WALLETCONNECT_ICON, type Featured } from "../lib/wallets";

// Icon-first wallet picker: exactly the three featured wallets plus WalletConnect (owner call; no
// "All Wallets", no extra installed wallets). EIP-6963 wallets are matched to the featured list by
// rdns. Picking a wallet only connects it; whatever opened the picker decides what happens next.

type Tile =
  | { kind: "connector"; key: string; name: string; icon?: string; connector: Connector }
  | { kind: "get"; key: string; name: string; icon?: string; featured: Featured }
  | { kind: "walletconnect"; key: string; name: string; icon: string; connector: Connector };

export function WalletPicker({ onError, label = "Connect wallet" }: { onError: (msg: string | null) => void; label?: string }) {
  const { connectors, connectAsync, isPending, variables } = useConnect();
  const { connector: active, isConnected } = useAccount();
  const [view, setView] = useState<{ k: "grid" } | { k: "get"; featured: Featured; icon?: string }>({ k: "grid" });

  const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected"); // EIP-6963
  const matches = (c: Connector, rdns: string[]) => rdns.includes(c.id) || rdns.includes(String(c.rdns ?? ""));
  const wc = connectors.find((c) => c.type === "walletConnect");
  const mobile = isMobile();

  const featured: Tile[] = FEATURED.map((f) => {
    if (f.key === "coinbase") {
      const c = connectors.find((x) => x.type === "coinbaseWallet");
      if (c) return { kind: "connector", key: f.key, name: f.name, icon: f.symbol, connector: c };
    }
    const c = announced.find((x) => matches(x, f.rdns));
    if (c) return { kind: "connector", key: f.key, name: f.name, icon: f.symbol, connector: c };
    return { kind: "get", key: f.key, name: f.name, icon: f.symbol, featured: f };
  });
  const wcTile: Tile[] = wc ? [{ kind: "walletconnect", key: "walletconnect", name: "WalletConnect", icon: WALLETCONNECT_ICON, connector: wc }] : [];
  const grid: Tile[] = [...featured, ...wcTile];

  async function connect(c: Connector) {
    onError(null);
    try {
      await connectAsync({ connector: c });
    } catch (err) {
      onError(isUserRejection(err) ? "Connection cancelled." : "Couldn't connect that wallet. Try another option.");
    }
  }

  function pick(t: Tile) {
    if (t.kind === "connector" || t.kind === "walletconnect") return connect(t.connector);
    // A featured wallet that isn't installed in this browser.
    const f = t.featured;
    if (mobile && f.mobileBrowser) return void (window.location.href = f.mobileBrowser(new URL(window.location.href)));
    if (mobile && wc) return connect(wc);
    setView({ k: "get", featured: f, icon: t.icon });
  }

  const pendingId = isPending ? (variables?.connector as { id?: string } | undefined)?.id : undefined;
  const pendingName = pendingId ? grid.find((t) => "connector" in t && t.connector.id === pendingId)?.name : undefined;

  function render(t: Tile) {
    const connector = t.kind === "connector" || t.kind === "walletconnect" ? t.connector : null;
    const pending = !!connector && pendingId === connector.id;
    const current = !!connector && isConnected && active?.id === connector.id;
    const status = t.kind === "get" ? " (not installed)" : current ? " (connected)" : "";
    return (
      <li key={t.key}>
        <button
          type="button"
          className={`wtile${pending ? " wtile--pending" : ""}${current ? " wtile--current" : ""}${t.kind === "get" ? " wtile--get" : ""}`}
          data-name={`${t.name}${t.kind === "get" ? " · not installed" : current ? " · connected" : ""}`}
          aria-label={pending ? `Connecting ${t.name}` : `${t.name}${status}`}
          aria-busy={pending || undefined}
          disabled={isPending && !pending}
          onClick={() => pick(t)}
        >
          {t.icon ? (
            <img className="wtile__icon" src={t.icon} alt="" width={52} height={52} />
          ) : (
            <span className="wtile__word" aria-hidden>
              {t.name}
            </span>
          )}
          {current && <span className="wtile__on" aria-hidden />}
        </button>
      </li>
    );
  }

  if (view.k === "get") {
    const f = view.featured;
    return (
      <div className="picker">
        <div className="picker__get">
          {view.icon && <img src={view.icon} alt="" width={64} height={64} />}
          <p>
            <strong>{f.name}</strong> isn't installed in this browser.
          </p>
          <div className="form__row">
            {f.install && (
              <a className="btn" href={f.install} target="_blank" rel="noopener noreferrer">
                Get {f.name}
              </a>
            )}
            {wc && (
              <button type="button" className="btn" onClick={() => connect(wc)}>
                Use {f.name} on your phone
              </button>
            )}
          </div>
          <button type="button" className="link" onClick={() => setView({ k: "grid" })}>
            ← All options
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="picker">
      <p className="picker__label">{label}</p>
      <ul className="wgrid" role="list">
        {grid.map(render)}
      </ul>
      <p className="picker__status" aria-live="polite">
        {pendingName ? `Opening ${pendingName}… approve the connection in your wallet.` : ""}
      </p>
      <p className="picker__hint picker__hint--quiet">Connecting is free. It doesn't sign or send anything.</p>
    </div>
  );
}
