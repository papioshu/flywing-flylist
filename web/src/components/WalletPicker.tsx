import { useState } from "react";
import { useAccount, useConnect, type Connector } from "wagmi";
import { isUserRejection } from "../lib/session";
import { COINBASE_ICON, FEATURED, isMobile, useRegistryIcons, WALLETCONNECT_ICON, type Featured } from "../lib/wallets";

// Icon-first wallet picker. Each tile is one wallet: no duplicates (EIP-6963 wallets are matched
// to the featured list by rdns, and wagmi already drops a 6963 announcement whose rdns belongs to a
// configured connector, e.g. Coinbase). Picking a wallet only connects it; whatever opened the
// picker decides what happens next.

type Tile =
  | { kind: "connector"; key: string; name: string; icon?: string; connector: Connector }
  | { kind: "get"; key: string; name: string; icon?: string; featured: Featured }
  | { kind: "walletconnect"; key: string; name: string; icon: string; connector: Connector }
  | { kind: "all"; key: string; name: string; icons: string[] };

/** How many installed-but-not-featured wallets show before the rest move under All Wallets. */
const MAX_EXTRA = 3;

export function WalletPicker({ onError, label = "Connect wallet" }: { onError: (msg: string | null) => void; label?: string }) {
  const { connectors, connectAsync, isPending, variables } = useConnect();
  const { connector: active, isConnected } = useAccount();
  const registry = useRegistryIcons();
  const [view, setView] = useState<{ k: "grid" } | { k: "all" } | { k: "get"; featured: Featured; icon?: string }>({ k: "grid" });

  const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected"); // EIP-6963
  const matches = (c: Connector, rdns: string[]) => rdns.includes(c.id) || rdns.includes(String(c.rdns ?? ""));
  const wc = connectors.find((c) => c.type === "walletConnect");
  const mobile = isMobile();

  const featured: Tile[] = FEATURED.map((f) => {
    if (f.key === "coinbase") {
      const c = connectors.find((x) => x.type === "coinbaseWallet");
      if (c) return { kind: "connector", key: f.key, name: f.name, icon: COINBASE_ICON, connector: c };
    }
    const c = announced.find((x) => matches(x, f.rdns));
    if (c) return { kind: "connector", key: f.key, name: f.name, icon: c.icon ?? registry[f.key], connector: c };
    return { kind: "get", key: f.key, name: f.name, icon: registry[f.key], featured: f };
  });
  const others: Tile[] = announced
    .filter((c) => !FEATURED.some((f) => matches(c, f.rdns)))
    .map((c) => ({ kind: "connector", key: c.id, name: c.name, icon: c.icon, connector: c }));
  // A browser wallet that doesn't announce itself over EIP-6963 (older extensions, some in-app browsers).
  const generic = connectors.find((c) => c.id === "injected");
  const legacy: Tile[] =
    !announced.length && generic && typeof window !== "undefined" && "ethereum" in window
      ? [{ kind: "connector", key: "injected", name: "Browser Wallet", connector: generic }]
      : [];
  const wcTile: Tile[] = wc ? [{ kind: "walletconnect", key: "walletconnect", name: "WalletConnect", icon: WALLETCONNECT_ICON, connector: wc }] : [];

  const wallets = [...featured, ...others, ...legacy];
  const overflow = others.length > MAX_EXTRA;
  const allIcons = wallets.flatMap((t) => ("icon" in t && t.icon ? [t.icon] : [])).slice(0, 4);
  const grid: Tile[] = [
    ...featured,
    ...others.slice(0, MAX_EXTRA),
    ...legacy,
    ...wcTile,
    ...(overflow || wc ? [{ kind: "all" as const, key: "all", name: "All Wallets", icons: allIcons }] : []),
  ];

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
    if (t.kind === "all") return setView({ k: "all" });
    // A featured wallet that isn't installed in this browser.
    const f = t.featured;
    if (mobile && f.mobileBrowser) return void (window.location.href = f.mobileBrowser(new URL(window.location.href)));
    if (mobile && wc) return connect(wc);
    setView({ k: "get", featured: f, icon: t.icon });
  }

  const pendingId = isPending ? (variables?.connector as { id?: string } | undefined)?.id : undefined;
  const pendingName = pendingId ? [...wallets, ...wcTile].find((t) => "connector" in t && t.connector.id === pendingId)?.name : undefined;

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
          {t.kind === "all" ? (
            <span className="wtile__stack" aria-hidden>
              {t.icons.map((src, i) => (
                <img key={i} src={src} alt="" width={22} height={22} />
              ))}
            </span>
          ) : t.icon ? (
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
      <p className="picker__label">{view.k === "all" ? "All wallets" : label}</p>
      <ul className="wgrid" role="list">
        {(view.k === "all" ? [...wallets, ...wcTile] : grid).map(render)}
      </ul>
      <p className="picker__status" aria-live="polite">
        {pendingName ? `Opening ${pendingName}… approve the connection in your wallet.` : ""}
      </p>
      {view.k === "all" ? (
        <p className="picker__hint">
          {wc && (
            <>
              <button type="button" className="link" onClick={() => connect(wc)}>
                Browse 500+ mobile wallets (WalletConnect)
              </button>
              {" · "}
            </>
          )}
          <button type="button" className="link" onClick={() => setView({ k: "grid" })}>
            ← Back
          </button>
        </p>
      ) : (
        <p className="picker__hint picker__hint--quiet">Connecting is free. It doesn't sign or send anything.</p>
      )}
    </div>
  );
}
