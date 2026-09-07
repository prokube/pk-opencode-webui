/**
 * API Contract Smoke Tests for OpenCode Server
 *
 * These tests verify that the OpenCode server API hasn't changed in breaking ways.
 * They test endpoint availability and response schema structure.
 *
 * Usage:
 *   1. Start OpenCode server: opencode serve
 *   2. Run tests: bun run test:api
 *
 * Environment variables:
 *   OPENCODE_URL - Server URL (default: http://127.0.0.1:4096)
 *   REQUIRE_SERVER - Set to "true" to fail if server unavailable (default: false)
 */

import { afterAll, describe, test, expect, beforeAll } from "bun:test";

const BASE_URL = process.env.OPENCODE_URL || "http://127.0.0.1:4096";
const REQUIRE_SERVER = process.env.REQUIRE_SERVER === "true";

let serverIsAvailable = false;
const createdSessions = new Set<string>();

async function createTestSession() {
  const response = await fetch(`${BASE_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await response.json() as { id?: string };
  if (response.ok && data.id) createdSessions.add(data.id);
  return { response, data };
}

// Helper to check if server is available
async function checkServer(): Promise<boolean> {
  const res = await fetch(`${BASE_URL}/global/health`, {
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  return res?.ok ?? false;
}

// Helper to skip test if server unavailable
function skipIfNoServer() {
  if (!serverIsAvailable) {
    if (REQUIRE_SERVER) {
      throw new Error(`OpenCode server required but not available at ${BASE_URL}`);
    }
    return true;
  }
  return false;
}

describe("OpenCode API Contract", () => {
  beforeAll(async () => {
    serverIsAvailable = await checkServer();
    if (!serverIsAvailable) {
      console.warn(
        `\nOpenCode server not available at ${BASE_URL}.\n` +
          "Start with: opencode serve\n" +
          "Tests will be skipped.\n"
      );
    }
  });

  afterAll(async () => {
    const responses = await Promise.all([...createdSessions].map((id) =>
      fetch(`${BASE_URL}/session/${id}`, { method: "DELETE" }).catch(() => undefined)
    ));
    if (responses.some((response) => !response?.ok && response?.status !== 404)) {
      throw new Error("Failed to clean up API contract test sessions");
    }
  });

  // Core Session Endpoints
  describe("Session API", () => {
    test("GET /session/status returns expected schema", async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/session/status`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      // /session/status returns a map of sessionID -> SessionStatus
      expect(data !== null && typeof data === "object" && !Array.isArray(data)).toBe(true);
    });

    test("GET /session returns array", async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/session`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });

    test("POST /session creates session", async () => {
      if (skipIfNoServer()) return;
      const { response, data } = await createTestSession();
      expect(response.ok).toBe(true);
      expect(data).toHaveProperty("id");
    });

    test("GET /session/{id}/message returns messages array", async () => {
      if (skipIfNoServer()) return;
      // First create a session to get an ID
      const { response, data: session } = await createTestSession();
      expect(response.ok).toBe(true);

      const res = await fetch(`${BASE_URL}/session/${session.id}/message`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });

    test("POST /session/{id}/message endpoint exists", async () => {
      if (skipIfNoServer()) return;
      // First create a session
      const { response, data: session } = await createTestSession();
      expect(response.ok).toBe(true);

      // Test that the endpoint accepts POST (we don't send a real prompt)
      const res = await fetch(`${BASE_URL}/session/${session.id}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "" }),
      });
      // Endpoint should exist (may return 400 for empty content, but not 404)
      expect(res.status).not.toBe(404);
    });
  });

  // Provider Endpoints
  describe("Provider API", () => {
    test("GET /provider returns provider summary object", async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/provider`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data !== null && typeof data === "object").toBe(true);
    });

    test("GET /provider/auth returns auth info", async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/provider/auth`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(typeof data).toBe("object");
    });
  });

  // Config Endpoints
  describe("Config API", () => {
    test("GET /config returns config object", async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/config`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(typeof data).toBe("object");
    });

    test("GET /config/providers returns providers config", async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/config/providers`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(typeof data).toBe("object");
    });
  });

  // Global Endpoints
  describe("Global API", () => {
    test("GET /global/health returns ok", async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/global/health`);
      expect(res.ok).toBe(true);
    });

    test("GET /global/config returns global config", async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/global/config`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(typeof data).toBe("object");
    });
  });

  // Project Endpoints
  describe("Project API", () => {
    test("GET /project returns array", async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/project`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });

    test("GET /project/current returns project object", async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/project/current`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data).toHaveProperty("id");
      expect(data).toHaveProperty("worktree");
    });
  });

  // File Endpoints
  describe("File API", () => {
    test("GET /file?path=. returns file list", async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/file?path=.`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });
  });

  // MCP Endpoints
  describe("MCP API", () => {
    test("GET /mcp returns MCP status", async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/mcp`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(typeof data).toBe("object");
    });
  });

  // VCS Endpoints
  describe("VCS API", () => {
    test("GET /vcs/diff?mode=git endpoint exists", async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/vcs/diff?mode=git`);
      expect(res.status).not.toBe(404);
      if (!res.ok) return;

      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
      for (const diff of data) {
        expect(typeof diff.file).toBe("string");
        expect(typeof diff.patch).toBe("string");
        expect(typeof diff.additions).toBe("number");
        expect(typeof diff.deletions).toBe("number");
      }
    });

    test("GET /vcs/diff?mode=branch endpoint exists", async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/vcs/diff?mode=branch`);
      expect(res.status).not.toBe(404);
      if (!res.ok) return;

      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
      for (const diff of data) {
        expect(typeof diff.file).toBe("string");
        expect(typeof diff.patch).toBe("string");
        expect(typeof diff.additions).toBe("number");
        expect(typeof diff.deletions).toBe("number");
      }
    });
  });

  // PTY Endpoints
  describe("PTY API", () => {
    test("GET /pty returns pty list", async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/pty`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });

    test("POST /pty creates terminal session", async () => {
      if (skipIfNoServer()) return;
      const res = await fetch(`${BASE_URL}/pty`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data).toHaveProperty("id");
    });
  });

  // SSE Event Endpoint
  describe("Event API", () => {
    test("GET /event returns SSE stream", async () => {
      if (skipIfNoServer()) return;
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 2000);

      const res = await fetch(`${BASE_URL}/event`, {
        signal: controller.signal,
        headers: { Accept: "text/event-stream" },
      }).catch((e) => {
        // AbortError is only expected after our explicit timeout
        if (e.name === "AbortError" && timedOut) return null;
        throw e;
      });

      clearTimeout(timeout);

      // If we got a response before abort, verify it's SSE
      if (res) {
        expect(res.ok).toBe(true);
        const contentType = res.headers.get("content-type") ?? "";
        expect(contentType).toContain("text/event-stream");
      }
    });

    test("GET /global/event returns SSE stream", async () => {
      if (skipIfNoServer()) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${BASE_URL}/global/event`, {
        signal: controller.signal,
        headers: { Accept: "text/event-stream" },
      }).catch((error) => {
        if (error.name === "AbortError") return null;
        throw error;
      });
      clearTimeout(timeout);

      if (!res) throw new Error("Global event stream did not respond before timeout");
      expect(res.ok).toBe(true);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
      controller.abort();
    });
  });
});
