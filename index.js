require("dotenv").config();
console.log("🚀 Starting Telegram bot...");

const realNodeFetch = require("node-fetch");
const realFetch = globalThis.fetch;

// Telegraf internally uses "node-fetch".
// When an explicit proxy agent is used, delegate directly to real node-fetch.
// Otherwise, route through Node's built-in fetch so requests go through the system network stack.
function fetchShim(url, init) {
  if (init?.agent) {
    return realNodeFetch(url, init);
  }

  // Strip node-fetch-specific options that built-in fetch doesn't understand
  const { agent, timeout, compress, ...rest } = init || {};
  // Convert node-fetch's timeout (ms) to an AbortSignal if no signal was given
  if (timeout && !rest.signal) {
    rest.signal = AbortSignal.timeout(timeout);
  }
  return realFetch(url, rest).catch((err) => {
    // Let Telegraf stop polling gracefully
    if (err?.name === "AbortError") throw err;

    // Telegraf only retries failures named "FetchError"
    // (see telegraf/lib/core/network/polling.js), while undici throws
    // "TypeError: fetch failed" with an ETIMEDOUT cause. Translate it so a
    // short network blip is retried instead of crashing the bot.
    const cause = err?.cause ?? err;
    const wrapped = new Error(
      `request to ${url} failed, reason: ${
        cause?.code || cause?.message || err?.message || "network error"
      }`
    );
    wrapped.name = "FetchError";
    wrapped.type = "system";
    wrapped.code = cause?.code;
    wrapped.errno = cause?.errno;
    wrapped.cause = cause;
    throw wrapped;
  });
}
require.cache[require.resolve("node-fetch")] = {
  id: require.resolve("node-fetch"),
  filename: require.resolve("node-fetch"),
  loaded: true,
  exports: Object.assign(fetchShim, { default: fetchShim }),
};

const { Telegraf } = require("telegraf");
const { HttpsProxyAgent } = require("https-proxy-agent");

const {
  generateResponse,
  getUserMode,
  setUserMode,
} = require("./ai/ai-router");
const { openDeepSeekTab } = require("./ai/extension");
const { replyFormatted } = require("./ai/format");

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN is missing in environment or .env file.");
  process.exit(1);
}

const proxyUrl =
  process.env.TELEGRAM_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.ALL_PROXY;

const telegrafOptions = {
  handlerTimeout: 900000, // 15 minutes timeout for slow local CPU inference
};

if (proxyUrl) {
  telegrafOptions.telegram = {
    agent: new HttpsProxyAgent(proxyUrl),
  };
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, telegrafOptions);
console.log("✅ Telegraf initialized");

bot.start((ctx) => {
  ctx.reply(
    "👋 Hello! I am your local DeepSeek AI assistant."
  );
});

const MODE_INFO = {
  ollama: { label: "Ollama", icon: "🤖" },
  browser: { label: "Browser Automation", icon: "🌐" },
  extension: { label: "Browser Extension", icon: "🧩" },
};

const SETTINGS_MODES = ["ollama", "browser", "extension"];

function settingsKeyboard(currentMode) {
  const button = (mode) => ({
    text:
      mode === currentMode
        ? `✅ ${MODE_INFO[mode].icon} ${MODE_INFO[mode].label}`
        : `${MODE_INFO[mode].icon} ${MODE_INFO[mode].label}`,
    callback_data: `settings:${mode}`,
  });
  return { inline_keyboard: SETTINGS_MODES.map((mode) => [button(mode)]) };
}

const SETTINGS_TEXT = "⚙️";

bot.command("setting", (ctx) => {
  const mode = getUserMode(ctx.from?.id);
  return ctx.reply(SETTINGS_TEXT, {
    reply_markup: settingsKeyboard(mode),
  });
});

bot.action(/^settings:(ollama|browser|extension)$/, async (ctx) => {
  const mode = ctx.match[1];
  if (ctx.from?.id) {
    setUserMode(ctx.from.id, mode);
  }

  await ctx
    .answerCbQuery(`AI mode set to ${MODE_INFO[mode].label}.`)
    .catch(() => {});

  try {
    await ctx.editMessageReplyMarkup(settingsKeyboard(mode));
  } catch (err) {
    if (!/not modified/i.test(err.message)) {
      console.error("Failed to update settings keyboard:", err);
    }
  }

  if (mode === "extension") {
    // Stage 1: selecting the mode opens/activates the DeepSeek tab through
    // the local bridge -> Chrome extension. Errors are logged locally and
    // only a friendly message is sent to Telegram.
    try {
      const result = await openDeepSeekTab();
      console.log(
        `🧩 DeepSeek tab ${result.status || "handled"} (tab ${result.tabId ?? "?"})`
      );
    } catch (err) {
      console.error(`🧩 Browser Extension open failed: ${err.details || err.message}`);
      await ctx
        .reply(
          err.friendlyMessage ||
            "❌ Browser Extension is not available.\n\n" +
              "Please make sure the Telegrambot Chrome Extension is installed and Chrome is running."
        )
        .catch(() => {});
    }
  }
});
console.log("✅ /setting registered");

bot.on("text", async (ctx) => {
  const userMessage = ctx.message.text;

  // Send typing indicator every 4 seconds while DeepSeek generates response
  await ctx.sendChatAction("typing").catch(() => {});
  const typingInterval = setInterval(() => {
    ctx.sendChatAction("typing").catch(() => {});
  }, 4000);

  try {
    const answer = await generateResponse(ctx.from?.id, userMessage);
    clearInterval(typingInterval);
    await replyFormatted(ctx, answer);
  } catch (error) {
    clearInterval(typingInterval);
    console.error("DeepSeek generation error:", error.cause || error);

    await ctx.reply(
      error.friendlyMessage ||
        "Sorry, I could not connect to DeepSeek or generation took too long."
    ).catch(() => {});
  }
});
console.log("✅ AI router initialized");

// Catch any unhandled middleware errors so bot polling doesn't crash
bot.catch((err, ctx) => {
  console.error(`Error for update ${ctx?.update?.update_id}:`, err);
});

let stopping = false;

// --- Local bridge for Browser Extension mode (bound to 127.0.0.1 only) ---
const { startBridge } = require("./bridge/extension-bridge");
const BRIDGE_RETRY_MS = 15000;
let extensionBridge = null;
let bridgeRetryTimer = null;
let bridgeStarting = false;
let bridgeLastError = null;

async function startExtensionBridge() {
  if (extensionBridge || bridgeStarting || stopping) return;
  bridgeStarting = true;
  try {
    extensionBridge = await startBridge();
    bridgeLastError = null;
    if (bridgeRetryTimer) {
      clearInterval(bridgeRetryTimer);
      bridgeRetryTimer = null;
    }
  } catch (err) {
    extensionBridge = null;
    const port = process.env.EXTENSION_BRIDGE_PORT || 8765;
    const reason =
      err && err.code === "EADDRINUSE"
        ? `port ${port} is already in use (another instance holding it?)`
        : `failed to start on port ${port}: ${err.message || err}`;

    // Log only when the failure state changes - retries happen every 15s.
    if (reason !== bridgeLastError) {
      console.error(`⚠️ Extension bridge not up (${reason}).`);
      console.error(
        `   Retrying every ${BRIDGE_RETRY_MS / 1000}s until it starts ` +
          "- Browser Extension mode cannot work without it."
      );
      bridgeLastError = reason;
    }

    // Self-heal: the port may free up later (stale instance shutting down,
    // transient bind failure). Never stay dead silently - a dead bridge is
    // what produced "open-deepseek failed: fetch failed (bridge unreachable)".
    if (!bridgeRetryTimer && !stopping) {
      bridgeRetryTimer = setInterval(() => {
        if (stopping) {
          clearInterval(bridgeRetryTimer);
          bridgeRetryTimer = null;
          return;
        }
        startExtensionBridge();
      }, BRIDGE_RETRY_MS);
    }
  } finally {
    bridgeStarting = false;
  }
}

const stop = (signal) => {
  stopping = true;
  console.log(`\n${signal} received, stopping bot...`);
  if (bridgeRetryTimer) {
    clearInterval(bridgeRetryTimer);
    bridgeRetryTimer = null;
  }
  if (extensionBridge) {
    extensionBridge.close().catch(() => {});
    extensionBridge = null;
  }
  try {
    bot.stop(signal);
  } catch {
    // Bot is not running yet (still waiting to connect)
  }
};

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

const RECONNECT_DELAY_MS = 5000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isNetworkError = (error) =>
  error?.name === "FetchError" ||
  error?.type === "system" ||
  error?.code === "ETIMEDOUT" ||
  error?.code === "ECONNRESET" ||
  error?.code === "ENOTFOUND" ||
  error?.code === "EAI_AGAIN";

async function startBot() {
  while (!stopping) {
    try {
      const botInfo = await bot.telegram.getMe();
      console.log(`🤖 Telegram bot @${botInfo.username} is running...`);
      await bot.launch();
      return;
    } catch (error) {
      if (stopping) return;

      if (!isNetworkError(error)) {
        console.error("Bot failed to start:", error);
        process.exit(1);
      }

      console.error(`Could not reach Telegram: ${error.message}`);
      console.error(
        `Retrying in ${RECONNECT_DELAY_MS / 1000}s. ` +
          "Make sure your VPN is connected and routing traffic to api.telegram.org."
      );
      await wait(RECONNECT_DELAY_MS);
    }
  }
}

async function main() {
  if (require.main === module) {
    await startExtensionBridge();
  }
  await startBot();
}

main().catch((error) => {
  console.error("Bot failed to start:", error);
  process.exit(1);
});
