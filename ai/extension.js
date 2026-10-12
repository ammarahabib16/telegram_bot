"use strict";

// Browser Extension mode adapter.
//
// Talks to the local bridge (bridge/extension-bridge.js), which in turn is
// polled by the Telegrambot Chrome Extension. Nothing here talks to Chrome
// directly and no secret is ever sent to the extension.

const EXTENSION_UNAVAILABLE_MESSAGE =
  "❌ Browser Extension is not available.\n\n" +
  "Please make sure the Telegrambot Chrome Extension is installed and Chrome is running.";

const EXTENSION_FAILED_MESSAGE =
  "❌ Browser Extension could not complete the request.\n\n" +
  "Please make sure the Telegrambot Chrome Extension is installed, enabled and Chrome is running.";

function bridgeBase() {
  const port = Number(process.env.EXTENSION_BRIDGE_PORT) || 8765;
  return `http://127.0.0.1:${port}`;
}

function friendlyError(friendlyMessage, details) {
  const error = new Error(friendlyMessage);
  error.friendlyMessage = friendlyMessage;
  error.details = details;
  return error;
}

async function bridgeHealth() {
  try {
    const res = await fetch(`${bridgeBase()}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return await res.json();
  } catch {
    return null;
  }
}

async function bridgePost(path, body, timeoutMs) {
  const res = await fetch(`${bridgeBase()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

function logFailure(prefix, error, health) {
  const seen =
    health && typeof health.lastExtensionSeenMs === "number"
      ? `extension last seen ${Math.round(health.lastExtensionSeenMs / 1000)}s ago`
      : health
        ? "extension has never connected to the bridge"
        : "bridge unreachable";
  console.error(`🧩 ${prefix}: ${error.message} (${seen})`);
}

/**
 * Stage 1: ask the extension to open (or activate) the DeepSeek tab.
 * Resolves with { ok: true, status: "created" | "activated", tabId }.
 * Throws an error carrying a .friendlyMessage safe for Telegram.
 */
async function openDeepSeekTab() {
  const ackTimeoutMs = Number(process.env.EXTENSION_ACK_TIMEOUT_MS) || 40000;
  let res;
  try {
    res = await bridgePost("/extension/open-deepseek", {}, ackTimeoutMs + 5000);
  } catch (err) {
    const health = await bridgeHealth();
    logFailure("open-deepseek failed", err, health);
    throw friendlyError(EXTENSION_UNAVAILABLE_MESSAGE, err.message);
  }

  if (!res.data || res.data.ok !== true) {
    const reason = (res.data && res.data.error) || `http_${res.status}`;
    const health = await bridgeHealth();
    logFailure("open-deepseek rejected", new Error(reason), health);
    if (reason === "extension_unavailable" || reason === "timeout") {
      throw friendlyError(EXTENSION_UNAVAILABLE_MESSAGE, reason);
    }
    throw friendlyError(EXTENSION_FAILED_MESSAGE, reason);
  }

  return res.data.result || { status: "unknown" };
}

/**
 * Stage 2: route a user message through the extension to the DeepSeek tab.
 * Resolves with the DeepSeek answer as a string.
 */
async function extensionResponse(message) {
  const ackTimeoutMs = Number(process.env.EXTENSION_ACK_TIMEOUT_MS) || 40000;
  const askTimeoutMs = Number(process.env.EXTENSION_ASK_TIMEOUT_MS) || 150000;

  let res;
  try {
    res = await bridgePost(
      "/extension/ask",
      { message },
      askTimeoutMs + Math.max(ackTimeoutMs, 10000) + 5000
    );
  } catch (err) {
    const health = await bridgeHealth();
    logFailure("ask failed", err, health);
    throw friendlyError(EXTENSION_UNAVAILABLE_MESSAGE, err.message);
  }

  if (!res.data || res.data.ok !== true) {
    const reason = (res.data && res.data.error) || `http_${res.status}`;
    const health = await bridgeHealth();
    logFailure("ask rejected", new Error(reason), health);

    if (reason === "timeout") {
      const error = new Error("extension ask timeout");
      error.friendlyMessage = "❌ DeepSeek took too long to respond. Please try again.";
      error.details = reason;
      throw error;
    }
    throw friendlyError(
      reason === "extension_unavailable" ? EXTENSION_UNAVAILABLE_MESSAGE : EXTENSION_FAILED_MESSAGE,
      reason
    );
  }

  const response = res.data.result && res.data.result.response;
  if (typeof response !== "string" || !response.trim()) {
    throw friendlyError(EXTENSION_FAILED_MESSAGE, "empty_response");
  }
  return response;
}

/**
 * Ask the extension to reload its background service worker.
 */
async function reloadExtension() {
  try {
    const res = await bridgePost("/extension/reload", {}, 6000);
    return res.data && res.data.ok === true;
  } catch {
    return false;
  }
}

module.exports = {
  openDeepSeekTab,
  extensionResponse,
  reloadExtension,
  EXTENSION_UNAVAILABLE_MESSAGE,
  EXTENSION_FAILED_MESSAGE,
};
