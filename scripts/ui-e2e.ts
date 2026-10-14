// Browser end-to-end test of the real FLYLIST UI (desktop + mobile) against a running API.
// A test EIP-1193 wallet is injected as window.ethereum and signs with throwaway viem keys,
// so the page runs the exact SIWE flow a browser-wallet user would. Balances come from the
// dev API's fake chain (DEV_FAKE_CHAIN=1), controlled over FAKE_URL.
//
//   WEB_URL=http://localhost:5173 FAKE_URL=http://127.0.0.1:8788 ADMIN_PRIVATE_KEY=0x... npx tsx scripts/ui-e2e.ts
import { mkdirSync, readFileSync } from "node:fs";
import { chromium, devices, type Browser, type Page } from "playwright";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const FAKE = process.env.FAKE_URL ?? "http://127.0.0.1:8788";
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

async function fake(path: string, body: unknown) {
  const r = await fetch(`${FAKE}${path}`, { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`fake chain ${path}: ${await r.text()}`);
}

async function walletPage(browser: Browser, keys: `0x${string}`[], opts: Parameters<Browser["newContext"]>[0] = {}) {
  const accounts = keys.map((k) => privateKeyToAccount(k));
  const context = await browser.newContext({ ...opts, acceptDownloads: true });
  // tsx/esbuild wraps functions with a __name() helper; define it in the page so the
  // serialized init script below can run.
  await context.addInitScript({ content: "window.__name = (f) => f;" });
  await context.exposeBinding("__testSign", async (_src, address: string, message: string) => {
    const a = accounts.find((x) => x.address.toLowerCase() === address.toLowerCase());
    if (!a) throw new Error("unknown test account");
    return a.signMessage({ message });
  });
  await context.addInitScript(
    ({ addresses }) => {
      const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
      let chainId = "0x2105"; // Base (8453)
      let current = addresses[0];
      const calls: string[] = ((window as any).__walletCalls = []);
      (window as any).__switchAccount = (i: number) => {
        current = addresses[i];
        listeners.accountsChanged?.forEach((l) => l([current]));
      };
      (window as any).ethereum = {
        isMetaMask: false,
        request: async ({ method, params }: { method: string; params?: any[] }) => {
          calls.push(method);
          switch (method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return [current];
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
    { addresses: accounts.map((a) => a.address) },
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { page, context, accounts, account: accounts[0], errors };
}

const modal = (page: Page) => page.locator(".modal");
const modalText = (page: Page) => page.locator(".pass--modal").innerText();
const walletCalls = (page: Page) => page.evaluate(() => (window as any).__walletCalls as string[]);
const apply = (page: Page) => page.getByRole("button", { name: /apply 4 fly list/i });

async function connectAndReachForm(page: Page) {
  await apply(page).click();
  await page.getByRole("button", { name: /Browser Wallet/ }).click();
  await page.getByLabel("X / Twitter username").waitFor({ timeout: 15_000 });
}

const browser = await chromium.launch();
try {
  // ---------- desktop: nothing happens until APPLY 4 FLYLIST ----------
  const userKey = generatePrivateKey();
  const d = await walletPage(browser, [userKey], { viewport: { width: 1280, height: 900 } });
  await d.page.goto(WEB);
  await apply(d.page).waitFor();
  await d.page.waitForTimeout(1500); // give any (wrong) auto-open logic time to fire
  await d.page.screenshot({ path: `${OUT}/01-desktop-landing.png`, fullPage: true });
  check("page load: no modal", (await modal(d.page).count()) === 0);
  check("page load: no wallet picker on the page", (await d.page.getByRole("button", { name: /Browser Wallet/ }).count()) === 0);
  check("page load: no wallet connect/sign requests", !(await walletCalls(d.page)).some((m) => m === "eth_requestAccounts" || m === "personal_sign"));

  await apply(d.page).click();
  await d.page.getByText("Wallet connection requested").waitFor();
  check("click: modal asks for a wallet connection", true);
  await d.page.getByRole("button", { name: /Browser Wallet/ }).click();
  await d.page.getByLabel("X / Twitter username").waitFor({ timeout: 15_000 });
  const walletInput = d.page.getByRole("textbox", { name: "Wallet address" });
  check("form: wallet field shows the verified address", (await walletInput.inputValue()) === `${d.account.address.slice(0, 6)}…${d.account.address.slice(-4)}`);
  check("form: wallet field is read-only", (await walletInput.getAttribute("readonly")) !== null);
  const lockedBg = await d.page.locator(".input--locked").evaluate((el) => getComputedStyle(el).backgroundColor);
  check(`form: wallet field greyed (${lockedBg})`, lockedBg !== "rgb(255, 255, 255)");
  const [wb, xb] = [await d.page.locator(".flyfields > div").nth(0).boundingBox(), await d.page.locator(".flyfields > div").nth(1).boundingBox()];
  check("form: fields side by side on desktop", !!wb && !!xb && Math.abs(wb.y - xb.y) < 2 && xb.x > wb.x);
  check("form: X labelled self-reported", (await modalText(d.page)).includes("Self-reported, not verified"));
  check("form: copy button has an accessible label", (await d.page.getByRole("button", { name: /Copy wallet address 0x/ }).count()) === 1);
  check("signature was requested exactly once", (await walletCalls(d.page)).filter((m) => m === "personal_sign").length === 1);
  await d.page.locator(".pass--modal").screenshot({ path: `${OUT}/02-desktop-form.png` });

  await d.page.getByLabel("X / Twitter username").fill("bad-handle!");
  await d.page.getByRole("button", { name: "SUBMIT TO FLYLIST" }).click();
  check("client-side username validation", await d.page.getByText("Letters, numbers and underscores only.").isVisible());

  await d.page.getByLabel("X / Twitter username").fill(`@${H1}`);
  await d.page.getByRole("button", { name: "SUBMIT TO FLYLIST" }).dblclick(); // double submit
  await d.page.getByText("You're on the FLYLIST").waitFor({ timeout: 15_000 });
  await d.page.locator(".pass--modal").screenshot({ path: `${OUT}/03-desktop-submitted.png` });
  check("submitted state shows callsign + Eligible", (await modalText(d.page)).includes(`@${H1}`) && (await modalText(d.page)).includes("Eligible"));

  // Reload: wagmi silently reconnects the wallet; that must NOT open anything or ask to sign.
  await d.page.reload();
  await apply(d.page).waitFor();
  await d.page.waitForTimeout(1500);
  check("reload with connected wallet: no modal", (await modal(d.page).count()) === 0);
  check("reload with connected wallet: no signature request", !(await walletCalls(d.page)).includes("personal_sign"));
  await d.page.evaluate(() => (window as any).__switchAccount(0)); // accountsChanged event
  await d.page.waitForTimeout(500);
  check("wallet state change: no modal", (await modal(d.page).count()) === 0);

  await apply(d.page).click();
  await d.page.getByText("Wallet already registered").waitFor({ timeout: 15_000 });
  check("returning wallet: compact registered status, no form", (await d.page.getByLabel("X / Twitter username").count()) === 0 && (await modalText(d.page)).includes(`@${H1}`));
  await d.page.getByRole("button", { name: "Change X username" }).click();
  await d.page.getByLabel("Correct your X username").fill(H2);
  await d.page.getByRole("button", { name: "Save username" }).click();
  await d.page.getByText(`@${H2}`).first().waitFor({ timeout: 15_000 });
  check("username correction (separate flow) reflected", (await modalText(d.page)).includes(`@${H2}`));
  await d.page.keyboard.press("Escape");
  check("Esc closes the modal", (await modal(d.page).count()) === 0);
  check("no page errors (desktop)", d.errors.length === 0);
  await d.context.close();

  // ---------- returning wallet, new browser ----------
  const r = await walletPage(browser, [userKey], { viewport: { width: 1280, height: 900 } });
  await r.page.goto(WEB);
  await apply(r.page).click();
  await r.page.getByRole("button", { name: /Browser Wallet/ }).click();
  await r.page.getByText("Wallet already registered").waitFor({ timeout: 15_000 });
  await r.page.locator(".pass--modal").screenshot({ path: `${OUT}/04-desktop-already-registered.png` });
  check("other browser: recognized from the database, original handle", (await modalText(r.page)).includes(`@${H2}`));
  await r.context.close();

  // ---------- ineligible wallet ----------
  const poorKey = generatePrivateKey();
  await fake("/balance", { wallet: privateKeyToAccount(poorKey).address, chainId: 1, wei: "10000000000000000" }); // 0.01 ETH
  const p = await walletPage(browser, [poorKey], { viewport: { width: 1280, height: 900 } });
  await p.page.goto(WEB);
  await apply(p.page).click();
  await p.page.getByRole("button", { name: /Browser Wallet/ }).click();
  await p.page.getByText("Not eligible yet").waitFor({ timeout: 15_000 });
  await p.page.locator(".pass--modal").screenshot({ path: `${OUT}/05-desktop-ineligible.png` });
  const ptext = await modalText(p.page);
  check("ineligible: shows $55 rule and the balances used", ptext.includes("$55.00") && ptext.includes("Robinhood Chain") && ptext.includes("0.01"));
  check("ineligible: no registration form", (await p.page.getByLabel("X / Twitter username").count()) === 0);

  // price feeds down -> unavailable, not ineligible
  await fake("/state", { chainlinkDown: true, coinbaseDown: true });
  const u = await walletPage(browser, [generatePrivateKey()], { viewport: { width: 1280, height: 900 } });
  await u.page.goto(WEB);
  await apply(u.page).click();
  await u.page.getByRole("button", { name: /Browser Wallet/ }).click();
  await u.page.getByText("Check unavailable").waitFor({ timeout: 15_000 });
  check("price outage: 'Check unavailable', not ineligible", !(await modalText(u.page)).includes("Not eligible"));
  await fake("/state", { chainlinkDown: false, coinbaseDown: false });
  await p.context.close();
  await u.context.close();

  // ---------- wallet switch mid-flow ----------
  const k1 = generatePrivateKey();
  const k2 = generatePrivateKey();
  const s = await walletPage(browser, [k1, k2], { viewport: { width: 1280, height: 900 } });
  await s.page.goto(WEB);
  await connectAndReachForm(s.page);
  await s.page.getByLabel("X / Twitter username").fill("switcher");
  await s.page.evaluate(() => (window as any).__switchAccount(1));
  await s.page.getByRole("heading", { name: "Wallet changed" }).waitFor({ timeout: 10_000 });
  await s.page.locator(".pass--modal").screenshot({ path: `${OUT}/06-desktop-wallet-switched.png` });
  check("switch mid-flow: form withdrawn", (await s.page.getByLabel("X / Twitter username").count()) === 0);
  await s.page.getByRole("button", { name: /Continue with/ }).click();
  await s.page.getByLabel("X / Twitter username").waitFor({ timeout: 15_000 });
  const second = s.accounts[1].address;
  check("switch: new wallet verified independently", (await s.page.getByRole("textbox", { name: "Wallet address" }).inputValue()).startsWith(second.slice(0, 6)));
  check("no page errors (switch)", s.errors.length === 0);
  await s.context.close();

  // ---------- mobile ----------
  const m = await walletPage(browser, [generatePrivateKey()], { ...devices["iPhone 13"] });
  await m.page.goto(WEB);
  await apply(m.page).waitFor();
  await m.page.screenshot({ path: `${OUT}/07-mobile-landing.png`, fullPage: true });
  check("mobile: no horizontal overflow", !(await m.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
  check("mobile: no modal on load", (await modal(m.page).count()) === 0);
  await apply(m.page).tap();
  await m.page.getByRole("button", { name: /Browser Wallet/ }).tap();
  await m.page.getByLabel("X / Twitter username").waitFor({ timeout: 15_000 });
  const [mw, mx] = [await m.page.locator(".flyfields > div").nth(0).boundingBox(), await m.page.locator(".flyfields > div").nth(1).boundingBox()];
  check("mobile: fields stacked", !!mw && !!mx && mx.y > mw.y + mw.height - 1);
  await m.page.getByLabel("X / Twitter username").fill(HM);
  await m.page.screenshot({ path: `${OUT}/08-mobile-form.png` });
  check("mobile: modal fits the viewport width", !(await m.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
  await m.page.getByRole("button", { name: "SUBMIT TO FLYLIST" }).tap();
  await m.page.getByText("You're on the FLYLIST").waitFor({ timeout: 15_000 });
  await m.page.screenshot({ path: `${OUT}/09-mobile-submitted.png` });
  check("mobile registration flow", (await modalText(m.page)).includes(`@${HM}`));
  check("no page errors (mobile)", m.errors.length === 0);
  await m.context.close();

  // ---------- admin: non-admin wallet is refused ----------
  const n = await walletPage(browser, [generatePrivateKey()], { viewport: { width: 1280, height: 900 } });
  await n.page.goto(`${WEB}/admin/allowlist`);
  await n.page.getByRole("button", { name: /Browser Wallet/ }).click();
  await n.page.getByRole("button", { name: "Sign in" }).click();
  await n.page.getByText("not an allowlist administrator").waitFor({ timeout: 15_000 });
  check("admin page refuses non-admin wallet", true);
  await n.context.close();

  // ---------- admin dashboard ----------
  const a = await walletPage(browser, [adminKey], { viewport: { width: 1440, height: 1000 } });
  await a.page.goto(`${WEB}/admin/allowlist`);
  await a.page.getByRole("button", { name: /Browser Wallet/ }).click();
  await a.page.getByRole("button", { name: "Sign in" }).click();
  await a.page.getByText("Total registrations").waitFor({ timeout: 15_000 });
  await a.page.getByText(`@${H2}`).waitFor();
  await a.page.screenshot({ path: `${OUT}/10-admin-dashboard.png`, fullPage: true });
  check("admin dashboard lists registrations", await a.page.getByText(`@${HM}`).isVisible());
  check("admin dashboard shows USD balance at registration", (await a.page.locator("tbody").innerText()).includes("$2500.00"));

  await a.page.getByLabel("Search").fill(H2);
  await a.page.waitForTimeout(800);
  check("admin search: exactly one row for the double-submitted wallet", (await a.page.locator("tbody tr").count()) === 1);

  // Click the date cell: the row's centre can land on the X profile link, which opens X instead.
  await a.page.locator("tbody tr").first().locator("td").first().click();
  await a.page.locator(".drawer select").first().selectOption("approved");
  await a.page.locator(".drawer textarea").fill('=HYPERLINK("http://evil","x"), test note');
  await a.page.getByRole("button", { name: "Save changes" }).click();
  await a.page.locator(".audit").getByText("admin update").waitFor({ timeout: 15_000 });
  await a.page.screenshot({ path: `${OUT}/11-admin-edit.png`, fullPage: true });
  const drawer = await a.page.locator(".drawer").innerText();
  check("admin edit saved with audit entry", drawer.includes("eligible → approved"));
  check("drawer shows eligibility snapshot", drawer.includes("chainlink") && drawer.includes("1000000000000000000 wei"));

  await a.page.locator(".drawer").getByRole("button", { name: "Close" }).click();
  await a.page.getByLabel("Search").fill("");
  await a.page.waitForTimeout(800);
  const [download] = await Promise.all([a.page.waitForEvent("download"), a.page.getByRole("button", { name: /Export CSV/ }).click()]);
  const file = `${OUT}/${download.suggestedFilename()}`;
  await download.saveAs(file);
  const csv = readFileSync(file, "utf8");
  check(`CSV downloaded as ${download.suggestedFilename()}`, /^flylist-all-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()));
  check("CSV has header + test registrations + balance columns", csv.includes('"eth_balance_wei"') && csv.includes(H2) && csv.includes(HM));
  check("CSV neutralizes formula in notes", csv.includes(`"'=HYPERLINK(""http://evil"",""x""), test note"`));

  const [fin] = await Promise.all([a.page.waitForEvent("download"), a.page.getByRole("button", { name: /Final mint allowlist/ }).click()]);
  const finFile = `${OUT}/${fin.suggestedFilename()}`;
  await fin.saveAs(finFile);
  const finCsv = readFileSync(finFile, "utf8");
  check(`final export ${fin.suggestedFilename()}: approved wallet in, others out`, finCsv.includes(H2) && !finCsv.includes(HM) && finCsv.trim().split("\r\n").slice(1).every((l) => l.includes('"approved"')));
  check("drawer shows verification fields (not required, self-reported)", /policy version/i.test(drawer) && /not required/i.test(drawer) && /self-reported, unverified/i.test(drawer) && /NFT holder/i.test(drawer));
  check("CSV has the Phase B verification columns", ['"verification_status"', '"x_auth_status"', '"nft_holder_status"', '"access_code"', '"approval_status"'].every((c) => csv.includes(c)));

  // ---------- admin: Phase B configuration ----------
  await a.page.getByRole("tab", { name: "Campaign policy" }).click();
  await a.page.getByText(/^Policy version \d+$/).waitFor({ timeout: 15_000 });
  await a.page.screenshot({ path: `${OUT}/13-admin-policy.png`, fullPage: true });
  const policyText = await a.page.locator(".settings").innerText();
  check(
    "policy shows every deferred integration off",
    /X verification activated: off/i.test(policyText) && /Community gating activated: off/i.test(policyText) && /Access codes activated: off/i.test(policyText),
  );
  const modeSelect = a.page.locator("select").filter({ has: a.page.locator('option[value="invite_code"]') });
  check("invite / community modes are disabled in the picker", (await modeSelect.locator('option[value="invite_code"]').isDisabled()) && (await modeSelect.locator('option[value="community"]').isDisabled()));
  const cooldown = a.page.getByLabel("Retry cooldown (s)");
  await cooldown.fill("301");
  await a.page.getByPlaceholder(/owner approved/).fill("ui e2e");
  await a.page.getByRole("button", { name: "Save policy" }).click();
  await a.page.getByText(/Saved as policy version \d+/).waitFor({ timeout: 15_000 });
  check("policy save creates a new version", true);
  await a.page.getByLabel("Retry cooldown (s)").fill("300");
  await a.page.getByRole("button", { name: "Save policy" }).click();
  await a.page.getByText(/Saved as policy version \d+/).waitFor({ timeout: 15_000 });
  check("policy history lists the e2e change", (await a.page.locator(".settings .audit").innerText()).includes("ui e2e"));

  await a.page.getByRole("tab", { name: "Partner collections" }).click();
  await a.page.getByText("No partner collections configured.").waitFor({ timeout: 15_000 });
  await a.page.screenshot({ path: `${OUT}/14-admin-collections.png`, fullPage: true });
  check("no partner collections configured", true);

  await a.page.getByRole("tab", { name: "Access codes" }).click();
  await a.page.getByRole("button", { name: "Generate" }).waitFor({ timeout: 15_000 });
  await a.page.getByRole("button", { name: "Generate" }).click();
  const once = a.page.locator(".codes-once pre");
  await once.waitFor({ timeout: 15_000 });
  const shown = (await once.innerText()).trim();
  check("generated code shown once", /^FLY-[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/.test(shown));
  await a.page.screenshot({ path: `${OUT}/15-admin-access-codes.png`, fullPage: true });
  await a.page.locator("tbody tr").first().getByRole("button", { name: "Revoke" }).click();
  await a.page.locator("tbody tr").first().getByText("revoked").waitFor({ timeout: 15_000 });
  check("access code revoked from the UI; table shows only the prefix", !(await a.page.locator("tbody").innerText()).includes(shown));

  await a.page.getByRole("tab", { name: /API usage/ }).click();
  await a.page.getByText("No paid API calls have been made.").waitFor({ timeout: 15_000 });
  await a.page.screenshot({ path: `${OUT}/16-admin-usage.png`, fullPage: true });
  check("usage tab: no paid calls", true);

  const am = await walletPage(browser, [adminKey], { ...devices["iPhone 13"] });
  await am.page.goto(`${WEB}/admin/allowlist`);
  await am.page.getByRole("button", { name: /Browser Wallet/ }).tap();
  await am.page.getByRole("button", { name: "Sign in" }).tap();
  await am.page.getByText("Total registrations").waitFor({ timeout: 15_000 });
  await am.page.screenshot({ path: `${OUT}/12-admin-mobile.png`, fullPage: true });
  await am.page.getByRole("tab", { name: "Campaign policy" }).tap();
  await am.page.getByText(/^Policy version \d+$/).waitFor({ timeout: 15_000 });
  await am.page.screenshot({ path: `${OUT}/17-admin-policy-mobile.png`, fullPage: true });
  check("policy tab renders on mobile without horizontal overflow", await am.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  check("no page errors (admin)", a.errors.length === 0 && am.errors.length === 0);
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
