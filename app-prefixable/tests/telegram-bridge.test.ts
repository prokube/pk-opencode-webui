import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cacheSession,
  extractReply,
  handleTextUpdate,
  joinOpenCodeUrl,
  parseConfig,
  parseMode,
  queueChatUpdate,
  resetSessionCacheForTest,
  sessionFromCache,
} from "../../shared/telegram-bridge";

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
] as const;

const envSnapshot = new Map<string, string | undefined>();

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
  beforeEach(() => {
    resetSessionCacheForTest();
    for (const key of envKeys) {
      envSnapshot.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    resetSessionCacheForTest();
    for (const key of envKeys) {
      const value = envSnapshot.get(key);
      if (value === undefined) {
        delete process.env[key];
        continue;
      }
      process.env[key] = value;
    }
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
    expect(parseConfig().sessionStorePath).toBe("/tmp/opencode-telegram-sessions.json");

    setEnv({ TELEGRAM_BOT_TOKEN: "token", TELEGRAM_SESSION_STORE_PATH: "/tmp/custom-store.json" });
    expect(parseConfig().sessionStorePath).toBe("/tmp/custom-store.json");

    setEnv({ TELEGRAM_BOT_TOKEN: "token", TELEGRAM_MODE: "bad-mode", OPENCODE_API_URL: "http://127.0.0.1:4096" });
    expect(() => parseConfig()).toThrow("Invalid TELEGRAM_MODE");
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

  test("cacheSession evicts oldest entries when max size is exceeded", () => {
    const config = {
      mode: "polling" as const,
      token: "token",
      openCodeUrl: "http://127.0.0.1:4096",
      sessionCacheMax: 2,
      sessionCacheTtlMs: 10_000,
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
        message: { message_id: 3, text: "/wat", chat: { id: 7 }, from: { id: 9 } },
      });

      const sentTexts = calls
        .filter((x) => x.url.includes("/sendMessage"))
        .map((x) => String(x.body.text || ""));
      expect(sentTexts[0]).toBe("Current session: session-1");
      expect(sentTexts[1]).toBe("Started a new session: session-2");
      expect(sentTexts[2]).toBe("Unknown command /wat. Use /help.");
      expect(map.get("chat:7:user:9")).toBe("session-2");
    } finally {
      globalThis.fetch = originalFetch;
    }
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
});
