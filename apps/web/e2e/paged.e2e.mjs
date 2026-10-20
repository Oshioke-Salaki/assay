// Pagination, search and filters on a report's "Who paid it" table, in real Chrome.
// Run against a started site: BASE=http://localhost:3100 node e2e/paged.e2e.mjs
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SELLER = process.env.SELLER ?? "0x5df8ae2b963165b735b18ca86b1ea448d2aa032c";
const OUT = process.env.OUT;

function check(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`ok  ${msg}`);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/address/${SELLER}`, { waitUntil: "networkidle" });
    const panel = page.locator('section[aria-label="Who paid it"]');
    const rows = panel.locator("tbody tr");
    check((await rows.count()) === 20, `${width}px: first page shows 20 payers`);
    check(await panel.getByText(/Page 1 of \d+/).isVisible(), `${width}px: pager shows page 1`);
    const first = await rows.first().textContent();
    await panel.getByRole("button", { name: "Next" }).click();
    await panel.getByText(/Page 2 of/).waitFor();
    await page.waitForFunction(
      (f) => document.querySelector('section[aria-label="Who paid it"] tbody tr')?.textContent !== f,
      first,
    );
    check(true, `${width}px: Next loads page 2 with different rows`);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    check(sw <= width, `${width}px: no horizontal page scroll (${sw})`);
    if (OUT) await page.screenshot({ path: `${OUT}/paged-${width}.png`, fullPage: false, clip: undefined });

    const target = (await rows.first().locator("a").first().getAttribute("href")).split("/").pop();
    await panel.getByRole("textbox").fill(target.slice(2, 12));
    await page.waitForFunction(
      (n) => document.querySelectorAll('section[aria-label="Who paid it"] tbody tr').length === n,
      1,
      { timeout: 10_000 },
    );
    check(true, `${width}px: search narrows to the one matching payer`);
    check((await panel.getByText(/Page 1 of/).count()) === 0, `${width}px: pager hides for one page`);
    await panel.getByRole("textbox").fill("0xdeadbeefdeadbeef");
    await panel.getByText(/No payer matches/).waitFor({ timeout: 10_000 });
    check(true, `${width}px: no-match search shows an empty state`);
    await panel.getByRole("textbox").fill("");
    const organic = panel.getByRole("button", { name: /^Organic/ });
    await organic.waitFor();
    if (await organic.isEnabled()) {
      await organic.click();
      await page.waitForTimeout(1200);
      const classes = await panel.locator("tbody tr td:nth-child(2)").allTextContents();
      check(
        classes.length > 0 && classes.every((c) => c.startsWith("Organic")),
        `${width}px: Organic filter shows only organic payers`,
      );
    }
    if (OUT && width === 390) await page.screenshot({ path: `${OUT}/paged-390-filter.png` });
    check(errors.length === 0, `${width}px: no page errors ${errors.join(" | ")}`);
    await page.close();
  }
} finally {
  await browser.close();
}
