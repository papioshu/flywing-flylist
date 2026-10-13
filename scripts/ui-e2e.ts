// Browser end-to-end test of the real UI (desktop + mobile) against a running API.
// A test EIP-1193 wallet is injected as window.ethereum and signs with a throwaway
// viem key, so the page runs the exact SIWE flow a browser-wallet user would.
//
//   WEB_URL=http://localhost:5173 ADMIN_PRIVATE_KEY=0x... npx tsx scripts/ui-e2e.ts
import { mkdirSync, readFileSync } from "node:fs";
import { chromium, devices, type Browser, type Page } from "playwright";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const OUT = process.env.OUT_DIR ?? ".data/ui-e2e";
const adminKey = process.env.ADMIN_PRIVATE_KEY as `0x${string}`;
mkdirSync(OUT, { recursive: true });

// Unique handles per run, since the test database may persist between runs.
const tag = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
const H1 = `qa${tag}`;
const H2 = `qa${tag}x`;
const HM = `mob${tag}`;

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
}

async function walletPage(browser: Browser, key: `0x${string}`, opts: Parameters<Browser["newContext"]>[0] = {}) {
  const account = privateKeyToAccount(key);
  const context = await browser.newContext({ ...opts, acceptDownloads: true });
  // tsx/esbuild wraps functions with a __name() helper; define it in the page so the
  // serialized init script below can run.
  await context.addInitScript({ content: "window.__name = (f) => f;" });
  await context.exposeBinding("__testSign", async (_src, message: string) => account.signMessage({ message }));
  await context.addInitScript(
    ({ address }) => {
      const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
      let chainId = "0x2105"; // Base (8453)
      (window as any).ethereum = {
        isMetaMask: false,
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
              return (window as any).__testSign(new TextDecoder().decode(bytes));
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

const passText = (page: Page) => page.locator(".pass").innerText();

const browser = await chromium.launch();
try {
  // ---------- desktop registration ----------
  const userKey = generatePrivateKey();
  const d = await walletPage(browser, userKey, { viewport: { width: 1280, height: 900 } });
  await d.page.goto(WEB);
  await d.page.getByRole("button", { name: /Browser Wallet/ }).waitFor();
  await d.page.screenshot({ path: `${OUT}/01-desktop-disconnected.png`, fullPage: true });
  check("disconnected state shows wallet options", /connect wallet/i.test(await passText(d.page)));

  await d.page.getByRole("button", { name: /Browser Wallet/ }).click();
  await d.page.getByLabel("X / Twitter Username").waitFor();
  check("connected state shows short address", (await passText(d.page)).includes(d.account.address.slice(0, 6)));

  await d.page.getByLabel("X / Twitter Username").fill("bad-handle!");
  await d.page.getByRole("button", { name: "Join Allowlist" }).click();
  check("client-side username validation", await d.page.getByText("Letters, numbers and underscores only.").isVisible());
  await d.page.screenshot({ path: `${OUT}/02-desktop-invalid.png` });

  await d.page.getByLabel("X / Twitter Username").fill(`@${H1}`);
  await d.page.getByRole("button", { name: "Join Allowlist" }).click();
  await d.page.getByText("You're on the list.").waitFor({ timeout: 15_000 });
  await d.page.screenshot({ path: `${OUT}/03-desktop-registered.png`, fullPage: true });
  check("registered state + callsign shown", (await passText(d.page)).includes(`@${H1}`));

  await d.page.reload();
  await d.page.getByText("Wallet Already Registered").waitFor({ timeout: 15_000 });
  check("after refresh: registration loaded from database", (await passText(d.page)).includes(`@${H1}`));

  await d.page.getByRole("button", { name: "Change X username" }).click();
  await d.page.getByLabel("X / Twitter Username").fill(H2);
  await d.page.getByRole("button", { name: "Update Username" }).click();
  await d.page.getByText(`@${H2}`).first().waitFor({ timeout: 15_000 });
  check("username update reflected", (await passText(d.page)).includes(`@${H2}`));
  check("no page errors (desktop)", d.errors.length === 0);
  await d.context.close();

  // ---------- returning wallet, new browser session ----------
  const r = await walletPage(browser, userKey, { viewport: { width: 1280, height: 900 } });
  await r.page.goto(WEB);
  await r.page.getByRole("button", { name: /Browser Wallet/ }).click();
  await r.page.getByLabel("X / Twitter Username").fill("someoneelse");
  await r.page.getByRole("button", { name: "Join Allowlist" }).click();
  await r.page.getByText("Wallet Already Registered").waitFor({ timeout: 15_000 });
  await r.page.screenshot({ path: `${OUT}/04-desktop-already-registered.png` });
  check("returning wallet sees Wallet Already Registered + original handle", (await passText(r.page)).includes(`@${H2}`));
  await r.context.close();

  // ---------- mobile ----------
  const m = await walletPage(browser, generatePrivateKey(), { ...devices["iPhone 13"] });
  await m.page.goto(WEB);
  await m.page.getByRole("button", { name: /Browser Wallet/ }).waitFor();
  await m.page.screenshot({ path: `${OUT}/05-mobile-disconnected.png`, fullPage: true });
  const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check("mobile: no horizontal overflow", !overflow);
  await m.page.getByRole("button", { name: /Browser Wallet/ }).tap();
  await m.page.getByLabel("X / Twitter Username").fill(HM);
  await m.page.screenshot({ path: `${OUT}/06-mobile-connected.png` });
  await m.page.getByRole("button", { name: "Join Allowlist" }).tap();
  await m.page.getByText("You're on the list.").waitFor({ timeout: 15_000 });
  await m.page.locator(".pass").screenshot({ path: `${OUT}/07-mobile-registered.png` });
  check("mobile registration flow", (await passText(m.page)).includes(`@${HM}`));
  check("no page errors (mobile)", m.errors.length === 0);
  await m.context.close();

  // ---------- admin: non-admin wallet is refused ----------
  const n = await walletPage(browser, generatePrivateKey(), { viewport: { width: 1280, height: 900 } });
  await n.page.goto(`${WEB}/admin/allowlist`);
  await n.page.getByRole("button", { name: /Browser Wallet/ }).click();
  await n.page.getByRole("button", { name: "Sign in" }).click();
  await n.page.getByText("not an allowlist administrator").waitFor({ timeout: 15_000 });
  check("admin page refuses non-admin wallet", true);
  await n.context.close();

  // ---------- admin dashboard ----------
  const a = await walletPage(browser, adminKey, { viewport: { width: 1440, height: 1000 } });
  await a.page.goto(`${WEB}/admin/allowlist`);
  await a.page.getByRole("button", { name: /Browser Wallet/ }).click();
  await a.page.getByRole("button", { name: "Sign in" }).click();
  await a.page.getByText("Total registrations").waitFor({ timeout: 15_000 });
  await a.page.getByText(`@${H2}`).waitFor();
  await a.page.screenshot({ path: `${OUT}/08-admin-dashboard.png`, fullPage: true });
  check("admin dashboard lists registrations", await a.page.getByText(`@${HM}`).isVisible());

  await a.page.getByLabel("Search").fill(H1);
  await a.page.waitForTimeout(800);
  check("admin search filters rows", (await a.page.locator("tbody tr").count()) === 1);

  await a.page.locator("tbody tr").first().click();
  await a.page.locator(".drawer select").first().selectOption("approved");
  await a.page.locator(".drawer textarea").fill('=HYPERLINK("http://evil","x"), test note');
  await a.page.getByRole("button", { name: "Save changes" }).click();
  await a.page.locator(".audit").getByText("admin update").waitFor({ timeout: 15_000 });
  await a.page.screenshot({ path: `${OUT}/09-admin-edit.png`, fullPage: true });
  check("admin edit saved with audit entry", (await a.page.locator(".drawer").innerText()).includes("registered → approved"));

  await a.page.locator(".drawer").getByRole("button", { name: "Close" }).click();
  await a.page.getByLabel("Search").fill("");
  await a.page.waitForTimeout(800);
  await a.page.screenshot({ path: `${OUT}/09b-before-export.png` });
  const [download] = await Promise.all([a.page.waitForEvent("download"), a.page.getByRole("button", { name: /Export CSV/ }).click()]);
  const file = `${OUT}/${download.suggestedFilename()}`;
  await download.saveAs(file);
  const csv = readFileSync(file, "utf8");
  check(`CSV downloaded as ${download.suggestedFilename()}`, /^flywing-allowlist-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()));
  check("CSV has header + both test registrations", csv.includes('"registration_id"') && csv.includes(H2) && csv.includes(HM));
  check("CSV neutralizes formula in notes", csv.includes(`"'=HYPERLINK(""http://evil"",""x""), test note"`));

  const am = await walletPage(browser, adminKey, { ...devices["iPhone 13"] });
  await am.page.goto(`${WEB}/admin/allowlist`);
  await am.page.getByRole("button", { name: /Browser Wallet/ }).tap();
  await am.page.getByRole("button", { name: "Sign in" }).tap();
  await am.page.getByText("Total registrations").waitFor({ timeout: 15_000 });
  await am.page.screenshot({ path: `${OUT}/10-admin-mobile.png`, fullPage: true });
  check("no page errors (admin)", a.errors.length === 0 && am.errors.length === 0);
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
