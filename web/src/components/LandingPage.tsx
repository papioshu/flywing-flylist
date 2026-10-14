import { useEffect, useState } from "react";
import { api, type Campaign } from "../lib/api";
import { COLLECTION } from "../lib/collection";
import { FlylistApply } from "./FlylistApply";

// The public FLYLIST landing page, art direction from RichFox's FLY WING kit (red / black / white,
// diagonal manga panels). Copy in the manifesto band is the wireframe's hero copy, verbatim.
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
    <div className="site">
      <header className="masthead">
        <a className="masthead__brand" href="/" aria-label="FLY WING home">
          <img src="/brand/fly-wing-mark.svg" alt="" width={34} height={39} />
          <img src="/brand/fly-wing-logo-black.svg" alt="" width={170} height={40} />
        </a>
        <span className={`gate-status ${closed ? "gate-status--closed" : ""}`}>
          FLYLIST{campaign ? (closed ? " · Closed" : " · Open") : ""}
        </span>
      </header>

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <picture>
            <source
              type="image/avif"
              srcSet="/art/landing-768.avif 768w, /art/landing-1280.avif 1280w, /art/landing-1920.avif 1920w"
              sizes="(orientation: portrait) 260vw, 100vw"
            />
            <img
              className="hero__art"
              src="/art/landing-1920.webp"
              srcSet="/art/landing-768.webp 768w, /art/landing-1280.webp 1280w, /art/landing-1920.webp 1920w"
              sizes="(orientation: portrait) 260vw, 100vw"
              width={1920}
              height={1080}
              alt="FLY WING wordmark among red manga clouds"
              fetchPriority="high"
            />
          </picture>
          <div className="hero__overlay">
            <h1 id="hero-title" className="hero__genesis">
              <span className="visually-hidden">FLY WING </span>Genesis
            </h1>
            <p className="hero__credit">by RichFox</p>
            <div className="hero__cta">
              <FlylistApply campaign={campaign} />
            </div>
          </div>
        </section>

        <section className="manifesto" aria-label="FLY WING GENESIS">
          <div className="manifesto__inner">
            <p className="manifesto__copy">
              Wings are given
              <br />
              to those chosen.
              <br />
              Head in the clouds.
              <br />
              Feet on the ground.
            </p>
            <p className="manifesto__tag">Fly sh*t only.</p>
          </div>
          <ul className="chips" aria-label="Collection">
            <li>{COLLECTION.supply.toLocaleString("en-US")} supply</li>
            <li className="chips__accent">{COLLECTION.feathers} feathers</li>
            <li>{COLLECTION.launchDate}</li>
          </ul>
        </section>

        <section className="how" aria-labelledby="how-title">
          <h2 id="how-title" className="how__title">
            <span className="brush">Flylist</span>
          </h2>
          <p className="how__lede">
            {closed
              ? "The FLYLIST is closed. Already applied? Use the button above to check your wallet's status."
              : "Three steps. Free. No gas, no transaction, no token approvals."}
          </p>
          <ol className="steps">
            <li>
              <span className="steps__n" aria-hidden>
                01
              </span>
              <h3>Hold the fare</h3>
              <p>At least $55 worth of ETH on Ethereum or Robinhood Chain. We read the balance once. Nothing moves.</p>
            </li>
            <li>
              <span className="steps__n" aria-hidden>
                02
              </span>
              <h3>Sign once</h3>
              <p>One free message proves you own the wallet. No transaction, no approvals, never your seed phrase.</p>
            </li>
            <li>
              <span className="steps__n" aria-hidden>
                03
              </span>
              <h3>Drop your X</h3>
              <p>Add your X username. It's saved to your wallet, and you can correct it later.</p>
            </li>
          </ol>
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
        <img src="/brand/fly-wing-mark-white.svg" alt="" width={22} height={26} loading="lazy" />
        <span>© {new Date().getFullYear()} FLY WING GENESIS · Art by RichFox</span>
        <a href="#privacy">Privacy</a>
      </footer>
    </div>
  );
}
