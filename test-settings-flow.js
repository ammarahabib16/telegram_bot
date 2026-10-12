// Harness: loads index.js with a fake Telegraf,
// then drives the registered handlers with mock contexts.
const assert = require("assert");

// First verify every Telegraf API that index.js uses exists on the REAL package
const realTelegraf = require("telegraf");
for (const m of ["start", "command", "action", "on", "catch", "launch", "stop"]) {
  assert(
    typeof realTelegraf.Telegraf.prototype[m] === "function",
    `real Telegraf is missing .${m}()`
  );
}
for (const m of ["answerCbQuery", "editMessageReplyMarkup", "reply"]) {
  assert(
    typeof realTelegraf.Context.prototype[m] === "function",
    `real Telegraf Context is missing .${m}()`
  );
}
console.log("PASS real Telegraf API surface verified");

const telegrafPath = require.resolve("telegraf");

const order = [];
const handlers = {};

class FakeBot {
  constructor() {
    handlers._instance = this;
  }
  start(h) {
    order.push("start");
    handlers.start = h;
  }
  command(cmd, h) {
    order.push(`command:${cmd}`);
    handlers[`command:${cmd}`] = h;
  }
  action(trigger, h) {
    order.push("action");
    handlers.action = { trigger, h };
  }
  on(event, h) {
    order.push(`on:${event}`);
    handlers[`on:${event}`] = h;
  }
  catch() {}
  launch() {
    return Promise.resolve();
  }
  stop() {}
  get telegram() {
    return { getMe: async () => ({ username: "fakebot" }) };
  }
}

require.cache[telegrafPath] = {
  id: telegrafPath,
  filename: telegrafPath,
  loaded: true,
  exports: { Telegraf: FakeBot },
};

// Patch the router BEFORE index.js destructures it, to capture wiring.
const router = require("./ai/ai-router");
let captured = null;
let mode = null;
router.generateResponse = async (userId, message) => {
  captured = { userId, message };
  mode = router.getUserMode(userId);
  if (message === "__THROW_FRIENDLY__") {
    const e = new Error("inner");
    e.friendlyMessage =
      "❌ Browser automation is currently unavailable.\n\nnpm run chrome";
    throw e;
  }
  if (message === "__THROW_PLAIN__") throw new Error("boom");
  return "MOCK_ANSWER";
};

// Patch the extension adapter BEFORE index.js destructures openDeepSeekTab.
const extensionAdapter = require("./ai/extension");
const openCalls = [];
let openShouldFail = false;
extensionAdapter.openDeepSeekTab = async () => {
  openCalls.push(Date.now());
  if (openShouldFail) {
    const e = new Error("simulated extension failure");
    e.friendlyMessage = extensionAdapter.EXTENSION_UNAVAILABLE_MESSAGE;
    e.details = "extension_unavailable";
    throw e;
  }
  return { ok: true, status: "created", tabId: 7 };
};

require("./index.js");

const settingCmd = handlers["command:setting"];
const cbHandler = handlers.action;
const textHandler = handlers["on:text"];

const KEYBOARD_ALL = [
  [["✅ 🤖 Ollama", "settings:ollama"]],
  [["🌐 Browser Automation", "settings:browser"]],
  [["🧩 Browser Extension", "settings:extension"]],
];

const shape = (markup) =>
  markup.inline_keyboard.map((row) => row.map((b) => [b.text, b.callback_data]));

(async () => {
  // --- registration order ---
  const idxSetting = order.indexOf("command:setting");
  const idxText = order.indexOf("on:text");
  assert(idxSetting !== -1 && idxText !== -1, "handlers registered");
  assert(idxSetting < idxText, "/setting must register before text handler");
  assert(
    String(cbHandler.trigger) === "/^settings:(ollama|browser|extension)$/",
    "action covers all three modes"
  );
  console.log("PASS handler registration (3-mode action regex)");

  // --- Test 1: /setting for new user -> default Ollama, exactly three buttons ---
  const replies = [];
  await settingCmd({
    from: { id: 111 },
    reply: async (text, extra) => replies.push({ text, extra }),
  });
  const m1 = replies[0];
  assert(m1.text && m1.text.trim().length > 0, "text must be non-empty for Telegram API");
  assert(!m1.text.includes("AI Settings"), "must NOT contain 'AI Settings' heading");
  assert(!m1.text.includes("Choose your AI mode"), "must NOT contain unnecessary text");
  assert(!m1.text.includes("Current mode"), "must NOT contain explanatory paragraph");
  const kb1 = m1.extra.reply_markup.inline_keyboard;
  assert.strictEqual(kb1.length, 3, "exactly three buttons");
  assert.deepStrictEqual(
    shape(m1.extra.reply_markup),
    KEYBOARD_ALL,
    "default keyboard: [ ✅ 🤖 Ollama ] / [ 🌐 Browser Automation ] / [ 🧩 Browser Extension ]"
  );
  console.log("PASS /setting default (new user -> ✅ 🤖 Ollama, 3 buttons, no heading)");

  // --- Test 2: Switch to Browser Automation ---
  const answers = [];
  const edits = [];
  await cbHandler.h({
    match: ["settings:browser", "browser"],
    from: { id: 111 },
    answerCbQuery: async (t) => answers.push(t),
    editMessageReplyMarkup: async (markup) => edits.push(markup),
  });
  assert.strictEqual(answers.length, 1, "callback query answered");
  assert.strictEqual(edits.length, 1, "settings keyboard updated via editMessageReplyMarkup");
  assert.deepStrictEqual(
    shape(edits[0]),
    [
      [["🤖 Ollama", "settings:ollama"]],
      [["✅ 🌐 Browser Automation", "settings:browser"]],
      [["🧩 Browser Extension", "settings:extension"]],
    ],
    "checkmark moved to Browser Automation"
  );
  assert.strictEqual(router.getUserMode(111), "browser", "mode saved for user 111");
  assert.strictEqual(router.getUserMode(222), "ollama", "user 222 remains default ollama");
  assert.strictEqual(openCalls.length, 0, "browser selection does not touch the extension");
  console.log("PASS switch to Browser + per-user isolation");

  // --- Test 3: Duplicate press does not crash ---
  const editErr = new Error("400: message is not modified");
  await cbHandler.h({
    match: ["settings:browser", "browser"],
    from: { id: 111 },
    answerCbQuery: async () => {},
    editMessageReplyMarkup: async () => {
      throw editErr;
    },
  });
  console.log("PASS duplicate press does not crash");

  // --- Test 4: Text routing with browser mode ---
  captured = null;
  const out = [];
  await textHandler({
    message: { text: "capital of australia" },
    from: { id: 111 },
    sendChatAction: async () => {},
    reply: async (t) => out.push(t),
  });
  assert.deepStrictEqual(captured, { userId: 111, message: "capital of australia" });
  assert.strictEqual(mode, "browser", "routed to browser adapter");
  assert.deepStrictEqual(out, ["MOCK_ANSWER"]);
  console.log("PASS text -> router (browser mode, user id passed)");

  // --- Test 5: Text routing default user -> ollama ---
  captured = null;
  out.length = 0;
  await textHandler({
    message: { text: "hello" },
    from: { id: 222 },
    sendChatAction: async () => {},
    reply: async (t) => out.push(t),
  });
  assert.strictEqual(mode, "ollama", "routed to ollama adapter");
  assert.deepStrictEqual(out, ["MOCK_ANSWER"]);
  console.log("PASS text -> router (ollama default)");

  // --- Test 6: Browser error -> friendly Telegram error ---
  out.length = 0;
  await textHandler({
    message: { text: "__THROW_FRIENDLY__" },
    from: { id: 111 },
    sendChatAction: async () => {},
    reply: async (t) => out.push(t),
  });
  assert(
    out[0].startsWith("❌ Browser automation is currently unavailable."),
    "friendly error: " + out[0]
  );
  console.log("PASS browser error -> friendly Telegram error");

  // --- Test 7: Plain error -> existing error text ---
  out.length = 0;
  await textHandler({
    message: { text: "__THROW_PLAIN__" },
    from: { id: 222 },
    sendChatAction: async () => {},
    reply: async (t) => out.push(t),
  });
  assert.strictEqual(
    out[0],
    "Sorry, I could not connect to DeepSeek or generation took too long."
  );
  console.log("PASS plain error -> existing error message");

  // --- Test 8: Switch back to Ollama ---
  const backEdits = [];
  await cbHandler.h({
    match: ["settings:ollama", "ollama"],
    from: { id: 111 },
    answerCbQuery: async () => {},
    editMessageReplyMarkup: async (markup) => backEdits.push(markup),
  });
  assert.deepStrictEqual(
    shape(backEdits[0]),
    KEYBOARD_ALL,
    "checkmark back on Ollama"
  );
  assert.strictEqual(router.getUserMode(111), "ollama");
  console.log("PASS switch back to Ollama");

  // --- Test 9: Select Browser Extension -> mode stored + DeepSeek opened ---
  const extEdits = [];
  const extReplies = [];
  const extAnswers = [];
  openShouldFail = false;
  const before = openCalls.length;
  await cbHandler.h({
    match: ["settings:extension", "extension"],
    from: { id: 111 },
    answerCbQuery: async (t) => extAnswers.push(t),
    editMessageReplyMarkup: async (markup) => extEdits.push(markup),
    reply: async (t) => extReplies.push(t),
  });
  assert.strictEqual(router.getUserMode(111), "extension", "extension mode stored for 111");
  assert.strictEqual(openCalls.length, before + 1, "openDeepSeekTab triggered once");
  assert.strictEqual(extReplies.length, 0, "no error reply on success");
  assert.strictEqual(extAnswers.length, 1, "callback answered");
  assert.deepStrictEqual(
    shape(extEdits[0]),
    [
      [["🤖 Ollama", "settings:ollama"]],
      [["🌐 Browser Automation", "settings:browser"]],
      [["✅ 🧩 Browser Extension", "settings:extension"]],
    ],
    "checkmark on Browser Extension, still exactly three buttons"
  );
  console.log("PASS select Browser Extension -> mode stored + DeepSeek open triggered");

  // --- Test 10: Extension unavailable -> friendly Telegram message ---
  const failReplies = [];
  openShouldFail = true;
  await cbHandler.h({
    match: ["settings:extension", "extension"],
    from: { id: 111 },
    answerCbQuery: async () => {},
    editMessageReplyMarkup: async () => {},
    reply: async (t) => failReplies.push(t),
  });
  openShouldFail = false;
  assert.strictEqual(failReplies.length, 1, "friendly error sent to Telegram");
  assert.strictEqual(
    failReplies[0],
    extensionAdapter.EXTENSION_UNAVAILABLE_MESSAGE
  );
  assert(/Telegrambot Chrome Extension/.test(failReplies[0]));
  assert(!/127\.0\.0\.1|localhost|:\d{4}|bridge/i.test(failReplies[0]), "no internals leaked");
  assert.strictEqual(router.getUserMode(111), "extension", "mode still stored");
  console.log("PASS extension unavailable -> exact friendly message, no internals");

  // --- Test 11: Text routing in extension mode ---
  captured = null;
  out.length = 0;
  await textHandler({
    message: { text: "route me to the extension" },
    from: { id: 111 },
    sendChatAction: async () => {},
    reply: async (t) => out.push(t),
  });
  assert.deepStrictEqual(captured, {
    userId: 111,
    message: "route me to the extension",
  });
  assert.strictEqual(mode, "extension", "routed to Browser Extension adapter");
  assert.deepStrictEqual(out, ["MOCK_ANSWER"]);
  console.log("PASS text -> router (extension mode)");

  // --- Test 12: User isolation for extension mode ---
  const isoEdits = [];
  await cbHandler.h({
    match: ["settings:extension", "extension"],
    from: { id: 222 },
    answerCbQuery: async () => {},
    editMessageReplyMarkup: async (markup) => isoEdits.push(markup),
  });
  assert.strictEqual(router.getUserMode(222), "extension", "user 222 now on extension");
  assert.strictEqual(router.getUserMode(111), "extension", "user 111 unchanged");
  const isoBack = [];
  await cbHandler.h({
    match: ["settings:ollama", "ollama"],
    from: { id: 222 },
    answerCbQuery: async () => {},
    editMessageReplyMarkup: async (markup) => isoBack.push(markup),
  });
  assert.strictEqual(router.getUserMode(222), "ollama", "user 222 back to ollama");
  assert.strictEqual(router.getUserMode(111), "extension", "user 111 still extension");
  console.log("PASS extension mode is per-user (isolation preserved)");

  console.log("\nALL HARNESS TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
