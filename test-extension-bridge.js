// Tests for the local extension bridge (bridge/extension-bridge.js).
// Uses a simulated extension client that imports the REAL extension tab
// logic, so bridge <-> extension protocol is exercised end to end.
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");
const { startBridge } = require("./bridge/extension-bridge");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createFakeChrome() {
  let nextTabId = 100;
  const state = { tabs: [], created: 0, updated: 0 };
  const chromeApi = {
    tabs: {
      async query({ url }) {
        return state.tabs.filter(
          (t) => !url || t.url.startsWith("https://chat.deepseek.com/")
        );
      },
      async create({ url, active }) {
        await sleep(20); // delay to expose query/create races
        state.created += 1;
        const tab = { id: nextTabId++, url, active: !!active, windowId: 1 };
        state.tabs.push(tab);
        return tab;
      },
      async update(id, props) {
        state.updated += 1;
        const tab = state.tabs.find((t) => t.id === id);
        if (tab) Object.assign(tab, props);
        return tab;
      },
    },
    windows: { async update() {} },
  };
  return { chromeApi, state };
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

async function startFakeExtension(base, chromeApi, tabsMod) {
  let stopped = false;
  const received = [];
  const loop = (async () => {
    while (!stopped) {
      let batch;
      try {
        const res = await fetch(`${base}/extension/commands?wait=200`);
        batch = await res.json();
      } catch {
        if (stopped) return;
        await sleep(50);
        continue;
      }
      for (const cmd of batch.commands || []) {
        received.push(cmd.action);
        let result;
        if (cmd.action === "open_deepseek") {
          try {
            // REAL extension logic (chrome-extension-react-template)
            const openResult = await tabsMod.queueOpenDeepSeek(chromeApi);
            result = { ok: true, data: openResult };
          } catch (err) {
            result = { ok: false, error: String(err && err.message) };
          }
        } else if (cmd.action === "ask") {
          await sleep(10);
          result = { ok: true, data: { response: `echo:${cmd.payload.message}` } };
        } else {
          result = { ok: false, error: "unknown_action" };
        }
        await fetch(`${base}/extension/result`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: cmd.id, ...result }),
        });
      }
    }
  })();
  return {
    received,
    stop() {
      stopped = true;
    },
  };
}

(async () => {
  const tabsMod = await import(
    pathToFileURL(
      path.join(
        __dirname,
        "chrome-extension-react-template/src/background/deepseek-tabs.js"
      )
    ).href
  );

  const bridge = await startBridge({
    port: 0,
    openTimeoutMs: 1500,
    askTimeoutMs: 2000,
    pollWaitMs: 300,
  });
  const base = `http://127.0.0.1:${bridge.port}`;

  try {
    // --- Test 1: bound to localhost only ---
    assert.strictEqual(bridge.server.address().address, "127.0.0.1", "bridge binds 127.0.0.1");
    console.log("PASS bridge binds 127.0.0.1 only");

    // --- Test 2: extension unavailable -> clear failure ---
    const r1 = await postJson(`${base}/extension/open-deepseek`, {});
    assert.strictEqual(r1.status, 503, "expected 503 when no extension is connected");
    assert.strictEqual(r1.data.ok, false);
    assert.strictEqual(r1.data.error, "extension_unavailable");
    console.log("PASS open-deepseek fails clearly when extension is unavailable");

    // --- Test 3: health before extension connects ---
    const health0 = await (await fetch(`${base}/health`)).json();
    assert.strictEqual(health0.ok, true);
    assert.strictEqual(health0.lastExtensionSeenMs, null, "extension never seen");
    console.log("PASS /health reports no extension before first poll");

    // --- Test 4: extension connects, first open creates a tab ---
    const fake = createFakeChrome();
    const client = await startFakeExtension(base, fake.chromeApi, tabsMod);
    await sleep(350);

    const health1 = await (await fetch(`${base}/health`)).json();
    assert.ok(health1.lastExtensionSeenMs !== null, "extension polled the bridge");

    const r2 = await postJson(`${base}/extension/open-deepseek`, {});
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.data));
    assert.strictEqual(r2.data.ok, true);
    assert.strictEqual(r2.data.result.status, "created");
    assert.strictEqual(fake.state.created, 1, "one tab created");
    assert.strictEqual(
      fake.state.tabs[0].url,
      "https://chat.deepseek.com/",
      "created with DeepSeek URL"
    );
    console.log("PASS no DeepSeek tab -> created (via real extension logic)");

    // --- Test 5: second open activates instead of creating ---
    const r3 = await postJson(`${base}/extension/open-deepseek`, {});
    assert.strictEqual(r3.data.result.status, "activated");
    assert.strictEqual(fake.state.created, 1, "still exactly one tab");
    assert.ok(fake.state.updated >= 1, "existing tab activated");
    console.log("PASS existing DeepSeek tab -> activated, no duplicate");

    // --- Test 6: rapid repeated clicks never duplicate the tab ---
    const burst = await Promise.all([
      postJson(`${base}/extension/open-deepseek`, {}),
      postJson(`${base}/extension/open-deepseek`, {}),
      postJson(`${base}/extension/open-deepseek`, {}),
    ]);
    assert.ok(
      burst.every((r) => r.data && r.data.ok === true),
      "all concurrent opens succeed"
    );
    assert.strictEqual(fake.state.created, 1, "burst created no extra tabs");
    assert.strictEqual(
      fake.state.tabs.filter((t) => t.url.startsWith("https://chat.deepseek.com/")).length,
      1,
      "exactly one DeepSeek tab exists"
    );
    console.log("PASS 3 concurrent opens -> still exactly one DeepSeek tab");

    // --- Test 7: ask round trip ---
    const r4 = await postJson(`${base}/extension/ask`, { message: "hello bridge" });
    assert.strictEqual(r4.data.ok, true);
    assert.strictEqual(r4.data.result.response, "echo:hello bridge");
    console.log("PASS ask command round trip returns the extension result");

    // --- Test 8: empty ask rejected ---
    const r5 = await postJson(`${base}/extension/ask`, { message: "   " });
    assert.strictEqual(r5.status, 400);
    assert.strictEqual(r5.data.error, "empty_message");
    console.log("PASS empty ask message rejected with 400");

    // --- Test 9: unknown command id rejected ---
    const r6 = await postJson(`${base}/extension/result`, { id: 999999, ok: true });
    assert.strictEqual(r6.status, 404);
    assert.strictEqual(r6.data.error, "unknown_command");
    console.log("PASS result for unknown command rejected");

    // --- Test 10: extension stops -> unavailable again ---
    client.stop();
    await sleep(500); // let its long-poll exit
    const r7 = await postJson(`${base}/extension/open-deepseek`, {});
    assert.strictEqual(r7.data.error, "extension_unavailable");
    console.log("PASS extension stopped -> extension_unavailable");

    // --- Test 11: commands received by the simulated extension ---
    assert.ok(client.received.includes("open_deepseek"), "extension saw open_deepseek");
    assert.ok(client.received.includes("ask"), "extension saw ask");
    console.log("PASS extension received open_deepseek and ask commands");

    // --- Test 12: stale extension (Chrome closed) -> immediate failure ---
    // The bridge must not make Telegram users wait out the full timeout when
    // the extension has not polled for a long time.
    bridge.state.lastExtensionSeen = Date.now() - 60000;
    const t0 = Date.now();
    const staleOpen = await postJson(`${base}/extension/open-deepseek`, {});
    const staleAsk = await postJson(`${base}/extension/ask`, { message: "hello" });
    const elapsed = Date.now() - t0;
    assert.strictEqual(staleOpen.status, 503);
    assert.strictEqual(staleOpen.data.error, "extension_unavailable");
    assert.strictEqual(staleAsk.status, 503);
    assert.strictEqual(staleAsk.data.error, "extension_unavailable");
    assert.ok(elapsed < 1000, `stale checks must fail fast, took ${elapsed}ms`);
    console.log("PASS stale extension -> immediate extension_unavailable (<1s)");

    console.log("\nALL BRIDGE TESTS PASSED");
  } finally {
    await bridge.close();
  }
  process.exit(0);
})().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
