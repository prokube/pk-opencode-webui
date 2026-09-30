import { describe, expect, test } from "bun:test"
import {
  normalizeServerUrl,
  parseConnections,
  parseTabs,
  remoteProxyUrl,
  serverAuthHeaders,
  serverHref,
  tabHref,
  tabKey,
} from "../src/utils/servers"

describe("server-bound sessions", () => {
  test("keeps base paths and scopes navigation without losing new-session or settings state", () => {
    expect(normalizeServerUrl(" example.test/opencode/ ")).toBe("http://example.test/opencode")
    expect(serverHref("alpha", "/workspace/session?new=draft#providers")).toBe(
      "/workspace/session?new=draft&server=alpha#providers",
    )
    expect(serverHref("alpha", "/workspace/session?server=beta")).toBe("/workspace/session?server=beta")
    expect(serverHref("local", "/settings")).toBe("/settings")
    expect(remoteProxyUrl("https://ui.test/notebook/team/editor", "https://api.test/sandbox/")).toStartWith(
      "https://ui.test/notebook/team/editor/api/remote/",
    )
  })
  test("identifies a session by both server and session ID", () => {
    const alpha = { server: "alpha", sessionId: "ses_shared", directory: "/workspace", title: "Alpha" }
    const beta = { ...alpha, server: "beta" }
    expect(tabKey(alpha)).not.toBe(tabKey(beta))
    expect(tabHref(alpha)).toEndWith("?server=alpha")
    expect(tabHref(beta)).toEndWith("?server=beta")
    expect(parseTabs(JSON.stringify([alpha, beta]), ["alpha"])).toEqual([alpha])
  })
  test("persists only connection metadata, never imported passwords", () => {
    const [item] = parseConnections(
      JSON.stringify([{ url: "https://api.test/", name: "Alpha", auth: "basic", password: "must-not-persist" }]),
    )
    expect(item.url).toBe("https://api.test")
    expect(JSON.stringify(item)).not.toContain("must-not-persist")
    expect(serverAuthHeaders(item, "secret")).toEqual({
      "x-opencode-server-authorization": `Basic ${btoa("opencode:secret")}`,
    })
    expect(serverAuthHeaders({ ...item, auth: "bearer" }, "pk_live_test")).toEqual({
      "x-opencode-server-authorization": "Bearer pk_live_test",
    })
  })
  test("rejects credentials and query tokens embedded in server URLs", () => {
    for (const value of [
      "https://user:secret@api.test",
      "https://api.test?token=secret",
      "https://api.test#token",
      "ftp://api.test",
      "file:///tmp",
    ])
      expect(() => normalizeServerUrl(value)).toThrow()
  })
})
