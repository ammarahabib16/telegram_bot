# Change 04: Browser Extension Mode — How It Works

Short explanation of the third AI mode (`🧩 Browser Extension`) added to the bot.

---

## 1. What was built

A third way to talk to DeepSeek: instead of driving Chrome from the outside
(Browser Automation / Playwright), the user's **own Chrome** gets a small
installed extension (SEWIT-style, named **Telegrambot Chrome Extension**) that
opens/activates DeepSeek and sends messages inside the page.

**Why a local bridge?** Chrome extensions cannot be reached from Node —
Manifest V3 service workers only make *outgoing* requests and can be killed by
Chrome at any time, so they cannot host a server. The bot therefore runs a tiny
HTTP server on `127.0.0.1` and the extension **pulls** work from it
(long-poll). This also keeps everything on the user's machine: no public URL,
no Telegram token in the extension.

Two stages:

- **Stage 1 (`open_deepseek`)** — selecting the mode opens/activates the
  DeepSeek tab (used by `/setting`).
- **Stage 2 (`ask`)** — normal chat messages are routed through DeepSeek's
  web page and the answer returns to Telegram.

---

## 2. Complete architecture

```text
Telegram message
      ↓
index.js  (/setting action or bot.on("text"))
      ↓
ai/extension.js        (mode adapter: openDeepSeekTab / extensionResponse)
      ↓  POST :8765
Local Bridge           (bridge/extension-bridge.js — 127.0.0.1 only)
      ↑  GET /extension/commands (long-poll, 20 s hold)
Chrome Extension       (MV3 service worker)
      ↓  chrome.tabs / chrome.scripting
DeepSeek Tab           (https://chat.deepseek.com/)
      ↑  POST /extension/result
      → bridge → ai/extension.js → Telegram reply
```

| Step | What happens |
| --- | --- |
| Bot → bridge | Adapter POSTs a command (`open_deepseek` or `ask`) and waits (40 s open / 150 s ask) |
| Bridge → extension | Extension long-polls for commands; bridge hands out each command exactly once |
| Extension → Chrome | Executes via `chrome.tabs` (Stage 1) or `chrome.scripting` into the DeepSeek tab (Stage 2) |
| Back | Result POSTed to the bridge, which resolves the bot's waiting request |
| Failure | Never picked up → `extension_unavailable` (fast-fail if extension silent > 50 s); otherwise `timeout` — Telegram only ever sees a friendly message |

---

## 3. Files and folders (extension-related only)

```text
telegram-deepseek-bot/
├── index.js                        # /setting UI (3 buttons), Stage-1 trigger, starts the bridge
├── ai/
│   ├── ai-router.js                # routes mode "extension" → extensionResponse()
│   └── extension.js                # bot-side adapter + friendly Telegram messages
├── bridge/
│   └── extension-bridge.js         # localhost HTTP bridge (server, queue, long-poll, timeouts)
├── chrome-extension-react-template/
│   ├── public/manifest.json        # MV3 manifest: permissions, name, background worker
│   ├── index.html                  # popup page (title)
│   ├── vite.config.ts              # builds background.js + bakes in the bridge port
│   ├── src/
│   │   ├── App.tsx / App.css       # toolbar popup: bridge status + "Open DeepSeek" button
│   │   └── background/
│   │       ├── service-worker.js   # long-poll loop, command dispatch, alarm watchdog
│   │       ├── bridge-client.js    # HTTP client for the bridge (poll + post result)
│   │       ├── deepseek-tabs.js    # find / activate / create DeepSeek tab (no duplicates)
│   │       └── deepseek-ask.js     # Stage 2: injected DOM interaction in the tab
│   └── build/                      # npm run extension:build output ← load this folder
├── test-extension-bridge.js        # bridge unit/integration tests
├── test-extension-tabs.js          # tab logic incl. duplicate prevention
├── test-extension-flow.js          # bot ↔ bridge ↔ extension round trip
├── test-extension-e2e.js           # real Chromium with the extension loaded
├── .env                            # EXTENSION_BRIDGE_PORT=8765 (+ timeout overrides)
└── package.json                    # npm start / test / extension:build scripts
```

---

## 4. How `/setting` works

```text
/setting
   ↓
3 buttons: 🤖 Ollama | 🌐 Browser | 🧩 Browser Extension   (✓ on active mode)
   ↓ tap 🧩
index.js stores mode per user → calls ai/extension.js openDeepSeekTab()
   ↓ POST /extension/open-deepseek
bridge → extension → open/activate DeepSeek tab → ack back
   ↓
Telegram confirms (or shows the friendly "not available" error)
   ↓ later messages
ai-router sees mode "extension" → extensionResponse(message) → Stage 2 → reply
```

Per-user mode isolation is unchanged (kept in `ai/ai-router.js`'s `Map`).

---

## 5. Local bridge

- **Why:** the only supported channel between Node and an MV3 extension
  (extension = outgoing connections only, may sleep at any time).
- **Port:** `8765` (`.env` → `EXTENSION_BRIDGE_PORT`); **localhost only**
  (`127.0.0.1` bind + socket filter). Changing it requires rebuilding the
  extension.
- **Bot → bridge:** `POST /extension/open-deepseek`, `POST /extension/ask`
  (JSON), plus `GET /health` / `GET /extension/status` for diagnostics.
- **Extension → bridge:** `GET /extension/commands?wait=20000` (long-poll,
  capped below Chrome's 30 s fetch limit) and `POST /extension/result`.
- **Command lifecycle:** `queued → delivered → done/failed`; delivered-once,
  re-queued if the response never reached the extension, removed on timeout so
  a stale command can never fire late; results resolve the bot's waiting POST
  with `200 ok`, `503 extension_unavailable`, `504 timeout`, or `502`.

---

## 6. Chrome extension

- **Manifest V3** with `type: module` background service worker; permissions:
  `tabs`, `scripting`, `alarms`; host permissions `http://127.0.0.1/*` and
  `https://chat.deepseek.com/*`.
- **React + Vite** project (existing template extended in place): Vite builds
  `background.js` and injects the bridge port at build time.
- **Service worker:** continuously long-polls the bridge; a 30 s `chrome.alarms`
  watchdog restarts polling if Chrome kills the worker; a keep-alive runs
  during a single `ask`.
- **Bridge check:** the popup polls `/health` and shows
  *Connected / waiting for poll / bridge not reachable*.
- **Open/activate tab:** `tabs.query` by the `https://chat.deepseek.com/`
  prefix → existing tab: `tabs.update(active)` + focus window; else
  `tabs.create`.
- **Duplicate prevention:** all open requests are serialized on a promise
  chain inside the extension, so rapid clicks can never race
  query-then-create — there is always at most one DeepSeek tab.
- **Stage 2:** a self-contained function is injected with
  `chrome.scripting.executeScript`, reusing the same DeepSeek selectors as
  `deepseek-chat.js`.

---

## 7. Environment / commands

```bash
npm start                 # bot + local bridge
npm run extension:build    # build the extension (after changing the port)
npm test                  # includes all extension test suites
npm run test:e2e          # real-Chromium end-to-end test (bot must be stopped)
```

**One-time setup:** run `npm run extension:build`, open `chrome://extensions`,
enable Developer mode → **Load unpacked** → select
`chrome-extension-react-template/build`, keep it enabled and stay logged into
`https://chat.deepseek.com/`. Chrome does not allow silent installs.

Runtime: `npm run chrome` is **not** needed for this mode.

---

## 8. What was NOT changed

- **Ollama mode** — untouched (still the default mode).
- **Browser Automation mode** — untouched (Playwright/CDP, `npm run chrome`).
- **`deepseek-chat.js` / CDP automation** — preserved; only reused its
  selectors by reference in the injected function.
- **No DeepSeek API** was added — everything goes through the web page.
- **No cookies/tokens/login automation** — the extension uses the user's
  existing session; no secrets are ever sent to it (the Telegram token never
  leaves the bot).
