// Browser test of the icon-first wallet picker inside the FLYLIST flow (FLY LIST is the only entry point).
// Several test wallets announce themselves over EIP-6963 (MetaMask, Rabby, Phantom rdns) and sign
// with throwaway viem keys. Test-only icons are plain coloured squares: they stand in for the icon
// each real wallet announces about itself and are never shipped.
//
// Needs the dev API with the fake chain (every wallet holds 1 ETH) and a web server pointed at it:
//   WEB_URL=http://localhost:5174 npx tsx scripts/wallet-e2e.ts
import { mkdirSync } from "node:fs";
import { chromium, devices, type Browser, type BrowserContextOptions, type Page } from "playwright";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const WEB = process.env.WEB_URL ?? "http://localhost:5174";
const OUT = process.env.OUT_DIR ?? ".data/wallet-e2e";
mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
}

type MockWallet = { name: string; rdns: string; color: string };
const METAMASK: MockWallet = { name: "MetaMask", rdns: "io.metamask", color: "#f6851b" };
const RABBY: MockWallet = { name: "Rabby Wallet", rdns: "io.rabby", color: "#7084ff" };
const PHANTOM: MockWallet = { name: "Phantom", rdns: "app.phantom", color: "#ab9ff2" };

async function open(browser: Browser, keys: `0x${string}`[], wallets: MockWallet[], opts: BrowserContextOptions = {}) {
  const accounts = keys.map((k) => privateKeyToAccount(k));
  const context = await browser.newContext(opts);
  await context.addInitScript({ content: "window.__name = (f) => f;" });
  await context.exposeBinding("__testSign", async (_s, address: string, message: string) => {
    const a = accounts.find((x) => x.address.toLowerCase() === address.toLowerCase());
    if (!a) throw new Error("unknown test account");
    return a.signMessage({ message });
  });
  await context.addInitScript(
    ({ addresses, wallets }) => {
      const calls: string[] = ((window as any).__walletCalls = []);
      const providers: Record<string, any> = {};
      for (const w of wallets) {
        const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
        let chainId = "0x1";
        let current = addresses[0];
        let connected = false;
        const provider = {
          request: async ({ method, params }: { method: string; params?: any[] }) => {
            calls.push(`${w.rdns}:${method}`);
            switch (method) {
              case "eth_requestAccounts":
                connected = true;
                return [current];
              case "eth_accounts":
                return connected ? [current] : [];
              case "eth_chainId":
                return chainId;
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
          __switch: (i: number) => {
            current = addresses[i];
            listeners.accountsChanged?.forEach((l) => l([current]));
          },
        };
        providers[w.rdns] = provider;
        const icon = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="6" fill="${w.color}"/></svg>`)}`;
        const detail = Object.freeze({ info: { uuid: crypto.randomUUID(), name: w.name, icon, rdns: w.rdns }, provider });
        const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
        window.addEventListener("eip6963:requestProvider", announce);
        announce();
      }
      (window as any).__providers = providers;
      if (wallets.length) (window as any).ethereum = providers[wallets[0].rdns];
    },
    { addresses: accounts.map((a) => a.address), wallets },
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { page, context, accounts, errors };
}

const calls = (p: Page) => p.evaluate(() => (window as any).__walletCalls as string[]);
const tileNames = (p: Page) => p.locator(".wtile").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
const flylist = (p: Page) => p.getByRole("button", { name: /apply 4 fly list/i });

const browser = await chromium.launch();
try {
  const keyA = generatePrivateKey();
  const keyB = generatePrivateKey();

  // ---------- desktop: three installed wallets ----------
  const d = await open(browser, [keyA, keyB], [METAMASK, RABBY, PHANTOM], { viewport: { width: 1366, height: 900 } });
  await d.page.goto(WEB);
  await flylist(d.page).waitFor();
  await d.page.waitForTimeout(800);
  check("load: no wallet requests", !(await calls(d.page)).some((c) => c.endsWith("eth_requestAccounts")));

  await flylist(d.page).click();
  await d.page.locator(".wgrid").waitFor();
  const names = await tileNames(d.page);
  console.log("      tiles:", names.join(" | "));
  check("grid: MetaMask, Coinbase Wallet, Rabby first", names.slice(0, 3).join("|") === "MetaMask|Coinbase Wallet|Rabby");
  check("grid: Phantom (other EIP-6963 wallet) shown", names.includes("Phantom"));
  check("grid: no duplicate wallets", new Set(names).size === names.length);
  check("grid: no generic Browser Wallet when wallets announce", !names.some((n) => /Browser Wallet/.test(n)));
  check("grid: MetaMask uses the fox symbol from MetaMask's pack", (await d.page.getByRole("button", { name: "MetaMask" }).locator("img").getAttribute("src")) === "/wallets/metamask-fox.svg");
  check("grid: Rabby uses the rabbit symbol from Rabby's pack", (await d.page.getByRole("button", { name: "Rabby" }).locator("img").getAttribute("src")) === "/wallets/rabby-symbol.svg");
  check("grid: other installed wallet (Phantom) uses its announced icon", (await d.page.getByRole("button", { name: "Phantom" }).locator("img").getAttribute("src"))!.includes("ab9ff2"));
  const loaded = await d.page.locator(".wgrid img").evaluateAll((imgs) => imgs.every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0));
  check("grid: every logo loaded", loaded);
  check("grid: Coinbase Wallet uses Coinbase SDK logo", (await d.page.getByRole("button", { name: "Coinbase Wallet" }).locator("img").getAttribute("src"))!.includes("0052FF"));
  await d.page.locator(".pass--modal").screenshot({ path: `${OUT}/01-desktop-grid.png` });

  // tooltip on hover
  await d.page.getByRole("button", { name: "Rabby" }).hover();
  await d.page.waitForTimeout(200);
  const tip = await d.page.getByRole("button", { name: "Rabby" }).evaluate((el) => {
    const s = getComputedStyle(el, "::after");
    return { text: s.content, opacity: s.opacity };
  });
  check(`tooltip: name on hover (${tip.text}, opacity ${tip.opacity})`, tip.text.includes("Rabby") && tip.opacity === "1");
  await d.page.locator(".pass--modal").screenshot({ path: `${OUT}/02-desktop-tooltip.png` });

  // keyboard: focus MetaMask, Enter connects and the FLYLIST flow continues (signature → eligibility → form)
  await d.page.getByRole("button", { name: "MetaMask" }).focus();
  await d.page.keyboard.press("Enter");
  await d.page.getByLabel("X / Twitter username").waitFor({ timeout: 20_000 });
  const signs = (await calls(d.page)).filter((c) => c.endsWith("personal_sign"));
  check("FLY LIST: keyboard-picked MetaMask connected and signed once", signs.length === 1 && signs[0].startsWith("io.metamask"));
  check("landing: no second connect button", (await d.page.locator(".wconnect").count()) === 0);
  const handle = `w${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
  await d.page.getByLabel("X / Twitter username").fill(handle);
  await d.page.getByRole("button", { name: "SUBMIT TO FLYLIST" }).click();
  await d.page.getByText("You're on the FLYLIST").waitFor({ timeout: 15_000 });
  check("FLY LIST: registration submitted", true);

  // switch account inside the wallet while the pass is open: the flow stops for the new wallet
  await d.page.evaluate(() => (window as any).__providers["io.metamask"].__switch(1));
  await d.page.locator("#flylist-title", { hasText: "Wallet changed" }).waitFor({ timeout: 10_000 });
  check("wallet account switch: FLYLIST shows 'Wallet changed'", true);
  check("no page errors (desktop)", d.errors.length === 0);
  if (d.errors.length) console.log(d.errors);
  await d.context.close();

  // ---------- returning wallet, disconnected start: FLY LIST asks for a wallet first ----------
  const r = await open(browser, [keyA], [METAMASK, PHANTOM], { viewport: { width: 1366, height: 900 } });
  await r.page.goto(WEB);
  await flylist(r.page).click();
  await r.page.locator("#flylist-title").waitFor();
  check("FLY LIST (disconnected): wallet grid inside the FLYLIST modal", (await r.page.locator(".pass--modal .wgrid").count()) === 1);
  await r.page.getByRole("button", { name: "MetaMask" }).click();
  await r.page.getByText("Wallet already registered").waitFor({ timeout: 20_000 });
  check("returning wallet (same address, different wallet app): already registered", true);
  check("no page errors (returning)", r.errors.length === 0);
  await r.context.close();

  // ---------- desktop with only Phantom: MetaMask / Rabby are "Get" tiles ----------
  const g = await open(browser, [keyA], [PHANTOM], { viewport: { width: 1366, height: 900 } });
  await g.page.goto(WEB);
  await flylist(g.page).click();
  const gNames = await tileNames(g.page);
  console.log("      tiles:", gNames.join(" | "));
  check("not installed: MetaMask and Rabby marked", gNames.includes("MetaMask (not installed)") && gNames.includes("Rabby (not installed)"));
  await g.page.locator(".pass--modal").screenshot({ path: `${OUT}/04-desktop-not-installed.png` });
  await g.page.getByRole("button", { name: "MetaMask (not installed)" }).click();
  const get = g.page.getByRole("link", { name: "Get MetaMask" });
  check("not installed: install link to metamask.io", (await get.getAttribute("href")) === "https://metamask.io/download/");
  check("not installed: no connect attempt", !(await calls(g.page)).some((c) => c.endsWith("eth_requestAccounts")));
  await g.context.close();

  // ---------- mobile, no wallet (regular phone browser) ----------
  const m = await open(browser, [keyA], [], { ...devices["iPhone 13"] });
  let deepLink = "";
  await m.page.route("https://metamask.app.link/**", (route) => {
    deepLink = route.request().url();
    return route.fulfill({ status: 200, body: "deep link" });
  });
  await m.page.goto(WEB);
  await flylist(m.page).tap();
  await m.page.locator(".wgrid").waitFor();
  await m.page.screenshot({ path: `${OUT}/05-mobile-grid.png` });
  const mNames = await tileNames(m.page);
  console.log("      tiles:", mNames.join(" | "));
  check("mobile: no duplicate wallets", new Set(mNames).size === mNames.length);
  await m.page.getByRole("button", { name: "MetaMask (not installed)" }).tap();
  await m.page.waitForURL(/metamask\.app\.link/, { timeout: 10_000 }).catch(() => {});
  const host = new URL(WEB).host;
  check(`mobile: MetaMask deep link opens this page in MetaMask (${deepLink})`, deepLink === `https://metamask.app.link/dapp/${host}/`);
  await m.context.close();

  // ---------- mobile inside a wallet's in-app browser (injected, announces itself) ----------
  const mi = await open(browser, [keyA], [METAMASK], { ...devices["iPhone 13"] });
  await mi.page.goto(WEB);
  await flylist(mi.page).tap();
  await mi.page.getByRole("button", { name: "MetaMask" }).tap();
  await mi.page.getByText("Wallet already registered").waitFor({ timeout: 20_000 });
  check("mobile in-app browser: connects and finds the registration", true);
  await mi.page.screenshot({ path: `${OUT}/06-mobile-inapp.png` });
  await mi.context.close();
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
