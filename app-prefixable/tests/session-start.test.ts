import { describe, expect, test } from "bun:test";
import { createSessionWithPrompt, formatStartError, startSessionError } from "../src/utils/session-start";
import type { OpencodeClient } from "../src/sdk/client";

describe("formatStartError", () => {
  const cases: { name: string; input: unknown; expected: string }[] = [
    { name: "error message", input: new Error("boom"), expected: "boom" },
    { name: "string", input: "bad request", expected: "bad request" },
    { name: "number", input: 42, expected: "42" },
    {
      name: "nested error field",
      input: { error: { message: "nested" } },
      expected: "nested",
    },
    {
      name: "detail fallback",
      input: { detail: "detail text" },
      expected: "detail text",
    },
    {
      name: "json fallback",
      input: { code: "E_FAIL" },
      expected: '{"code":"E_FAIL"}',
    },
    { name: "null unknown", input: null, expected: "Unknown error" },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(formatStartError(c.input)).toBe(c.expected);
    });
  }
});

describe("startSessionError", () => {
  const model = { providerID: "openai", modelID: "gpt-4.1" };
  const cases: {
    name: string;
    input: {
      loading: boolean;
      providerCount: number;
      model: { providerID: string; modelID: string } | null;
      connected: string[];
    };
    expected: string | null;
  }[] = [
    {
      name: "loading providers",
      input: { loading: true, providerCount: 1, model, connected: ["openai"] },
      expected: "Providers are still loading. Please try again in a moment.",
    },
    {
      name: "no providers",
      input: { loading: false, providerCount: 0, model, connected: ["openai"] },
      expected: "No providers are available. Please add one in Settings.",
    },
    {
      name: "model missing",
      input: { loading: false, providerCount: 1, model: null, connected: ["openai"] },
      expected: "Please select a model before sending messages. Click the model button in the header.",
    },
    {
      name: "provider disconnected",
      input: { loading: false, providerCount: 1, model, connected: ["anthropic"] },
      expected: 'Provider "openai" is not connected. Please configure it in Settings.',
    },
    {
      name: "ready",
      input: { loading: false, providerCount: 1, model, connected: ["openai"] },
      expected: null,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(startSessionError(c.input)).toBe(c.expected);
    });
  }
});

describe("createSessionWithPrompt", () => {
  test("attempts delete when promptAsync returns an error", async () => {
    let deleted = 0;
    let deletedID = "";
    const client = {
      session: {
        create: async () => ({ data: { id: "s-1" } }),
        promptAsync: async () => ({ error: { message: "prompt failed" } }),
        delete: async (args: { sessionID: string }) => {
          deleted += 1;
          deletedID = args.sessionID;
          return { data: {} };
        },
      },
    } as unknown as OpencodeClient;

    await expect(
      createSessionWithPrompt({
        client,
        text: "hello",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4.1" },
      }),
    ).rejects.toThrow("prompt failed");
    expect(deleted).toBe(1);
    expect(deletedID).toBe("s-1");
  });

  test("does not attempt delete when promptAsync succeeds", async () => {
    let deleted = 0;
    const client = {
      session: {
        create: async () => ({ data: { id: "s-2" } }),
        promptAsync: async () => ({ data: {} }),
        delete: async () => {
          deleted += 1;
          return { data: {} };
        },
      },
    } as unknown as OpencodeClient;

    const session = await createSessionWithPrompt({
      client,
      text: "hello",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-4.1" },
    });

    expect(session.id).toBe("s-2");
    expect(deleted).toBe(0);
  });
});
