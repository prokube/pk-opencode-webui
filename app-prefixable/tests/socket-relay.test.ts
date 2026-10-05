import { expect, test } from "bun:test"
import { socketRelay } from "../../shared/socket-relay"
import type { RemoteSocket } from "../../shared/remote-server"

test("terminal relay authenticates upstream and buffers input during its handshake", async () => {
  const upstream = Bun.serve({
    port: 0,
    async fetch(request, server) {
      if (request.headers.get("authorization") !== "Bearer remote-key")
        return new Response("Unauthorized", { status: 401 })
      await Bun.sleep(50)
      if (server.upgrade(request)) return
      return new Response("Upgrade failed", { status: 500 })
    },
    websocket: {
      message(socket, data) {
        socket.send(data)
      },
    },
  })
  const relay = Bun.serve<RemoteSocket>({
    port: 0,
    fetch(request, server) {
      if (
        server.upgrade(request, {
          data: { target: upstream.url.href.replace(/^http/, "ws"), headers: { Authorization: "Bearer remote-key" } },
        })
      )
        return
      return new Response("Upgrade failed", { status: 500 })
    },
    websocket: socketRelay((data) => data),
  })
  const socket = new WebSocket(relay.url.href.replace(/^http/, "ws"))
  try {
    const echoed = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Terminal input was lost during handshake")), 2000)
      socket.addEventListener("open", () => socket.send("first keystrokes"))
      socket.addEventListener("message", (event) => {
        clearTimeout(timer)
        resolve(String(event.data))
      })
      socket.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("WebSocket failed"))
      })
    })
    expect(echoed).toBe("first keystrokes")
  } finally {
    socket.close()
    relay.stop(true)
    upstream.stop(true)
  }
})
