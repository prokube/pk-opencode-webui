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
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()
  return Bun.serve({
    port: 18041 + index,
    fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === "/test/writes") return Response.json(writes)
      if (url.pathname === "/test/streams") return Response.json(streams.size)
      if (url.pathname === "/test/reset") {
        sessions.splice(0, sessions.length, initial())
        writes.length = 0
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
        return req.json().then((body) => {
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
              name: "Mock",
              env: [],
              models: {
                echo: {
                  id: "echo",
                  providerID: "mock",
                  name: "Echo",
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
          connected: ["mock"],
          default: { mock: "echo" },
        })
      if (url.pathname === "/provider/auth") return Response.json({})
      if (
        url.pathname === "/session/status" ||
        url.pathname === "/mcp" ||
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
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    uis.forEach((ui) => ui.kill())
    servers.forEach((server) => server.stop(true))
    process.exit(0)
  })
await Promise.all(uis.map((ui) => ui.exited))
