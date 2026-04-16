import { describe, expect, test } from "bun:test"
import { normalizeProxiedResponse } from "../../shared/proxy"

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

  test("sets explicit cors origin and vary when requested", async () => {
    const response = new Response("ok", {
      headers: {
        "access-control-allow-origin": "https://example.com",
      },
    })

    const normalized = normalizeProxiedResponse(response, "https://ui.example.com")

    expect(await normalized.text()).toBe("ok")
    expect(normalized.headers.get("access-control-allow-origin")).toBe("https://ui.example.com")
    expect(normalized.headers.get("vary")).toBe("Origin")
  })
})
