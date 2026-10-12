// Real end-to-end test (requires Playwright browsers + built extension):
//
//   local bridge (127.0.0.1:<EXTENSION_BRIDGE_PORT>)
//        -> fresh Chromium with the built extension loaded unpacked
//        -> extension long-polls the bridge
//        -> open-deepseek creates / activates a chat.deepseek.com tab
//
// This is the same path the Telegram bot uses when the user selects
// 🧩 Browser Extension in /setting. No npm run chrome / CDP is involved.
//
// Run:  npm run extension:build && npm run test:e2e
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startBridge } = require("./bridge/extension-bridge");

const EXT_DIR = path.join(__dirname, "chrome-extension-react-template", "build");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// evaluate() on a stale MV3 service-worker handle (Chrome may terminate and
// restart the worker at any time) never settles - bound every call so the
// test fails loudly instead of hanging forever.
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("worker.evaluate timed out (service worker restarted)")),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function configuredPort() {
  try {
    const envText = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    const m = envText.match(/^EXTENSION_BRIDGE_PORT\s*=\s*(\d+)/m);
    if (m) return Number(m[1]);
  } catch {
    // fall through
  }
  return 8765;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

(async () => {
  assert(
    fs.existsSync(path.join(EXT_DIR, "manifest.json")),
    "extension is not built -> run: npm run extension:build"
  );

  const port = configuredPort();
  let bridge;
  try {
    // Default timeouts: the extension answers in milliseconds when it is alive.
    bridge = await startBridge({ port });
  } catch (err) {
    if (err && err.code === "EADDRINUSE") {
      console.log(`SKIP: port ${port} is already in use (is the bot running?).`);
      console.log("Stop the bot, then re-run: npm run test:e2e");
      process.exit(0);
    }
    throw err;
  }

  const { chromium } = require("playwright");
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "telegrambot-ext-e2e-"));
  const base = `http://127.0.0.1:${port}`;
  let context = null;

  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: process.env.EXTENSION_E2E_HEADLESS === "1",
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
      ],
    });

    // --- extension service worker must come up ---
    let worker = context.serviceWorkers()[0];
    if (!worker) {
      worker = await context.waitForEvent("serviceworker", { timeout: 20000 });
    }
    assert.ok(worker, "extension service worker did not start");
    console.log("PASS extension loaded unpacked (service worker running)");

    // --- extension must start polling the bridge ---
    let connected = false;
    const connectDeadline = Date.now() + 20000;
    while (Date.now() < connectDeadline) {
      try {
        const health = await (await fetch(`${base}/health`)).json();
        if (health.lastExtensionSeenMs !== null) {
          connected = true;
          break;
        }
      } catch {
        // bridge briefly unavailable
      }
      await sleep(300);
    }
    assert(connected, "extension never polled the local bridge");
    console.log("PASS extension connected to the local bridge (long-poll)");

    const getWorker = async () => {
      const workers = context.serviceWorkers();
      if (workers.length > 0) return workers[workers.length - 1];
      // A restarted worker re-attaches via its next alarm/poll (<= ~35s).
      return await context.waitForEvent("serviceworker", { timeout: 35000 });
    };

    const deepSeekTabs = async () => {
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const worker = await getWorker();
          const evaluation = worker.evaluate(() =>
            chrome.tabs.query({ url: "https://chat.deepseek.com/*" })
          );
          evaluation.catch(() => {}); // stale handle may reject after the race
          return await withTimeout(evaluation, 10000);
        } catch (err) {
          lastErr = err;
          await sleep(1000);
        }
      }
      throw lastErr;
    };

    // The exact function index.js calls when the user selects 🧩 Browser
    // Extension in /setting (adapter -> bridge -> extension -> tabs API).
    process.env.EXTENSION_BRIDGE_PORT = String(port);
    const ext = require("./ai/extension");

    // --- Telegram selects 🧩 Browser Extension ---
    const first = await ext.openDeepSeekTab();
    assert.strictEqual(first.status, "created");
    const firstTabId = first.tabId;
    assert.ok(typeof firstTabId === "number", "tabId returned");

    await sleep(1500); // let the tab settle
    let tabs = await deepSeekTabs();
    assert.strictEqual(tabs.length, 1, `expected 1 DeepSeek tab, got ${tabs.length}`);
    assert.ok(
      tabs[0].url.startsWith("https://chat.deepseek.com"),
      `unexpected tab url: ${tabs[0].url}`
    );
    console.log(`PASS openDeepSeekTab() -> DeepSeek tab created (tabId ${firstTabId})`);

    // --- second click must activate, never duplicate ---
    const second = await ext.openDeepSeekTab();
    assert.strictEqual(second.status, "activated");
    assert.strictEqual(second.tabId, firstTabId, "same tab activated");
    tabs = await deepSeekTabs();
    assert.strictEqual(tabs.length, 1, "still exactly one DeepSeek tab");
    assert.strictEqual(tabs[0].active, true, "existing tab made active");
    console.log("PASS second click -> existing tab activated (no duplicate)");

    // --- rapid repeated clicks never duplicate the tab ---
    const burst = await Promise.all(
      Array.from({ length: 4 }, () => ext.openDeepSeekTab())
    );
    assert.ok(
      burst.every((r) => r.status === "created" || r.status === "activated"),
      JSON.stringify(burst)
    );
    await sleep(500);
    tabs = await deepSeekTabs();
    assert.strictEqual(tabs.length, 1, `burst created duplicates: ${tabs.length}`);
    console.log("PASS 4 rapid clicks -> still exactly one DeepSeek tab");

    // --- health endpoint used by diagnostics ---
    const health = await (await fetch(`${base}/health`)).json();
    assert.strictEqual(health.ok, true);
    assert.ok(health.lastExtensionSeenMs !== null);
    assert.strictEqual(health.queueDepth, 0);
    assert.strictEqual(health.inFlight, 0);
    console.log("PASS /health shows extension connected, queue drained");

    console.log("\nALL REAL E2E TESTS PASSED");
  } finally {
    if (context) await context.close().catch(() => {});
    await bridge.close().catch(() => {});
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  process.exit(0);
})().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
