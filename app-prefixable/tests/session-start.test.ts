import { describe, expect, test } from "bun:test";
import { formatStartError, startSessionError } from "../src/utils/session-start";

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
