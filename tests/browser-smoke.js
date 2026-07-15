const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { chromium } = require("playwright");
const { getRuntimeConfig } = require("../src/config");
const { createStore } = require("../src/store");
const { startServer } = require("../server");

async function main() {
  let server;
  let browser;
  let tempDir;
  const hardTimeout = setTimeout(() => {
    console.error("Browser smoke timed out after 25 seconds.");
    process.exit(124);
  }, 25_000);

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "threads-affiliate-ui-"));
  const store = createStore(path.join(tempDir, "store.json"));
  const config = getRuntimeConfig({
    PUBLIC_BASE_URL: "http://127.0.0.1:4173",
    THREADS_DRY_RUN: "true"
  });
  server = await startServer(0, { store, config });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;

  browser = await chromium.launch({ headless: true, timeout: 10_000 });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(5_000);
  page.setDefaultNavigationTimeout(10_000);
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForLoadState("networkidle");
  await page.waitForSelector("#postRows tr");

  assert.equal(await page.locator("text=內容工廠").first().isVisible(), true);
  assert.equal(await page.locator("text=合規 / 風險審核").first().isVisible(), true);
  assert.equal(await page.locator("text=聯盟收益管道").first().isVisible(), true);
  assert.equal(await page.locator("#postRows tr").count() > 0, true);

  await page.click("#generateBtn");
  await page.waitForSelector("text=已產生 A／B／C 三版草稿");
  const rowsAfterGenerate = await page.locator("#postRows tr").count();
  assert.equal(rowsAfterGenerate >= 5, true);

  fs.mkdirSync(path.join(__dirname, "..", "docs"), { recursive: true });
  await page.screenshot({
    path: path.join(__dirname, "..", "docs", "ui-smoke.png"),
    fullPage: true
  });

  if (browser) await browser.close();
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  clearTimeout(hardTimeout);

  assert.deepEqual(consoleErrors, []);
  console.log("Browser smoke passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
