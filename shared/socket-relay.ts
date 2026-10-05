import { openBackendSocket, type RemoteSocket } from "./remote-server"

const closeCode = (code: number) => ([1005, 1006, 1015].includes(code) ? 1011 : code)

export function socketRelay<T>(resolve: (data: T) => RemoteSocket, activity = () => {}) {
  const peers = new WeakMap<object, { socket: WebSocket; pending: Array<string | Buffer>; bytes: number }>()
  return {
    open(client: Bun.ServerWebSocket<T>) {
      const target = resolve(client.data)
      const socket = openBackendSocket(target.target, target.headers)
      socket.binaryType = "arraybuffer"
      const peer = { socket, pending: [] as Array<string | Buffer>, bytes: 0 }
      peers.set(client, peer)
      socket.addEventListener("open", () => {
        if (client.readyState !== WebSocket.OPEN) {
          socket.close()
          return
        }
        for (const message of peer.pending) socket.send(message)
        peer.pending.length = 0
        peer.bytes = 0
      })
      socket.addEventListener("message", (event) => {
        if (client.readyState === WebSocket.OPEN) client.send(event.data)
      })
      socket.addEventListener("close", (event) => {
        peers.delete(client)
        if (client.readyState === WebSocket.OPEN) client.close(closeCode(event.code), event.reason)
      })
      socket.addEventListener("error", () => {
        if (client.readyState === WebSocket.OPEN) client.close(1011, "Backend connection error")
      })
    },
    message(client: Bun.ServerWebSocket<T>, message: string | Buffer) {
      activity()
      const peer = peers.get(client)
      if (!peer) return
      if (peer.socket.readyState === WebSocket.OPEN) {
        peer.socket.send(message)
        return
      }
      if (peer.socket.readyState !== WebSocket.CONNECTING) return
      peer.bytes += typeof message === "string" ? Buffer.byteLength(message) : message.byteLength
      if (peer.bytes > 65_536) {
        client.close(1009, "Terminal connection buffer exceeded")
        return
      }
      peer.pending.push(message)
    },
    close(client: Bun.ServerWebSocket<T>, code: number, reason: string) {
      const peer = peers.get(client)
      if (peer && (peer.socket.readyState === WebSocket.OPEN || peer.socket.readyState === WebSocket.CONNECTING))
        peer.socket.close(closeCode(code), reason)
      peers.delete(client)
    },
  }
}
