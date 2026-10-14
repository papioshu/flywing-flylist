import { useEffect, useState } from "react";
import { api, type Campaign } from "../lib/api";
import { FlylistApply } from "./FlylistApply";

// The public FLYLIST landing page, built to RichFox's landing wireframe (2026-10-14): one full-screen
// cloud graphic with the FLY WING wordmark baked in, and a white FLY LIST pill under it. FLY LIST is the
// only wallet entry point (owner: no second connect button).
// The registration terms and privacy notice live in the FLYLIST modal, before any wallet connects.
export function LandingPage() {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  // Public campaign rules only (open/closed). No wallet calls happen until the FLY LIST button is clicked.
  useEffect(() => {
    api<{ campaign: Campaign }>("/campaign")
      .then((r) => setCampaign(r.campaign))
      .catch(() => setCampaign(null));
  }, []);
  return (
    <main className="landing">
      <picture>
        <source
          type="image/avif"
          srcSet="/art/landing-768.avif 768w, /art/landing-1280.avif 1280w, /art/landing-1920.avif 1920w"
          sizes="(max-aspect-ratio: 7/11) 280vw, 100vw"
        />
        <img
          className="landing__art"
          src="/art/landing-1920.webp"
          srcSet="/art/landing-768.webp 768w, /art/landing-1280.webp 1280w, /art/landing-1920.webp 1920w"
          sizes="(max-aspect-ratio: 7/11) 280vw, 100vw"
          width={1920}
          height={1080}
          alt="FLY WING wordmark among red manga clouds"
          fetchPriority="high"
        />
      </picture>
      <h1 className="visually-hidden">FLY WING GENESIS FLYLIST</h1>
      <div className="landing__overlay">
        <FlylistApply campaign={campaign} />
      </div>
      <p className="landing__credit">Art by RichFox</p>
    </main>
  );
}
