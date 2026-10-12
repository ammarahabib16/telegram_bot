"use strict";

// Local-only HTTP bridge between the Telegram bot and the Chrome extension.
//
//   Telegram -> index.js -> ai/extension.js -> [this bridge] -> Chrome extension
//
// The bridge never talks to the public internet. It binds to 127.0.0.1 only.
// No Telegram token or other secret is ever forwarded to the extension.
//
// Endpoints (bot side):
//   POST /extension/open-deepseek   -> waits for the extension to open/activate DeepSeek
//   POST /extension/ask { message } -> Stage 2: run a message through DeepSeek
//   GET  /health, GET /extension/status
//
// Endpoints (extension side):
//   GET  /extension/commands?wait=<ms>  -> long-poll for pending commands
//   POST /extension/result { id, ok, data?, error? } -> command outcome

const http = require("http");

const DEFAULT_OPEN_TIMEOUT_MS = 40000; // must cover one extension alarm cycle (30s)
const DEFAULT_ASK_TIMEOUT_MS = 150000;
const DEFAULT_POLL_WAIT_MS = 20000; // keep well below Chrome's 30s fetch-response limit
const MAX_BODY_BYTES = 64 * 1024;
const EXTENSION_STALE_MS = 50000; // polling extension stays < ~40s stale
const EXTENSION_GRACE_MS = 10000; // grace period right after bridge start

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function createBridge(options = {}) {
  const host = options.host || "127.0.0.1";
  const port =
    options.port !== undefined ? options.port : envNumber("EXTENSION_BRIDGE_PORT", 8765);
  const openTimeoutMs =
    options.openTimeoutMs || envNumber("EXTENSION_ACK_TIMEOUT_MS", DEFAULT_OPEN_TIMEOUT_MS);
  const askTimeoutMs =
    options.askTimeoutMs || envNumber("EXTENSION_ASK_TIMEOUT_MS", DEFAULT_ASK_TIMEOUT_MS);
  const pollWaitMs = options.pollWaitMs || DEFAULT_POLL_WAIT_MS;

  const state = {
    queue: [], // commands not yet picked up by the extension
    waiters: [], // parked long-poll requests
    delivered: new Map(), // command id -> command awaiting a result
    nextId: 1,
    lastExtensionSeen: null, // ms timestamp of the last extension request
    lastCommand: null, // { id, action, at, state } for diagnostics
    startedAt: Date.now(),
  };

  function touchExtension() {
    state.lastExtensionSeen = Date.now();
  }

  // Chrome closed / extension not installed -> fail fast instead of making
  // the Telegram user wait for the full command timeout.
  function extensionLikelyAlive() {
    const now = Date.now();
    if (state.lastExtensionSeen !== null) {
      return now - state.lastExtensionSeen < EXTENSION_STALE_MS;
    }
    return now - state.startedAt < EXTENSION_GRACE_MS;
  }

  function updateLastCommand(cmd) {
    if (state.lastCommand && state.lastCommand.id === cmd.id) {
      state.lastCommand.state = cmd.state;
    }
  }

  function markDelivered(cmd) {
    cmd.state = "delivered";
    cmd.deliveredAt = Date.now();
    state.delivered.set(cmd.id, cmd);
    touchExtension(); // delivery only happens because the extension asked
    updateLastCommand(cmd);
  }

  function requeue(cmd) {
    // The extension never actually received it (connection dropped before the
    // response was flushed). Put it back so it is not lost.
    if (!cmd || cmd.done || cmd.state !== "delivered") return;
    state.delivered.delete(cmd.id);
    cmd.state = "queued";
    state.queue.unshift(cmd);
    updateLastCommand(cmd);
  }

  function enqueue(action, payload, timeoutMs) {
    const cmd = {
      id: state.nextId++,
      action,
      payload: payload || {},
      createdAt: Date.now(),
      state: "queued",
      done: false,
      finish: null,
      timer: null,
    };

    const promise = new Promise((resolve) => {
      cmd.finish = (result) => {
        if (cmd.done) return;
        cmd.done = true;
        clearTimeout(cmd.timer);
        state.delivered.delete(cmd.id);
        // A command that timed out or was already settled must never be
        // delivered to the extension afterwards.
        const queuedAt = state.queue.indexOf(cmd);
        if (queuedAt !== -1) state.queue.splice(queuedAt, 1);
        cmd.state = result.ok ? "done" : "failed";
        updateLastCommand(cmd);
        resolve(result);
      };
    });

    cmd.timer = setTimeout(() => {
      // Never picked up -> extension is not running.
      // Picked up but no result -> extension stalled or Chrome went away.
      const pickedUp = cmd.state === "delivered";
      cmd.finish({ ok: false, error: pickedUp ? "timeout" : "extension_unavailable" });
    }, timeoutMs);

    state.lastCommand = { id: cmd.id, action, at: cmd.createdAt, state: cmd.state };

    const waiter = state.waiters.shift();
    if (waiter) {
      if (waiter.settled) {
        state.queue.push(cmd);
      } else {
        markDelivered(cmd);
        waiter.settle({ commands: [cmd], onClose: () => requeue(cmd) });
      }
    } else {
      state.queue.push(cmd);
    }

    return promise;
  }

  function waitForCommands(waitMs) {
    while (state.queue.length) {
      const cmd = state.queue.shift();
      if (cmd.done) continue; // never deliver a settled command
      markDelivered(cmd);
      return Promise.resolve({ commands: [cmd], onClose: () => requeue(cmd) });
    }
    return new Promise((resolve) => {
      const waiter = { settled: false, timer: null, settle: null };
      const settle = (payload) => {
        if (waiter.settled) return;
        waiter.settled = true;
        clearTimeout(waiter.timer);
        const idx = state.waiters.indexOf(waiter);
        if (idx !== -1) state.waiters.splice(idx, 1);
        resolve(payload);
      };
      waiter.settle = settle;
      waiter.timer = setTimeout(() => settle({ commands: [], onClose: null }), waitMs);
      state.waiters.push(waiter);
    });
  }

  function stats() {
    const now = Date.now();
    return {
      ok: true,
      uptimeMs: now - state.startedAt,
      queueDepth: state.queue.length,
      inFlight: state.delivered.size,
      lastExtensionSeenMs: state.lastExtensionSeen ? now - state.lastExtensionSeen : null,
      lastCommand: state.lastCommand,
    };
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(Object.assign(new Error("body_too_large"), { statusCode: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(Object.assign(new Error("invalid_json"), { statusCode: 400 }));
        }
      });
      req.on("error", reject);
    });
  }

  function sendJson(res, statusCode, payload) {
    if (res.writableEnded) return;
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Private-Network": "true",
      "Cache-Control": "no-store",
    });
    res.end(body);
  }

  function failureStatus(error) {
    if (error === "extension_unavailable") return 503;
    if (error === "timeout") return 504;
    return 502;
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${host}:${port || 8765}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Allow-Private-Network": "true",
      });
      res.end();
      return;
    }

    // --- extension side -------------------------------------------------
    if (req.method === "GET" && path === "/extension/commands") {
      touchExtension();
      const waitRaw = Number(url.searchParams.get("wait"));
      const waitMs = Number.isFinite(waitRaw)
        ? Math.min(Math.max(waitRaw, 0), 29000)
        : pollWaitMs;

      // If the connection dies before the command reached the extension,
      // put the command back at the front of the queue.
      let onCloseCmd = null;
      let closedEarly = false;
      res.on("close", () => {
        if (res.writableFinished) return;
        closedEarly = true;
        if (onCloseCmd) onCloseCmd();
      });

      const { commands, onClose } = await waitForCommands(waitMs);
      onCloseCmd = onClose;
      if (onClose && closedEarly) onClose();

      sendJson(res, 200, {
        commands: commands.map((c) => ({ id: c.id, action: c.action, payload: c.payload })),
      });
      return;
    }

    if (req.method === "POST" && path === "/extension/result") {
      touchExtension();
      const body = await readBody(req);
      const cmd = state.delivered.get(Number(body.id));
      if (!cmd) {
        sendJson(res, 404, { ok: false, error: "unknown_command" });
        return;
      }
      cmd.finish(
        body.ok
          ? { ok: true, data: body.data || {} }
          : { ok: false, error: body.error || "extension_error" }
      );
      sendJson(res, 200, { ok: true });
      return;
    }

    // --- bot side -------------------------------------------------------
    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, stats());
      return;
    }

    if (req.method === "GET" && path === "/extension/status") {
      const seen = state.lastExtensionSeen;
      sendJson(res, 200, {
        ok: true,
        connected: seen !== null && Date.now() - seen < 40000,
        lastSeenMs: seen ? Date.now() - seen : null,
      });
      return;
    }

    if (req.method === "POST" && path === "/extension/open-deepseek") {
      if (!extensionLikelyAlive()) {
        sendJson(res, 503, { ok: false, error: "extension_unavailable" });
        return;
      }
      const result = await enqueue("open_deepseek", {}, openTimeoutMs);
      if (result.ok) {
        sendJson(res, 200, { ok: true, result: result.data });
      } else {
        sendJson(res, failureStatus(result.error), { ok: false, error: result.error });
      }
      return;
    }

    if (req.method === "POST" && path === "/extension/ask") {
      const body = await readBody(req);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) {
        sendJson(res, 400, { ok: false, error: "empty_message" });
        return;
      }
      const timeoutMs = Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : askTimeoutMs;
      if (!extensionLikelyAlive()) {
        sendJson(res, 503, { ok: false, error: "extension_unavailable" });
        return;
      }
      const result = await enqueue("ask", { message }, timeoutMs);
      if (result.ok) {
        sendJson(res, 200, { ok: true, result: result.data });
      } else {
        sendJson(res, failureStatus(result.error), { ok: false, error: result.error });
      }
      return;
    }

    if (req.method === "POST" && path === "/extension/reload") {
      if (!extensionLikelyAlive()) {
        sendJson(res, 503, { ok: false, error: "extension_unavailable" });
        return;
      }
      const result = await enqueue("reload", {}, 5000);
      if (result.ok) {
        sendJson(res, 200, { ok: true, result: result.data });
      } else {
        sendJson(res, failureStatus(result.error), { ok: false, error: result.error });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  }

  const server = http.createServer((req, res) => {
    res.on("error", () => {});
    handle(req, res).catch((err) => {
      const status = err && err.statusCode ? err.statusCode : 500;
      sendJson(res, status, {
        ok: false,
        error: err && err.message ? err.message : "internal_error",
      });
      if (status === 500) console.error("[bridge] request failed:", err);
    });
  });

  // Defense in depth: never accept connections from outside localhost.
  server.on("connection", (socket) => {
    const addr = socket.remoteAddress;
    if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") {
      socket.destroy();
    }
  });

  const bridge = {
    server,
    state,
    options: { host, port, openTimeoutMs, askTimeoutMs, pollWaitMs },
    stats,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve(bridge);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    async close() {
      // Fail anything still waiting so callers never hang.
      for (const cmd of [...state.delivered.values()]) {
        cmd.finish({ ok: false, error: "bridge_shutdown" });
      }
      for (const cmd of [...state.queue]) {
        cmd.finish({ ok: false, error: "bridge_shutdown" });
      }
      for (const waiter of state.waiters.splice(0)) {
        waiter.settle({ commands: [], onClose: null });
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };

  return bridge;
}

async function startBridge(options = {}) {
  const bridge = await createBridge(options).listen();
  const address = bridge.server.address();
  console.log(
    `🌉 Extension bridge listening on http://127.0.0.1:${address.port} (localhost only)`
  );
  bridge.port = address.port;
  return bridge;
}

module.exports = { startBridge, createBridge };
