import { describe, expect, test } from "bun:test"
import { normalizeProxiedResponse, serializeScriptData, stripHopByHopHeaders } from "../../shared/proxy"

describe("normalizeProxiedResponse", () => {
  test("removes decode-sensitive headers and keeps body/status", async () => {
    const response = new Response("payload", {
      status: 201,
      statusText: "Created",
      headers: {
        "content-encoding": "gzip",
        "content-length": "999",
        "x-test": "ok",
        "access-control-allow-origin": "https://example.com",
      },
    })

    const normalized = normalizeProxiedResponse(response)

    expect(normalized.status).toBe(201)
    expect(normalized.statusText).toBe("Created")
    expect(await normalized.text()).toBe("payload")
    expect(normalized.headers.get("content-encoding")).toBeNull()
    expect(normalized.headers.get("content-length")).toBeNull()
    expect(normalized.headers.get("x-test")).toBe("ok")
    expect(normalized.headers.get("access-control-allow-origin")).toBe("https://example.com")
  })

  test("keeps content-length when upstream response is unencoded", async () => {
    const response = new Response("ok", {
      headers: {
        "content-length": "2",
      },
    })

    const normalized = normalizeProxiedResponse(response)

    expect(await normalized.text()).toBe("ok")
    expect(normalized.headers.get("content-length")).toBe("2")
    expect(normalized.headers.get("content-encoding")).toBeNull()
  })

  test("escapes data that could terminate an inline script", () => {
    const value = "</script><script>alert(1)</script>&\u2028"
    const data = serializeScriptData({ branding: value })
    expect(data).not.toContain("<")
    expect(data).not.toContain(">")
    expect(data).not.toContain("&")
    expect(JSON.parse(data)).toEqual({ branding: value })
  })

  test("strips hop-by-hop request headers named by Connection", () => {
    const headers = new Headers({ Connection: "keep-alive, X-Internal", Host: "ui.example", "X-Internal": "secret" })
    stripHopByHopHeaders(headers)
    expect(headers.get("connection")).toBeNull()
    expect(headers.get("host")).toBeNull()
    expect(headers.get("x-internal")).toBeNull()
  })

})
