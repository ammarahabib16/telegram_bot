# Change 03: Browser Extension Mode (third AI mode)

## Overview

Added `🧩 Browser Extension` as a third selectable AI mode alongside
`🤖 Ollama` and `🌐 Browser Automation`.

```text
Telegram
   -> index.js
   -> AI Router
   -> Browser Extension mode (ai/extension.js)
   -> Local bridge (127.0.0.1:<EXTENSION_BRIDGE_PORT>)
   -> Chrome extension (Manifest V3 service worker, long-poll)
   -> chrome.tabs.create() / activate
   -> https://chat.deepseek.com/
```

The Telegram bot and Chrome run on the same Windows machine; the bridge is a
small localhost-only HTTP server started by the bot. The extension *pulls*
commands from the bridge (long-poll), which is the simplest reliable pattern
for a Manifest V3 service worker.

The existing Ollama and Browser Automation (Playwright + CDP) modes are
untouched and continue to work exactly as before.

---

## What Was Changed

### New files (bot side)

1. [`bridge/extension-bridge.js`](file:///D:/telegram-deepseek-bot/bridge/extension-bridge.js)
   - Local HTTP server bound to `127.0.0.1` only (plus an extra connection
     filter that destroys any non-loopback socket).
   - `POST /extension/open-deepseek` - enqueues `open_deepseek`, waits for the
     extension to acknowledge, returns `{ ok, result:{status,tabId} }` or a
     clear `{ ok:false, error }`.
   - `POST /extension/ask {message}` - Stage 2 message round trip.
   - `GET /extension/commands?wait=<ms>` - long-poll used by the extension
     (wait capped at 29s, below Chrome's 30s fetch-response limit).
   - `POST /extension/result` - extension reports a command outcome.
   - `GET /health`, `GET /extension/status` - diagnostics.
   - Commands are delivered exactly once; if the response never reaches the
     extension the command is re-queued. Timed-out commands are removed so a
     stale command can never be delivered later.
   - If the extension has not polled for 50s (Chrome closed / not installed),
     commands fail fast with `extension_unavailable` instead of making the
     user wait out the full timeout.
   - Configurable via `.env`: `EXTENSION_BRIDGE_PORT` (default 8765),
     `EXTENSION_ACK_TIMEOUT_MS` (default 40000 - must cover one 30s
     extension alarm cycle), `EXTENSION_ASK_TIMEOUT_MS` (default 150000).

2. [`ai/extension.js`](file:///D:/telegram-deepseek-bot/ai/extension.js)
   - `openDeepSeekTab()` - Stage 1, called by the `/setting` action handler.
   - `extensionResponse(message)` - Stage 2, called by the AI router.
   - Maps every failure to the friendly Telegram message
     (`EXTENSION_UNAVAILABLE_MESSAGE`, timeout or generic wording); detailed
     diagnostics (including "extension last seen Ns ago") are only logged to
   the local terminal. No localhost/port details ever reach Telegram.

### Modified files (bot side)

3. [`ai/ai-router.js`](file:///D:/telegram-deepseek-bot/ai/ai-router.js)
   - Added `"extension"` to `VALID_MODES`; routes extension-mode messages to
     `extensionResponse()`. Per-user `Map` storage and isolation unchanged.

4. [`index.js`](file:///D:/telegram-deepseek-bot/index.js)
   - `MODE_INFO` + `/setting` keyboard now render exactly three buttons with
     the checkmark on the selected mode; no heading, no explanatory text.
   - Action regex extended to `^settings:(ollama|browser|extension)$`.
   - Selecting `🧩 Browser Extension` stores the mode, updates the keyboard,
     then automatically triggers `openDeepSeekTab()` (Stage 1). Failures
     reply with the friendly "not available" message.
   - Starts the local bridge when run as the main module (`npm start`);
     `EADDRINUSE` is reported locally without crashing the bot.
   - Bridge is closed on `SIGINT`/`SIGTERM`.

5. [`.env`](file:///D:/telegram-deepseek-bot/.env) - `EXTENSION_BRIDGE_PORT=8765`
   (+ commented timeout overrides).

6. [`package.json`](file:///D:/telegram-deepseek-bot/package.json)
   - `npm test` runs all four test suites, `npm run test:e2e` runs the real
     Chrome end-to-end test, `npm run extension:build` builds the extension.

### Chrome extension (existing project extended, no duplicate created)

The repo already contained `chrome-extension-react-template/` (the React +
Vite MV3 template from the reference article), so it was extended in place
instead of creating a second extension project.

7. `chrome-extension-react-template/public/manifest.json`
   - Renamed to **Telegrambot Chrome Extension**, Manifest V3,
     background service worker with `type: module`.

8. `chrome-extension-react-template/src/background/service-worker.js` (new,
   replaces `src/background.ts`)
   - Long-poll loop against the bridge, command dispatch, `chrome.alarms`
     watchdog (30s period) so polling restarts if Chrome terminates the
     worker (MV3 30s idle rule), popup message handlers.

9. `chrome-extension-react-template/src/background/deepseek-tabs.js` (new)
   - `findDeepSeekTab()` / `openDeepSeekTab()` / `queueOpenDeepSeek()`.
   - URL matching uses `https://chat.deepseek.com/` prefix (lookalike domains
     such as `chat.deepseek.com.evil.example` are rejected).
   - Open requests are serialized on a promise chain, so several rapid
     Telegram clicks can never create duplicate DeepSeek tabs.

10. `chrome-extension-react-template/src/background/deepseek-ask.js` (new)
    - Stage 2: injects a self-contained function into the DeepSeek tab with
      `chrome.scripting.executeScript` using the same selectors as
      `deepseek-chat.js`; a trivial extension API call every 25s keeps the
      service worker alive for the duration of that one operation.

11. `chrome-extension-react-template/src/background/bridge-client.js` (new)
    - Long-poll/result client; bridge port is injected at build time from
      `../.env` via `vite.config.ts` (`define`), so both sides always agree.

12. `chrome-extension-react-template/src/App.tsx` + `App.css`
    - Popup now shows bridge connection status, last command, and a manual
      "Open DeepSeek now" button (normal operation never needs the popup).

13. `vite.config.ts`, `vite-env.d.ts`, `index.html`, `README.md`,
    `eslint.config.js` (ESLint 9 flat config - the template shipped ESLint 9
    with a legacy `.eslintrc.cjs` that ESLint 9 refuses to load; `.eslintrc.cjs`
    removed).

---

## Manifest Permissions

| Permission | Purpose |
| --- | --- |
| `tabs` | query tabs by URL to find/activate an existing DeepSeek tab |
| `scripting` | inject Stage 2 DeepSeek interaction code into the tab |
| `alarms` | restart bridge polling after MV3 service-worker termination |
| `http://127.0.0.1/*` host permission | talk to the local bot bridge (any port) |
| `https://chat.deepseek.com/*` host permission | open/activate DeepSeek and inject code |

No cookie/storage/clipboard permissions. The extension never receives the
Telegram token, never extracts cookies or credentials, and never touches
login, CAPTCHA or security controls - it uses the user's existing logged-in
Chrome session as-is.

---

## Message Flow

### Stage 1 - selecting the mode opens DeepSeek

```text
/setting -> [🧩 Browser Extension]
   -> index.js action handler stores the per-user mode
   -> ai/extension.js openDeepSeekTab()
   -> POST http://127.0.0.1:8765/extension/open-deepseek
   -> extension long-poll picks up {action:"open_deepseek"}
   -> existing tab? tabs.update(active) : tabs.create(url)
   -> POST /extension/result {status, tabId}
   -> bot logs success (or replies with the friendly error)
```

### Stage 2 - messages through DeepSeek

```text
Telegram message -> AI router (mode "extension")
   -> ai/extension.js extensionResponse()
   -> POST /extension/ask {message}
   -> extension: find/create DeepSeek tab -> executeScript(ask)
   -> response posted back to /extension/result
   -> Telegram reply
```

---

## Tests

`npm test` (all pass):

- `test-settings-flow.js` - three modes, default mode, switching, checkmark
  position, user isolation, no "AI Settings" heading, extension open trigger,
  friendly error reply without internals, extension-mode text routing.
- `test-extension-bridge.js` - localhost binding, unavailable/stale failure
  modes, delivery, ack, re-queue safety, ask round trip, unknown ids,
  concurrent opens with the REAL extension tab logic.
- `test-extension-tabs.js` - URL prefix safety, create vs activate,
  lookalike-domain rejection, 6 concurrent opens -> exactly one tab.
- `test-extension-flow.js` - `ai/extension.js` <-> bridge <-> extension with
  friendly-message and no-internals assertions.

`npm run test:e2e` (real Chrome): launches Playwright Chromium with the built
extension loaded unpacked, waits for the service worker to poll the bridge,
then drives `openDeepSeekTab()` exactly like the `/setting` handler does:
tab created, second call activates the same tab, 4 rapid clicks still yield
exactly one DeepSeek tab.

Manual verification: `npm start` logs
`🌉 Extension bridge listening on http://127.0.0.1:8765 (localhost only)`.

---

## One-Time Manual Setup

```bash
npm run extension:build
```

then `chrome://extensions` -> Developer mode -> **Load unpacked** ->
`chrome-extension-react-template/build`, and stay logged into
`https://chat.deepseek.com/`. Chrome does not allow a bot to install
extensions silently, so this step is always manual and only needed once.

## Runtime Steps After Setup

```text
npm start
Telegram: /setting -> [🧩 Browser Extension]
Expected: checkmark on the button, DeepSeek tab opens/activates by itself
```

`npm run chrome` (Playwright/CDP) is NOT required for this mode.

## Known Limitations

- Port changes require an extension rebuild (port is baked in at build time).
- If Chrome is open but the MV3 service worker was idle-terminated, command
  delivery waits for the 30s alarm watchdog (worst case ~30-40s); while the
  worker is polling it is near-instant.
- Stage 2 against a live DeepSeek session requires a logged-in profile; it
  reuses the existing selectors and fails gracefully with a friendly message
  if the message box is not available.
- The extension must be (re)loaded manually after every rebuild.
