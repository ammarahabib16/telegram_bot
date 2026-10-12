// End-to-end flow test: Telegram bot adapter <-> local bridge <-> extension.
//
//   ai/extension.js (what index.js calls)
//        -> bridge/extension-bridge.js (local HTTP, 127.0.0.1)
//        -> simulated extension client running the REAL extension tab logic
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
      async query({ url } = {}) {
        return state.tabs.filter(
          (t) => !url || t.url.startsWith("https://chat.deepseek.com/")
        );
      },
      async create({ url, active }) {
        await sleep(15);
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

async function startFakeExtension(base, chromeApi, tabsMod) {
  let stopped = false;
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
        let result;
        if (cmd.action === "open_deepseek") {
          try {
            const openResult = await tabsMod.queueOpenDeepSeek(chromeApi);
            result = { ok: true, data: openResult };
          } catch (err) {
            result = { ok: false, error: String(err && err.message) };
          }
        } else if (cmd.action === "ask") {
          result = { ok: true, data: { response: '## Answer\n\n```python\nprint("' + cmd.payload.message + '")\n```' } };
        } else if (cmd.action === "reload") {
          result = { ok: true, data: { reloaded: true } };
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
    stop() {
      stopped = true;
    },
  };
}

function assertNoInternals(message) {
  assert(!/127\.0\.0\.1|localhost|:\d{4}|bridge|stack|Error:/.test(message),
    `friendly message leaks internals: ${message}`);
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
    openTimeoutMs: 800,
    askTimeoutMs: 1200,
    pollWaitMs: 200,
  });
  const base = `http://127.0.0.1:${bridge.port}`;

  // The adapter reads the port from the environment at call time.
  process.env.EXTENSION_BRIDGE_PORT = String(bridge.port);
  process.env.EXTENSION_ACK_TIMEOUT_MS = "800";
  process.env.EXTENSION_ASK_TIMEOUT_MS = "1200";

  const ext = require("./ai/extension");

  try {
    // --- Test 1: extension not running -> friendly, leak-free error ---
    await assert.rejects(
      () => ext.openDeepSeekTab(),
      (err) => {
        assert.strictEqual(err.friendlyMessage, ext.EXTENSION_UNAVAILABLE_MESSAGE);
        assert(/Telegrambot Chrome Extension/.test(err.friendlyMessage));
        assert(/Chrome is running/.test(err.friendlyMessage));
        assertNoInternals(err.friendlyMessage);
        return true;
      }
    );
    console.log("PASS unavailable extension -> exact friendly Telegram message");

    // --- Test 2: extension starts, open -> created, then activated ---
    const fake = createFakeChrome();
    const client = await startFakeExtension(base, fake.chromeApi, tabsMod);
    await sleep(300);

    const first = await ext.openDeepSeekTab();
    assert.strictEqual(first.status, "created");
    assert.strictEqual(fake.state.created, 1);

    const second = await ext.openDeepSeekTab();
    assert.strictEqual(second.status, "activated");
    assert.strictEqual(fake.state.created, 1, "no duplicate DeepSeek tab");
    console.log("PASS openDeepSeekTab -> created then activated (single tab)");

    // --- Test 3: Stage 2 message routing round trip ---
    const answer = await ext.extensionResponse("canberra");
    assert(answer.includes("## Answer"), "Markdown heading preserved in extensionResponse");
    assert(answer.includes("```python"), "Markdown code fence preserved in extensionResponse");
    console.log("PASS extensionResponse routes through bridge to extension");

    // --- Test 3b: Extension reload round trip ---
    const reloaded = await ext.reloadExtension();
    assert.strictEqual(reloaded, true, "reloadExtension succeeds through bridge");
    console.log("PASS reloadExtension round trip verified");

    // --- Test 4: friendly timeout message when DeepSeek is too slow ---
    const slowBridge = await startBridge({
      port: 0,
      openTimeoutMs: 500,
      askTimeoutMs: 300,
      pollWaitMs: 100,
    });
    process.env.EXTENSION_BRIDGE_PORT = String(slowBridge.port);
    // Extension client is connected but never answers "ask" commands:
    // the bridge must time out with a friendly, leak-free message.
    let stoppedSlow = false;
    const slowClient = (async () => {
      const b = `http://127.0.0.1:${slowBridge.port}`;
      while (!stoppedSlow) {
        let batch;
        try {
          const res = await fetch(`${b}/extension/commands?wait=100`);
          batch = await res.json();
        } catch {
          await sleep(50);
          continue;
        }
        for (const cmd of batch.commands || []) {
          if (cmd.action === "ask") continue; // swallow: never post a result
          await fetch(`${b}/extension/result`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: cmd.id,
              ok: true,
              data: { status: "created", tabId: 1 },
            }),
          });
        }
      }
    })();
    await sleep(350);
    await assert.rejects(
      () => ext.extensionResponse("too slow"),
      (err) => {
        assert(/took too long/.test(err.friendlyMessage), err.friendlyMessage);
        assertNoInternals(err.friendlyMessage);
        return true;
      }
    );
    stoppedSlow = true;
    await slowClient;
    await slowBridge.close();
    console.log("PASS slow DeepSeek -> friendly timeout message without internals");

    // --- Test 5: extension disappears -> unavailable again ---
    process.env.EXTENSION_BRIDGE_PORT = String(bridge.port);
    client.stop();
    await sleep(500);
    await assert.rejects(
      () => ext.openDeepSeekTab(),
      (err) => {
        assert.strictEqual(err.friendlyMessage, ext.EXTENSION_UNAVAILABLE_MESSAGE);
        return true;
      }
    );
    console.log("PASS extension stopped -> unavailable friendly message");

    console.log("\nALL BOT<->BRIDGE<->EXTENSION FLOW TESTS PASSED");
  } finally {
    await bridge.close();
    delete process.env.EXTENSION_BRIDGE_PORT;
    delete process.env.EXTENSION_ACK_TIMEOUT_MS;
    delete process.env.EXTENSION_ASK_TIMEOUT_MS;
  }
  process.exit(0);
})().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
