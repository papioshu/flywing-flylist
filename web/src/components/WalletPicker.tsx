import { useConnect } from "wagmi";
import { isUserRejection } from "../lib/session";

const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** Lists the wallets wagmi can use. Detected browser wallets (EIP-6963) replace the generic one. */
export function WalletPicker({ onError, label = "Connect Wallet" }: { onError: (msg: string | null) => void; label?: string }) {
  const { connectors, connectAsync, isPending, variables } = useConnect();

  const detected = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
  const hasInjected = typeof window !== "undefined" && "ethereum" in window;
  const list = [
    ...(detected.length ? detected : hasInjected ? connectors.filter((c) => c.id === "injected") : []),
    ...connectors.filter((c) => c.type !== "injected"),
  ];

  async function connect(c: (typeof connectors)[number]) {
    onError(null);
    try {
      await connectAsync({ connector: c });
    } catch (err) {
      onError(isUserRejection(err) ? "Connection cancelled." : "Couldn't connect that wallet. Try another option.");
    }
  }

  const host = window.location.host + window.location.pathname;

  return (
    <div className="picker">
      <p className="picker__label">{label}</p>
      <div className="picker__list">
        {list.map((c) => {
          const pending = isPending && (variables?.connector as { id?: string } | undefined)?.id === c.id;
          const name = c.id === "injected" ? "Browser Wallet" : c.name;
          return (
            <button key={c.uid} className="btn btn--wallet" onClick={() => connect(c)} disabled={isPending}>
              {c.icon ? <img src={c.icon} alt="" width={22} height={22} /> : <span className="btn__dot" aria-hidden />}
              <span>{pending ? "Connecting…" : name}</span>
            </button>
          );
        })}
      </div>
      {!hasInjected && isMobile() && (
        <p className="picker__hint">
          On your phone? Open this page inside your wallet app's browser, e.g.{" "}
          <a href={`https://metamask.app.link/dapp/${host}`}>MetaMask</a> or{" "}
          <a href={`https://link.trustwallet.com/open_url?url=${encodeURIComponent(window.location.href)}`}>Trust Wallet</a>.
        </p>
      )}
    </div>
  );
}
