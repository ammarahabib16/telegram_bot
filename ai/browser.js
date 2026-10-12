const { ask } = require("../deepseek-chat");

// Sequential queue lock: prevents concurrent browser requests from interfering on the same DeepSeek page
let pendingQueue = Promise.resolve();

// The ONLY text Browser Automation failures may send to Telegram.
// Raw Playwright errors (locator details, stack traces, DOM internals,
// timeouts) must stay in the terminal - index.js logs the original error
// via console.error("DeepSeek generation error:", error.cause || error).
const BROWSER_UNAVAILABLE_MESSAGE =
  "Timeout: Browser automation is currently unavailable.";

async function browserResponse(message) {
  const run = async () => {
    try {
      return await ask(message);
    } catch (err) {
      const error = new Error(err.message);
      error.name = "BrowserError";
      error.cause = err;
      error.friendlyMessage = BROWSER_UNAVAILABLE_MESSAGE;
      throw error;
    }
  };

  const current = pendingQueue.then(run, run);
  pendingQueue = current.catch(() => {});
  return current;
}

module.exports = { browserResponse, BROWSER_UNAVAILABLE_MESSAGE };
