import { useEffect, useState } from "react";
import { api, type Campaign } from "../lib/api";
import { FlylistApply } from "./FlylistApply";

const FLOCK = [
  { src: "/art/fwg-9.webp", alt: "FLY WING bird in a ninja headband against flames" },
  { src: "/art/fwg-0.webp", alt: "FLY WING bird with headphones holding a fireball" },
  { src: "/art/fwg-6.webp", alt: "Pink FLY WING bird with a guitar and a UFO" },
  { src: "/art/fwg-4.webp", alt: "Blue FLY WING bird in a cowboy hat" },
  { src: "/art/fwg-14.webp", alt: "FLY WING bird with a balloon hat holding a coin" },
  { src: "/art/fwg-10.webp", alt: "Red FLY WING bird with a cap and bat" },
];

export function LandingPage() {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  // Public campaign rules only (open/closed). No wallet calls happen until APPLY 4 FLYLIST is clicked.
  useEffect(() => {
    api<{ campaign: Campaign }>("/campaign")
      .then((r) => setCampaign(r.campaign))
      .catch(() => setCampaign(null));
  }, []);
  const closed = campaign !== null && !campaign.isOpen;
  return (
    <div className="page">
      <header className="topbar">
        <a className="wordmark" href="/">
          FLY WING <span>GENESIS</span>
        </a>
        <span className={`pill ${closed ? "pill--dark" : ""}`}>FLYLIST{campaign ? (closed ? " · Gate closed" : " · Gate open") : ""}</span>
      </header>

      <main>
        <section className="hero">
          <div className="hero__copy">
            <p className="kicker">5,555 birds · Departure soon</p>
            <h1 className="hero__title">
              The gate
              <br />
              {closed ? "is closed." : "is open."}
            </h1>
            <p className="hero__lede">
              Apply for the FLY WING GENESIS FLYLIST. Connect, sign one free message, drop your X handle. That's the whole
              flight check.
            </p>
            <ul className="checks">
              <li>Free. No gas.</li>
              <li>No transaction, no token approvals.</li>
              <li>We never ask for your seed phrase.</li>
            </ul>
          </div>

          <div className="hero__art" aria-hidden>
            {FLOCK.slice(0, 3).map((b, i) => (
              <img key={b.src} className={`card card--${i}`} src={b.src} alt="" width={320} height={320} />
            ))}
          </div>
        </section>

        <FlylistApply campaign={campaign} />

        <section className="flock" aria-label="Some of the flock">
          {FLOCK.map((b) => (
            <img key={b.src} src={b.src} alt={b.alt} width={200} height={200} loading="lazy" />
          ))}
        </section>

        <section className="fine">
          <div>
            <h3>What joining means</h3>
            <p>
              Applying puts your wallet on the FLYLIST registration list. It does <strong>not</strong> guarantee a mint spot
              or an NFT. To apply, a wallet must hold at least $55 worth of ETH on Ethereum or Robinhood Chain; we read the
              balance once and never move, charge or lock it. The team reviews registrations, and approvals and mint details will be announced on FLY WING's
              official channels. Nobody from FLY WING will ever DM you a mint link or ask for your recovery phrase.
            </p>
          </div>
          <div id="privacy">
            <h3>Privacy</h3>
            <p>
              <strong>What we collect:</strong> your public wallet address, the X username you type in, the network you
              signed on, when you registered, and the ETH balance and ETH/USD price we read when you applied. <strong>Why:</strong> to run the FLY WING GENESIS FLYLIST, review
              registrations, and later build the mint list. <strong>How it's used:</strong> your wallet and X username are
              linked together and visible only to the FLY WING team. We don't publish the list, sell it, or share it. Your
              signature is checked once and not stored. To be removed, contact FLY WING on X.
            </p>
          </div>
        </section>
      </main>

      <footer className="footer">
        <span>© {new Date().getFullYear()} FLY WING GENESIS</span>
        <a href="#privacy">Privacy</a>
      </footer>
    </div>
  );
}
