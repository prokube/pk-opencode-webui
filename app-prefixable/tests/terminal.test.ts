import { describe, expect, test } from "bun:test"
import { ptyRemoveSucceeded } from "../src/context/terminal"
import { terminalSocketUrl } from "../src/utils/terminal-connection"

describe("terminal state", () => {
  test("ticket authorization never follows redirects carrying server credentials", async () => {
    const forwarded: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname.endsWith("/connect-ticket"))
          return new Response(null, { status: 307, headers: { location: "/redirect-target" } })
        forwarded.push(request.headers.get("x-opencode-server-authorization") || "")
        return Response.json({ ticket: "unexpected" })
      },
    })
    try {
      await expect(terminalSocketUrl({ url: server.url.href, id: "pty_test", remote: true, headers: { "x-opencode-server-authorization": "Bearer fixture-secret" } })).rejects.toThrow()
      expect(forwarded).toEqual([])
    } finally {
      server.stop(true)
    }
  })

  test("drops a PTY only after removal or an idempotent not-found response", () => {
    expect(ptyRemoveSucceeded({ data: true, response: { status: 200 } })).toBe(true)
    expect(ptyRemoveSucceeded({ response: { status: 404 } })).toBe(true)
    expect(ptyRemoveSucceeded({ data: false, response: { status: 200 } })).toBe(false)
    expect(ptyRemoveSucceeded({ response: { status: 500 } })).toBe(false)
  })
})
