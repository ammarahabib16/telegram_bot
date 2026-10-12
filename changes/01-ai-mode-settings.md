# Change 01: AI Mode Selection with `/setting`

## Overview

Added user-selectable AI mode switching between **Ollama Mode** (Cloud/Local Ollama) and **Browser Automation Mode** (Playwright + Chrome CDP + DeepSeek Web) via the `/setting` Telegram command.

Mode selection is stored on a per-user basis in-memory, defaulting to `ollama` for new or unconfigured users. Normal messages are dispatched through an AI routing layer without altering or replacing existing provider implementations.

---

## What Was Changed

1. **AI Routing Architecture (`ai/` directory)**:
   - [`ai/ai-router.js`](file:///D:/telegram-deepseek-bot/ai/ai-router.js): Manages per-user AI mode state (`userModes` Map keyed by Telegram user ID) and exports `generateResponse(userId, message)`, `getUserMode(userId)`, `setUserMode(userId, mode)`.
   - [`ai/browser.js`](file:///D:/telegram-deepseek-bot/ai/browser.js): Adapter wrapping the existing [`deepseek-chat.js`](file:///D:/telegram-deepseek-bot/deepseek-chat.js) `ask()` function. Provides friendly error messages when Chrome CDP is unavailable without exposing stack traces to Telegram users.
   - [`ai/ollama.js`](file:///D:/telegram-deepseek-bot/ai/ollama.js): Adapter preserving existing Ollama Cloud configuration, system prompt, response cleaning (`<think>` tags stripping), Telegram formatting, and API requests.

2. **Telegram Bot (`index.js`)**:
   - Added the `/setting` command to display current AI mode and inline selection keyboard.
   - Added regex action handler `^settings:(ollama|browser)$` for handling button presses, updating user mode state, answering callback queries to dismiss loading spinners, and editing the settings message inline.
   - Updated message handler `bot.on("text")` to route user messages through `generateResponse(ctx.from?.id, userMessage)`.
   - Maintained all existing commands (`/start`), error handlers, typing action intervals, text chunking, and network retry logic.

---

## `/setting` Command & Inline Keyboard

- **Command**: `/setting`
- **Interface**:
  ```text
  ⚙️ AI Settings

  Choose your AI mode:

  🤖 Ollama
  🌐 Browser Automation

  Current mode: 🤖 Ollama
  ```
- **Inline Buttons**:
  - `[ ✅ Ollama ]` / `[ 🌐 Browser Automation ]` (when Ollama is active)
  - `[ 🤖 Ollama ]` / `[ ✅ Browser Automation ]` (when Browser Automation is active)
- **Callback Data**: `settings:ollama` and `settings:browser`
- **Inline Updates**: Updates the message in-place with confirmation and checkmark indicator.

---

## Mode Details

### 1. Ollama Mode (`ollama`)
- Default mode for all users.
- Connects to Ollama using `OLLAMA_URL` and `OLLAMA_MODEL`.
- Retains existing Telegram-specific Markdown formatting and system prompt rules.

### 2. Browser Automation Mode (`browser`)
- Connects to Chrome over CDP via `http://127.0.0.1:9333` (or `CDP_URL`).
- Reuses `deepseek-chat.js` for interacting with `https://chat.deepseek.com/` using the `ammara` profile copy.
- No DeepSeek API, token extraction, or credential scraping.
- Friendly error if Chrome or the DeepSeek tab is unavailable:
  ```text
  ❌ Browser automation is currently unavailable.

  Make sure Chrome is running with:

  npm run chrome
  ```

---

## User-Specific Mode Storage

- In-memory `Map` storing `userId -> mode`.
- Isolated per user: User A switching to `browser` does not affect User B remaining on `ollama`.
- Defaults to `ollama` if no mode has been set.

---

## Files Changed / Created

- [`package.json`](file:///D:/telegram-deepseek-bot/package.json): Added `"start": "node index.js"` script for standard bot startup.
- [`ai/ai-router.js`](file:///D:/telegram-deepseek-bot/ai/ai-router.js): Per-user state storage and dispatch logic.
- [`ai/browser.js`](file:///D:/telegram-deepseek-bot/ai/browser.js): Browser automation adapter with friendly error formatting.
- [`ai/ollama.js`](file:///D:/telegram-deepseek-bot/ai/ollama.js): Ollama API adapter and formatting rules.
- [`index.js`](file:///D:/telegram-deepseek-bot/index.js): Bot startup lifecycle, proxy agent integration, commands, callback query handling, and message routing.
- [`test-settings-flow.js`](file:///D:/telegram-deepseek-bot/test-settings-flow.js): Integration test harness validating Telegraf API surface, `/setting` interactions, mode switching, user isolation, error handling, and routing.
- [`changes/01-ai-mode-settings.md`](file:///D:/telegram-deepseek-bot/changes/01-ai-mode-settings.md): Feature documentation.

---

## Testing Performed

- Verified Telegraf API compatibility across all registered handlers.
- Verified `/setting` command displays default Ollama mode and proper keyboard layout.
- Verified inline button click switches mode to `browser`, answers callback query, edits message, and persists mode for the specific user.
- Verified duplicate inline button clicks do not crash on "message is not modified" errors.
- Verified user isolation (User 1 on browser mode, User 2 on default Ollama mode).
- Verified text handler routes queries according to the user's active mode.
- Verified friendly error display on browser automation failure and preserved error display on plain Ollama errors.
- Verified switching back to Ollama mode.
- All automated harness tests executed and passed (`ALL HARNESS TESTS PASSED`).

---

## Limitations

- **Browser Mode Prerequisite**: Browser Automation requires Chrome to be started beforehand via `npm run chrome` with a valid DeepSeek session tab.
- **In-Memory Storage**: User mode selections are stored in memory and reset to default (`ollama`) if the bot process restarts. Persistent database storage can be attached to `ai/ai-router.js` if persistent preferences across bot restarts are required in the future.
