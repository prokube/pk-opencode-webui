const servers = ["Local", "Alpha", "Beta"].map((name, index) => {
  const initial = () => ({
    id: "ses_shared",
    title: `${name} session`,
    directory: "/workspace",
    projectID: "project",
    version: "1",
    time: { created: Date.now(), updated: Date.now() },
  })
  const sessions = [initial()]
  const writes: string[] = []
   const requests: { path: string; method: string; directory: string | null; cookie: boolean; authorization: string | null }[] = []
  const pending = new Map<string, () => void>()
  const held = new Set<string>()
  let connected = true
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()
  return Bun.serve({
    port: 18041 + index,
    async fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === "/test/requests") return Response.json(requests)
      if (url.pathname === "/test/hold") { held.add(url.searchParams.get("path")!); return Response.json(true) }
      if (url.pathname === "/test/release") {
        const path = url.searchParams.get("path")!
        held.delete(path)
        pending.get(path)?.()
        pending.delete(path)
        return Response.json(true)
      }
      if (url.pathname === "/test/writes") return Response.json(writes)
      if (url.pathname === "/test/streams") return Response.json(streams.size)
      if (url.pathname === "/test/reset") {
        sessions.splice(0, sessions.length, initial())
        writes.length = 0
        requests.length = 0
        connected = true
        held.clear()
        for (const release of pending.values()) release()
        pending.clear()
        return Response.json(true)
      }
      if (url.pathname === "/test/event")
        return req.json().then((payload) => {
          for (const stream of streams)
            stream.enqueue(encoder.encode(`data: ${JSON.stringify({ directory: "/workspace", payload })}\n\n`))
          return Response.json(true)
        })
      if (index === 2 && req.headers.get("authorization") !== `Basic ${btoa("opencode:beta-secret")}`)
        return new Response("Unauthorized", { status: 401 })
      requests.push({ path: url.pathname, method: req.method, directory: req.headers.get("x-opencode-directory"), cookie: req.headers.has("cookie"), authorization: req.headers.get("authorization") })
      if (held.has(url.pathname)) await new Promise<void>((resolve) => pending.set(url.pathname, resolve))
      // Drain mocked mutation bodies before responding so pooled connections can
      // safely carry the following session/provider request.
      const body = req.body ? await req.text() : ""
      if (url.pathname === "/auth/mock") {
        connected = req.method !== "DELETE"
        writes.push(`auth:${req.method}`)
        return Response.json(true)
      }
      if (url.pathname === "/provider/mock/oauth/authorize")
        return Response.json({ url: "https://provider.example/authorize", method: "auto", instructions: `${name} device code` })
      if (url.pathname === "/provider/mock/oauth/callback") {
        connected = true
        writes.push("oauth:callback")
        return Response.json(true)
      }
      if (url.pathname === "/global/dispose") { writes.push("dispose"); return Response.json(true) }
      if (url.pathname === "/pty/pty_test/connect" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (server.upgrade(req)) return
        return new Response("Upgrade failed", { status: 500 })
      }
      if (url.pathname === "/pty" && req.method === "POST")
        return Response.json({
          id: "pty_test",
          title: "Terminal",
          status: "running",
          cwd: "/workspace",
          command: "sh",
          args: [],
          pid: 1,
        })
      if (url.pathname === "/pty/pty_test")
        return Response.json(req.method === "DELETE" ? true : { id: "pty_test", status: "running" })
      if (req.method === "POST" && url.pathname === "/session") {
        const session = {
          ...sessions[0],
          id: `ses_${name.toLowerCase()}_${sessions.length}`,
          title: `${name} new session`,
        }
        sessions.push(session)
        writes.push("create")
        for (const stream of streams)
          stream.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ directory: "/workspace", payload: { type: "session.created", properties: { info: session } } })}\n\n`,
            ),
          )
        return Response.json(session)
      }
      if (req.method === "POST" && url.pathname.endsWith("/prompt_async")) {
        writes.push("prompt")
        return new Response(null, { status: 204 })
      }
      if (req.method === "PATCH" && url.pathname.startsWith("/session/"))
        return Promise.resolve(JSON.parse(body)).then((body) => {
          const session = sessions.find((item) => item.id === url.pathname.split("/")[2])!
          session.title = (body as { title: string }).title
          writes.push(session.title)
          return Response.json(session)
        })
      if (url.pathname === "/global/event") {
        const stream = new ReadableStream({
          start(controller) {
            streams.add(controller)
            controller.enqueue(
              encoder.encode('data: {"directory":"global","payload":{"type":"server.connected","properties":{}}}\n\n'),
            )
            const timer = setInterval(() => controller.enqueue(encoder.encode(": heartbeat\n\n")), 1000)
            req.signal.addEventListener(
              "abort",
              () => {
                clearInterval(timer)
                streams.delete(controller)
                controller.close()
              },
              { once: true },
            )
          },
        })
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
      }
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.18.33" })
      if (url.pathname === "/path")
        return Response.json({
          home: "/workspace",
          directory: "/workspace",
          worktree: "/workspace",
          config: "/workspace/.config",
          state: "/workspace/.state",
        })
      if (url.pathname === "/project/current")
        return Response.json({ id: "project", worktree: "/workspace", time: { created: 1 } })
      if (url.pathname === "/project")
        return Response.json([{ id: "project", worktree: "/workspace", time: { created: 1 } }])
      if (url.pathname === "/provider")
        return Response.json({
          all: [
            {
              id: "mock",
               name: `${name} Provider`,
              env: [],
               models: {
                 alternate: {
                   id: "alternate", providerID: "mock", name: `${name} Alternate`,
                   limit: { context: 32768, output: 4096 },
                 },
                 echo: {
                  id: "echo",
                  providerID: "mock",
                   name: `${name} Model`,
                  api: { id: "echo", url: "http://mock.invalid", npm: "@ai-sdk/openai-compatible" },
                  limit: { context: 32768, output: 4096 },
                  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                  capabilities: {
                    attachment: false,
                    reasoning: false,
                    temperature: true,
                    toolcall: true,
                    interleaved: false,
                    input: { text: true, image: false, audio: false, pdf: false, video: false },
                    output: { text: true },
                  },
                  options: {},
                  headers: {},
                  variants: {},
                  status: "active",
                  release_date: "2026-01-01",
                },
              },
            },
          ],
           connected: connected ? ["mock"] : [],
          default: { mock: "echo" },
        })
       if (url.pathname === "/provider/auth") return Response.json({ mock: [{ type: "api", label: `${name} API key` }, { type: "oauth", label: `${name} device login` }] })
      if (url.pathname === "/mcp") return Response.json({ shared: { status: "failed", error: `${name} MCP detail` } })
      if (
        url.pathname === "/session/status" ||
        url.pathname === "/config" ||
        url.pathname === "/global/config"
      )
        return Response.json({})
      if (url.pathname === "/session") return Response.json(sessions)
      if (/^\/session\/[^/]+$/.test(url.pathname))
        return Response.json(sessions.find((item) => item.id === url.pathname.split("/")[2]) || sessions[0])
      if (url.pathname === "/vcs") return Response.json({ branch: "main" })
      return Response.json([])
    },
    websocket: {
      open(ws) {
        ws.send(new Uint8Array([0, ...encoder.encode(JSON.stringify({ cursor: 0 }))]))
        ws.send(`${name} terminal\r\n`)
      },
      message(ws, data) {
        ws.send(`${name}:${data}`)
      },
    },
  })
})

const uis = [
  ["18040", "/notebook/test/ui/"],
  ["18044", "/"],
].map(([port, base]) =>
  Bun.spawn(["bun", "run", "../docker/serve-ui.ts"], {
    env: {
      ...process.env,
      PORT: port,
      BASE_PATH: base,
      BASE_PATH_STRIPPED: "false",
      API_URL: "http://127.0.0.1:18041",
      DIST_DIR: `${process.cwd()}/dist`,
    },
    stdout: "inherit",
    stderr: "inherit",
  }),
)
// Model a cookie-authenticated gateway. Browser-session traffic never enters
// the notebook server's /api/remote relay; websocket upgrades terminate here.
const gateways = [18045, 18046].map((port, index) => {
  let valid = true
  return Bun.serve({
    port,
    async fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === "/test/session/reset") { valid = true; return Response.json(true) }
      if (url.pathname === "/test/session/expire") { valid = false; return Response.json(true) }
      if (url.pathname.startsWith("/browser-server/")) {
        if (!valid || !req.headers.get("cookie")?.includes("browser-session=valid")) return new Response("Login required", { status: 401 })
        if (req.headers.has("authorization") || req.headers.has("x-opencode-server-authorization")) return new Response("Unexpected credential", { status: 400 })
        if (url.pathname.endsWith("/connect") && req.headers.get("upgrade") === "websocket") {
          if (server.upgrade(req)) return
          return new Response("Upgrade failed", { status: 500 })
        }
        const path = url.pathname.slice("/browser-server".length)
        // Do not forward browser framing headers with a re-encoded request body.
        // Bun can otherwise send conflicting framing on pooled POST connections.
        const headers = new Headers(req.headers)
        headers.delete("content-length")
        headers.delete("transfer-encoding")
        const body = req.body ? await req.arrayBuffer() : undefined
        return fetch(`http://127.0.0.1:18042${path}${url.search}`, { method: req.method, headers, body, signal: req.signal })
      }
      return fetch(`http://127.0.0.1:${index ? 18044 : 18040}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: req.body, signal: req.signal })
    },
    websocket: {
      open(ws) { ws.send("Browser session terminal\r\n") },
      message(ws, data) { ws.send(data) },
    },
  })
})
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    uis.forEach((ui) => ui.kill())
    servers.forEach((server) => server.stop(true))
    gateways.forEach((server) => server.stop(true))
    process.exit(0)
  })
await Promise.all(uis.map((ui) => ui.exited))
