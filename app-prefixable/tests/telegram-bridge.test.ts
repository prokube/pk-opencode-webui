import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowTelegramHealthRequest,
  cacheSession,
  createOutboundSSEParser,
  consumeOutboundEventStream,
  extractReply,
  handleBridgeEvent,
  handleCallbackUpdate,
  handleTelegramUpdate,
  handleTextUpdate,
  isTimeoutError,
  joinOpenCodeUrl,
  parseConfig,
  parseMode,
  queueChatUpdate,
  readTelegramBridgeHealth,
  registerTelegramCommands,
  resetSessionCacheForTest,
  runPollingHealthServer,
  setRetryDelayForTest,
  telegramHealthHost,
  sessionFromCache,
} from "../../shared/telegram-bridge";

function parseOutboundBlocks(chunks: string[]): string[] {
  const parser = createOutboundSSEParser();
  const blocks: string[] = [];
  for (const chunk of chunks) {
    blocks.push(...parser.push(chunk));
  }
  blocks.push(...parser.flush());
  return blocks;
}

function streamFromChunks(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

const envKeys = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_MODE",
  "OPENCODE_API_URL",
  "API_URL",
  "OPENCODE_DIRECTORY",
  "TELEGRAM_SESSION_CACHE_MAX",
  "TELEGRAM_SESSION_CACHE_TTL_MS",
  "TELEGRAM_BRIDGE_PORT",
  "TELEGRAM_WEBHOOK_PATH",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_WEBHOOK_URL",
  "TELEGRAM_SESSION_STORE_PATH",
  "TELEGRAM_SESSION_LINK_BASE",
  "TELEGRAM_NOTIFY_DEBOUNCE_MS",
  "TELEGRAM_HEALTH_PUBLIC",
] as const;

const envSnapshot = new Map<string, string | undefined>();
let settingsPathSnapshot: string | undefined;
const testTempDirs: string[] = [];

function setEnv(next: Partial<Record<(typeof envKeys)[number], string | undefined>>) {
  for (const key of envKeys) {
    const value = next[key];
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

describe("telegram bridge config and cache", () => {
  beforeEach(async () => {
    resetSessionCacheForTest();
    settingsPathSnapshot = process.env.TELEGRAM_SETTINGS_PATH;
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-test-"));
    testTempDirs.push(dir);
    process.env.TELEGRAM_SETTINGS_PATH = join(dir, "telegram-settings.json");
    for (const key of envKeys) {
      envSnapshot.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(async () => {
    resetSessionCacheForTest();
    for (const key of envKeys) {
      const value = envSnapshot.get(key);
      if (value === undefined) {
        delete process.env[key];
        continue;
      }
      process.env[key] = value;
    }
    if (settingsPathSnapshot === undefined) {
      delete process.env.TELEGRAM_SETTINGS_PATH;
    }
    if (settingsPathSnapshot !== undefined) {
      process.env.TELEGRAM_SETTINGS_PATH = settingsPathSnapshot;
    }
    await Promise.all(testTempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    testTempDirs.length = 0;
    envSnapshot.clear();
  });

  test("parseMode accepts known values and rejects unknown", () => {
    expect(parseMode("polling")).toBe("polling");
    expect(parseMode("WEBHOOK")).toBe("webhook");
    expect(parseMode("  WebHook  ")).toBe("webhook");
    expect(() => parseMode("invalid")).toThrow("Invalid TELEGRAM_MODE");
  });

  test("queueChatUpdate serializes tasks per chat", async () => {
    const order: string[] = [];
    let unlock = () => {};
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });

    const first = queueChatUpdate("chat-1", async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    const second = queueChatUpdate("chat-1", async () => {
      order.push("second:start");
      order.push("second:end");
    });
    const other = queueChatUpdate("chat-2", async () => {
      order.push("other:start");
      order.push("other:end");
    });

    await Promise.resolve();
    expect(order.includes("second:start")).toBe(false);

    unlock();
    await Promise.all([first, second, other]);

    expect(order.indexOf("first:end")).toBeLessThan(order.indexOf("second:start"));
    expect(order.includes("other:start")).toBe(true);
  });

  test("parseConfig uses polling default and rejects invalid TELEGRAM_MODE", () => {
    setEnv({ TELEGRAM_BOT_TOKEN: "token", OPENCODE_API_URL: "http://127.0.0.1:4096" });
    expect(parseConfig().mode).toBe("polling");
    expect(parseConfig().sessionStorePath).toBe(join(tmpdir(), "opencode-telegram-sessions.json"));
    expect(parseConfig().notificationDebounceMs).toBe(20_000);

    setEnv({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_SESSION_STORE_PATH: join(tmpdir(), "custom-store.json"),
      TELEGRAM_SESSION_LINK_BASE: "https://opencode.example.com/notebook",
      TELEGRAM_NOTIFY_DEBOUNCE_MS: "5000",
    });
    expect(parseConfig().sessionStorePath).toBe(join(tmpdir(), "custom-store.json"));
    expect(parseConfig().sessionLinkBase).toBe("https://opencode.example.com/notebook");
    expect(parseConfig().notificationDebounceMs).toBe(5000);

    setEnv({ TELEGRAM_BOT_TOKEN: "token", TELEGRAM_MODE: "bad-mode", OPENCODE_API_URL: "http://127.0.0.1:4096" });
    expect(() => parseConfig()).toThrow("Invalid TELEGRAM_MODE");

    setEnv({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_SESSION_STORE_PATH: "relative-store.json",
      OPENCODE_API_URL: "http://127.0.0.1:4096",
    });
    expect(parseConfig().sessionStorePath).toBe(join(tmpdir(), "opencode-telegram-sessions.json"));

    process.env.TELEGRAM_SETTINGS_PATH = join(testTempDirs[0] || tmpdir(), "telegram-settings-missing-token.json");
    setEnv({ TELEGRAM_BOT_TOKEN: undefined, OPENCODE_API_URL: "http://127.0.0.1:4096" });
    expect(() => parseConfig()).toThrow("Set TELEGRAM_BOT_TOKEN or save token in persisted Telegram settings");
  });

  test("parseConfig includes source in URL parse errors", () => {
    setEnv({ TELEGRAM_BOT_TOKEN: "token", OPENCODE_API_URL: "bad-url" });
    expect(() => parseConfig()).toThrow("openCodeUrl must be a valid URL (OPENCODE_API_URL)");

    setEnv({ TELEGRAM_BOT_TOKEN: "token", OPENCODE_API_URL: "http://127.0.0.1:4096", TELEGRAM_WEBHOOK_URL: "bad-url" });
    expect(() => parseConfig()).toThrow("webhookUrl must be a valid URL (TELEGRAM_WEBHOOK_URL)");

    setEnv({
      TELEGRAM_BOT_TOKEN: "token",
      OPENCODE_API_URL: "http://127.0.0.1:4096",
      TELEGRAM_WEBHOOK_URL: undefined,
      TELEGRAM_SESSION_LINK_BASE: "bad-url",
    });
    expect(() => parseConfig()).toThrow("sessionLinkBase must be a valid URL (TELEGRAM_SESSION_LINK_BASE)");
  });

  test("parseConfig trims persisted token and recovers from backup when primary missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-bridge-config-"));
    const path = join(dir, "telegram-settings.json");
    const backup = `${path}.bak.${Date.now()}.recover`;

    try {
      process.env.TELEGRAM_SETTINGS_PATH = path;
      process.env.TELEGRAM_BOT_TOKEN = "env-token";
      process.env.OPENCODE_API_URL = "http://127.0.0.1:4096";

      await writeFile(
        path,
        JSON.stringify(
          {
            version: 1,
            updatedAt: new Date().toISOString(),
            settings: {
              token: "\t   ",
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      expect(parseConfig().token).toBe("env-token");

      await rm(path, { force: true });
      await writeFile(
        backup,
        JSON.stringify(
          {
            version: 1,
            updatedAt: new Date().toISOString(),
            settings: {
              token: "persisted-token",
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      expect(parseConfig().token).toBe("persisted-token");
      expect(await Bun.file(path).exists()).toBe(true);
      expect(await Bun.file(backup).exists()).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true }).catch(() => undefined);
    }
  });

  test("joinOpenCodeUrl keeps configured base path with leading slash paths", () => {
    expect(joinOpenCodeUrl("http://127.0.0.1:4096/notebook/ns/name", "/session").toString()).toBe(
      "http://127.0.0.1:4096/notebook/ns/name/session",
    );
    expect(joinOpenCodeUrl("http://127.0.0.1:4096/proxy/", "/session/abc/message").toString()).toBe(
      "http://127.0.0.1:4096/proxy/session/abc/message",
    );
  });

  test("extractReply returns fallback text when no text parts exist", () => {
    expect(extractReply({ parts: [{ type: "tool" }] })).toBe(
      "I finished processing your request, but there was no text response.",
    );
  });

  test("registerTelegramCommands sends canonical Telegram command payload", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      };

      await registerTelegramCommands({
        mode: "polling",
        token: "token",
        openCodeUrl: "http://127.0.0.1:4096",
        sessionCacheMax: 10,
        sessionCacheTtlMs: 10_000,
        notificationDebounceMs: 20_000,
        port: 4097,
        webhookPath: "/webhook",
        sessionStorePath: "/tmp/test-store.json",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/setMyCommands");
    expect(calls[0]?.body.commands).toEqual([
      { command: "new", description: "Start a fresh OpenCode session" },
      { command: "status", description: "Show current session mapping" },
      { command: "sessions", description: "List known sessions for this chat/user mapping" },
      { command: "recent", description: "Show latest user/assistant exchanges" },
      { command: "switch", description: "Switch this chat/user mapping to an existing session" },
      { command: "project", description: "Show or set OpenCode project directory" },
      { command: "notify", description: "Control proactive notifications" },
      { command: "pending", description: "Show pending inbox items" },
      { command: "inbox", description: "Alias for /pending" },
      { command: "prompts", description: "List saved prompts available in this session" },
      { command: "prompt", description: "Run a saved prompt by name or id" },
      { command: "help", description: "Show available commands" },
    ]);
  });

  test("cacheSession evicts oldest entries when max size is exceeded", () => {
    const config = {
      mode: "polling" as const,
      token: "token",
      openCodeUrl: "http://127.0.0.1:4096",
      sessionCacheMax: 2,
      sessionCacheTtlMs: 10_000,
      notificationDebounceMs: 20_000,
      port: 4097,
      webhookPath: "/webhook",
      sessionStorePath: "/tmp/test-store.json",
    };

    cacheSession(config, "chat-a", "session-a");
    cacheSession(config, "chat-b", "session-b");
    cacheSession(config, "chat-c", "session-c");

    expect(sessionFromCache(config, "chat-a")).toBeUndefined();
    expect(sessionFromCache(config, "chat-b")).toBe("session-b");
    expect(sessionFromCache(config, "chat-c")).toBe("session-c");
  });

  test("readTelegramBridgeHealth reports healthy when dependencies are reachable", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/getMe")) {
          return new Response(JSON.stringify({ ok: true, result: { id: 1 } }), { status: 200 });
        }
        if (url.includes("/session/status")) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const report = await readTelegramBridgeHealth({
        config: {
          mode: "polling",
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
        },
      });

      expect(report.status).toBe("healthy");
      expect(report.dependencies.telegramApi.status).toBe("ok");
      expect(report.dependencies.openCodeApi.status).toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("readTelegramBridgeHealth reports degraded when dependency fails", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/getMe")) {
          return new Response(JSON.stringify({ ok: false }), { status: 200 });
        }
        if (url.includes("/session/status")) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const report = await readTelegramBridgeHealth({
        config: {
          mode: "polling",
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
        },
      });

      expect(report.status).toBe("degraded");
      expect(report.dependencies.telegramApi.status).toBe("error");
      expect(report.dependencies.openCodeApi.status).toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("readTelegramBridgeHealth checks dependencies concurrently", async () => {
    const originalFetch = globalThis.fetch;
    let releaseTelegram = () => {};
    let openCodeStarted = false;
    try {
      globalThis.fetch = (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/getMe")) {
          return new Promise<Response>((resolve) => {
            releaseTelegram = () => resolve(new Response(JSON.stringify({ ok: true, result: { id: 1 } }), { status: 200 }));
          });
        }
        if (url.includes("/session/status")) {
          openCodeStarted = true;
          return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
        }
        return Promise.reject(new Error(`Unexpected fetch ${url}`));
      };

      const run = readTelegramBridgeHealth({
        config: {
          mode: "polling",
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
        },
      });

      await Promise.resolve();
      expect(openCodeStarted).toBe(true);
      releaseTelegram();
      const report = await run;
      expect(report.status).toBe("healthy");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("health helpers default to localhost-only policy", () => {
    delete process.env.TELEGRAM_HEALTH_PUBLIC;
    expect(telegramHealthHost("polling")).toBe("127.0.0.1");
    expect(telegramHealthHost("webhook")).toBe("0.0.0.0");
    expect(allowTelegramHealthRequest("127.0.0.1")).toBe(true);
    expect(allowTelegramHealthRequest("::1")).toBe(true);
    expect(allowTelegramHealthRequest("10.0.0.12")).toBe(false);
  });

  test("health helpers allow public access when explicitly enabled", () => {
    process.env.TELEGRAM_HEALTH_PUBLIC = "true";
    expect(telegramHealthHost("polling")).toBe("0.0.0.0");
    expect(allowTelegramHealthRequest("10.0.0.12")).toBe(true);
  });

  test("runPollingHealthServer tolerates bind failures", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    const bunRef = Bun as unknown as { serve: typeof Bun.serve };
    const originalServe = bunRef.serve;
    bunRef.serve = (() => {
      throw new Error("EADDRINUSE");
    }) as typeof Bun.serve;

    try {
      const started = runPollingHealthServer({
        config: {
          mode: "polling",
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
        },
      });

      expect(started).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      bunRef.serve = originalServe;
      warnSpy.mockRestore();
    }
  });

  test("handleTextUpdate parses whitespace and bot-qualified help command", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/")) {
          return new Response(JSON.stringify({ id: "exists" }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const map = new Map<string, string>();
      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async (key: string) => map.get(key),
          set: async (key: string, value: string) => {
            map.set(key, value);
          },
          delete: async (key: string) => {
            map.delete(key);
          },
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: {
          message_id: 1,
          text: "/help@prokubebot\nmore",
          chat: { id: 42 },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/sendMessage");
    expect(String(calls[0]?.body.text || "")).toContain("Available commands:");
    expect(String(calls[0]?.body.text || "")).toContain("/pending - Show pending inbox items");
    expect(String(calls[0]?.body.text || "")).toContain("/notify - Control proactive notifications (on|off|status)");
  });

  test("handleTextUpdate routes status, new@botname, and unknown commands", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const createdSessions = ["session-1", "session-2"];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url === "http://127.0.0.1:4096/session") {
          const id = createdSessions.shift();
          return new Response(JSON.stringify({ id }), { status: 200 });
        }
        if (url.includes("/session/")) {
          return new Response(JSON.stringify({ id: "exists" }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const map = new Map<string, string>();
      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async (key: string) => map.get(key),
          set: async (key: string, value: string) => {
            map.set(key, value);
          },
          delete: async (key: string) => {
            map.delete(key);
          },
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/status", chat: { id: 7 }, from: { id: 9 } },
      });
      await handleTextUpdate(runtime, {
        update_id: 2,
        message: { message_id: 2, text: "/new@mybot", chat: { id: 7 }, from: { id: 9 } },
      });
      await handleTextUpdate(runtime, {
        update_id: 3,
        message: { message_id: 3, text: "/statuz", chat: { id: 7 }, from: { id: 9 } },
      });

      const sentTexts = calls
        .filter((x) => x.url.includes("/sendMessage"))
        .map((x) => String(x.body.text || ""));
      expect(sentTexts[0]).toBe("Current session: session-1");
      expect(sentTexts[1]).toBe("Started a new session: session-2");
      expect(sentTexts[2]).toBe("Unknown command /statuz. Try /status, /sessions or use /help.");
      expect(calls.filter((x) => x.url.includes("/session/")).length).toBe(1);
      expect(map.get("chat:7:user:9")).toBe("session-2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("handleTextUpdate reports long-running prompt timeout without generic error", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current/message")) {
          throw new DOMException("The operation timed out.", "TimeoutError");
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 4,
        message: { message_id: 4, text: "please continue", chat: { id: 7 }, from: { id: 9 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sentTexts = calls.filter((x) => x.url.includes("/sendMessage")).map((x) => String(x.body.text || ""));
    expect(sentTexts.some((text) => text.includes("Prompt started in session session-current"))).toBe(true);
    expect(sentTexts.some((text) => text.includes("internal error"))).toBe(false);
  });

  test("/prompts lists available saved prompts with scope hints", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/api/ext/saved-prompts")) {
          return new Response(
            JSON.stringify({
              global: [{ id: "g-1", title: "Quick summary", text: "Summarize", createdAt: 10 }],
              project: [{ id: "p-1", title: "Deploy release", text: "Deploy", createdAt: 20 }],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/prompts", chat: { id: 77 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const text = String(calls.find((x) => x.url.includes("/sendMessage"))?.body.text || "");
    expect(text).toContain("Saved prompts:");
    expect(text).toContain("Deploy release [project] (p-1)");
    expect(text).toContain("Quick summary [global] (g-1)");
    expect(text).toContain("Use /prompt <name|id> to run one.");
  });

  test("/prompts includes inline buttons for quick prompt selection", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/api/ext/saved-prompts")) {
          return new Response(
            JSON.stringify({
              global: [{ id: "g-1", title: "Quick summary", text: "Summarize", createdAt: 10 }],
              project: [{ id: "p-1", title: "Deploy release", text: "Deploy", createdAt: 20 }],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 11,
        message: { message_id: 11, text: "/prompts", chat: { id: 78 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sent = calls.find((x) => x.url.includes("/sendMessage"));
    const markup = sent?.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
    const first = markup?.inline_keyboard?.[0]?.[0]?.callback_data || "";
    const second = markup?.inline_keyboard?.[1]?.[0]?.callback_data || "";
    expect(first).toBe("p:p-1");
    expect(second).toBe("p:g-1");
  });

  test("/prompts accepts nested saved-prompts payload shapes", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/api/ext/saved-prompts")) {
          return new Response(
            JSON.stringify({
              global: { prompts: [{ id: "g-1", title: "Quick summary", text: "Summarize", createdAt: 10 }] },
              project: { prompts: [{ id: "p-1", title: "Deploy release", text: "Deploy", createdAt: 20 }] },
            }),
            { status: 200 },
          );
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 13,
        message: { message_id: 13, text: "/prompts", chat: { id: 178 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const text = String(calls.find((x) => x.url.includes("/sendMessage"))?.body.text || "");
    expect(text).toContain("Saved prompts:");
    expect(text).toContain("Deploy release [project] (p-1)");
    expect(text).toContain("Quick summary [global] (g-1)");
  });

  test("/prompts inline button numbering stays contiguous after invalid callback IDs are skipped", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/api/ext/saved-prompts")) {
          return new Response(
            JSON.stringify({
              global: [],
              project: [
                { id: "p-1", title: "First", text: "Run first", createdAt: 30 },
                { id: "bad id", title: "Skipped", text: "Run skipped", createdAt: 20 },
                { id: "p-2", title: "Third", text: "Run third", createdAt: 10 },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 14,
        message: { message_id: 14, text: "/prompts", chat: { id: 179 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sent = calls.find((x) => x.url.includes("/sendMessage"));
    const markup = sent?.body.reply_markup as { inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>> } | undefined;
    const first = markup?.inline_keyboard?.[0]?.[0];
    const second = markup?.inline_keyboard?.[1]?.[0];
    expect(first?.text).toBe("First");
    expect(first?.callback_data).toBe("p:p-1");
    expect(second?.text).toBe("Third");
    expect(second?.callback_data).toBe("p:p-2");
  });

  test("/prompts sends follow-up chunks when markup response exceeds Telegram limits", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const veryLong = "x".repeat(350);
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/api/ext/saved-prompts")) {
          return new Response(
            JSON.stringify({
              global: [],
              project: Array.from({ length: 25 }, (_, index) => ({
                id: `p-${index + 1}`,
                title: `Prompt ${index + 1} ${veryLong}`,
                text: `Run ${index + 1}`,
                createdAt: 1000 - index,
              })),
            }),
            { status: 200 },
          );
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 15,
        message: { message_id: 15, text: "/prompts", chat: { id: 180 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const messages = calls.filter((x) => x.url.includes("/sendMessage"));
    expect(messages.length).toBeGreaterThan(1);
    expect(messages[0]?.body.reply_markup).toBeDefined();
    expect(messages.slice(1).every((item) => item.body.reply_markup === undefined)).toBe(true);
    expect(String(messages[0]?.body.text || "").length).toBeLessThanOrEqual(3900);
  });

  test("prompt callback runs the selected saved prompt", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const map = new Map<string, string>([["chat:79:user:6", "session-current"]]);
    const alarms = new Map<string, boolean>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/api/ext/saved-prompts")) {
          return new Response(
            JSON.stringify({
              global: [{ id: "g-1", title: "Quick summary", text: "Summarize now", createdAt: 10 }],
              project: [{ id: "p-1", title: "Deploy release", text: "Deploy now", createdAt: 20 }],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/answerCallbackQuery")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        if (url.includes("/session/session-current/message")) {
          return new Response(JSON.stringify({ parts: [{ type: "text", text: "Deploy complete." }] }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async (key: string) => map.get(key),
          set: async (key: string, value: string) => {
            map.set(key, value);
          },
          delete: async (key: string) => {
            map.delete(key);
          },
          sessionAlarmSet: async (sessionId: string, enabled: boolean) => {
            if (enabled) {
              alarms.set(sessionId, true);
              return;
            }
            alarms.delete(sessionId);
          },
        },
      };

      await handleCallbackUpdate(runtime, {
        update_id: 12,
        callback_query: {
          id: "cb-prompt-1",
          data: "p:p-1",
          from: { id: 6 },
          message: { message_id: 12, chat: { id: 79 } },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const callbackAck = calls.find((x) => x.url.includes("/answerCallbackQuery"));
    expect(String(callbackAck?.body.text || "")).toContain("Running prompt");
    const promptRun = calls.find((x) => x.url.includes("/session/session-current/message"));
    expect(promptRun?.body.parts).toEqual([{ type: "text", text: "Deploy now" }]);
    const sentTexts = calls.filter((x) => x.url.includes("/sendMessage")).map((x) => String(x.body.text || ""));
    expect(sentTexts.some((text) => text.includes("Deploy complete."))).toBe(true);
    expect(alarms.get("session-current")).toBe(true);
  });

  test("prompt callback continues when callback query is already expired", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const map = new Map<string, string>([["chat:79:user:6", "session-current"]]);
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/api/ext/saved-prompts")) {
          return new Response(
            JSON.stringify({
              global: [{ id: "g-1", title: "Quick summary", text: "Summarize now", createdAt: 10 }],
              project: [{ id: "p-1", title: "Deploy release", text: "Deploy now", createdAt: 20 }],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/answerCallbackQuery")) {
          return new Response(
            JSON.stringify({ ok: false, description: "Bad Request: query is too old and response timeout expired or query ID is invalid" }),
            { status: 400 },
          );
        }
        if (url.includes("/session/session-current/message")) {
          return new Response(JSON.stringify({ parts: [{ type: "text", text: "Deploy complete." }] }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async (key: string) => map.get(key),
          set: async (key: string, value: string) => {
            map.set(key, value);
          },
          delete: async (key: string) => {
            map.delete(key);
          },
          sessionAlarmSet: async () => undefined,
        },
      };

      await handleCallbackUpdate(runtime, {
        update_id: 14,
        callback_query: {
          id: "cb-prompt-expired",
          data: "p:p-1",
          from: { id: 6 },
          message: { message_id: 14, chat: { id: 79 } },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sentTexts = calls.filter((x) => x.url.includes("/sendMessage")).map((x) => String(x.body.text || ""));
    expect(sentTexts.some((text) => text.includes("Deploy complete."))).toBe(true);
    expect(sentTexts.some((text) => text.includes("something went wrong while processing that button"))).toBe(false);
  });

  test("prompt callback reports long-running prompt instead of generic callback error", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const map = new Map<string, string>([["chat:79:user:6", "session-current"]]);
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/api/ext/saved-prompts")) {
          return new Response(
            JSON.stringify({
              global: [{ id: "g-1", title: "Quick summary", text: "Summarize now", createdAt: 10 }],
              project: [{ id: "p-1", title: "Deploy release", text: "Deploy now", createdAt: 20 }],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/answerCallbackQuery")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        if (url.includes("/session/session-current/message")) {
          throw new DOMException("The operation timed out.", "TimeoutError");
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async (key: string) => map.get(key),
          set: async (key: string, value: string) => {
            map.set(key, value);
          },
          delete: async (key: string) => {
            map.delete(key);
          },
          sessionAlarmSet: async () => undefined,
        },
      };

      await handleCallbackUpdate(runtime, {
        update_id: 13,
        callback_query: {
          id: "cb-prompt-timeout",
          data: "p:p-1",
          from: { id: 6 },
          message: { message_id: 13, chat: { id: 79 } },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sentTexts = calls.filter((x) => x.url.includes("/sendMessage")).map((x) => String(x.body.text || ""));
    expect(sentTexts.some((text) => text.includes("Prompt started in session session-current"))).toBe(true);
    expect(sentTexts.some((text) => text.includes("something went wrong while processing that button"))).toBe(false);
  });

  test("/prompts uses deterministic ordering when createdAt is invalid", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/api/ext/saved-prompts")) {
          return new Response(
            JSON.stringify({
              global: [{ id: "g-1", title: "Global fallback", text: "Global", createdAt: "bad" }],
              project: [{ id: "p-1", title: "Project dated", text: "Project", createdAt: 5 }],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/prompts", chat: { id: 77 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const text = String(calls.find((x) => x.url.includes("/sendMessage"))?.body.text || "");
    expect(text.indexOf("Project dated [project] (p-1)")).toBeLessThan(text.indexOf("Global fallback [global] (g-1)"));
  });

  test("/prompts resolves project prompts from the mapped session directory", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current")) {
          return new Response(JSON.stringify({ id: "session-current", directory: "/workspace/project-a" }), { status: 200 });
        }
        if (url.includes("/api/ext/saved-prompts")) {
          const value = new URL(url).searchParams.get("directory");
          if (value !== "/workspace/project-a") {
            return new Response(JSON.stringify({ global: [], project: [] }), { status: 200 });
          }
          return new Response(
            JSON.stringify({
              global: [{ id: "g-1", title: "Global prompt", text: "Global", createdAt: 10 }],
              project: [{ id: "p-1", title: "Project deploy", text: "Deploy", createdAt: 20 }],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/prompts", chat: { id: 91 }, from: { id: 6 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const text = String(calls.find((x) => x.url.includes("/sendMessage"))?.body.text || "");
    expect(text).toContain("Project deploy [project] (p-1)");
    expect(calls.some((x) => x.url.includes("/api/ext/saved-prompts?directory=%2Fworkspace%2Fproject-a"))).toBe(true);
  });

  test("/prompts falls back when mapped directory has no saved prompts", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current") && !url.includes("/message")) {
          return new Response(JSON.stringify({ id: "session-current", directory: "/workspace/project-a" }), { status: 200 });
        }
        if (url.includes("/api/ext/saved-prompts?directory=%2Fworkspace%2Fproject-a")) {
          return new Response(JSON.stringify({ global: [], project: [] }), { status: 200 });
        }
        if (url.includes("/api/ext/saved-prompts?directory=%2Fworkspace%2Fproject-b")) {
          return new Response(
            JSON.stringify({
              global: [{ id: "g-1", title: "Global backup", text: "Global", createdAt: 10 }],
              project: [{ id: "p-2", title: "Project fallback", text: "Project", createdAt: 20 }],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
          directory: "/workspace/project-b",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/prompts", chat: { id: 96 }, from: { id: 6 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const promptCalls = calls.filter((x) => x.url.includes("/api/ext/saved-prompts")).map((x) => x.url);
    expect(promptCalls[0]).toContain("directory=%2Fworkspace%2Fproject-a");
    expect(promptCalls[1]).toContain("directory=%2Fworkspace%2Fproject-b");
    const text = String(calls.find((x) => x.url.includes("/sendMessage"))?.body.text || "");
    expect(text).toContain("Project fallback [project] (p-2)");
  });

  test("/prompts falls back to configured directory when mapped directory is rejected", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current") && !url.includes("/message")) {
          return new Response(JSON.stringify({ id: "session-current", directory: "/workspace/project-a" }), { status: 200 });
        }
        if (url.includes("/api/ext/saved-prompts?directory=%2Fworkspace%2Fproject-a")) {
          return new Response("forbidden", { status: 403 });
        }
        if (url.includes("/api/ext/saved-prompts?directory=%2Fworkspace%2Fproject-b")) {
          return new Response(
            JSON.stringify({
              global: [{ id: "g-1", title: "Global backup", text: "Global", createdAt: 10 }],
              project: [{ id: "p-2", title: "Project fallback", text: "Project", createdAt: 20 }],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
          directory: "/workspace/project-b",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/prompts", chat: { id: 93 }, from: { id: 6 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const promptCalls = calls.filter((x) => x.url.includes("/api/ext/saved-prompts")).map((x) => x.url);
    expect(promptCalls[0]).toContain("directory=%2Fworkspace%2Fproject-a");
    expect(promptCalls[1]).toContain("directory=%2Fworkspace%2Fproject-b");
    const text = String(calls.find((x) => x.url.includes("/sendMessage"))?.body.text || "");
    expect(text).toContain("Project fallback [project] (p-2)");
  });

  test("/prompts falls back to global prompts when mapped and configured directories are empty", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current") && !url.includes("/message")) {
          return new Response(JSON.stringify({ id: "session-current", directory: "/workspace/project-a" }), { status: 200 });
        }
        if (url.includes("/api/ext/saved-prompts?directory=%2Fworkspace%2Fproject-a")) {
          return new Response(JSON.stringify({ global: [], project: [] }), { status: 200 });
        }
        if (url.includes("/api/ext/saved-prompts?directory=%2Fworkspace%2Fproject-b")) {
          return new Response(JSON.stringify({ global: [], project: [] }), { status: 200 });
        }
        if (url.endsWith("/api/ext/saved-prompts")) {
          return new Response(
            JSON.stringify({
              global: [{ id: "g-9", title: "Global rescue", text: "Run global rescue", createdAt: 10 }],
              project: [],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
          directory: "/workspace/project-b",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/prompts", chat: { id: 98 }, from: { id: 6 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const promptCalls = calls.filter((x) => x.url.includes("/api/ext/saved-prompts")).map((x) => x.url);
    expect(promptCalls[0]).toContain("directory=%2Fworkspace%2Fproject-a");
    expect(promptCalls[1]).toContain("directory=%2Fworkspace%2Fproject-b");
    expect(promptCalls[2]).toBe("http://127.0.0.1:4096/api/ext/saved-prompts");
    const text = String(calls.find((x) => x.url.includes("/sendMessage"))?.body.text || "");
    expect(text).toContain("Global rescue [global] (g-9)");
  });

  test("/prompts reports endpoint guidance when saved-prompts returns non-JSON", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current") && !url.includes("/message")) {
          return new Response(JSON.stringify({ id: "session-current", directory: "/workspace/project-a" }), { status: 200 });
        }
        if (url.includes("/api/ext/saved-prompts")) {
          return new Response("<!doctype html><html><body>Not JSON</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
          directory: "/workspace/project-b",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/prompts", chat: { id: 98 }, from: { id: 6 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const text = String(calls.find((x) => x.url.includes("/sendMessage"))?.body.text || "");
    expect(text).toContain("Saved prompts endpoint returned an unexpected response");
    expect(text).toContain("/api/ext");
  });

  test("/prompt falls back to global prompts when mapped and configured directories are rejected", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current") && !url.includes("/message")) {
          return new Response(JSON.stringify({ id: "session-current", directory: "/workspace/project-a" }), { status: 200 });
        }
        if (url.includes("/api/ext/saved-prompts?directory=%2Fworkspace%2Fproject-a")) {
          return new Response("forbidden", { status: 403 });
        }
        if (url.includes("/api/ext/saved-prompts?directory=%2Fworkspace%2Fproject-b")) {
          return new Response("forbidden", { status: 403 });
        }
        if (url.endsWith("/api/ext/saved-prompts")) {
          return new Response(
            JSON.stringify({
              global: [{ id: "g-1", title: "Global fallback", text: "Run global plan", createdAt: 10 }],
              project: [],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/session/session-current/message")) {
          return new Response(JSON.stringify({ parts: [{ type: "text", text: "Global prompt complete." }] }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
          directory: "/workspace/project-b",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/prompt Global fallback", chat: { id: 94 }, from: { id: 6 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const promptCalls = calls.filter((x) => x.url.includes("/api/ext/saved-prompts")).map((x) => x.url);
    expect(promptCalls[0]).toContain("directory=%2Fworkspace%2Fproject-a");
    expect(promptCalls[1]).toContain("directory=%2Fworkspace%2Fproject-b");
    expect(promptCalls[2]).toBe("http://127.0.0.1:4096/api/ext/saved-prompts");
    const runCall = calls.find((x) => x.url.includes("/session/session-current/message"));
    expect(runCall?.body.parts).toEqual([{ type: "text", text: "Run global plan" }]);
  });

  test("/prompts returns no-prompts guidance when any context lookup succeeded", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current") && !url.includes("/message")) {
          return new Response(JSON.stringify({ id: "session-current", directory: "/workspace/project-a" }), { status: 200 });
        }
        if (url.includes("/api/ext/saved-prompts?directory=%2Fworkspace%2Fproject-a")) {
          return new Response(JSON.stringify({ global: [], project: [] }), { status: 200 });
        }
        if (url.includes("/api/ext/saved-prompts?directory=%2Fworkspace%2Fproject-b")) {
          return new Response("unavailable", { status: 503 });
        }
        if (url.endsWith("/api/ext/saved-prompts")) {
          return new Response(JSON.stringify({ global: [], project: [] }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
          directory: "/workspace/project-b",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/prompts", chat: { id: 95 }, from: { id: 6 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const promptCalls = calls.filter((x) => x.url.includes("/api/ext/saved-prompts")).map((x) => x.url);
    expect(promptCalls[0]).toContain("directory=%2Fworkspace%2Fproject-a");
    expect(promptCalls[1]).toContain("directory=%2Fworkspace%2Fproject-b");
    expect(promptCalls[2]).toBe("http://127.0.0.1:4096/api/ext/saved-prompts");
    const text = String(calls.find((x) => x.url.includes("/sendMessage"))?.body.text || "");
    expect(text).toBe(
      "No saved prompts found. If your prompts are project-scoped, run /status in the target project first or configure Telegram directory in bridge settings.",
    );
  });

  test("/prompts returns actionable guidance when saved prompts access is rejected", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current") && !url.includes("/message")) {
          return new Response(JSON.stringify({ id: "session-current", directory: "/workspace/project-a" }), { status: 200 });
        }
        if (url.includes("/api/ext/saved-prompts")) {
          return new Response("forbidden", { status: 403 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
          directory: "/workspace/project-b",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/prompts", chat: { id: 95 }, from: { id: 6 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const text = String(calls.find((x) => x.url.includes("/sendMessage"))?.body.text || "");
    expect(text).toContain("OpenCode rejected saved prompts access");
    expect(text).not.toContain("internal error");
  });

  test("/prompts empty-state message reflects merged prompt list", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/api/ext/saved-prompts")) {
          return new Response(JSON.stringify({ global: [], project: [] }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/prompts", chat: { id: 90 }, from: { id: 6 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const text = String(calls.find((x) => x.url.includes("/sendMessage"))?.body.text || "");
    expect(text).toBe(
      "No saved prompts found. If your prompts are project-scoped, run /status in the target project first or configure Telegram directory in bridge settings.",
    );
  });

  test("/prompt runs a saved prompt and returns assistant response", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/api/ext/saved-prompts")) {
          return new Response(
            JSON.stringify({
              global: [{ id: "g-1", title: "Deploy release", text: "Please deploy the release.", createdAt: 10 }],
              project: [],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/session/session-current/message")) {
          return new Response(JSON.stringify({ parts: [{ type: "text", text: "Deployment complete." }] }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/prompt Deploy release", chat: { id: 77 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const runCall = calls.find((x) => x.url.includes("/session/session-current/message"));
    expect(runCall?.body.parts).toEqual([{ type: "text", text: "Please deploy the release." }]);
    const sent = String(calls.filter((x) => x.url.includes("/sendMessage")).at(-1)?.body.text || "");
    expect(sent).toBe("Deployment complete.");
  });

  test("/prompt resolves prompt list from mapped session directory", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current") && !url.includes("/message")) {
          return new Response(JSON.stringify({ id: "session-current", directory: "/workspace/project-a" }), { status: 200 });
        }
        if (url.includes("/api/ext/saved-prompts")) {
          const value = new URL(url).searchParams.get("directory");
          if (value !== "/workspace/project-a") {
            return new Response(
              JSON.stringify({
                global: [{ id: "g-1", title: "Global fallback", text: "Global", createdAt: 10 }],
                project: [],
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              global: [],
              project: [{ id: "p-1", title: "Project deploy", text: "Deploy from mapped context", createdAt: 20 }],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/session/session-current/message")) {
          return new Response(JSON.stringify({ parts: [{ type: "text", text: "Project deployment complete." }] }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
          directory: "/workspace/project-b",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/prompt Project deploy", chat: { id: 92 }, from: { id: 6 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.some((x) => x.url.includes("/api/ext/saved-prompts?directory=%2Fworkspace%2Fproject-a"))).toBe(true);
    expect(calls.some((x) => x.url.includes("/api/ext/saved-prompts?directory=%2Fworkspace%2Fproject-b"))).toBe(false);
    const runCall = calls.find((x) => x.url.includes("/session/session-current/message"));
    expect(runCall?.body.parts).toEqual([{ type: "text", text: "Deploy from mapped context" }]);
  });

  test("/prompt falls back when mapped directory has no saved prompts", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current") && !url.includes("/message")) {
          return new Response(JSON.stringify({ id: "session-current", directory: "/workspace/project-a" }), { status: 200 });
        }
        if (url.includes("/api/ext/saved-prompts?directory=%2Fworkspace%2Fproject-a")) {
          return new Response(JSON.stringify({ global: [], project: [] }), { status: 200 });
        }
        if (url.includes("/api/ext/saved-prompts?directory=%2Fworkspace%2Fproject-b")) {
          return new Response(
            JSON.stringify({
              global: [],
              project: [{ id: "p-2", title: "Project fallback", text: "Run fallback prompt", createdAt: 20 }],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/session/session-current/message")) {
          return new Response(JSON.stringify({ parts: [{ type: "text", text: "Fallback prompt complete." }] }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
          directory: "/workspace/project-b",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/prompt Project fallback", chat: { id: 97 }, from: { id: 6 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const promptCalls = calls.filter((x) => x.url.includes("/api/ext/saved-prompts")).map((x) => x.url);
    expect(promptCalls[0]).toContain("directory=%2Fworkspace%2Fproject-a");
    expect(promptCalls[1]).toContain("directory=%2Fworkspace%2Fproject-b");
    const runCall = calls.find((x) => x.url.includes("/session/session-current/message"));
    expect(runCall?.body.parts).toEqual([{ type: "text", text: "Run fallback prompt" }]);
  });

  test("/prompt falls back to global prompts when mapped and configured directories are empty", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current") && !url.includes("/message")) {
          return new Response(JSON.stringify({ id: "session-current", directory: "/workspace/project-a" }), { status: 200 });
        }
        if (url.includes("/api/ext/saved-prompts?directory=%2Fworkspace%2Fproject-a")) {
          return new Response(JSON.stringify({ global: [], project: [] }), { status: 200 });
        }
        if (url.includes("/api/ext/saved-prompts?directory=%2Fworkspace%2Fproject-b")) {
          return new Response(JSON.stringify({ global: [], project: [] }), { status: 200 });
        }
        if (url.endsWith("/api/ext/saved-prompts")) {
          return new Response(
            JSON.stringify({
              global: [{ id: "g-9", title: "Global rescue", text: "Run global rescue", createdAt: 10 }],
              project: [],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/session/session-current/message")) {
          return new Response(JSON.stringify({ parts: [{ type: "text", text: "Global rescue done." }] }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
          directory: "/workspace/project-b",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/prompt Global rescue", chat: { id: 99 }, from: { id: 6 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const promptCalls = calls.filter((x) => x.url.includes("/api/ext/saved-prompts")).map((x) => x.url);
    expect(promptCalls[0]).toContain("directory=%2Fworkspace%2Fproject-a");
    expect(promptCalls[1]).toContain("directory=%2Fworkspace%2Fproject-b");
    expect(promptCalls[2]).toBe("http://127.0.0.1:4096/api/ext/saved-prompts");
    const runCall = calls.find((x) => x.url.includes("/session/session-current/message"));
    expect(runCall?.body.parts).toEqual([{ type: "text", text: "Run global rescue" }]);
  });

  test("/prompt returns actionable guidance for unknown names", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/api/ext/saved-prompts")) {
          return new Response(
            JSON.stringify({
              global: [{ id: "g-1", title: "Deploy release", text: "Deploy", createdAt: 10 }],
              project: [],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/prompt missing", chat: { id: 77 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sent = String(calls.filter((x) => x.url.includes("/sendMessage")).at(-1)?.body.text || "");
    expect(sent).toBe("Saved prompt not found: missing. Use /prompts to list available options.");
  });

  test("/prompt returns disambiguation when multiple names match", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/api/ext/saved-prompts")) {
          return new Response(
            JSON.stringify({
              global: [
                { id: "g-1", title: "Deploy release", text: "Deploy prod", createdAt: 10 },
                { id: "g-2", title: "Deploy release staging", text: "Deploy stage", createdAt: 9 },
              ],
              project: [],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/prompt deploy", chat: { id: 77 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sent = String(calls.filter((x) => x.url.includes("/sendMessage")).at(-1)?.body.text || "");
    expect(sent).toContain("Multiple prompts match \"deploy\":");
    expect(sent).toContain("Deploy release [global] (g-1)");
    expect(sent).toContain("Use /prompt <id> to pick one.");
  });

  test("/sessions lists known sessions and /switch supports index and explicit id", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const createdSessions = ["session-1", "session-2"];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url === "http://127.0.0.1:4096/session") {
          const id = createdSessions.shift();
          return new Response(JSON.stringify({ id }), { status: 200 });
        }
        if (url.includes("/session/session-2")) {
          return new Response(JSON.stringify({ id: "session-2", title: "Second chat" }), { status: 200 });
        }
        if (url.includes("/session/session-1")) {
          return new Response(JSON.stringify({ id: "session-1", title: "First chat" }), { status: 200 });
        }
        if (url.includes("/session/custom-session")) {
          return new Response(JSON.stringify({ id: "custom-session", title: "Custom thread" }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const map = new Map<string, string>();
      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async (key: string) => map.get(key),
          set: async (key: string, value: string) => {
            map.set(key, value);
          },
          delete: async (key: string) => {
            map.delete(key);
          },
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/status", chat: { id: 19 }, from: { id: 4 } },
      });
      await handleTextUpdate(runtime, {
        update_id: 2,
        message: { message_id: 2, text: "/new", chat: { id: 19 }, from: { id: 4 } },
      });
      await handleTextUpdate(runtime, {
        update_id: 3,
        message: { message_id: 3, text: "/sessions", chat: { id: 19 }, from: { id: 4 } },
      });
      await handleTextUpdate(runtime, {
        update_id: 4,
        message: { message_id: 4, text: "/switch 2", chat: { id: 19 }, from: { id: 4 } },
      });
      await handleTextUpdate(runtime, {
        update_id: 5,
        message: { message_id: 5, text: "/switch custom-session", chat: { id: 19 }, from: { id: 4 } },
      });
      await handleTextUpdate(runtime, {
        update_id: 6,
        message: { message_id: 6, text: "/status", chat: { id: 19 }, from: { id: 4 } },
      });

      const sent = calls
        .filter((x) => x.url.includes("/sendMessage"))
        .map((x) => String(x.body.text || ""));
      expect(sent[2]).toContain("Known sessions for this chat/user mapping:");
      expect(sent[2]).toContain("1. Second chat (session-2) (current)");
      expect(sent[2]).toContain("2. First chat (session-1)");
      expect(sent[2]).toContain("Use /switch [session-id|index] to switch.");
      expect(sent[3]).toBe("Switched to session: First chat (session-1)");
      expect(sent[4]).toBe("Switched to session: Custom thread (custom-session)");
      expect(sent[5]).toBe("Current session: Custom thread (custom-session)");
      expect(map.get("chat:19:user:4")).toBe("custom-session");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("/sessions is read-only and does not persist history", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    let historyWrites = 0;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-1")) {
          return new Response(JSON.stringify({ title: "Sprint Planning" }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
          historyGet: async () => ["session-old"],
          historySet: async () => {
            historyWrites += 1;
          },
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/sessions", chat: { id: 63 }, from: { id: 8 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sent = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sent[0]).toContain("1. session-current (current)");
    expect(sent[0]).toContain("2. session-old");
    expect(historyWrites).toBe(0);
  });

  test("/sessions trims session ids in display and current marker matching", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current")) {
          return new Response(JSON.stringify({ id: "session-current", title: "Current thread" }), { status: 200 });
        }
        if (url.includes("/session/session-old")) {
          return new Response(JSON.stringify({ id: "session-old", title: "Older thread" }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "  session-current  ",
          set: async () => undefined,
          delete: async () => undefined,
          historyGet: async () => ["  session-old  "],
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/sessions", chat: { id: 94 }, from: { id: 8 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sent = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sent[0]).toContain("1. Current thread (session-current) (current)");
    expect(sent[0]).toContain("2. Older thread (session-old)");
    expect(sent[0]).not.toContain("session-current  ");
  });

  test("/sessions and /status normalize multiline titles and truncate inline length", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const raw = `Current\nsession ${"x".repeat(140)}`;
    const normalized = raw.replace(/\s+/g, " ").trim();
    const expectedTitle = `${normalized.slice(0, 117)}...`;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current")) {
          return new Response(JSON.stringify({ id: "session-current", title: raw }), { status: 200 });
        }
        if (url.includes("/session/session-old")) {
          return new Response(JSON.stringify({ id: "session-old", title: "Older\nthread" }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
          historyGet: async () => ["session-old"],
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/sessions", chat: { id: 95 }, from: { id: 8 } },
      });
      await handleTextUpdate(runtime, {
        update_id: 2,
        message: { message_id: 2, text: "/status", chat: { id: 95 }, from: { id: 8 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sent = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sent[0]).toContain(`1. ${expectedTitle} (session-current) (current)`);
    expect(sent[0]).toContain("2. Older thread (session-old)");
    expect(sent[0]).not.toContain("Current\nsession");
    expect(sent[1]).toBe(`Current session: ${expectedTitle} (session-current)`);
  });

  test("/status avoids redundant history persistence when current session already first", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    let historyWrites = 0;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
          historyGet: async () => ["session-current", "session-old"],
          historySet: async () => {
            historyWrites += 1;
          },
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/status", chat: { id: 64 }, from: { id: 8 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sent = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sent[0]).toBe("Current session: session-current");
    expect(historyWrites).toBe(0);
  });

  test("/project status reports whether override is configured", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 90,
        message: { message_id: 90, text: "/project", chat: { id: 95 }, from: { id: 8 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const text = String(calls.find((x) => x.url.includes("/sendMessage"))?.body.text || "");
    expect(text).toContain("Project directory override is not set");
  });

  test("/project status includes project picker buttons from recent sessions", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/s-a")) {
          return new Response(JSON.stringify({ id: "s-a", title: "Alpha", directory: "/work/a" }), { status: 200 });
        }
        if (url.includes("/session/s-b")) {
          return new Response(JSON.stringify({ id: "s-b", title: "Beta", directory: "/work/b" }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "s-a",
          set: async () => undefined,
          delete: async () => undefined,
          historyGet: async () => ["s-b"],
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 93,
        message: { message_id: 93, text: "/project", chat: { id: 95 }, from: { id: 8 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sent = calls.find((x) => x.url.includes("/sendMessage"));
    const keyboard = sent?.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
    expect(keyboard?.inline_keyboard?.[0]?.[0]?.callback_data).toBe("d:s:s-a");
    expect(keyboard?.inline_keyboard?.[1]?.[0]?.callback_data).toBe("d:s:s-b");
  });

  test("/project set and clear update runtime and persist settings", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const settingsPath = process.env.TELEGRAM_SETTINGS_PATH || "";
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 91,
        message: { message_id: 91, text: "/project /tmp/work-a", chat: { id: 95 }, from: { id: 8 } },
      });
      expect(runtime.config.directory).toBe("/tmp/work-a");

      let stored = JSON.parse(await Bun.file(settingsPath).text()) as { settings?: { directory?: string } };
      expect(stored.settings?.directory).toBe("/tmp/work-a");

      await handleTextUpdate(runtime, {
        update_id: 92,
        message: { message_id: 92, text: "/project clear", chat: { id: 95 }, from: { id: 8 } },
      });
      expect(runtime.config.directory).toBeUndefined();

      stored = JSON.parse(await Bun.file(settingsPath).text()) as { settings?: { directory?: string } };
      expect(stored.settings?.directory).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sentTexts = calls.filter((x) => x.url.includes("/sendMessage")).map((x) => String(x.body.text || ""));
    expect(sentTexts.some((text) => text.includes("Project directory override set to: /tmp/work-a"))).toBe(true);
    expect(sentTexts.some((text) => text.includes("Cleared project directory override"))).toBe(true);
  });

  test("project picker callback switches directory from selected session", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/answerCallbackQuery")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        if (url.includes("/session/s-a")) {
          return new Response(JSON.stringify({ id: "s-a", title: "Alpha", directory: "/work/a" }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "s-a",
          set: async () => undefined,
          delete: async () => undefined,
          historyGet: async () => ["s-a"],
        },
      };

      await handleCallbackUpdate(runtime, {
        update_id: 94,
        callback_query: {
          id: "cb-project-switch",
          data: "d:s:s-a",
          from: { id: 8 },
          message: { message_id: 94, chat: { id: 95 } },
        },
      });

      expect(runtime.config.directory).toBe("/work/a");
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sentTexts = calls.filter((x) => x.url.includes("/sendMessage")).map((x) => String(x.body.text || ""));
    expect(sentTexts.some((text) => text.includes("Project directory override set to: /work/a"))).toBe(true);
  });

  test("/sessions and /status reuse cached session metadata within ttl", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current")) {
          return new Response(JSON.stringify({ id: "session-current", title: "Current thread" }), { status: 200 });
        }
        if (url.includes("/session/session-old")) {
          return new Response(JSON.stringify({ id: "session-old", title: "Older thread" }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
          historyGet: async () => ["session-old"],
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/sessions", chat: { id: 67 }, from: { id: 8 } },
      });
      await handleTextUpdate(runtime, {
        update_id: 2,
        message: { message_id: 2, text: "/status", chat: { id: 67 }, from: { id: 8 } },
      });
      await handleTextUpdate(runtime, {
        update_id: 3,
        message: { message_id: 3, text: "/sessions", chat: { id: 67 }, from: { id: 8 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.filter((x) => x.url.includes("/session/session-current")).length).toBe(1);
    expect(calls.filter((x) => x.url.includes("/session/session-old")).length).toBe(1);
  });

  test("/sessions limits concurrent session title lookups", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    let activeLookups = 0;
    let maxConcurrentLookups = 0;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/") && !url.includes("/message")) {
          activeLookups += 1;
          maxConcurrentLookups = Math.max(maxConcurrentLookups, activeLookups);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeLookups -= 1;
          return new Response(JSON.stringify({ id: "session-id", title: "Session title" }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-01",
          set: async () => undefined,
          delete: async () => undefined,
          historyGet: async () => Array.from({ length: 19 }, (_, idx) => `session-${String(idx + 2).padStart(2, "0")}`),
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/sessions", chat: { id: 68 }, from: { id: 8 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(maxConcurrentLookups).toBeLessThanOrEqual(6);
    expect(calls.filter((x) => x.url.includes("/session/") && !x.url.includes("/message")).length).toBe(20);
  });

  test("session metadata cache normalizes whitespace in session ids", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current")) {
          return new Response(JSON.stringify({ id: "session-current", title: "Current thread" }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => " session-current ",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/status", chat: { id: 88 }, from: { id: 8 } },
      });
      await handleTextUpdate(runtime, {
        update_id: 2,
        message: { message_id: 2, text: "/status", chat: { id: 88 }, from: { id: 8 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.filter((x) => x.url.includes("/session/session-current")).length).toBe(1);
    expect(calls.some((x) => x.url.includes("/session/%20session-current%20"))).toBe(false);
  });

  test("/recent returns latest user and assistant exchanges", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current/message")) {
          return new Response(
            JSON.stringify([
              {
                info: { id: "u-1", role: "user" },
                parts: [{ type: "text", text: "First question" }],
              },
              {
                info: { id: "a-1", role: "assistant", parentID: "u-1" },
                parts: [{ type: "text", text: "First answer" }],
              },
              {
                info: { id: "u-2", role: "user" },
                parts: [{ type: "text", text: "Second question" }],
              },
              {
                info: { id: "a-2", role: "assistant", parentID: "u-2" },
                parts: [{ type: "text", text: "Second answer" }],
              },
            ]),
            { status: 200 },
          );
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/recent", chat: { id: 101 }, from: { id: 4 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const text = String(calls.filter((x) => x.url.includes("/sendMessage")).at(-1)?.body.text || "");
    expect(text).toContain("Recent activity for session session-current");
    expect(text).toContain("You: First question");
    expect(text).toContain("Assistant: First answer");
    expect(text).toContain("You: Second question");
    expect(text).toContain("Assistant: Second answer");
  });

  test("/recent reports empty state when no message history exists", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current/message")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 2,
        message: { message_id: 2, text: "/recent 3", chat: { id: 101 }, from: { id: 4 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const text = String(calls.filter((x) => x.url.includes("/sendMessage")).at(-1)?.body.text || "");
    expect(text).toBe("No recent chat messages found for session session-current. Send a new message first.");
  });

  test("/recent validates invalid count arguments", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 4,
        message: { message_id: 4, text: "/recent foo", chat: { id: 101 }, from: { id: 4 } },
      });
      await handleTextUpdate(runtime, {
        update_id: 5,
        message: { message_id: 5, text: "/recent 0", chat: { id: 101 }, from: { id: 4 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const texts = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(texts).toEqual([
      "Usage: /recent [count] (count must be >= 1; values above 12 are clamped to 12)",
      "Usage: /recent [count] (count must be >= 1; values above 12 are clamped to 12)",
    ]);
    expect(calls.some((x) => x.url.includes("/session/session-current/message"))).toBe(false);
  });

  test("/recent keeps truncated inline text on one line", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const long = "z".repeat(600);
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current/message")) {
          return new Response(
            JSON.stringify([
              { info: { id: "u-1", role: "user" }, parts: [{ type: "text", text: long }] },
              { info: { id: "a-1", role: "assistant", parentID: "u-1" }, parts: [{ type: "text", text: "ok" }] },
            ]),
            { status: 200 },
          );
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 6,
        message: { message_id: 6, text: "/recent 1", chat: { id: 101 }, from: { id: 4 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const text = String(calls.filter((x) => x.url.includes("/sendMessage")).at(-1)?.body.text || "");
    expect(text).toContain(`You: ${"z".repeat(497)}...`);
    expect(text).not.toContain("\n\n...");
  });

  test("/recent reports missing active mapping", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 5,
        message: { message_id: 5, text: "/recent", chat: { id: 101 }, from: { id: 4 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const text = String(calls.filter((x) => x.url.includes("/sendMessage")).at(-1)?.body.text || "");
    expect(text).toBe("No active session mapping for this chat/user yet. Use /status or /new first.");
    expect(calls.some((x) => x.url.includes("/session/"))).toBe(false);
  });

  test("/recent excludes non-chat and ignored message parts", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current/message")) {
          return new Response(
            JSON.stringify([
              {
                info: { id: "sys-1", role: "system" },
                parts: [{ type: "text", text: "system-secret" }],
              },
              {
                info: { id: "u-1", role: "user" },
                parts: [
                  { type: "text", text: "Keep this" },
                  { type: "text", text: "drop-ignored", ignored: true },
                  { type: "text", text: "drop-synthetic", synthetic: true },
                  { type: "tool", text: "tool-payload" },
                ],
              },
              {
                info: { id: "a-1", role: "assistant", parentID: "u-1" },
                parts: [{ type: "text", text: "Assistant text" }],
              },
            ]),
            { status: 200 },
          );
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 6,
        message: { message_id: 6, text: "/recent 1", chat: { id: 101 }, from: { id: 4 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const text = String(calls.filter((x) => x.url.includes("/sendMessage")).at(-1)?.body.text || "");
    expect(text).toContain("You: Keep this");
    expect(text).toContain("Assistant: Assistant text");
    expect(text).not.toContain("system-secret");
    expect(text).not.toContain("drop-ignored");
    expect(text).not.toContain("drop-synthetic");
    expect(text).not.toContain("tool-payload");
  });

  test("/recent output is chunked for Telegram message size limits", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const long = "x".repeat(2000);
    const rows = Array.from({ length: 12 }, (_, i) => {
      const n = i + 1;
      return [
        { info: { id: `u-${n}`, role: "user" }, parts: [{ type: "text", text: `${long}-${n}` }] },
        { info: { id: `a-${n}`, role: "assistant", parentID: `u-${n}` }, parts: [{ type: "text", text: `${long}-a-${n}` }] },
      ];
    }).flat();

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current/message")) {
          return new Response(JSON.stringify(rows), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 7,
        message: { message_id: 7, text: "/recent 12", chat: { id: 101 }, from: { id: 4 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sent = calls.filter((x) => x.url.includes("/sendMessage"));
    expect(sent.length).toBeGreaterThan(1);
    for (const row of sent) {
      expect(String(row.body.text || "").length).toBeLessThanOrEqual(3900);
    }
  });

  test("/recent enforces max limit when count is too high", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const rows = Array.from({ length: 20 }, (_, i) => {
      const n = i + 1;
      return [
        { info: { id: `u-${n}`, role: "user" }, parts: [{ type: "text", text: `user-${n}` }] },
        { info: { id: `a-${n}`, role: "assistant", parentID: `u-${n}` }, parts: [{ type: "text", text: `assistant-${n}` }] },
      ];
    }).flat();

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-current/message")) {
          return new Response(JSON.stringify(rows), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 3,
        message: { message_id: 3, text: "/recent 99", chat: { id: 101 }, from: { id: 4 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const text = String(calls.filter((x) => x.url.includes("/sendMessage")).at(-1)?.body.text || "");
    expect(text).toContain("showing 12 of 20");
    expect(text).toContain("You: user-9");
    expect(text).not.toContain("You: user-8");
    expect(text).toContain("Assistant: assistant-20");
  });

  test("/status keeps handling updates when history persistence fails", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
          historyGet: async () => ["session-old"],
          historySet: async () => {
            throw new Error("history write failed");
          },
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/status", chat: { id: 65 }, from: { id: 8 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sent = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sent).toEqual(["Current session: session-current"]);
  });

  test("/status does not wait for slow history persistence", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    let release = () => {};
    const stalledHistory = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => "session-current",
          set: async () => undefined,
          delete: async () => undefined,
          historyGet: async () => ["session-old"],
          historySet: async () => {
            await stalledHistory;
          },
        },
      };

      const status = handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/status", chat: { id: 66 }, from: { id: 8 } },
      });
      const raced = await Promise.race([
        status.then(() => "done"),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
      ]);
      expect(raced).toBe("done");
      release();
      await stalledHistory;
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sent = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sent).toEqual(["Current session: session-current"]);
  });

  test("/switch returns clear validation errors for missing and invalid index", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    let historyWrites = 0;
    const map = new Map<string, string>([["chat:33:user:2", "session-a"]]);
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async (key: string) => map.get(key),
          set: async (key: string, value: string) => {
            map.set(key, value);
          },
          delete: async (key: string) => {
            map.delete(key);
          },
          historyGet: async () => ["session-b"],
          historySet: async () => {
            historyWrites += 1;
          },
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/switch", chat: { id: 33 }, from: { id: 2 } },
      });
      await handleTextUpdate(runtime, {
        update_id: 2,
        message: { message_id: 2, text: "/switch 9", chat: { id: 33 }, from: { id: 2 } },
      });

      const sent = calls
        .filter((x) => x.url.includes("/sendMessage"))
        .map((x) => String(x.body.text || ""));
      expect(sent[0]).toContain("Recent sessions for this chat/user mapping (1-2 of 2).");
      expect(sent[0]).toContain("Tap a session button to switch instantly");
      const picker = calls.filter((x) => x.url.includes("/sendMessage"))[0]?.body.reply_markup as {
        inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
      } | undefined;
      expect(picker?.inline_keyboard?.[0]?.[0]?.text).toContain("session-a");
      expect(picker?.inline_keyboard?.[1]?.[0]?.text).toContain("session-b");
      expect(String(picker?.inline_keyboard?.[0]?.[0]?.callback_data || "")).toMatch(/^s:s:1:[a-z0-9]{6,24}$/);
      expect(sent[1]).toBe("Invalid session index: 9. Available indices: 1-2.");
      expect(historyWrites).toBe(0);
      expect(map.get("chat:33:user:2")).toBe("session-a");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("/switch with no args advertises quick recent-session switching", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const map = new Map<string, string>([["chat:46:user:3", "session-a"]]);
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-a")) {
          return new Response(JSON.stringify({ id: "session-a", title: "Alpha" }), { status: 200 });
        }
        if (url.includes("/session/session-b")) {
          return new Response(JSON.stringify({ id: "session-b", title: "Beta" }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async (key: string) => map.get(key),
          set: async (key: string, value: string) => {
            map.set(key, value);
          },
          delete: async (key: string) => {
            map.delete(key);
          },
          historyGet: async () => ["session-b"],
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/switch", chat: { id: 46 }, from: { id: 3 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sent = String(calls.filter((x) => x.url.includes("/sendMessage")).at(-1)?.body.text || "");
    expect(sent).toContain("Recent sessions for this chat/user mapping (1-2 of 2).");
    const picker = calls.filter((x) => x.url.includes("/sendMessage")).at(-1)?.body.reply_markup as {
      inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
    } | undefined;
    expect(picker?.inline_keyboard?.[0]?.[0]?.text).toContain("Alpha");
    expect(picker?.inline_keyboard?.[1]?.[0]?.text).toContain("Beta");
    expect(String(picker?.inline_keyboard?.[1]?.[0]?.callback_data || "")).toMatch(/^s:s:2:[a-z0-9]{6,24}$/);
  });

  test("/switch empty-state copy advertises /new and picker usage", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          historyGet: async () => [],
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/switch", chat: { id: 77 }, from: { id: 3 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sent = String(calls.filter((x) => x.url.includes("/sendMessage")).at(-1)?.body.text || "");
    expect(sent).toContain("Use /new to create one");
    expect(sent).toContain("run /switch to pick from recent sessions");
  });

  test("/switch picker paginates with More callbacks", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const map = new Map<string, string>([["chat:81:user:3", "session-01"]]);
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/answerCallbackQuery")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async (key: string) => map.get(key),
          set: async (key: string, value: string) => {
            map.set(key, value);
          },
          delete: async (key: string) => {
            map.delete(key);
          },
          historyGet: async () => Array.from({ length: 12 }, (_, idx) => `session-${String(idx + 1).padStart(2, "0")}`),
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/switch", chat: { id: 81 }, from: { id: 3 } },
      });

      await handleCallbackUpdate(runtime, {
        update_id: 2,
        callback_query: {
          id: "cb-switch-more",
          data: "s:p:2",
          from: { id: 3 },
          message: { message_id: 2, chat: { id: 81 } },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const messages = calls.filter((x) => x.url.includes("/sendMessage"));
    expect(String(messages[0]?.body.text || "")).toContain("(1-10 of 12)");
    expect(String(messages[1]?.body.text || "")).toContain("(11-12 of 12)");
    const secondMarkup = messages[1]?.body.reply_markup as {
      inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
    } | undefined;
    const navRow = secondMarkup?.inline_keyboard?.at(-1);
    expect(navRow?.some((button) => button.text === "Back")).toBe(true);
    expect(navRow?.some((button) => button.text === "More")).toBe(false);
  });

  test("/switch picker callback switches to selected session", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const map = new Map<string, string>([["chat:82:user:3", "session-a"]]);
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/answerCallbackQuery")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        if (url.includes("/session/session-b")) {
          return new Response(JSON.stringify({ id: "session-b", title: "Beta thread" }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async (key: string) => map.get(key),
          set: async (key: string, value: string) => {
            map.set(key, value);
          },
          delete: async (key: string) => {
            map.delete(key);
          },
          historyGet: async () => ["session-b", "session-c"],
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/switch", chat: { id: 82 }, from: { id: 3 } },
      });

      const picker = calls.find((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes("Recent sessions"));
      const data = String(
        ((picker?.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined)
          ?.inline_keyboard?.[1]?.[0]?.callback_data) || "",
      );

      await handleCallbackUpdate(runtime, {
        update_id: 2,
        callback_query: {
          id: "cb-switch-select",
          data,
          from: { id: 3 },
          message: { message_id: 2, chat: { id: 82 } },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const callbackAck = calls.filter((x) => x.url.includes("/answerCallbackQuery")).at(-1);
    expect(String(callbackAck?.body.text || "")).toContain("Switched");
    const sentTexts = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sentTexts.some((text) => text.includes("Switched to session: Beta thread (session-b)"))).toBe(true);
    expect(map.get("chat:82:user:3")).toBe("session-b");
  });

  test("session history cache is bounded and evicts oldest chat keys", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const historyReads = new Map<string, number>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 2,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          historyGet: async (key: string) => {
            historyReads.set(key, (historyReads.get(key) || 0) + 1);
            return ["session-old"];
          },
        },
      };

      const updates = [
        { update_id: 1, message: { message_id: 1, text: "/sessions", chat: { id: 101 }, from: { id: 5 } } },
        { update_id: 2, message: { message_id: 2, text: "/sessions", chat: { id: 102 }, from: { id: 5 } } },
        { update_id: 3, message: { message_id: 3, text: "/sessions", chat: { id: 103 }, from: { id: 5 } } },
        { update_id: 4, message: { message_id: 4, text: "/sessions", chat: { id: 101 }, from: { id: 5 } } },
      ];

      for (const update of updates) {
        await handleTextUpdate(runtime, update);
      }

      expect(historyReads.get("chat:101:user:5")).toBe(2);
      expect(historyReads.get("chat:102:user:5")).toBe(1);
      expect(historyReads.get("chat:103:user:5")).toBe(1);
      expect(calls.filter((x) => x.url.includes("/sendMessage")).length).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("/switch validates explicit session ids before remapping", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/missing-session")) {
          return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const map = new Map<string, string>([["chat:35:user:3", "session-a"]]);
      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async (key: string) => map.get(key),
          set: async (key: string, value: string) => {
            map.set(key, value);
          },
          delete: async (key: string) => {
            map.delete(key);
          },
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/switch missing-session", chat: { id: 35 }, from: { id: 3 } },
      });
      await handleTextUpdate(runtime, {
        update_id: 2,
        message: { message_id: 2, text: "/switch missing-session", chat: { id: 35 }, from: { id: 3 } },
      });

      const sent = calls
        .filter((x) => x.url.includes("/sendMessage"))
        .map((x) => String(x.body.text || ""));
      expect(sent[0]).toBe("Session not found: missing-session. Use /sessions to select a known session or /new to create one.");
      expect(sent[1]).toBe("Session not found: missing-session. Use /sessions to select a known session or /new to create one.");
      expect(map.get("chat:35:user:3")).toBe("session-a");
      expect(calls.filter((x) => x.url.includes("/session/missing-session")).length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("queued switch commands are serialized and /status reflects latest mapping", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/")) {
          return new Response(JSON.stringify({ id: "exists" }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const map = new Map<string, string>([["chat:44:user:10", "session-a"]]);
      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async (key: string) => map.get(key),
          set: async (key: string, value: string) => {
            map.set(key, value);
          },
          delete: async (key: string) => {
            map.delete(key);
          },
        },
      };

      const updates = [
        {
          update_id: 1,
          message: { message_id: 1, text: "/switch session-b", chat: { id: 44 }, from: { id: 10 } },
        },
        {
          update_id: 2,
          message: { message_id: 2, text: "/switch session-c", chat: { id: 44 }, from: { id: 10 } },
        },
        {
          update_id: 3,
          message: { message_id: 3, text: "/status", chat: { id: 44 }, from: { id: 10 } },
        },
      ];

      await Promise.all(updates.map((update) => queueChatUpdate("44", () => handleTextUpdate(runtime, update))));

      const sent = calls
        .filter((x) => x.url.includes("/sendMessage"))
        .map((x) => String(x.body.text || ""));
      expect(sent).toEqual([
        "Switched to session: session-b",
        "Switched to session: session-c",
        "Current session: session-c",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("handleTextUpdate supports notification opt-in commands", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const map = new Map<string, string>();
      const notify = new Map<string, boolean>();
      const alarms = new Map<string, boolean>();
      map.set("chat:77:user:5", "session-77");
      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async (key: string) => map.get(key),
          set: async (key: string, value: string) => {
            map.set(key, value);
          },
          delete: async (key: string) => {
            map.delete(key);
          },
          notificationGet: async (key: string) => notify.get(key) === true,
          notificationSet: async (key: string, enabled: boolean) => {
            if (enabled) {
              notify.set(key, true);
              return;
            }
            notify.delete(key);
          },
          sessionAlarmSet: async (sessionId: string, enabled: boolean) => {
            if (enabled) {
              alarms.set(sessionId, true);
              return;
            }
            alarms.delete(sessionId);
          },
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/notify status", chat: { id: 77 }, from: { id: 5 } },
      });
      await handleTextUpdate(runtime, {
        update_id: 2,
        message: { message_id: 2, text: "/notify on", chat: { id: 77 }, from: { id: 5 } },
      });
      await handleTextUpdate(runtime, {
        update_id: 3,
        message: { message_id: 3, text: "/notify status", chat: { id: 77 }, from: { id: 5 } },
      });
      await handleTextUpdate(runtime, {
        update_id: 4,
        message: { message_id: 4, text: "/notify off", chat: { id: 77 }, from: { id: 5 } },
      });

      const sentTexts = calls
        .filter((x) => x.url.includes("/sendMessage"))
        .map((x) => String(x.body.text || ""));
      expect(sentTexts[0]).toBe("Notifications are disabled.");
      expect(sentTexts[1]).toBe("Notifications enabled for this chat.");
      expect(sentTexts[2]).toBe("Notifications are enabled.");
      expect(sentTexts[3]).toBe("Notifications disabled for this chat.");
      expect(notify.get("chat:77")).toBeUndefined();
      expect(alarms.get("session-77")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("/notify setting applies to whole chat across users", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const notify = new Map<string, boolean>();
      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          notificationGet: async (key: string) => notify.get(key) === true,
          notificationSet: async (key: string, enabled: boolean) => {
            if (enabled) {
              notify.set(key, true);
              return;
            }
            notify.delete(key);
          },
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/notify on", chat: { id: 90 }, from: { id: 5 } },
      });
      await handleTextUpdate(runtime, {
        update_id: 2,
        message: { message_id: 2, text: "/notify status", chat: { id: 90 }, from: { id: 6 } },
      });

      const sentTexts = calls
        .filter((x) => x.url.includes("/sendMessage"))
        .map((x) => String(x.body.text || ""));
      expect(sentTexts[0]).toBe("Notifications enabled for this chat.");
      expect(sentTexts[1]).toBe("Notifications are enabled.");
      expect(notify.get("chat:90")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("/notify status includes inline toggle buttons", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const notify = new Map<string, boolean>();
      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          notificationGet: async (key: string) => notify.get(key) === true,
          notificationSet: async (key: string, enabled: boolean) => {
            if (enabled) {
              notify.set(key, true);
              return;
            }
            notify.delete(key);
          },
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 8,
        message: { message_id: 8, text: "/notify status", chat: { id: 81 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sent = calls.find((x) => x.url.includes("/sendMessage"));
    expect(String(sent?.body.text || "")).toBe("Notifications are disabled.");
    const markup = sent?.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
    const top = markup?.inline_keyboard?.[0] || [];
    expect(top.map((item) => item.callback_data)).toEqual(["n:on", "n:off"]);
    expect(markup?.inline_keyboard?.[1]?.[0]?.callback_data).toBe("n:status");
  });

  test("notify callback toggles state and returns updated button state", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const alarms = new Map<string, boolean>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/answerCallbackQuery")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const notify = new Map<string, boolean>();
      const map = new Map<string, string>();
      map.set("chat:81:user:5", "session-81");
      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async (key: string) => map.get(key),
          set: async () => undefined,
          delete: async () => undefined,
          notificationGet: async (key: string) => notify.get(key) === true,
          notificationSet: async (key: string, enabled: boolean) => {
            if (enabled) {
              notify.set(key, true);
              return;
            }
            notify.delete(key);
          },
          sessionAlarmSet: async (sessionId: string, enabled: boolean) => {
            if (enabled) {
              alarms.set(sessionId, true);
              return;
            }
            alarms.delete(sessionId);
          },
        },
      };

      await handleCallbackUpdate(runtime, {
        update_id: 82,
        callback_query: {
          id: "cb-notify-on",
          data: "n:on",
          from: { id: 5 },
          message: { message_id: 7, chat: { id: 81 } },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.some((x) => x.url.includes("/answerCallbackQuery") && String(x.body.text || "").includes("Updating notifications"))).toBe(true);
    const sent = calls.find((x) => x.url.includes("/sendMessage"));
    expect(String(sent?.body.text || "")).toBe("Notifications enabled for this chat.");
    const markup = sent?.body.reply_markup as { inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>> } | undefined;
    const top = markup?.inline_keyboard?.[0] || [];
    expect(top.map((item) => item.callback_data)).toEqual(["n:on", "n:off"]);
    expect((top[0]?.text || "").includes("✅")).toBe(true);
    expect(alarms.get("session-81")).toBe(true);
  });

  test("session action switch callback remaps to target session", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/answerCallbackQuery")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        if (url.includes("/session/session-target")) {
          return new Response(JSON.stringify({ title: "Launch Readiness" }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const map = new Map<string, string>();
      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async (key: string) => map.get(key),
          set: async (key: string, value: string) => {
            map.set(key, value);
          },
          delete: async () => undefined,
          historyGet: async () => [],
          historySet: async () => undefined,
        },
      };

      await handleCallbackUpdate(runtime, {
        update_id: 83,
        callback_query: {
          id: "cb-session-switch",
          data: "a:s:session-target",
          from: { id: 5 },
          message: { message_id: 7, chat: { id: 81 } },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.some((x) => x.url.includes("/answerCallbackQuery") && String(x.body.text || "").includes("Switched"))).toBe(true);
    expect(calls.some((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes("Switched to session: Launch Readiness"))).toBe(true);
  });

  test("session action latest-message callback sends recent output", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/answerCallbackQuery")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        if (url.includes("/session/session-target/message")) {
          return new Response(JSON.stringify([
            {
              info: { id: "m1", role: "user" },
              parts: [{ type: "text", text: "show me latest" }],
            },
            {
              info: { id: "m2", role: "assistant", parentID: "m1" },
              parts: [{ type: "text", text: "Here is the latest update." }],
            },
          ]), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleCallbackUpdate(runtime, {
        update_id: 84,
        callback_query: {
          id: "cb-session-recent",
          data: "a:r:session-target",
          from: { id: 5 },
          message: { message_id: 7, chat: { id: 81 } },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.some((x) => x.url.includes("/answerCallbackQuery") && String(x.body.text || "").includes("Fetching latest message"))).toBe(true);
    expect(calls.some((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes("Latest message in session-target"))).toBe(true);
    expect(calls.some((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes("Assistant: Here is the latest update."))).toBe(true);
  });

  test("session action latest-message callback does not truncate long assistant output", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const longText = `${"A".repeat(520)} END`;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/answerCallbackQuery")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        if (url.includes("/session/session-target/message")) {
          return new Response(JSON.stringify([
            {
              info: { id: "m1", role: "assistant" },
              parts: [{ type: "text", text: longText }],
            },
          ]), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleCallbackUpdate(runtime, {
        update_id: 86,
        callback_query: {
          id: "cb-session-recent-long",
          data: "a:r:session-target",
          from: { id: 5 },
          message: { message_id: 7, chat: { id: 81 } },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.some((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes(longText))).toBe(true);
  });

  test("session action latest-message callback falls back to assistant-only history", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/answerCallbackQuery")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        if (url.includes("/session/session-target/message")) {
          return new Response(JSON.stringify([
            {
              info: { id: "m1", role: "assistant" },
              parts: [{ type: "text", text: "Pipeline completed successfully." }],
            },
          ]), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleCallbackUpdate(runtime, {
        update_id: 85,
        callback_query: {
          id: "cb-session-recent-assistant-only",
          data: "a:r:session-target",
          from: { id: 5 },
          message: { message_id: 7, chat: { id: 81 } },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.some((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes("Latest message in session-target"))).toBe(true);
    expect(calls.some((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes("Assistant: Pipeline completed successfully."))).toBe(true);
  });

  test("/pending returns aggregated actionable items for the chat", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => ["chat:77:user:5"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          sessionID: "session-1",
          questions: [{ header: "Need confirmation" }],
        },
      });
      await handleBridgeEvent(runtime, {
        type: "permission.asked",
        properties: {
          sessionID: "session-1",
          permission: "shell",
          patterns: ["docker *"],
        },
      });

      await handleTextUpdate(runtime, {
        update_id: 9,
        message: { message_id: 9, text: "/pending", chat: { id: 77 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sentTexts = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    const digest = sentTexts[sentTexts.length - 1] || "";
    expect(digest).toContain("Pending inbox for this chat:");
    expect(digest).toContain("[question] Question pending: Need confirmation");
    expect(digest).toContain("[permission] Permission request: shell (docker *)");
    expect(digest).toContain("session session-1");
  });

  test("/pending reports explicit empty state", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          pendingGet: async () => [],
          pendingSet: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/pending", chat: { id: 77 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const text = String(calls.find((x) => x.url.includes("/sendMessage"))?.body.text || "");
    expect(text).toContain("Pending inbox is clear");
  });

  test("/pending shows actionable and recent inbox items", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<
      string,
      Array<{
        id: string;
        kind: "question" | "permission" | "task-finished";
        sessionId: string;
        text: string;
        stampedAt: number;
        resolved: boolean;
      }>
    >();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => ["chat:77:user:5"],
          notificationGet: async () => true,
          pendingGet: async (chatKey: string) => pending.get(chatKey) || [],
          pendingSet: async (chatKey: string, items: Array<{
            id: string;
            kind: "question" | "permission" | "task-finished";
            sessionId: string;
            text: string;
            stampedAt: number;
            resolved: boolean;
          }>) => {
            pending.set(chatKey, [...items]);
          },
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: { sessionID: "session-1", questions: [{ header: "Need a decision" }] },
      });
      await handleBridgeEvent(runtime, {
        type: "permission.asked",
        properties: { sessionID: "session-1", permission: "write", patterns: ["src/**"] },
      });
      await handleBridgeEvent(runtime, {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "busy" } },
      });
      await handleBridgeEvent(runtime, {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "idle" } },
      });
      await handleTextUpdate(runtime, {
        update_id: 4,
        message: { message_id: 1, text: "/pending", chat: { id: 77 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sent = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    const digest = sent[sent.length - 1] || "";
    expect(digest).toContain("Pending inbox for this chat:");
    expect(digest).toContain("[finished]");
    expect(digest).toContain("Next:");
  });

  test("/inbox finished guidance points to /recent details", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const now = Date.now();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          pendingGet: async () => [
            {
              id: "finished-1",
              kind: "task-finished" as const,
              sessionId: "session-1",
              text: "Task finished: session is idle",
              stampedAt: now,
              resolved: false,
            },
          ],
          pendingSet: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 15,
        message: { message_id: 15, text: "/inbox", chat: { id: 77 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const text = String(calls.find((x) => x.url.includes("/sendMessage"))?.body.text || "");
    expect(text).toContain("Next: use /recent for details.");
    expect(text.includes("/status for details")).toBe(false);
  });

  test("/pending prunes expired entries and caps retained inbox size", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const key = "chat:77";
    const now = Date.now();
    const retained = Array.from({ length: 70 }, (_, i) => ({
      id: `entry-${i}`,
      kind: "question" as const,
      sessionId: "session-1",
      text: `Question pending: Need input ${i}`,
      stampedAt: now - i * 1_000,
      resolved: false,
    }));
    const expired = {
      id: "expired",
      kind: "permission" as const,
      sessionId: "session-1",
      text: "Permission request: old",
      stampedAt: now - 4 * 24 * 60 * 60 * 1_000,
      resolved: false,
    };
    const pending = new Map<string, Array<typeof retained[number] | typeof expired>>([[key, [...retained, expired]]]);

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          pendingGet: async (chatKey: string) => pending.get(chatKey) || [],
          pendingSet: async (chatKey: string, items: Array<typeof retained[number]>) => {
            pending.set(chatKey, [...items]);
          },
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 11,
        message: { message_id: 11, text: "/pending", chat: { id: 77 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const next = pending.get(key) || [];
    expect(next).toHaveLength(60);
    expect(next.some((item) => item.id === "expired")).toBe(false);
    const digest = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""))
      .join("\n");
    expect(digest).toContain("+52 more item(s) retained.");
  });

  test("/pending retention sort is deterministic when timestamps match", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const key = "chat:77";
    const now = Date.now();
    const pending = new Map<string, Array<{
      id: string;
      kind: "question" | "permission" | "task-finished";
      sessionId: string;
      text: string;
      stampedAt: number;
      resolved: boolean;
    }>>([
      [
        key,
        [
          {
            id: "b-item",
            kind: "question",
            sessionId: "session-1",
            text: "Question pending: second",
            stampedAt: now,
            resolved: false,
          },
          {
            id: "a-item",
            kind: "question",
            sessionId: "session-1",
            text: "Question pending: first",
            stampedAt: now,
            resolved: false,
          },
        ],
      ],
    ]);

    const runtime = {
      config: {
        mode: "polling" as const,
        token: "token",
        openCodeUrl: "http://127.0.0.1:4096",
        sessionCacheMax: 10,
        sessionCacheTtlMs: 10_000,
        notificationDebounceMs: 20_000,
        telegramAlarmChannelEnabled: false,
        port: 4097,
        webhookPath: "/webhook",
        sessionStorePath: "/tmp/test-store.json",
      },
      store: {
        get: async () => undefined,
        set: async () => undefined,
        delete: async () => undefined,
        pendingGet: async (chatKey: string) => pending.get(chatKey) || [],
        pendingSet: async (chatKey: string, items: Array<{
          id: string;
          kind: "question" | "permission" | "task-finished";
          sessionId: string;
          text: string;
          stampedAt: number;
          resolved: boolean;
        }>) => {
          pending.set(chatKey, [...items]);
        },
      },
    };

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      await handleTextUpdate(runtime, {
        update_id: 13,
        message: { message_id: 13, text: "/pending", chat: { id: 77 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const stored = pending.get(key) || [];
    expect(stored.map((item) => item.id)).toEqual(["a-item", "b-item"]);
    expect(calls.some((x) => x.url.includes("/sendMessage"))).toBe(true);
  });

  test("/pending ignores partial adapter implementations", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          pendingGet: async () => [
            {
              id: "adapter-entry",
              kind: "question" as const,
              sessionId: "session-1",
              text: "Question pending: adapter only",
              stampedAt: Date.now(),
              resolved: false,
            },
          ],
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 14,
        message: { message_id: 14, text: "/pending", chat: { id: 77 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const text = String(calls.find((x) => x.url.includes("/sendMessage"))?.body.text || "");
    expect(text).toContain("Pending inbox is clear");
    expect(text).not.toContain("adapter only");
  });

  test("handleBridgeEvent serializes pending updates for same chat", async () => {
    const pending = new Map<string, Array<{
      id: string;
      kind: "question" | "permission" | "task-finished";
      sessionId: string;
      text: string;
      stampedAt: number;
      resolved: boolean;
    }>>();
    const key = "chat:77";
    const runtime = {
      config: {
        mode: "polling" as const,
        token: "token",
        openCodeUrl: "http://127.0.0.1:4096",
        sessionCacheMax: 10,
        sessionCacheTtlMs: 10_000,
        notificationDebounceMs: 20_000,
        telegramAlarmChannelEnabled: false,
        port: 4097,
        webhookPath: "/webhook",
        sessionStorePath: "/tmp/test-store.json",
      },
      store: {
        get: async () => undefined,
        set: async () => undefined,
        delete: async () => undefined,
        sessionKeys: async () => ["chat:77:user:5"],
        notificationGet: async () => true,
        pendingGet: async (chatKey: string) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return pending.get(chatKey) || [];
        },
        pendingSet: async (chatKey: string, items: Array<{
          id: string;
          kind: "question" | "permission" | "task-finished";
          sessionId: string;
          text: string;
          stampedAt: number;
          resolved: boolean;
        }>) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          pending.set(chatKey, [...items]);
        },
      },
    };

    await Promise.all([
      handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: { sessionID: "session-1", questions: [{ header: "Need confirmation" }] },
      }),
      handleBridgeEvent(runtime, {
        type: "permission.asked",
        properties: { sessionID: "session-1", permission: "shell", patterns: ["docker *"] },
      }),
    ]);

    const items = pending.get(key) || [];
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.kind).sort()).toEqual(["permission", "question"]);
  });

  test("permission.asked reuses stable request id for pending entries", async () => {
    const pending = new Map<string, Array<{
      id: string;
      kind: "question" | "permission" | "task-finished";
      sessionId: string;
      text: string;
      stampedAt: number;
      resolved: boolean;
    }>>();
    const runtime = {
      config: {
        mode: "polling" as const,
        token: "token",
        openCodeUrl: "http://127.0.0.1:4096",
        sessionCacheMax: 10,
        sessionCacheTtlMs: 10_000,
        notificationDebounceMs: 20_000,
        telegramAlarmChannelEnabled: false,
        port: 4097,
        webhookPath: "/webhook",
        sessionStorePath: "/tmp/test-store.json",
      },
      store: {
        get: async () => undefined,
        set: async () => undefined,
        delete: async () => undefined,
        sessionKeys: async () => ["chat:77:user:5"],
        notificationGet: async () => true,
        pendingGet: async (chatKey: string) => pending.get(chatKey) || [],
        pendingSet: async (chatKey: string, items: Array<{
          id: string;
          kind: "question" | "permission" | "task-finished";
          sessionId: string;
          text: string;
          stampedAt: number;
          resolved: boolean;
        }>) => {
          pending.set(chatKey, [...items]);
        },
      },
    };

    await handleBridgeEvent(runtime, {
      type: "permission.asked",
      properties: {
        id: "perm-request-1",
        sessionID: "session-1",
        permission: "shell",
        patterns: ["docker *"],
      },
    });
    await handleBridgeEvent(runtime, {
      type: "permission.asked",
      properties: {
        id: "perm-request-1",
        sessionID: "session-1",
        permission: "shell",
        patterns: ["kubectl *"],
      },
    });

    const items = pending.get("chat:77") || [];
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toContain("perm-request-1");
    expect(items[0]?.text).toContain("kubectl *");
  });

  test("permission notifications debounce retries per request id only", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 60_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => ["chat:77:user:5"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "permission.asked",
        properties: {
          id: "perm-a",
          sessionID: "session-same",
          permission: "shell",
          patterns: ["docker *"],
        },
      });
      await handleBridgeEvent(runtime, {
        type: "permission.asked",
        properties: {
          id: "perm-a",
          sessionID: "session-same",
          permission: "shell",
          patterns: ["docker *"],
        },
      });
      await handleBridgeEvent(runtime, {
        type: "permission.asked",
        properties: {
          id: "perm-b",
          sessionID: "session-same",
          permission: "shell",
          patterns: ["kubectl *"],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sentTexts = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sentTexts).toHaveLength(2);
    expect(sentTexts[0]).toContain("docker *");
    expect(sentTexts[1]).toContain("kubectl *");
  });

  test("question pending inbox text is truncated for oversized prompts", async () => {
    const pending = new Map<string, Array<{
      id: string;
      kind: "question" | "permission" | "task-finished";
      sessionId: string;
      text: string;
      stampedAt: number;
      resolved: boolean;
    }>>();
    const runtime = {
      config: {
        mode: "polling" as const,
        token: "token",
        openCodeUrl: "http://127.0.0.1:4096",
        sessionCacheMax: 10,
        sessionCacheTtlMs: 10_000,
        notificationDebounceMs: 20_000,
        telegramAlarmChannelEnabled: false,
        port: 4097,
        webhookPath: "/webhook",
        sessionStorePath: "/tmp/test-store.json",
      },
      store: {
        get: async () => undefined,
        set: async () => undefined,
        delete: async () => undefined,
        sessionKeys: async () => ["chat:77:user:5"],
        notificationGet: async () => true,
        pendingGet: async (chatKey: string) => pending.get(chatKey) || [],
        pendingSet: async (chatKey: string, items: Array<{
          id: string;
          kind: "question" | "permission" | "task-finished";
          sessionId: string;
          text: string;
          stampedAt: number;
          resolved: boolean;
        }>) => {
          pending.set(chatKey, [...items]);
        },
      },
    };

    await handleBridgeEvent(runtime, {
      type: "question.asked",
      properties: {
        id: "req-long-question",
        sessionID: "session-1",
        questions: [{ header: "Need confirmation ".repeat(30) }],
      },
    });

    const text = pending.get("chat:77")?.[0]?.text || "";
    expect(text.startsWith("Question pending:")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(240);
    expect(text.endsWith("...")).toBe(true);
  });

  test("question and permission events still queue pending when notifications are disabled", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const inbox = new Map<string, Array<{
      id: string;
      kind: "question" | "permission" | "task-finished";
      sessionId: string;
      text: string;
      stampedAt: number;
      resolved: boolean;
    }>>();
    const pending = new Map<string, unknown[]>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => ["chat:77:user:5"],
          notificationGet: async () => false,
          pendingGet: async (chatKey: string) => inbox.get(chatKey) || [],
          pendingSet: async (chatKey: string, items: Array<{
            id: string;
            kind: "question" | "permission" | "task-finished";
            sessionId: string;
            text: string;
            stampedAt: number;
            resolved: boolean;
          }>) => {
            inbox.set(chatKey, [...items]);
          },
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async () => undefined,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-disabled",
          sessionID: "session-1",
          questions: [{ header: "Need approval", options: [{ label: "Yes" }, { label: "No" }] }],
        },
      });
      await handleBridgeEvent(runtime, {
        type: "permission.asked",
        properties: {
          sessionID: "session-1",
          permission: "shell",
          patterns: ["docker *"],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.some((x) => x.url.includes("/sendMessage"))).toBe(false);
    const items = inbox.get("chat:77") || [];
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.kind).sort()).toEqual(["permission", "question"]);
    const stored = (pending.get("chat:77:user:5") || []) as Array<{ requestId?: string }>;
    expect(stored[0]?.requestId).toBe("req-disabled");
  });

  test("question and permission events notify immediately when enabled", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const inbox = new Map<string, Array<{
      id: string;
      kind: "question" | "permission" | "task-finished";
      sessionId: string;
      text: string;
      stampedAt: number;
      resolved: boolean;
    }>>();
    const pending = new Map<string, unknown[]>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => ["chat:88:user:9"],
          notificationGet: async () => true,
          pendingGet: async (chatKey: string) => inbox.get(chatKey) || [],
          pendingSet: async (chatKey: string, items: Array<{
            id: string;
            kind: "question" | "permission" | "task-finished";
            sessionId: string;
            text: string;
            stampedAt: number;
            resolved: boolean;
          }>) => {
            inbox.set(chatKey, [...items]);
          },
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async () => undefined,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-enabled",
          sessionID: "session-1",
          questions: [{ header: "Need approval", options: [{ label: "Yes" }, { label: "No" }] }],
        },
      });
      await handleBridgeEvent(runtime, {
        type: "permission.asked",
        properties: {
          sessionID: "session-1",
          permission: "shell",
          patterns: ["docker *"],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sent = calls.filter((x) => x.url.includes("/sendMessage")).map((x) => String(x.body.text || ""));
    expect(sent.some((text) => text.includes("Question pending:"))).toBe(true);
    expect(sent.some((text) => text.includes("Permission request: shell"))).toBe(true);
    const items = inbox.get("chat:88") || [];
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.kind).sort()).toEqual(["permission", "question"]);
  });

  test("question alerts route to notify-on chats even without session mapping", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const inbox = new Map<string, Array<{
      id: string;
      kind: "question" | "permission" | "task-finished";
      sessionId: string;
      text: string;
      stampedAt: number;
      resolved: boolean;
    }>>();
    const pending = new Map<string, unknown[]>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => [],
          notificationKeys: async () => ["chat:188"],
          sessionAlarmGet: async () => true,
          pendingGet: async (chatKey: string) => inbox.get(chatKey) || [],
          pendingSet: async (chatKey: string, items: Array<{
            id: string;
            kind: "question" | "permission" | "task-finished";
            sessionId: string;
            text: string;
            stampedAt: number;
            resolved: boolean;
          }>) => {
            inbox.set(chatKey, [...items]);
          },
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async () => undefined,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-notify-fanout",
          sessionID: "session-bell",
          questions: [{ header: "Need approval", options: [{ label: "Yes" }, { label: "No" }] }],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sent = calls.filter((x) => x.url.includes("/sendMessage"));
    expect(sent.some((x) => x.body.chat_id === 188)).toBe(true);
    expect((inbox.get("chat:188") || []).map((item) => item.kind)).toEqual(["question"]);
    const stored = (pending.get("chat:188") || []) as Array<{ requestId?: string }>;
    expect(stored[0]?.requestId).toBe("req-notify-fanout");
  });

  test("question pending storage prefers chat-scoped key when notify and mapped keys both exist", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const upsertKeys: string[] = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => ["chat:188:user:9"],
          notificationKeys: async () => ["chat:188"],
          notificationGet: async () => true,
          sessionAlarmGet: async () => true,
          questionList: async () => [],
          questionUpsert: async (name: string) => {
            upsertKeys.push(name);
          },
          questionDelete: async () => undefined,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-prefer-chat-key",
          sessionID: "session-bell",
          questions: [{ header: "Need approval", options: [{ label: "Yes" }, { label: "No" }] }],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(upsertKeys).toEqual(["chat:188"]);
    expect(calls.some((x) => x.url.includes("/sendMessage") && x.body.chat_id === 188)).toBe(true);
  });

  test("legacy user-scoped notification keys do not bypass /notify chat status", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => [],
          notificationKeys: async () => ["chat:188:user:9"],
          notificationGet: async (key: string) => key === "chat:188" ? false : true,
          sessionAlarmGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "permission.asked",
        properties: {
          id: "perm-legacy-notify-key",
          sessionID: "session-bell",
          permission: "shell",
          patterns: ["docker *"],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.some((x) => x.url.includes("/sendMessage"))).toBe(false);
  });

  test("notify-off chats do not receive proactive alerts", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => [],
          notificationKeys: async () => [],
          sessionAlarmGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "permission.asked",
        properties: {
          id: "perm-notify-off",
          sessionID: "session-bell",
          permission: "shell",
          patterns: ["docker *"],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.some((x) => x.url.includes("/sendMessage"))).toBe(false);
  });

  test("session alarms gate proactive Telegram alerts", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const inbox = new Map<string, Array<{
      id: string;
      kind: "question" | "permission" | "task-finished";
      sessionId: string;
      text: string;
      stampedAt: number;
      resolved: boolean;
    }>>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => [],
          notificationKeys: async () => ["chat:188"],
          sessionAlarmGet: async () => false,
          pendingGet: async (chatKey: string) => inbox.get(chatKey) || [],
          pendingSet: async (chatKey: string, items: Array<{
            id: string;
            kind: "question" | "permission" | "task-finished";
            sessionId: string;
            text: string;
            stampedAt: number;
            resolved: boolean;
          }>) => {
            inbox.set(chatKey, [...items]);
          },
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-alarm-off",
          sessionID: "session-muted",
          questions: [{ header: "Need approval" }],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.some((x) => x.url.includes("/sendMessage"))).toBe(false);
    expect((inbox.get("chat:188") || []).length).toBe(0);
  });

  test("session alarms read latest state from disk for cross-process updates", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const dir = await mkdtemp(join(tmpdir(), "telegram-store-"));
    testTempDirs.push(dir);
    const storePath = join(dir, "telegram-sessions.json");
    await writeFile(
      storePath,
      `${JSON.stringify({
        version: 4,
        sessions: {},
        history: {},
        notifications: { "chat:188": true },
        sessionAlarms: { "session-disk": true },
        inbox: {},
        pending: {},
      }, null, 2)}\n`,
    );

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: storePath,
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => [],
          notificationKeys: async () => ["chat:188"],
          sessionAlarmGet: async () => false,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-disk-alarm",
          sessionID: "session-disk",
          questions: [{ header: "Need confirmation" }],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.some((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes("Question pending:"))).toBe(true);
  });

  test("session alarms inherit from root session for child events", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const alarms = new Map<string, boolean>([["session-root", true]]);
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/session/session-child")) {
          return new Response(JSON.stringify({ id: "session-child", parentID: "session-root" }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => [],
          notificationKeys: async () => ["chat:188"],
          sessionAlarmGet: async (sessionId: string) => alarms.get(sessionId) === true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-inherited",
          sessionID: "session-child",
          questions: [{ header: "Confirm" }],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.some((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes("Question pending:"))).toBe(true);
  });

  test("question, permission, and task-finished skip proactive send when telegram channel is disabled", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const inbox = new Map<string, Array<{
      id: string;
      kind: "question" | "permission" | "task-finished";
      sessionId: string;
      text: string;
      stampedAt: number;
      resolved: boolean;
    }>>();
    const pending = new Map<string, unknown[]>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          telegramAlarmChannelEnabled: false,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => ["chat:88:user:9"],
          notificationGet: async () => true,
          pendingGet: async (chatKey: string) => inbox.get(chatKey) || [],
          pendingSet: async (chatKey: string, items: Array<{
            id: string;
            kind: "question" | "permission" | "task-finished";
            sessionId: string;
            text: string;
            stampedAt: number;
            resolved: boolean;
          }>) => {
            inbox.set(chatKey, [...items]);
          },
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async () => undefined,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-channel-off",
          sessionID: "session-1",
          questions: [{ header: "Need approval", options: [{ label: "Yes" }, { label: "No" }] }],
        },
      });
      await handleBridgeEvent(runtime, {
        type: "permission.asked",
        properties: {
          id: "perm-channel-off",
          sessionID: "session-1",
          permission: "shell",
          patterns: ["docker *"],
        },
      });
      await handleBridgeEvent(runtime, {
        type: "session.status",
        properties: {
          sessionID: "session-1",
          status: { type: "busy" },
        },
      });
      await handleBridgeEvent(runtime, {
        type: "session.status",
        properties: {
          sessionID: "session-1",
          status: { type: "idle" },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.some((x) => x.url.includes("/sendMessage"))).toBe(false);
    const items = inbox.get("chat:88") || [];
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.kind).sort()).toEqual(["permission", "question", "task-finished"]);
  });

  test("/pending response is chunked under Telegram message limits", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const longText = "x".repeat(4500);
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          pendingGet: async () => [
            {
              id: "entry-1",
              kind: "question" as const,
              sessionId: "session-1",
              text: longText,
              stampedAt: Date.now(),
              resolved: false,
            },
          ],
          pendingSet: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 12,
        message: { message_id: 12, text: "/pending", chat: { id: 77 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const parts = calls.filter((x) => x.url.includes("/sendMessage")).map((x) => String(x.body.text || ""));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 3900)).toBe(true);
  });

  test("concurrent bridge events do not drop pending items for same chat", async () => {
    const pending = new Map<
      string,
      Array<{
        id: string;
        kind: "question" | "permission" | "task-finished";
        sessionId: string;
        text: string;
        stampedAt: number;
        resolved: boolean;
      }>
    >();
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const runtime = {
      config: {
        mode: "polling" as const,
        token: "token",
        openCodeUrl: "http://127.0.0.1:4096",
        sessionCacheMax: 10,
        sessionCacheTtlMs: 10_000,
        notificationDebounceMs: 20_000,
        port: 4097,
        webhookPath: "/webhook",
        sessionStorePath: "/tmp/test-store.json",
      },
      store: {
        get: async () => undefined,
        set: async () => undefined,
        delete: async () => undefined,
        sessionKeys: async () => ["chat:77:user:5"],
        notificationGet: async () => true,
        pendingGet: async (chatKey: string) => pending.get(chatKey) || [],
        pendingSet: async (chatKey: string, items: Array<{
          id: string;
          kind: "question" | "permission" | "task-finished";
          sessionId: string;
          text: string;
          stampedAt: number;
          resolved: boolean;
        }>) => {
          await sleep(5);
          pending.set(chatKey, [...items]);
        },
      },
    };

    await Promise.all([
      handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: { sessionID: "session-1", questions: [{ header: "Need input A" }] },
      }),
      handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: { sessionID: "session-1", questions: [{ header: "Need input B" }] },
      }),
    ]);

    const kept = pending.get("chat:77") || [];
    expect(kept).toHaveLength(2);
    expect(kept.some((item) => item.text.includes("Need input A"))).toBe(true);
    expect(kept.some((item) => item.text.includes("Need input B"))).toBe(true);
  });

  test("pending adapter does not mix inboxGet with pendingSet", async () => {
    let pendingSetCalled = false;
    const runtime = {
      config: {
        mode: "polling" as const,
        token: "token",
        openCodeUrl: "http://127.0.0.1:4096",
        sessionCacheMax: 10,
        sessionCacheTtlMs: 10_000,
        notificationDebounceMs: 20_000,
        port: 4097,
        webhookPath: "/webhook",
        sessionStorePath: "/tmp/test-store.json",
      },
      store: {
        get: async () => undefined,
        set: async () => undefined,
        delete: async () => undefined,
        sessionKeys: async () => ["chat:77:user:5"],
        notificationGet: async () => false,
        inboxGet: async () => [],
        pendingSet: async () => {
          pendingSetCalled = true;
          throw new Error("should not mix inboxGet with pendingSet");
        },
      },
    };

    await handleBridgeEvent(runtime, {
      type: "permission.asked",
      properties: {
        sessionID: "session-1",
        permission: { command: "npm test" },
      },
    });

    expect(pendingSetCalled).toBe(false);
  });

  test("handleBridgeEvent dedupes proactive session-key notifications per chat when debounce is disabled", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => ["chat:77:user:5", "chat:77:user:6"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          sessionID: "session-1",
          questions: [{ header: "Need input" }],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const messages = calls.filter((x) => x.url.includes("/sendMessage") && x.body.chat_id === 77);
    expect(messages.length).toBe(1);
  });

  test("handleBridgeEvent continues notifying other chats after one failure", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, Array<{
      id: string;
      kind: "question" | "permission" | "task-finished";
      sessionId: string;
      text: string;
      stampedAt: number;
      resolved: boolean;
    }>>();
    const queued = new Map<string, unknown[]>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          if (body.chat_id === 77) {
            throw new Error("telegram down for chat 77");
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => ["chat:77:user:5", "chat:88:user:6"],
          notificationGet: async () => true,
          pendingGet: async (chatKey: string) => pending.get(chatKey) || [],
          pendingSet: async (chatKey: string, items: Array<{
            id: string;
            kind: "question" | "permission" | "task-finished";
            sessionId: string;
            text: string;
            stampedAt: number;
            resolved: boolean;
          }>) => {
            pending.set(chatKey, [...items]);
          },
          questionList: async (name: string) => (queued.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            queued.set(name, [row]);
          },
          questionDelete: async () => undefined,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          sessionID: "session-1",
          questions: [{ header: "Need input" }],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const messages = calls.filter((x) => x.url.includes("/sendMessage"));
    expect(messages.some((x) => x.body.chat_id === 88)).toBe(true);
    expect((pending.get("chat:77") || []).length).toBe(1);
    expect((pending.get("chat:88") || []).length).toBe(1);
  });

  test("handleBridgeEvent sends task-finished only on non-idle to idle transition", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => ["chat:77:user:5"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "idle" } },
      });
      await handleBridgeEvent(runtime, {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "busy" } },
      });
      await handleBridgeEvent(runtime, {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "idle" } },
      });
      await handleBridgeEvent(runtime, {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "idle" } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sentTexts = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sentTexts).toEqual(["Task finished: the session is now idle.\n\nSession: session-1"]);
    const sent = calls.find((x) => x.url.includes("/sendMessage"));
    const markup = sent?.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
    expect(markup?.inline_keyboard?.[0]?.map((item) => item.callback_data)).toEqual(["a:s:session-1", "a:r:session-1"]);
  });

  test("handleBridgeEvent clears tracked status on session.deleted without sessionID", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => ["chat:77:user:5"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "busy" } },
      });
      await handleBridgeEvent(runtime, {
        type: "session.deleted",
        properties: { info: { id: "session-1" } },
      });
      await handleBridgeEvent(runtime, {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "idle" } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sentTexts = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sentTexts).toEqual([]);
  });

  test("sessionForChat does not cache new session when store set fails", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const createdSessions = ["session-1", "session-2"];
    const map = new Map<string, string>();
    let failSet = true;

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url === "http://127.0.0.1:4096/session") {
          const id = createdSessions.shift();
          return new Response(JSON.stringify({ id }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async (key: string) => map.get(key),
          set: async (key: string, value: string) => {
            if (failSet) {
              throw new Error("persist failed");
            }
            map.set(key, value);
          },
          delete: async (key: string) => {
            map.delete(key);
          },
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/status", chat: { id: 7 }, from: { id: 9 } },
      });
      failSet = false;
      await handleTextUpdate(runtime, {
        update_id: 2,
        message: { message_id: 2, text: "/status", chat: { id: 7 }, from: { id: 9 } },
      });

      const sentTexts = calls
        .filter((x) => x.url.includes("/sendMessage"))
        .map((x) => String(x.body.text || ""));
      expect(sentTexts[0]).toContain("Sorry, I ran into an internal error");
      expect(sentTexts[1]).toBe("Current session: session-2");
      expect(map.get("chat:7:user:9")).toBe("session-2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("/new does not cache session when store set fails", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const createdSessions = ["session-1", "session-2"];
    const map = new Map<string, string>();
    let failSet = true;

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url === "http://127.0.0.1:4096/session") {
          const id = createdSessions.shift();
          return new Response(JSON.stringify({ id }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async (key: string) => map.get(key),
          set: async (key: string, value: string) => {
            if (failSet) {
              throw new Error("persist failed");
            }
            map.set(key, value);
          },
          delete: async (key: string) => {
            map.delete(key);
          },
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 1,
        message: { message_id: 1, text: "/new", chat: { id: 7 }, from: { id: 9 } },
      });
      failSet = false;
      await handleTextUpdate(runtime, {
        update_id: 2,
        message: { message_id: 2, text: "/status", chat: { id: 7 }, from: { id: 9 } },
      });

      const sentTexts = calls
        .filter((x) => x.url.includes("/sendMessage"))
        .map((x) => String(x.body.text || ""));
      expect(sentTexts[0]).toContain("Sorry, I ran into an internal error");
      expect(sentTexts[1]).toBe("Current session: session-2");
      expect(map.get("chat:7:user:9")).toBe("session-2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("/new auto-enables session alarm when chat notifications are enabled", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const alarms = new Map<string, boolean>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url === "http://127.0.0.1:4096/session") {
          return new Response(JSON.stringify({ id: "session-new" }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 20_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          notificationGet: async (key: string) => key === "chat:7",
          sessionAlarmSet: async (sessionId: string, enabled: boolean) => {
            if (enabled) {
              alarms.set(sessionId, true);
              return;
            }
            alarms.delete(sessionId);
          },
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 3,
        message: { message_id: 3, text: "/new", chat: { id: 7 }, from: { id: 9 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(alarms.get("session-new")).toBe(true);
    expect(calls.some((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes("Started a new session: session-new"))).toBe(true);
  });

  test("outbound SSE parser handles CRLF split across chunk boundaries", () => {
    const blocks = parseOutboundBlocks(["data: one\r", "\n\r", "\ndata: two\n\n"]);
    expect(blocks).toEqual(["data: one", "data: two"]);
  });

  test("isTimeoutError classifies timeout names, codes, and messages", () => {
    const named = new Error("stream died");
    named.name = "TimeoutError";
    expect(isTimeoutError(named)).toBe(true);

    const coded = Object.assign(new Error("network failed"), { code: "ETIMEDOUT" });
    expect(isTimeoutError(coded)).toBe(true);

    expect(isTimeoutError(new Error("request timed out after 30s"))).toBe(true);
    expect(isTimeoutError(new Error("socket timeout waiting for headers"))).toBe(true);
    expect(isTimeoutError(new Error("connection reset by peer"))).toBe(false);
    expect(isTimeoutError("timeout")).toBe(false);
  });

  test("outbound SSE parser normalizes lone CR and detects boundaries", () => {
    const blocks = parseOutboundBlocks(["data: one\r\rdata: two\r\r"]);
    expect(blocks).toEqual(["data: one", "data: two"]);
  });

  test("consumeOutboundEventStream flushes decoder output before parser flush", async () => {
    const OriginalDecoder = globalThis.TextDecoder;
    const NativeDecoder = globalThis.TextDecoder;
    class FlushOnlyDecoder {
      private pending: string[] = [];

      decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions) {
        if (input && options?.stream) {
          const native = new NativeDecoder();
          this.pending.push(native.decode(input));
          return "";
        }
        if (input) {
          const native = new NativeDecoder();
          return native.decode(input);
        }
        return this.pending.join("");
      }
    }
    Object.assign(globalThis, { TextDecoder: FlushOnlyDecoder });

    try {
      const chunks = [
        new TextEncoder().encode(
          'data: {"payload":{"type":"question.asked","properties":{"sessionID":"session-1","questions":[{"header":"Need input"}]}}}\n\n',
        ),
      ];
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
          calls.push({ url, body });
          if (url.includes("/sendMessage")) {
            return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
          }
          throw new Error(`Unexpected fetch ${url}`);
        };

        const runtime = {
          config: {
            mode: "polling" as const,
            token: "token",
            openCodeUrl: "http://127.0.0.1:4096",
            sessionCacheMax: 10,
            sessionCacheTtlMs: 10_000,
            notificationDebounceMs: 0,
            port: 4097,
            webhookPath: "/webhook",
            sessionStorePath: "/tmp/test-store.json",
          },
          store: {
            get: async () => undefined,
            set: async () => undefined,
            delete: async () => undefined,
            sessionKeys: async () => ["chat:77:user:5"],
            notificationGet: async () => true,
          },
        };

        await consumeOutboundEventStream(runtime, streamFromChunks(chunks));
      } finally {
        globalThis.fetch = originalFetch;
      }

      const sentTexts = calls
        .filter((x) => x.url.includes("/sendMessage"))
        .map((x) => String(x.body.text || ""));
      expect(sentTexts.some((text) => text.includes("Question pending:"))).toBe(true);
      expect(sentTexts.some((text) => text.includes("Need input"))).toBe(true);
      expect(sentTexts.some((text) => text.includes("Open session session-1"))).toBe(true);
    } finally {
      Object.assign(globalThis, { TextDecoder: OriginalDecoder });
    }
  });

  test("consumeOutboundEventStream flushes decoder and handles final event", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const payload = '{"payload":{"type":"question.asked","properties":{"sessionID":"session-1","questions":[{"header":"Need caf\u00e9"}]}}}';
    const bytes = new TextEncoder().encode(payload);
    const head = bytes.slice(0, bytes.length - 1);
    const tail = bytes.slice(bytes.length - 1);
    const chunks = [
      new TextEncoder().encode("data: "),
      head,
      tail,
      new TextEncoder().encode("\n\n"),
    ];

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => ["chat:77:user:5"],
          notificationGet: async () => true,
        },
      };

      await consumeOutboundEventStream(runtime, streamFromChunks(chunks));
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sentTexts = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sentTexts.some((text) => text.includes("Question pending:"))).toBe(true);
    expect(sentTexts.some((text) => text.includes("Need caf\u00e9"))).toBe(true);
    expect(sentTexts.some((text) => text.includes("Open session session-1"))).toBe(true);
  });

  test("question prompt supports choice reply index and sends answer to OpenCode", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, unknown[]>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        if (url.includes("/question/req-1/reply")) {
          return new Response(JSON.stringify(true), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async (name: string, requestId: string) => {
            const rows = (pending.get(name) || []) as Array<{ requestId?: string }>;
            pending.set(
              name,
              rows.filter((row) => row.requestId !== requestId),
            );
          },
          sessionKeys: async () => ["chat:77:user:5"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-1",
          sessionID: "session-1",
          questions: [{
            header: "Pick one",
            options: [
              { label: "Alpha", description: "Issue #101 - stabilize rollout" },
              { label: "Beta", description: "Issue #102 - add project picker" },
            ],
          }],
        },
      });

      await handleTextUpdate(runtime, {
        update_id: 2,
        message: { message_id: 2, text: "2", chat: { id: 77 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const replyCall = calls.find((x) => x.url.includes("/question/req-1/reply"));
    expect(replyCall?.body.answers).toEqual([["Beta"]]);
    const sentTexts = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sentTexts.some((text) => text.includes("1) Alpha - Issue #101 - stabilize rollout"))).toBe(true);
    expect(sentTexts.some((text) => text.includes("Open session session-1"))).toBe(true);
    expect(sentTexts.some((text) => text.includes("Thanks, your answer was sent."))).toBe(true);
  });

  test("text replies resolve pending question from chat-scoped notify key", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, unknown[]>();
    pending.set("chat:77", [{
      requestId: "req-chat-key",
      callbackId: "cbchatkey",
      sessionId: "session-1",
      createdAt: Date.now() - 1000,
      expiresAt: Date.now() + 60_000,
      questions: [{
        header: "Pick one",
        question: "Pick one",
        options: ["Alpha", "Beta"],
        multiple: false,
        custom: true,
      }],
      answers: [],
    }]);
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        if (url.includes("/question/req-chat-key/reply")) {
          return new Response(JSON.stringify(true), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async (name: string, requestId: string) => {
            const rows = (pending.get(name) || []) as Array<{ requestId?: string }>;
            pending.set(name, rows.filter((row) => row.requestId !== requestId));
          },
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 2,
        message: { message_id: 2, text: "1", chat: { id: 77 }, from: { id: 5 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const replyCall = calls.find((x) => x.url.includes("/question/req-chat-key/reply"));
    expect(replyCall?.body.answers).toEqual([["Alpha"]]);
    expect(pending.get("chat:77")).toEqual([]);
    expect(pending.get("chat:77:user:5")).toBeUndefined();
  });

  test("question notifications include inline buttons with compact callback payloads", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, unknown[]>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async () => undefined,
          sessionKeys: async () => ["chat:88:user:9"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-inline",
          sessionID: "session-inline",
          questions: [{ header: "Pick one", options: [{ label: "Alpha" }, { label: "Beta" }], custom: false }],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const prompt = calls.find((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes("Question pending:"));
    const markup = prompt?.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
    const first = markup?.inline_keyboard?.[0]?.[0]?.callback_data || "";
    const second = markup?.inline_keyboard?.[1]?.[0]?.callback_data || "";
    expect(first).toMatch(/^q:[a-z0-9]{6,24}:1:1$/);
    expect(second).toMatch(/^q:[a-z0-9]{6,24}:1:2$/);
    expect(first).not.toContain("Alpha");
  });

  test("inline-button prompts stay under Telegram message limits with long labels", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, unknown[]>();
    const longLabel = "long-option-label-".repeat(320);
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          const text = String(body.text || "");
          if (text.length > 4096) {
            return new Response(JSON.stringify({ ok: false, description: "Bad Request: message is too long" }), { status: 400 });
          }
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async () => undefined,
          sessionKeys: async () => ["chat:89:user:3"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-inline-long",
          sessionID: "session-inline-long",
          questions: [{ header: "Pick one", options: [{ label: `${longLabel}A` }, { label: `${longLabel}B` }], custom: false }],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const prompt = calls.find((x) => x.url.includes("/sendMessage") && x.body.reply_markup);
    const promptText = String(prompt?.body.text || "");
    expect(prompt).toBeDefined();
    expect(promptText.length).toBeLessThanOrEqual(3900);
    expect(promptText).toContain("1)");
    expect(calls.some((x) => String(x.body.text || "").includes("Open session session-inline-long"))).toBe(true);
  });

  test("question notifications fall back to text-only prompt when option list is too large", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, unknown[]>();
    const options = Array.from({ length: 21 }, (_, index) => ({ label: `Option ${index + 1}` }));
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async () => undefined,
          sessionKeys: async () => ["chat:188:user:9"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-inline-fallback",
          sessionID: "session-inline-fallback",
          questions: [{ header: "Pick one", options, custom: false }],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const prompt = calls.find((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes("Question pending:"));
    expect(prompt).toBeDefined();
    expect(prompt?.body.reply_markup).toBeUndefined();
  });

  test("callback query with incomplete payload still acknowledges callback", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/answerCallbackQuery")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async () => [],
          questionUpsert: async () => undefined,
          questionDelete: async () => undefined,
        },
      };

      await handleCallbackUpdate(runtime, {
        update_id: 80,
        callback_query: {
          id: "cb-missing-chat",
          data: "q:abc123:1:1",
          from: { id: 77 },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const callbackAck = calls.find((x) => x.url.includes("/answerCallbackQuery"));
    expect(String(callbackAck?.body.text || "")).toContain("could not be processed");
  });

  test("callback query submits selected option and confirms success", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, unknown[]>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        if (url.includes("/answerCallbackQuery")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        if (url.includes("/question/req-callback/reply")) {
          return new Response(JSON.stringify(true), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async (name: string, requestId: string) => {
            const rows = (pending.get(name) || []) as Array<{ requestId?: string }>;
            pending.set(name, rows.filter((row) => row.requestId !== requestId));
          },
          sessionKeys: async () => ["chat:90:user:3"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-callback",
          sessionID: "session-callback",
          questions: [{ header: "Pick one", options: [{ label: "Alpha" }, { label: "Beta" }] }],
        },
      });

      const prompt = calls.find((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes("Question pending:"));
      const data = String(
        ((prompt?.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined)
          ?.inline_keyboard?.[1]?.[0]?.callback_data) || "",
      );

      await handleCallbackUpdate(runtime, {
        update_id: 22,
        callback_query: {
          id: "cb-1",
          data,
          from: { id: 3 },
          message: { message_id: 9, chat: { id: 90 } },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const reply = calls.find((x) => x.url.includes("/question/req-callback/reply"));
    expect(reply?.body.answers).toEqual([["Beta"]]);
    const callbackAck = calls.find((x) => x.url.includes("/answerCallbackQuery"));
    expect(String(callbackAck?.body.text || "")).toContain("Sending answer");
    const callbackAckIndex = calls.findIndex((x) => x.url.includes("/answerCallbackQuery"));
    const replyIndex = calls.findIndex((x) => x.url.includes("/question/req-callback/reply"));
    expect(callbackAckIndex).toBeGreaterThan(-1);
    expect(replyIndex).toBeGreaterThan(-1);
    expect(callbackAckIndex).toBeLessThan(replyIndex);
    const sentTexts = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sentTexts.some((text) => text.includes("Thanks, your answer was sent."))).toBe(true);
  });

  test("callback query with stale option re-sends prompt with inline buttons", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, unknown[]>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        if (url.includes("/answerCallbackQuery")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async (name: string, requestId: string) => {
            const rows = (pending.get(name) || []) as Array<{ requestId?: string }>;
            pending.set(name, rows.filter((row) => row.requestId !== requestId));
          },
          sessionKeys: async () => ["chat:93:user:6"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-stale-option",
          sessionID: "session-stale-option",
          questions: [{ header: "Pick one", options: [{ label: "Alpha" }, { label: "Beta" }] }],
        },
      });

      const prompt = calls.find((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes("Question pending:"));
      const firstData = String(
        ((prompt?.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined)
          ?.inline_keyboard?.[0]?.[0]?.callback_data) || "",
      );
      const staleData = firstData.replace(/:\d+$/, ":9");

      await handleCallbackUpdate(runtime, {
        update_id: 82,
        callback_query: {
          id: "cb-stale-option",
          data: staleData,
          from: { id: 6 },
          message: { message_id: 7, chat: { id: 93 } },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const callbackAcks = calls.filter((x) => x.url.includes("/answerCallbackQuery"));
    expect(String(callbackAcks[0]?.body.text || "")).toContain("no longer available");
    const prompts = calls.filter((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes("Question pending:"));
    const resent = prompts[prompts.length - 1];
    expect(resent).toBeDefined();
    expect((resent?.body.reply_markup as { inline_keyboard?: unknown } | undefined)?.inline_keyboard).toBeDefined();
  });

  test("callback query returns explicit guidance on non-missing reply errors", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, unknown[]>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        if (url.includes("/answerCallbackQuery")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        if (url.includes("/question/req-callback-error/reply")) {
          return new Response("bad request", { status: 400 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async (name: string, requestId: string) => {
            const rows = (pending.get(name) || []) as Array<{ requestId?: string }>;
            pending.set(name, rows.filter((row) => row.requestId !== requestId));
          },
          sessionKeys: async () => ["chat:92:user:7"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-callback-error",
          sessionID: "session-callback-error",
          questions: [{ header: "Pick one", options: [{ label: "Alpha" }, { label: "Beta" }] }],
        },
      });

      const prompt = calls.find((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes("Question pending:"));
      const data = String(
        ((prompt?.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined)
          ?.inline_keyboard?.[0]?.[0]?.callback_data) || "",
      );

      await handleCallbackUpdate(runtime, {
        update_id: 24,
        callback_query: {
          id: "cb-error",
          data,
          from: { id: 7 },
          message: { message_id: 9, chat: { id: 92 } },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const replyCalls = calls.filter((x) => x.url.includes("/question/req-callback-error/reply"));
    expect(replyCalls).toHaveLength(1);
    const callbackAcks = calls
      .filter((x) => x.url.includes("/answerCallbackQuery"))
      .map((x) => String(x.body.text || ""));
    expect(callbackAcks.some((text) => text.includes("Sending answer"))).toBe(true);
    const sentTexts = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sentTexts.some((text) => text.includes("something went wrong while processing that button"))).toBe(true);
    expect((pending.get("chat:92:user:7") || []).length).toBe(1);
  });

  test("stale callback query returns guidance without crashing", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        if (url.includes("/answerCallbackQuery")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async () => [],
          questionUpsert: async () => undefined,
          questionDelete: async () => undefined,
        },
      };

      await handleTelegramUpdate(runtime, {
        update_id: 23,
        callback_query: {
          id: "cb-stale",
          data: "q:abc123:1:1",
          from: { id: 4 },
          message: { message_id: 5, chat: { id: 91 } },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const callbackAck = calls.find((x) => x.url.includes("/answerCallbackQuery"));
    expect(String(callbackAck?.body.text || "")).toContain("expired");
    const chatText = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""))
      .join("\n");
    expect(chatText).toContain("That question is no longer pending");
  });

  test("callback query resolves pending question stored under chat-only key", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, unknown[]>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        if (url.includes("/answerCallbackQuery")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        if (url.includes("/question/req-chat-only/reply")) {
          return new Response(JSON.stringify(true), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async (name: string, requestId: string) => {
            const rows = (pending.get(name) || []) as Array<{ requestId?: string }>;
            pending.set(name, rows.filter((row) => row.requestId !== requestId));
          },
          sessionKeys: async () => ["chat:95"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-chat-only",
          sessionID: "session-chat-only",
          questions: [{ header: "Pick one", options: [{ label: "Alpha" }, { label: "Beta" }] }],
        },
      });

      const prompt = calls.find((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes("Question pending:"));
      const data = String(
        ((prompt?.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined)
          ?.inline_keyboard?.[0]?.[0]?.callback_data) || "",
      );

      await handleCallbackUpdate(runtime, {
        update_id: 81,
        callback_query: {
          id: "cb-chat-only",
          data,
          from: { id: 42 },
          message: { message_id: 2, chat: { id: 95 } },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const reply = calls.find((x) => x.url.includes("/question/req-chat-only/reply"));
    expect(reply?.body.answers).toEqual([["Alpha"]]);
    expect(pending.get("chat:95") || []).toEqual([]);
  });

  test("question prompt accepts custom text, rejects stale, and keeps bridge running", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, unknown[]>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        if (url.includes("/question/req-2/reply")) {
          return new Response("not found", { status: 404 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async (name: string, requestId: string) => {
            const rows = (pending.get(name) || []) as Array<{ requestId?: string }>;
            pending.set(
              name,
              rows.filter((row) => row.requestId !== requestId),
            );
          },
          sessionKeys: async () => ["chat:66:user:2"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-2",
          sessionID: "session-2",
          questions: [{ header: "Need details", options: [{ label: "Yes" }, { label: "No" }], custom: true }],
        },
      });

      await handleTextUpdate(runtime, {
        update_id: 10,
        message: { message_id: 10, text: "I need a custom answer", chat: { id: 66 }, from: { id: 2 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const replyCall = calls.find((x) => x.url.includes("/question/req-2/reply"));
    expect(replyCall?.body.answers).toEqual([["I need a custom answer"]]);
    const replyCalls = calls.filter((x) => x.url.includes("/question/req-2/reply"));
    expect(replyCalls).toHaveLength(1);
    const sentTexts = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sentTexts.some((text) => text.includes("That question is no longer pending."))).toBe(true);
  });

  test("question prompt rejects partial numeric tokens and sends guidance", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, unknown[]>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        if (url.includes("/question/req-parse/reply")) {
          return new Response(JSON.stringify(true), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async (name: string, requestId: string) => {
            const rows = (pending.get(name) || []) as Array<{ requestId?: string }>;
            pending.set(
              name,
              rows.filter((row) => row.requestId !== requestId),
            );
          },
          sessionKeys: async () => ["chat:54:user:1"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-parse",
          sessionID: "session-4",
          questions: [{ header: "Pick one", options: [{ label: "Alpha" }, { label: "Beta" }], custom: false }],
        },
      });

      await handleTextUpdate(runtime, {
        update_id: 25,
        message: { message_id: 25, text: "1a", chat: { id: 54 }, from: { id: 1 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const replyCalls = calls.filter((x) => x.url.includes("/question/req-parse/reply"));
    expect(replyCalls).toHaveLength(0);
    const sentTexts = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    const guidance = sentTexts.find((text) => text.includes("Please reply with an option number between 1 and 2"));
    expect(guidance).toBeDefined();
    expect(guidance || "").toContain("Question pending:");
  });

  test("multi-question replies support mixed option indexes and custom text", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, unknown[]>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        if (url.includes("/question/req-multi/reply")) {
          return new Response(JSON.stringify(true), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async (name: string, requestId: string) => {
            const rows = (pending.get(name) || []) as Array<{ requestId?: string }>;
            pending.set(
              name,
              rows.filter((row) => row.requestId !== requestId),
            );
          },
          sessionKeys: async () => ["chat:72:user:9"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-multi",
          sessionID: "session-multi",
          questions: [
            { header: "Pick one", options: [{ label: "Alpha" }, { label: "Beta" }], custom: false },
            { header: "Add details", custom: true },
          ],
        },
      });

      await handleTextUpdate(runtime, {
        update_id: 30,
        message: { message_id: 30, text: "1:2; 2:ship it", chat: { id: 72 }, from: { id: 9 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const replyCall = calls.find((x) => x.url.includes("/question/req-multi/reply"));
    expect(replyCall?.body.answers).toEqual([["Beta"], ["ship it"]]);
  });

  test("multi-question replies advance step-by-step without index formatting", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, unknown[]>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        if (url.includes("/question/req-missing-index/reply")) {
          return new Response(JSON.stringify(true), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async (name: string, requestId: string) => {
            const rows = (pending.get(name) || []) as Array<{ requestId?: string }>;
            pending.set(
              name,
              rows.filter((row) => row.requestId !== requestId),
            );
          },
          sessionKeys: async () => ["chat:74:user:8"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-missing-index",
          sessionID: "session-missing-index",
          questions: [{ header: "First" }, { header: "Second" }],
        },
      });

      await handleTextUpdate(runtime, {
        update_id: 31,
        message: { message_id: 31, text: "first answer; second answer", chat: { id: 74 }, from: { id: 8 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const replyCalls = calls.filter((x) => x.url.includes("/question/req-missing-index/reply"));
    expect(replyCalls).toHaveLength(0);
    const sentTexts = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sentTexts.some((text) => text.includes("Please reply using question-number format"))).toBe(false);
    expect(sentTexts.some((text) => text.includes("Thanks, answer recorded."))).toBe(true);
    expect(sentTexts.some((text) => text.includes("Step 2/2"))).toBe(true);
  });

  test("multi-question single-select callbacks submit one question at a time", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, unknown[]>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        if (url.includes("/answerCallbackQuery")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        if (url.includes("/question/req-step-callback/reply")) {
          return new Response(JSON.stringify(true), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async (name: string, requestId: string) => {
            const rows = (pending.get(name) || []) as Array<{ requestId?: string }>;
            pending.set(name, rows.filter((row) => row.requestId !== requestId));
          },
          sessionKeys: async () => ["chat:96:user:4"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-step-callback",
          sessionID: "session-step-callback",
          questions: [
            { header: "Pick first", options: [{ label: "A1" }, { label: "A2" }], custom: false },
            { header: "Pick second", options: [{ label: "B1" }, { label: "B2" }], custom: false },
          ],
        },
      });

      const firstPrompt = calls.find((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes("Step 1/2"));
      const firstData = String(
        ((firstPrompt?.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined)
          ?.inline_keyboard?.[1]?.[0]?.callback_data) || "",
      );
      await handleCallbackUpdate(runtime, {
        update_id: 200,
        callback_query: {
          id: "cb-step-1",
          data: firstData,
          from: { id: 4 },
          message: { message_id: 9, chat: { id: 96 } },
        },
      });

      const secondPrompt = calls.find((x) => x.url.includes("/sendMessage") && String(x.body.text || "").includes("Step 2/2"));
      const secondData = String(
        ((secondPrompt?.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined)
          ?.inline_keyboard?.[0]?.[0]?.callback_data) || "",
      );
      await handleCallbackUpdate(runtime, {
        update_id: 201,
        callback_query: {
          id: "cb-step-2",
          data: secondData,
          from: { id: 4 },
          message: { message_id: 10, chat: { id: 96 } },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const replyCalls = calls.filter((x) => x.url.includes("/question/req-step-callback/reply"));
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]?.body.answers).toEqual([["A2"], ["B1"]]);
  });

  test("question notifications do not debounce distinct request ids", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, Array<{ requestId: string }>>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 60_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => pending.get(name) || [],
          questionUpsert: async (name: string, row: unknown) => {
            const next = [...(pending.get(name) || []), row as { requestId: string }];
            pending.set(name, next);
          },
          questionDelete: async () => undefined,
          sessionKeys: async () => ["chat:77:user:5"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-a",
          sessionID: "session-same",
          questions: [{ header: "First question" }],
        },
      });
      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-b",
          sessionID: "session-same",
          questions: [{ header: "Second question" }],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sentTexts = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sentTexts.filter((text) => text.includes("Question pending:")).length).toBe(2);
    expect((pending.get("chat:77:user:5") || []).map((row) => row.requestId)).toEqual(["req-a", "req-b"]);
  });

  test("question notifications dedupe proactive sends per chat when debounce is disabled", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, Array<{ requestId: string }>>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => pending.get(name) || [],
          questionUpsert: async (name: string, row: unknown) => {
            const next = [...(pending.get(name) || []), row as { requestId: string }];
            pending.set(name, next);
          },
          questionDelete: async () => undefined,
          sessionKeys: async () => ["chat:77:user:5", "chat:77:user:6"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-dedupe",
          sessionID: "session-dedupe",
          questions: [{ header: "Need one answer" }],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sentTexts = calls
      .filter((x) => x.url.includes("/sendMessage") && x.body.chat_id === 77)
      .map((x) => String(x.body.text || ""));
    expect(sentTexts.filter((text) => text.includes("Question pending:")).length).toBe(1);
    expect(sentTexts.filter((text) => text.includes("Open session session-dedupe")).length).toBe(1);
  });

  test("question fallback notifications debounce per request id and refresh pending entries", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, Array<{
      id: string;
      kind: "question" | "permission" | "task-finished";
      sessionId: string;
      text: string;
      stampedAt: number;
      resolved: boolean;
    }>>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 60_000,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          sessionKeys: async () => ["chat:77:user:5"],
          notificationGet: async () => true,
          pendingGet: async (chatKey: string) => pending.get(chatKey) || [],
          pendingSet: async (chatKey: string, items: Array<{
            id: string;
            kind: "question" | "permission" | "task-finished";
            sessionId: string;
            text: string;
            stampedAt: number;
            resolved: boolean;
          }>) => {
            pending.set(chatKey, [...items]);
          },
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-fallback-a",
          sessionID: "session-fallback",
          questions: [],
        },
      });
      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-fallback-a",
          sessionID: "session-fallback",
          questions: [],
        },
      });
      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-fallback-b",
          sessionID: "session-fallback",
          questions: [],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sentTexts = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sentTexts).toHaveLength(2);

    const items = pending.get("chat:77") || [];
    expect(items).toHaveLength(2);
    expect(items.filter((item) => item.id.includes("req-fallback-a"))).toHaveLength(1);
    expect(items.filter((item) => item.id.includes("req-fallback-b"))).toHaveLength(1);
  });

  test("pending question queues are scoped per chat and user", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, unknown[]>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        if (url.includes("/question/req-user-5/reply")) {
          return new Response(JSON.stringify(true), { status: 200 });
        }
        if (url === "http://127.0.0.1:4096/session") {
          return new Response(JSON.stringify({ id: "session-user-6" }), { status: 200 });
        }
        if (url.includes("/session/session-user-6/message")) {
          return new Response(JSON.stringify({ parts: [{ type: "text", text: "no pending" }] }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [...(pending.get(name) || []), row]);
          },
          questionDelete: async (name: string, requestId: string) => {
            const rows = (pending.get(name) || []) as Array<{ requestId?: string }>;
            pending.set(
              name,
              rows.filter((row) => row.requestId !== requestId),
            );
          },
          sessionKeys: async () => ["chat:77:user:5"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-user-5",
          sessionID: "session-user-scoped",
          questions: [{ header: "Pick", options: [{ label: "One" }] }],
        },
      });

      await handleTextUpdate(runtime, {
        update_id: 40,
        message: { message_id: 40, text: "hello", chat: { id: 77 }, from: { id: 6 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const replyCalls = calls.filter((x) => x.url.includes("/question/req-user-5/reply"));
    expect(replyCalls).toHaveLength(0);
    const userFiveQueue = (pending.get("chat:77:user:5") || []) as Array<{ requestId?: string }>;
    const userSixQueue = (pending.get("chat:77:user:6") || []) as Array<{ requestId?: string }>;
    expect(userFiveQueue.map((row) => row.requestId)).toEqual(["req-user-5"]);
    expect(userSixQueue).toEqual([]);
  });

  test("question reply retries transient OpenCode failures", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const waits: number[] = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, unknown[]>();
    let failures = 0;
    try {
      setRetryDelayForTest(async (ms: number) => {
        waits.push(ms);
      });
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        if (url.includes("/question/req-retry/reply")) {
          failures += 1;
          if (failures < 3) {
            return new Response("temporary", { status: 500 });
          }
          return new Response(JSON.stringify(true), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async (name: string, requestId: string) => {
            const rows = (pending.get(name) || []) as Array<{ requestId?: string }>;
            pending.set(
              name,
              rows.filter((row) => row.requestId !== requestId),
            );
          },
          sessionKeys: async () => ["chat:55:user:1"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-retry",
          sessionID: "session-3",
          questions: [{ header: "Pick", options: [{ label: "One" }] }],
        },
      });

      await handleTextUpdate(runtime, {
        update_id: 20,
        message: { message_id: 20, text: "1", chat: { id: 55 }, from: { id: 1 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const replyCalls = calls.filter((x) => x.url.includes("/question/req-retry/reply"));
    expect(replyCalls).toHaveLength(3);
    expect(waits).toEqual([400, 800]);
    const sentTexts = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sentTexts.some((text) => text.includes("Thanks, your answer was sent."))).toBe(true);
  });

  test("question reply does not retry non-retriable 4xx failures", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const pending = new Map<string, unknown[]>();
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        if (url.includes("/question/req-no-retry/reply")) {
          return new Response("bad request", { status: 400 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        store: {
          get: async () => undefined,
          set: async () => undefined,
          delete: async () => undefined,
          questionList: async (name: string) => (pending.get(name) || []) as unknown[],
          questionUpsert: async (name: string, row: unknown) => {
            pending.set(name, [row]);
          },
          questionDelete: async (name: string, requestId: string) => {
            const rows = (pending.get(name) || []) as Array<{ requestId?: string }>;
            pending.set(
              name,
              rows.filter((row) => row.requestId !== requestId),
            );
          },
          sessionKeys: async () => ["chat:56:user:3"],
          notificationGet: async () => true,
        },
      };

      await handleBridgeEvent(runtime, {
        type: "question.asked",
        properties: {
          id: "req-no-retry",
          sessionID: "session-no-retry",
          questions: [{ header: "Pick", options: [{ label: "One" }] }],
        },
      });

      await handleTextUpdate(runtime, {
        update_id: 50,
        message: { message_id: 50, text: "1", chat: { id: 56 }, from: { id: 3 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const replyCalls = calls.filter((x) => x.url.includes("/question/req-no-retry/reply"));
    expect(replyCalls).toHaveLength(1);
    const sentTexts = calls
      .filter((x) => x.url.includes("/sendMessage"))
      .map((x) => String(x.body.text || ""));
    expect(sentTexts.some((text) => text.includes("Sorry, I ran into an internal error"))).toBe(true);
  });

  test("legacy default session mapping keeps using base OpenCode URL in multi-source mode", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url === "http://127.0.0.1:4096/session/session-legacy/message") {
          return new Response(JSON.stringify({ parts: [{ type: "text", text: "base-source reply" }] }), { status: 200 });
        }
        if (url === "http://127.0.0.1:5000/session/session-legacy/message") {
          return new Response(JSON.stringify({ parts: [{ type: "text", text: "wrong-source reply" }] }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const sources = [{ id: "source-a", openCodeUrl: "http://127.0.0.1:5000", enabled: true }];
      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          multiSourceEnabled: true,
          sources,
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        sources,
        sourceById: new Map(sources.map((source) => [source.id, source])),
        defaultSourceId: "source-a",
        store: {
          get: async () => "session-legacy",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 99,
        message: { message_id: 99, text: "hello", chat: { id: 11 }, from: { id: 3 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const promptCalls = calls.filter((x) => x.url.includes("/session/session-legacy/message"));
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]?.url).toBe("http://127.0.0.1:4096/session/session-legacy/message");
    const sent = String(calls.filter((x) => x.url.includes("/sendMessage")).at(-1)?.body.text || "");
    expect(sent).toBe("base-source reply");
  });

  test("missing source mapping does not fall back to another source", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const sources = [{ id: "source-a", openCodeUrl: "http://127.0.0.1:5000", enabled: true }];
      const runtime = {
        config: {
          mode: "polling" as const,
          token: "token",
          openCodeUrl: "http://127.0.0.1:4096",
          multiSourceEnabled: true,
          sources,
          sessionCacheMax: 10,
          sessionCacheTtlMs: 10_000,
          notificationDebounceMs: 0,
          port: 4097,
          webhookPath: "/webhook",
          sessionStorePath: "/tmp/test-store.json",
        },
        sources,
        sourceById: new Map(sources.map((source) => [source.id, source])),
        defaultSourceId: "source-a",
        store: {
          get: async () => "source-missing::session-2",
          set: async () => undefined,
          delete: async () => undefined,
        },
      };

      await handleTextUpdate(runtime, {
        update_id: 100,
        message: { message_id: 100, text: "hello", chat: { id: 12 }, from: { id: 4 } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const promptCalls = calls.filter((x) => x.url.includes("/session/session-2/message"));
    expect(promptCalls).toHaveLength(0);
    const sent = String(calls.filter((x) => x.url.includes("/sendMessage")).at(-1)?.body.text || "");
    expect(sent).toContain("Source source-missing is no longer configured.");
  });
});
