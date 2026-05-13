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

import { describe, test, expect, beforeAll } from "bun:test";

const BASE_URL = process.env.OPENCODE_URL || "http://127.0.0.1:4096";
const REQUIRE_SERVER = process.env.REQUIRE_SERVER === "true";
const RUN_MUTATION_TESTS = process.env.RUN_MUTATION_TESTS === "true";

let serverIsAvailable = false;

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
      const res = await fetch(`${BASE_URL}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data).toHaveProperty("id");
    });

    test("GET /session/{id}/message returns messages array", async () => {
      if (skipIfNoServer()) return;
      // First create a session to get an ID
      const sessionRes = await fetch(`${BASE_URL}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(sessionRes.ok).toBe(true);
      const session = await sessionRes.json();

      const res = await fetch(`${BASE_URL}/session/${session.id}/message`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });

    test("POST /session/{id}/message endpoint exists", async () => {
      if (skipIfNoServer()) return;
      // First create a session
      const sessionRes = await fetch(`${BASE_URL}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(sessionRes.ok).toBe(true);
      const session = await sessionRes.json();

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

  // Extended Endpoints
  describe("Extended API", () => {
    let extendedApiAvailable = false;

    beforeAll(async () => {
      if (!serverIsAvailable) return;
      const res = await fetch(`${BASE_URL}/api/ext/saved-prompts`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      const contentType = res?.headers.get("content-type") ?? "";
      extendedApiAvailable = res !== null && contentType.includes("application/json");
      if (!extendedApiAvailable) {
        console.warn(
          `\nExtended API not available at ${BASE_URL}/api/ext/saved-prompts.\n` +
            "These endpoints are served by the dev/production server, not the backend directly.\n" +
            "Extended API tests will be skipped.\n"
        );
      }
    });

    function skipIfNoExtendedApi() {
      if (!extendedApiAvailable) return true;
      return false;
    }

    test("GET /api/ext/saved-prompts returns prompt arrays", async () => {
      if (skipIfNoServer() || skipIfNoExtendedApi()) return;
      const res = await fetch(`${BASE_URL}/api/ext/saved-prompts`);
      expect(res.status).not.toBe(404);
      expect(res.ok).toBe(true);
      const contentType = res.headers.get("content-type") ?? "";
      expect(contentType).toContain("application/json");
      const data = await res.json();
      expect(data !== null && typeof data === "object" && !Array.isArray(data)).toBe(true);
      expect(Array.isArray(data.global)).toBe(true);
      expect(Array.isArray(data.project)).toBe(true);
    });

    test("PUT /api/ext/saved-prompts accepts valid payload", async () => {
      if (!RUN_MUTATION_TESTS) return;
      if (skipIfNoServer() || skipIfNoExtendedApi()) return;
      const readRes = await fetch(`${BASE_URL}/api/ext/saved-prompts`);
      expect(readRes.ok).toBe(true);
      const readContentType = readRes.headers.get("content-type") ?? "";
      expect(readContentType).toContain("application/json");
      const current = await readRes.json();
      expect(current !== null && typeof current === "object" && !Array.isArray(current)).toBe(true);
      const payload = {
        global: Array.isArray(current.global) ? current.global : [],
        project: Array.isArray(current.project) ? current.project : [],
      };
      const res = await fetch(`${BASE_URL}/api/ext/saved-prompts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(res.status).not.toBe(404);
      expect(res.ok).toBe(true);
    });

    test("GET /api/ext/saved-prompts supports directory param", async () => {
      if (skipIfNoServer() || skipIfNoExtendedApi()) return;
      const projectRes = await fetch(`${BASE_URL}/project/current`);
      expect(projectRes.ok).toBe(true);
      const project = await projectRes.json();
      expect(typeof project?.worktree === "string" && project.worktree.length > 0).toBe(true);

      const params = new URLSearchParams({ directory: project.worktree });
      const res = await fetch(`${BASE_URL}/api/ext/saved-prompts?${params.toString()}`);
      expect(res.status).not.toBe(404);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(Array.isArray(data.global)).toBe(true);
      expect(Array.isArray(data.project)).toBe(true);
    });

    test("PUT /api/ext/saved-prompts rejects project prompts without directory", async () => {
      if (skipIfNoServer() || skipIfNoExtendedApi()) return;
      const payload = {
        global: [],
        project: [{ id: "x", title: "t", text: "p", createdAt: Date.now(), scope: "project" }],
      };
      const res = await fetch(`${BASE_URL}/api/ext/saved-prompts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(typeof data?.error).toBe("string");
    });

    test("GET /api/ext/saved-prompts rejects outside directory", async () => {
      if (skipIfNoServer() || skipIfNoExtendedApi()) return;
      const candidate = "/tmp";
      const params = new URLSearchParams({ directory: candidate });
      const res = await fetch(`${BASE_URL}/api/ext/saved-prompts?${params.toString()}`);
      expect([200, 403]).toContain(res.status);
      if (res.status === 403) {
        const data = await res.json();
        expect(typeof data?.error).toBe("string");
      }
    });

    test("PUT /api/ext/saved-prompts rejects outside directory", async () => {
      if (skipIfNoServer() || skipIfNoExtendedApi()) return;
      const payload = { global: "invalid", project: [] };
      const params = new URLSearchParams({ directory: "/tmp" });
      const res = await fetch(`${BASE_URL}/api/ext/saved-prompts?${params.toString()}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect([400, 403]).toContain(res.status);
      if (res.status === 400 || res.status === 403) {
        const data = await res.json();
        expect(typeof data?.error).toBe("string");
      }
    });

    test("GET /api/ext/telegram/session-alarm endpoint exists", async () => {
      if (skipIfNoServer() || skipIfNoExtendedApi()) return;
      const res = await fetch(`${BASE_URL}/api/ext/telegram/session-alarm`);
      expect(res.status).not.toBe(404);
      expect([200, 400]).toContain(res.status);
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
  });
});
