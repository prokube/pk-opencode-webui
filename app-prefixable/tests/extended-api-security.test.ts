import { describe, expect, test } from "bun:test"
import { handleExtendedEndpoint, isSameOriginRequest } from "../../shared/extended-api"

describe("extended API security", () => {
  test("rejects cross-origin mutations", async () => {
    const url = new URL("https://ui.example/notebook/user/app/api/ext/mkdir")
    const req = new Request(url, {
      method: "POST",
      headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
      body: JSON.stringify({ path: "." }),
    })
    const response = await handleExtendedEndpoint("/api/ext/mkdir", req.method, url, req)

    expect(response?.status).toBe(403)
    expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(response?.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin")
  })

  test("allows same-origin mutations and requests without Origin", async () => {
    for (const origin of ["https://ui.example", undefined]) {
      const url = new URL("https://ui.example/notebook/user/app/api/ext/mkdir")
      const headers = new Headers({ "Content-Type": "application/json" })
      if (origin) headers.set("Origin", origin)
      const req = new Request(url, { method: "POST", headers, body: "{}" })
      const response = await handleExtendedEndpoint("/api/ext/mkdir", req.method, url, req)

      expect(response?.status).toBe(400)
      expect(response?.headers.get("Referrer-Policy")).toBe("no-referrer")
    }
  })

  test("uses forwarded origin behind TLS termination", () => {
    const req = new Request("http://ui.example/notebook/user/app/api/ext/mkdir", {
      headers: {
        Origin: "https://public.example",
        "X-Forwarded-Host": "public.example",
        "X-Forwarded-Proto": "https",
      },
    })
    expect(isSameOriginRequest(req)).toBe(true)
  })

  test("rejects cross-site fetch metadata even without Origin", () => {
    const req = new Request("https://ui.example/api/ext/mkdir", {
      headers: { "Sec-Fetch-Site": "cross-site" },
    })
    expect(isSameOriginRequest(req)).toBe(false)
  })
})
