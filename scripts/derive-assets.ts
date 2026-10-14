// Regenerates the web copies of RichFox's art from the archival originals in assets-src/richfox/.
// The originals are never modified. Run: npx tsx scripts/derive-assets.ts
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const SRC = "assets-src/richfox";
const OUT = "web/public";
mkdirSync(`${OUT}/art`, { recursive: true });
mkdirSync(`${OUT}/brand`, { recursive: true });

// Landing hero (1920×1080 RGBA, opaque in practice). Widths match the srcset in LandingPage.tsx.
const landing = `${SRC}/LandingPage Graphic.png`;
for (const w of [768, 1280, 1920]) {
  await sharp(landing).resize({ width: w }).avif({ quality: 55 }).toFile(`${OUT}/art/landing-${w}.avif`);
  await sharp(landing).resize({ width: w }).webp({ quality: 78 }).toFile(`${OUT}/art/landing-${w}.webp`);
}

// Social card: 1200×630 centred crop that keeps the FLY WING wordmark.
await sharp(landing).resize({ width: 1200, height: 630, fit: "cover", position: "centre" }).jpeg({ quality: 82, mozjpeg: true }).toFile(`${OUT}/art/og.jpg`);

// Logos: RichFox's SVGs copied as-is (paths + a <style> block only, no scripts or external refs).
// The wireframe shows the header wordmark in black; same paths, fill swapped.
const logo = readFileSync(`${SRC}/Header Text Logo.svg`, "utf8");
writeFileSync(`${OUT}/brand/fly-wing-logo-black.svg`, logo.replace(/fill:\s*#872e2c/i, "fill: #0d0d0d"));
const mark = readFileSync(`${SRC}/Home Button Top Left.svg`, "utf8");
writeFileSync(`${OUT}/brand/fly-wing-mark.svg`, mark);
writeFileSync(`${OUT}/brand/fly-wing-mark-white.svg`, mark.replace(/fill:\s*#872e2c/i, "fill: #ffffff"));

// Cursor: RichFox's feather path in the owner's cursor colour #ffea77 (same file as the website),
// thin dark outline so it stays visible on the white modal. Explicit 32px size.
writeFileSync(
  `${OUT}/brand/cursor.svg`,
  readFileSync(`${SRC}/cursor.svg`, "utf8")
    .replace('viewBox="0 0 32 32"', 'width="32" height="32" viewBox="0 0 32 32"')
    .replace("<path ", '<path fill="#ffea77" stroke="#0d0d0d" stroke-width="0.8" stroke-linejoin="round" '),
);

// Fonts: ChasingClouds (owner-cleared for web use, D028) is served as the original TTF plus a
// WOFF made with fontTools:  python -c "from fontTools.ttLib import TTFont; f=TTFont('assets-src/richfox/ChasingClouds-Regular.ttf'); f.flavor='woff'; f.save('web/public/fonts/chasing-clouds.woff')"
mkdirSync(`${OUT}/fonts`, { recursive: true });
copyFileSync(`${SRC}/ChasingClouds-Regular.ttf`, `${OUT}/fonts/chasing-clouds.ttf`);

// Favicon from the bird mark on white.
await sharp(Buffer.from(mark), { density: 600 })
  .resize({ width: 150, height: 150, fit: "contain", background: "#ffffff" })
  .extend({ top: 15, bottom: 15, left: 15, right: 15, background: "#ffffff" })
  .png()
  .toFile(`${OUT}/favicon.png`);

console.log("derived assets written");
