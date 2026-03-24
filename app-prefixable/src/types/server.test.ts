import { describe, test, expect } from "bun:test";
import { getAuthHeaders, type ServerAuth } from "./server";

describe("getAuthHeaders", () => {
  test("type 'none' returns empty headers", () => {
    expect(getAuthHeaders({ type: "none" })).toEqual({});
  });

  test("type 'api-key' returns x-api-key header", () => {
    const auth: ServerAuth = { type: "api-key", key: "sk-test-123" };
    expect(getAuthHeaders(auth)).toEqual({ "x-api-key": "sk-test-123" });
  });

  test("type 'basic' returns Basic auth header", () => {
    const auth: ServerAuth = { type: "basic", username: "user", password: "pass" };
    const headers = getAuthHeaders(auth);
    expect(headers.Authorization).toStartWith("Basic ");
    // Decode and verify
    const decoded = atob(headers.Authorization!.slice(6));
    expect(decoded).toBe("user:pass");
  });

  test("type 'basic' handles non-ASCII username/password", () => {
    const auth: ServerAuth = { type: "basic", username: "über", password: "paß" };
    const headers = getAuthHeaders(auth);
    expect(headers.Authorization).toStartWith("Basic ");
    // Decode the base64, then reconstruct the UTF-8 bytes
    const binary = atob(headers.Authorization!.slice(6));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded).toBe("über:paß");
  });
});
