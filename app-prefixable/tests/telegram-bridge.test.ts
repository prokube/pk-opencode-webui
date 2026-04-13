import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheSession,
  createOutboundSSEParser,
  consumeOutboundEventStream,
  extractReply,
  handleBridgeEvent,
  handleTextUpdate,
  joinOpenCodeUrl,
  parseConfig,
  parseMode,
  queueChatUpdate,
  registerTelegramCommands,
  resetSessionCacheForTest,
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
      { command: "notify", description: "Control proactive notifications" },
      { command: "pending", description: "Show pending inbox items" },
      { command: "inbox", description: "Alias for /pending" },
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

  test("handleTextUpdate parses whitespace and bot-qualified help command", async () => {
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
      expect(sentTexts[2]).toBe("Unknown command /statuz. Try /status or use /help.");
      expect(map.get("chat:7:user:9")).toBe("session-2");
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
          notificationGet: async () => false,
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

  test("handleBridgeEvent does not debounce failed key and still notifies another key in same chat", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    let failed = false;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.includes("/sendMessage")) {
          if (!failed) {
            failed = true;
            throw new Error("temporary telegram error");
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
    expect(messages.length).toBe(2);
  });

  test("handleBridgeEvent continues notifying other chats after one failure", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
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
    expect(sentTexts).toEqual(["Task finished: the session is now idle.\n\nOpen session session-1"]);
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

  test("outbound SSE parser handles CRLF split across chunk boundaries", () => {
    const blocks = parseOutboundBlocks(["data: one\r", "\n\r", "\ndata: two\n\n"]);
    expect(blocks).toEqual(["data: one", "data: two"]);
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
      expect(sentTexts).toEqual(["Question pending: Need input\n\nOpen session session-1"]);
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
    expect(sentTexts).toEqual(["Question pending: Need caf\u00e9\n\nOpen session session-1"]);
  });
});
