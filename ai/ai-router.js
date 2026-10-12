const ollama = require("./ollama");
const browser = require("./browser");
const extension = require("./extension");
const { formatAnswer } = require("./format");

const DEFAULT_MODE = "ollama";
const VALID_MODES = new Set(["ollama", "browser", "extension"]);

// telegramUserId (string) -> "ollama" | "browser" | "extension"
// In-memory per-user mode storage; defaults to Ollama when unset.
const userModes = new Map();

function getUserMode(userId) {
  if (!userId) return DEFAULT_MODE;
  return userModes.get(String(userId)) || DEFAULT_MODE;
}

function setUserMode(userId, mode) {
  if (!userId) return;
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Unknown AI mode: ${mode}`);
  }
  userModes.set(String(userId), mode);
}

// Every mode's answer goes through the shared formatter (ai/format.js) so
// Ollama, Browser Automation, and Browser Extension all produce identical
// clean Telegram text. index.js then renders it to HTML and chunks it.
// Errors (and their friendlyMessage) are thrown before this point and are
// never formatted.
async function generateResponse(userId, message) {
  const mode = getUserMode(userId);
  let answer;
  if (mode === "browser") {
    answer = await browser.browserResponse(message);
  } else if (mode === "extension") {
    answer = await extension.extensionResponse(message);
  } else {
    answer = await ollama.askOllama(message);
  }
  return formatAnswer(answer);
}

module.exports = {
  generateResponse,
  getUserMode,
  setUserMode,
  DEFAULT_MODE,
};
