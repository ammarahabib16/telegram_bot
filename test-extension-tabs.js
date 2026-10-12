// Unit tests for the Chrome extension's tab logic (DeepSeek tab detection,
// activation, creation and duplicate prevention). The module is plain ESM
// with Chrome injected as a parameter, so it runs outside Chrome.
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createFakeChrome() {
  let nextTabId = 1;
  const state = { tabs: [], created: 0, updated: 0, createCalls: 0 };
  const chromeApi = {
    tabs: {
      async query({ url } = {}) {
        return state.tabs.filter(
          (t) => !url || t.url.startsWith("https://chat.deepseek.com/")
        );
      },
      async create({ url, active }) {
        state.createCalls += 1;
        await sleep(25);
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
    windows: {
      async update() {},
    },
  };
  return { chromeApi, state };
}

(async () => {
  const mod = await import(
    pathToFileURL(
      path.join(
        __dirname,
        "chrome-extension-react-template/src/background/deepseek-tabs.js"
      )
    ).href
  );
  const { isDeepSeekUrl, findDeepSeekTab, openDeepSeekTab, queueOpenDeepSeek, DEEPSEEK_URL } = mod;

  // --- Test 1: URL matching is a safe prefix check ---
  assert.strictEqual(DEEPSEEK_URL, "https://chat.deepseek.com/");
  assert.ok(isDeepSeekUrl("https://chat.deepseek.com/"));
  assert.ok(isDeepSeekUrl("https://chat.deepseek.com"));
  assert.ok(isDeepSeekUrl("https://chat.deepseek.com/a/b?c=1"));
  assert.ok(!isDeepSeekUrl("https://chat.deepseek.com.evil.example/"));
  assert.ok(!isDeepSeekUrl("http://chat.deepseek.com/"));
  assert.ok(!isDeepSeekUrl(undefined));
  console.log("PASS DeepSeek URL prefix check (lookalike domains rejected)");

  // --- Test 2: no DeepSeek tab -> create ---
  {
    const fake = createFakeChrome();
    const result = await openDeepSeekTab(fake.chromeApi);
    assert.strictEqual(result.status, "created");
    assert.strictEqual(fake.state.created, 1);
    assert.strictEqual(fake.state.tabs[0].url, "https://chat.deepseek.com/");
    assert.strictEqual(fake.state.tabs[0].active, true, "new tab is active");
    console.log("PASS no DeepSeek tab -> creates one (active, correct URL)");
  }

  // --- Test 3: DeepSeek tab exists -> activate, never create ---
  {
    const fake = createFakeChrome();
    fake.state.tabs.push({
      id: 42,
      url: "https://chat.deepseek.com/",
      active: false,
      windowId: 7,
    });
    const found = await findDeepSeekTab(fake.chromeApi);
    assert.ok(found && found.id === 42, "existing tab found");

    const result = await openDeepSeekTab(fake.chromeApi);
    assert.strictEqual(result.status, "activated");
    assert.strictEqual(result.tabId, 42);
    assert.strictEqual(fake.state.created, 0, "no tab created");
    assert.ok(fake.state.updated >= 1, "existing tab made active");
    console.log("PASS existing DeepSeek tab -> activated (no duplicate)");
  }

  // --- Test 4: non-DeepSeek tabs are ignored ---
  {
    const fake = createFakeChrome();
    fake.state.tabs.push({ id: 1, url: "https://example.com/", active: true, windowId: 1 });
    fake.state.tabs.push({
      id: 2,
      url: "https://chat.deepseek.com.evil.example/",
      active: true,
      windowId: 1,
    });
    const found = await findDeepSeekTab(fake.chromeApi);
    assert.strictEqual(found, null, "lookalike domain must not match");
    const result = await openDeepSeekTab(fake.chromeApi);
    assert.strictEqual(result.status, "created");
    assert.strictEqual(fake.state.created, 1);
    console.log("PASS lookalike / unrelated tabs do not count as DeepSeek");
  }

  // --- Test 5: many rapid clicks -> exactly one DeepSeek tab ---
  {
    const fake = createFakeChrome();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => queueOpenDeepSeek(fake.chromeApi))
    );
    assert.strictEqual(fake.state.created, 1, "only one tab ever created");
    assert.strictEqual(
      fake.state.tabs.filter((t) => t.url.startsWith("https://chat.deepseek.com/")).length,
      1,
      "exactly one DeepSeek tab"
    );
    assert.ok(results.every((r) => r.status === "created" || r.status === "activated"));
    console.log("PASS 6 concurrent opens -> exactly one DeepSeek tab (serialized)");
  }

  console.log("\nALL EXTENSION TAB TESTS PASSED");
  process.exit(0);
})().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
