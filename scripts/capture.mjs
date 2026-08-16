/**
 * Phase 0 capture for the marktplaats.nl read-only MCP.
 *
 * Drives a real Chromium over the PUBLIC, logged-out search flow and records a
 * HAR with response bodies embedded. Read-only: it searches and opens detail
 * pages. It never logs in, posts, bids, messages, or buys.
 *
 * Each flow runs twice with different inputs, so diffing the two recorded URLs
 * shows which path/query parts are parameters.
 *
 * Usage: node capture.mjs
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve Playwright.
 *
 * Capture is a maintenance task, not a runtime one: the MCP server never
 * launches a browser. So Playwright is deliberately NOT a dependency of this
 * package, and `npm install` stays small for everyone who only wants the server.
 *
 * Install it on demand before re-recording:
 *   npm install -D playwright && npx playwright install chromium
 *
 * Set MARKTPLAATS_PLAYWRIGHT to reuse an install from elsewhere, pointing at
 * either the package directory or its entry file.
 */
async function loadChromium() {
  const override = process.env.MARKTPLAATS_PLAYWRIGHT;
  if (override) {
    const tries = [override, join(override, "index.mjs"), join(override, "index.js")];
    const hit = tries.find((p) => existsSync(p));
    if (!hit) {
      console.error(
        `FATAL: MARKTPLAATS_PLAYWRIGHT is set to "${override}" but no Playwright entry point was found there.`,
      );
      process.exit(3);
    }
    return (await import(hit)).chromium;
  }

  for (const pkg of ["playwright", "playwright-core"]) {
    try {
      return (await import(pkg)).chromium;
    } catch {
      /* try the next candidate */
    }
  }

  console.error(
    [
      "FATAL: Playwright is not installed.",
      "",
      "Capture needs a real browser; the MCP server itself does not.",
      "Install it on demand, then re-run this script:",
      "",
      "  npm install -D playwright",
      "  npx playwright install chromium",
      "  node capture.mjs",
      "",
      "Already have Playwright elsewhere? Point at it instead:",
      "  MARKTPLAATS_PLAYWRIGHT=/path/to/node_modules/playwright node capture.mjs",
    ].join("\n"),
  );
  process.exit(3);
}

const chromium = await loadChromium();

const OUT = resolve(HERE, "..", "captures");
const SHOTS = resolve(HERE, "..", "shots");
mkdirSync(OUT, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

// Two different searches + two different detail pages, per the skill's
// "run each flow twice with different inputs" rule.
const SEARCHES = ["iphone 15", "racefiets"];

const browser = await chromium.launch({
  args: ["--disable-blink-features=AutomationControlled"],
});

const context = await browser.newContext({
  recordHar: { path: join(OUT, "capture.har"), content: "embed" },
  viewport: { width: 1440, height: 900 },
  locale: "nl-NL",
  timezoneId: "Europe/Amsterdam",
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/141.0.0.0 Safari/537.36",
});

const page = await context.newPage();
const log = (...a) => console.log("[capture]", ...a);

async function shot(name) {
  await page.screenshot({ path: join(SHOTS, name + ".png"), fullPage: false });
  log("shot:", name, "| url:", page.url(), "| title:", await page.title());
}

async function dismissConsent() {
  // Marktplaats is an EU site, so a consent wall is expected. Try the known
  // accept controls; do not fail the run if none is present.
  const selectors = [
    '#gdpr-consent-banner button[data-testid="accept-button"]',
    'button:has-text("Accepteren")',
    'button:has-text("Alles accepteren")',
    'button:has-text("Accept all")',
    '[data-testid="gdpr-accept-button"]',
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2500 })) {
        await el.click({ timeout: 3000 });
        log("consent dismissed via", sel);
        await page.waitForTimeout(1500);
        return true;
      }
    } catch {
      /* try the next selector */
    }
  }
  // The wall often lives in an iframe.
  for (const frame of page.frames()) {
    for (const sel of ['button:has-text("Accepteren")', 'button:has-text("Accept")']) {
      try {
        const el = frame.locator(sel).first();
        if (await el.isVisible({ timeout: 1200 })) {
          await el.click({ timeout: 3000 });
          log("consent dismissed in iframe via", sel);
          await page.waitForTimeout(1500);
          return true;
        }
      } catch {
        /* keep looking */
      }
    }
  }
  log("no consent wall found (or already accepted)");
  return false;
}

try {
  log("opening homepage");
  await page.goto("https://www.marktplaats.nl/", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.waitForTimeout(2500);
  await shot("01-home-before-consent");
  await dismissConsent();
  await shot("02-home-after-consent");

  for (let i = 0; i < SEARCHES.length; i++) {
    const term = SEARCHES[i];
    const n = String(i + 1);

    log(`search ${n}: ${term}`);
    await page.goto(
      "https://www.marktplaats.nl/q/" + encodeURIComponent(term.replace(/\s+/g, "-")) + "/",
      { waitUntil: "domcontentloaded", timeout: 45000 },
    );
    await page.waitForTimeout(3500);
    await shot(`1${n}-results-${term.replace(/\s+/g, "-")}`);

    // Open the first real listing from the results.
    const link = page
      .locator('a[href*="/v/"], a[href*="/a/"]')
      .filter({ hasNot: page.locator("[data-sponsored]") })
      .first();

    let href = null;
    try {
      href = await link.getAttribute("href", { timeout: 8000 });
    } catch {
      log("  no listing link matched on results page");
    }

    if (href) {
      const url = href.startsWith("http") ? href : "https://www.marktplaats.nl" + href;
      log("  opening detail:", url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(3500);
      await shot(`2${n}-detail-${term.replace(/\s+/g, "-")}`);
    }

    // Page 2 of results, so pagination params land in the capture.
    if (i === 0) {
      await page.goto(
        "https://www.marktplaats.nl/q/" +
          encodeURIComponent(term.replace(/\s+/g, "-")) +
          "/p/2/",
        { waitUntil: "domcontentloaded", timeout: 45000 },
      );
      await page.waitForTimeout(3000);
      await shot("3-results-page2");
    }
  }

  log("done driving");
} catch (err) {
  console.error("[capture] ERROR:", err.message);
  try {
    await shot("99-error");
  } catch {
    /* screenshot is best-effort */
  }
} finally {
  // Closing the context is what flushes the HAR to disk.
  await context.close();
  await browser.close();
  log("HAR written to", join(OUT, "capture.har"));
}
