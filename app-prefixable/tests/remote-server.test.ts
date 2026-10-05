import { afterAll, describe, expect, test } from "bun:test"
import { createRemoteProxy, remoteTarget, type RemoteSocket } from "../../shared/remote-server"

const upstream = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname.endsWith("/redirect"))
      return new Response(null, { status: 302, headers: { Location: "https://other.invalid/session" } })
    if (url.pathname.endsWith("/global/event"))
      return new Response(
        'data: {"directory":"/workspace","payload":{"type":"server.connected","properties":{}}}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      )
    return Response.json(
      { path: url.pathname, headers: Object.fromEntries(request.headers) },
      { headers: { "Set-Cookie": "upstream=secret", "Cache-Control": "public" } },
    )
  },
})
afterAll(() => upstream.stop(true))
const base = `${upstream.url.origin}/nested/api`
const root = `/api/remote/${Buffer.from(base).toString("base64url")}`
const request = (path: string, init?: RequestInit) => new Request(`https://ui.test/notebook/team/ui${path}`, init)

describe("authenticated remote transport", () => {
  test("preserves upstream prefix and strips platform credentials and identity", async () => {
    const path = root + "/session"
    const response = (await createRemoteProxy()(
      request(path, {
        headers: {
          Origin: "https://ui.test",
          Cookie: "platform=must-not-forward",
          Authorization: "Bearer platform-jwt",
          "kubeflow-userid": "admin",
          "x-auth-request-email": "admin",
          "x-opencode-server-authorization": "Bearer remote-key",
        },
      }),
      path,
      () => false,
    )) as Response
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.path).toBe("/nested/api/session")
    expect(body.headers.authorization).toBe("Bearer remote-key")
    for (const key of ["cookie", "kubeflow-userid", "x-auth-request-email", "x-opencode-server-authorization"])
      expect(body.headers[key]).toBeUndefined()
    expect(response.headers.has("set-cookie")).toBe(false)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-security-policy")).toContain("sandbox")
  })
  test("rejects cross-origin access and never handles remote filesystem calls locally", async () => {
    const proxy = createRemoteProxy()
    const path = root + "/session"
    expect(
      ((await proxy(request(path, { headers: { Origin: "https://other.test" } }), path, () => false)) as Response)
        .status,
    ).toBe(403)
    const file = root + "/api/ext/file"
    expect(((await proxy(request(file, { method: "PUT" }), file, () => false)) as Response).status).toBe(501)
    expect(() => remoteTarget(base, "/../session")).toThrow()
  })
  test("does not forward credentials across redirects", async () => {
    const path = root + "/session/redirect"
    const response = (await createRemoteProxy()(request(path), path, () => false)) as Response
    expect(response.status).toBe(502)
    expect(response.headers.has("location")).toBe(false)
  })
  test("streams remote SSE through the same transport", async () => {
    const path = root + "/global/event"
    const response = (await createRemoteProxy()(request(path), path, () => false)) as Response
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(await response.text()).toContain('"server.connected"')
  })
  test("binds single-use terminal tickets to server and PTY, with expiry", async () => {
    let now = 1_000
    const proxy = createRemoteProxy(() => now)
    const mint = async () => {
      const path = root + "/pty/pty_a/connect-ticket"
      const response = (await proxy(
        request(path, { method: "POST", headers: { "x-opencode-server-authorization": "Bearer secret" } }),
        path,
        () => false,
      )) as Response
      return (await response.json()).ticket as string
    }
    const ticket = await mint()
    const path = root + "/pty/pty_a/connect"
    let socket: RemoteSocket | undefined
    const accepted = await proxy(
      request(path + `?ticket=${ticket}&directory=%2Fworkspace`, { headers: { Upgrade: "websocket" } }),
      path,
      (value) => {
        socket = value
        return true
      },
    )
    expect(accepted).toBe(true)
    expect(socket?.headers).toEqual({ Authorization: "Bearer secret" })
    expect(socket?.target).toContain("/nested/api/pty/pty_a/connect?directory=%2Fworkspace")
    expect(socket?.target).not.toContain("ticket=")
    expect(socket?.target).not.toContain("secret")
    expect(
      (
        (await proxy(
          request(path + `?ticket=${ticket}`, { headers: { Upgrade: "websocket" } }),
          path,
          () => true,
        )) as Response
      ).status,
    ).toBe(401)
    const expired = await mint()
    now += 30_001
    expect(
      (
        (await proxy(
          request(path + `?ticket=${expired}`, { headers: { Upgrade: "websocket" } }),
          path,
          () => true,
        )) as Response
      ).status,
    ).toBe(401)
    const other = await mint()
    const wrong = root + "/pty/pty_b/connect"
    expect(
      (
        (await proxy(
          request(wrong + `?ticket=${other}`, { headers: { Upgrade: "websocket" } }),
          wrong,
          () => true,
        )) as Response
      ).status,
    ).toBe(401)
  })
})
