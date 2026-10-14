import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COLLECTION } from "../web/src/lib/collection";

// The landing page's supply facts must match the canonical Nimbus project config. The check
// runs on the owner's machine (this repo at C:/Projectwork/FlyWingGenesis/mint-site, nimbus-generator at
// C:/Projectwork/nimbus-generator) and is skipped elsewhere.
const NIMBUS = process.env.NIMBUS_PROJECT_JSON ?? "../../nimbus-generator/projects/fly-wing-genesis/project.json";

describe("collection facts", () => {
  it.skipIf(!existsSync(NIMBUS))("match nimbus-generator's FLY WING GENESIS project config", () => {
    const meta = JSON.parse(readFileSync(NIMBUS, "utf8")).meta;
    expect(COLLECTION.supply).toBe(meta.expectedSupply);
    expect(COLLECTION.feathers).toBe(meta.expectedOneOfOneCount);
  });

  it("generated pieces are supply minus feathers", () => {
    expect(COLLECTION.supply - COLLECTION.feathers).toBe(5530);
  });
});
