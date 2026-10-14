// Public collection facts shown on the landing page. Single definition for the site.
// Canonical source: nimbus-generator/projects/fly-wing-genesis/project.json
// (expectedSupply, expectedOneOfOneCount); tests/collection.test.ts checks these against it
// when that repo is present. Launch date confirmed by the owner 2026-10-14 (Mint Site D027).
export const COLLECTION = {
  supply: 5555,
  feathers: 25, // hand-painted 1-of-1s inside the supply
  launchDate: "11.4.26",
} as const;
