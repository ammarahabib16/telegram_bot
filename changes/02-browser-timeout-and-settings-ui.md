# Change 02: Fix Browser Automation Timeout + Simplify `/setting` UI

## Overview

1. **Browser Automation Timeout Fix**: Resolved the 120-second timeout bug occurring on consecutive prompts (especially 3rd+ prompts) caused by DeepSeek Web's virtual list unmounting older DOM nodes during viewport scrolling.
2. **Sequential Queue Locking**: Implemented sequential request locking in [`ai/browser.js`](file:///D:/telegram-deepseek-bot/ai/browser.js) to prevent concurrent messages from colliding on the same DeepSeek web page.
3. **Simplified `/setting` UI**: Removed all headings, explanatory paragraphs, and extra messages. The `/setting` command now displays only the two inline buttons with a checkmark indicator directly on the selected button (`[ ✅ 🤖 Ollama ]` or `[ ✅ 🌐 Browser Automation ]`).

---

## Root Cause Analysis

- **DOM Virtualization (`ds-virtual-list`)**: DeepSeek Web uses a virtualized list container (`ds-virtual-list-visible-items`) that unmounts older chat messages from the DOM when scrolling down.
- **Flawed Detection Condition**: The previous code measured `before = await page.locator(ASSISTANT_SEL).count()` and waited for `count > before`. After 2–3 turns, virtual scrolling reduced the number of mounted message nodes in the DOM (e.g. from 3 to 2), making `count > before` (`2 > 3`) mathematically impossible. The polling loop then stalled indefinitely until hitting the 120s timeout.

---

## What Was Changed

### 1. [`deepseek-chat.js`](file:///D:/telegram-deepseek-bot/deepseek-chat.js)
- Replaced the flawed `count > before` requirement with baseline state tracking (`baselineCount`, `baselineText`).
- Handled submission acknowledgment by monitoring textarea clearance, input events, and send button state.
- Detected generation progress and completion using idle indicators (send SVG circle icon, absence of stop button, disabled state).
- Added stabilization checks across consecutive polls (`stablePolls`) to return complete responses without premature truncation.

### 2. [`ai/browser.js`](file:///D:/telegram-deepseek-bot/ai/browser.js)
- Added sequential request queueing via a promise chain lock (`pendingQueue`) so multiple Telegram messages are processed one after another on the single DeepSeek page.
- Added distinguished friendly error messaging for timeouts vs offline Chrome.

### 3. [`index.js`](file:///D:/telegram-deepseek-bot/index.js)
- Removed `AI Settings` text, headings, and extra paragraphs from `/setting`.
- Set minimal visible emoji `⚙️` for Telegram Bot API `sendMessage` compliance (Telegram rejects empty strings with `400: Bad Request: text must be non-empty`).
- Used `ctx.editMessageReplyMarkup()` on button actions to toggle inline keyboard checkmarks smoothly in-place without touching message text.
- Updated keyboard button formatting:
  - Default / Ollama active: `[ ✅ 🤖 Ollama ]` and `[ 🌐 Browser Automation ]`
  - Browser active: `[ 🤖 Ollama ]` and `[ ✅ 🌐 Browser Automation ]`

### 4. [`test-settings-flow.js`](file:///D:/telegram-deepseek-bot/test-settings-flow.js)
- Updated test harness assertions to verify that no `AI Settings` heading or unnecessary text is rendered and that button checkmarks toggle properly.

---

## Testing & Verification

1. **Automated Test Suite**:
   - Ran `node test-settings-flow.js`: all tests passed (`ALL HARNESS TESTS PASSED`).
2. **Consecutive Real Browser Requests**:
   - Prompt 1: "What is the capital of Japan?" → `Tokyo` (3.8s)
   - Prompt 2: "What is the capital of Germany?" → `Berlin` (3.4s)
   - Prompt 3: "What is the capital of Italy?" → `Rome` (3.2s)
   - Prompt 4: "What is the capital of Canada?" → `Ottawa` (3.5s)
   - Verified zero timeouts across consecutive prompts.
