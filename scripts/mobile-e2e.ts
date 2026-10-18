// Phone layout + flow check for the FLYLIST page on both platforms: iPhones in WebKit (Safari's engine) and
// Android phones in Chromium (Chrome's engine), small to large, portrait plus one landscape. For each phone it walks
// landing → wallet picker → eligible form → submitted, plus already-registered and not-eligible, and checks:
//   - no horizontal scroll, and the key blocks are centred (left and right gaps within 2px: "symmetrical");
//   - every button/tile is at least 44px tall (Apple's minimum tap size; Android's is 48dp, so it also prints those
//     under 48 as notes);
//   - text inputs use ≥16px type, so iOS Safari doesn't zoom the page when the field is focused;
//   - the dialog fits the screen, and SUBMIT is reachable;
//   - no page errors.
// Screenshots go to OUT_DIR/<device>-<step>.png. Emulation is not a real device: it doesn't cover wallet-app
// deep links or the in-app browsers, which still need a real-phone pass.
//
//   WEB_URL=http://localhost:5174 FAKE_URL=http://127.0.0.1:8791 npm run -s e2e:mobile
import { mkdirSync } from "node:fs";
import { chromium, devices, webkit, type Browser, type BrowserContextOptions, type Page } from "playwright";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const FAKE = process.env.FAKE_URL ?? "http://127.0.0.1:8788";
const OUT = process.env.OUT_DIR ?? ".data/mobile-e2e";
mkdirSync(OUT, { recursive: true });

const ALL_PHONES: { name: string; engine: "webkit" | "chromium"; device: BrowserContextOptions }[] = [
  { name: "iphone-se", engine: "webkit", device: devices["iPhone SE"] },
  { name: "iphone-13", engine: "webkit", device: devices["iPhone 13"] },
  { name: "iphone-15-pro-max", engine: "webkit", device: devices["iPhone 15 Pro Max"] },
  { name: "iphone-13-landscape", engine: "webkit", device: devices["iPhone 13 landscape"] },
  { name: "galaxy-s9plus", engine: "chromium", device: devices["Galaxy S9+"] },
  { name: "pixel-7", engine: "chromium", device: devices["Pixel 7"] },
  { name: "galaxy-s24", engine: "chromium", device: devices["Galaxy S24"] },
  { name: "pixel-7-landscape", engine: "chromium", device: devices["Pixel 7 landscape"] },
];
// ONLY=iphone-se,pixel-7 runs a subset.
const PHONES = process.env.ONLY ? ALL_PHONES.filter((p) => process.env.ONLY!.split(",").includes(p.name)) : ALL_PHONES;

let failures = 0;
const notes: string[] = [];
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

async function fake(path: string, body: unknown) {
  const r = await fetch(`${FAKE}${path}`, { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`fake chain ${path}: ${await r.text()}`);
}

// Same injected test wallet as scripts/ui-e2e.ts: a window.ethereum that reports MetaMask and signs with a viem key,
// i.e. what a phone user sees inside MetaMask's in-app browser.
async function walletPage(browser: Browser, key: `0x${string}`, device: BrowserContextOptions) {
  const account = privateKeyToAccount(key);
  const context = await browser.newContext(device);
  await context.addInitScript({ content: "window.__name = (f) => f;" });
  await context.exposeBinding("__testSign", async (_src, _address: string, message: string) => account.signMessage({ message }));
  await context.addInitScript(
    ({ address }) => {
      const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
      let chainId = "0x1";
      (window as any).ethereum = {
        isMetaMask: true,
        request: async ({ method, params }: { method: string; params?: any[] }) => {
          switch (method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return [address];
            case "eth_chainId":
              return chainId;
            case "net_version":
              return String(parseInt(chainId, 16));
            case "wallet_switchEthereumChain":
              chainId = params![0].chainId;
              listeners.chainChanged?.forEach((l) => l(chainId));
              return null;
            case "wallet_requestPermissions":
            case "wallet_revokePermissions":
              return [{ parentCapability: "eth_accounts" }];
            case "personal_sign": {
              const hex: string = params![0];
              const bytes = new Uint8Array(hex.slice(2).match(/../g)!.map((b) => parseInt(b, 16)));
              return (window as any).__testSign(params![1], new TextDecoder().decode(bytes));
            }
            default:
              throw Object.assign(new Error(`Unsupported method ${method}`), { code: 4200 });
          }
        },
        on: (e: string, l: (...a: unknown[]) => void) => (listeners[e] ??= []).push(l),
        removeListener: (e: string, l: (...a: unknown[]) => void) => {
          listeners[e] = (listeners[e] ?? []).filter((x) => x !== l);
        },
      };
    },
    { address: account.address },
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { page, context, account, errors };
}

/** Layout facts for the current screen, measured in the page. */
function measure(page: Page, selectors: string[]) {
  return page.evaluate((sels) => {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    // Landscape phones get the desktop boarding-pass layout (stub on the right, content left-aligned like desktop),
    // so only the dialog itself is expected to be centred there.
    const stub = document.querySelector(".pass__stub");
    const desktopLayout = !!stub && getComputedStyle(stub).display !== "none";
    const centred = sels.filter((s) => !desktopLayout || s === ".pass--modal" || s === ".btn--apply").flatMap((s) => {
      const el = document.querySelector(s);
      if (!el) return [];
      const r = el.getBoundingClientRect();
      return [{ s, left: Math.round(r.left), right: Math.round(vw - r.right), width: Math.round(r.width), height: Math.round(r.height) }];
    });
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    // With the dialog open, only its controls are reachable, so only those are measured.
    const scope = document.querySelector(".modal") ?? document;
    const targets = [...scope.querySelectorAll("button, a[href], input:not([type=hidden]), [role=button]")]
      .filter(visible)
      .filter((el) => !el.classList.contains("visually-hidden") && !el.closest(".visually-hidden"))
      .map((el) => {
        const r = el.getBoundingClientRect();
        const label = ((el as HTMLElement).innerText || el.getAttribute("aria-label") || el.tagName).trim().split("\n")[0].slice(0, 40);
        // Inline text links inside a sentence are exempt (WCAG 2.5.8 inline exception).
        const inline = el.tagName === "A" && getComputedStyle(el).display === "inline";
        return { label, h: Math.round(r.height), w: Math.round(r.width), inline };
      });
    const inputs = [...document.querySelectorAll("input:not([type=hidden]), textarea, select")]
      .filter(visible)
      .map((el) => ({ name: el.getAttribute("aria-label") || (el as HTMLInputElement).name || el.id, size: parseFloat(getComputedStyle(el).fontSize) }));
    // The dialog panel clips its overflow (clip-path), so content wider than the panel is cut off rather than
    // scrolling the page. List any visible element that pokes past the panel's right edge.
    const panel = document.querySelector(".pass__main");
    const pr = panel?.getBoundingClientRect();
    const clipped = !pr
      ? []
      : [...panel!.querySelectorAll("*")]
          .filter(visible)
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.right > pr.right + 1)
          .map(({ el, r }) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} +${Math.round(r.right - pr.right)}px`);
    return { vw, vh, overflow: document.documentElement.scrollWidth > vw + 1, centred, targets, inputs, clipped };
  }, selectors);
}

async function audit(phone: string, step: string, page: Page, selectors: string[]) {
  await page.waitForTimeout(350); // let entrance transitions settle
  await page.screenshot({ path: `${OUT}/${phone}-${step}.png` });
  const m = await measure(page, selectors);
  check(`${phone} ${step}: no horizontal scroll`, !m.overflow);
  check(`${phone} ${step}: nothing cut off at the panel's right edge`, m.clipped.length === 0, m.clipped.slice(0, 6).join(", "));
  for (const c of m.centred) {
    check(`${phone} ${step}: ${c.s} centred`, Math.abs(c.left - c.right) <= 2, `left ${c.left}px, right ${c.right}px`);
    check(`${phone} ${step}: ${c.s} fits the width`, c.left >= 0 && c.right >= 0, `left ${c.left}px, right ${c.right}px`);
  }
  for (const t of m.targets.filter((t) => !t.inline)) {
    check(`${phone} ${step}: tap target "${t.label}" ≥ 44px`, t.h >= 44, `${t.w}×${t.h}`);
    if (t.h < 48) notes.push(`${phone} ${step}: "${t.label}" is ${t.h}px tall (Android guideline 48dp)`);
  }
  for (const i of m.inputs) check(`${phone} ${step}: input "${i.name}" ≥ 16px (no iOS zoom)`, i.size >= 16, `${i.size}px`);
}

const apply = (page: Page) => page.getByRole("button", { name: /apply 4 fly list/i });
const MODAL = [".pass--modal"];

const browsers = { webkit: await webkit.launch(), chromium: await chromium.launch() };
try {
  for (const phone of PHONES) {
    const browser = browsers[phone.engine];
    console.log(`\n--- ${phone.name} (${phone.engine}, ${phone.device.viewport?.width}×${phone.device.viewport?.height}) ---`);

    // Eligible wallet: landing → picker → form → submitted.
    const w = await walletPage(browser, generatePrivateKey(), phone.device);
    await w.page.goto(WEB);
    await apply(w.page).waitFor();
    await audit(phone.name, "1-landing", w.page, [".btn--apply"]);
    await apply(w.page).tap();
    await w.page.getByRole("button", { name: "MetaMask", exact: true }).waitFor();
    await audit(phone.name, "2-picker", w.page, [...MODAL, ".wgrid"]);
    check(`${phone.name}: picker shows exactly the 4 wallets`, (await w.page.locator(".wgrid > li").count()) === 4);
    await w.page.getByRole("button", { name: "MetaMask", exact: true }).tap();
    const handle = w.page.getByLabel("X / Twitter username");
    await handle.waitFor({ timeout: 20_000 });
    await audit(phone.name, "3-form", w.page, MODAL);
    await handle.tap();
    await handle.fill(`m${Date.now().toString(36)}`);
    const submit = w.page.getByRole("button", { name: "SUBMIT TO FLYLIST" });
    await submit.scrollIntoViewIfNeeded();
    check(`${phone.name}: SUBMIT reachable on screen`, await submit.isVisible());
    await submit.tap();
    await w.page.getByText("You're on the FLYLIST").waitFor({ timeout: 20_000 });
    await audit(phone.name, "4-submitted", w.page, [...MODAL, ".stamp"]);
    check(`${phone.name}: no page errors (register)`, w.errors.length === 0, w.errors.join(" | "));

    // Same wallet again: already registered.
    await w.page.goto(WEB);
    await apply(w.page).tap();
    await w.page.getByRole("button", { name: "MetaMask", exact: true }).tap().catch(() => {});
    await w.page.getByText("Wallet already registered").waitFor({ timeout: 20_000 });
    await audit(phone.name, "5-already", w.page, [...MODAL, ".stamp"]);
    await w.context.close();

    // Under $55: not eligible.
    const poorKey = generatePrivateKey();
    await fake("/balance", { wallet: privateKeyToAccount(poorKey).address, chainId: 1, wei: "10000000000000000" });
    const p = await walletPage(browser, poorKey, phone.device);
    await p.page.goto(WEB);
    await apply(p.page).tap();
    await p.page.getByRole("button", { name: "MetaMask", exact: true }).tap();
    await p.page.getByText("Not eligible", { exact: true }).waitFor({ timeout: 20_000 });
    await audit(phone.name, "6-not-eligible", p.page, MODAL);
    check(`${phone.name}: no page errors (not eligible)`, p.errors.length === 0, p.errors.join(" | "));
    await p.context.close();
  }
} finally {
  await browsers.webkit.close();
  await browsers.chromium.close();
}

if (notes.length) console.log(`\nNotes (not failures):\n  ${[...new Set(notes)].join("\n  ")}`);
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
