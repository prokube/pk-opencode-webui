import { isApiPath, isSameOriginRequest } from "./extended-api"
import { isEventStreamPath, normalizeProxiedResponse, proxyEventResponse } from "./proxy"
import { normalizeRemoteUrl } from "./remote-url"

export const REMOTE_AUTH_HEADER = "x-opencode-server-authorization"
export type RemoteSocket = { target: string; headers: Record<string, string> }

export function openBackendSocket(url: string, headers?: Record<string, string>) {
  // lib.dom's constructor declaration hides Bun's documented headers option.
  const Socket = WebSocket as unknown as { new (url: string, options?: Bun.WebSocketOptions): WebSocket }
  return new Socket(url, headers ? { headers } : undefined)
}

export function remoteTarget(base: string, path: string, search = "") {
  const normalized = normalizeRemoteUrl(base)
  const target = new URL(normalized + path + search)
  const root = normalized + "/"
  if (
    !target.href.startsWith(root) ||
    !path.startsWith("/") ||
    path.includes("\\") ||
    target.pathname !== new URL(normalized).pathname.replace(/\/$/, "") + path
  )
    throw new Error("Invalid remote API path")
  return target
}

function response(body: string, status: number) {
  return new Response(body, { status, headers: { "Cache-Control": "no-store" } })
}

// Tickets are short-lived capabilities for browser WebSockets, which cannot
// send an Authorization header. They never contain credentials in their URL.
export function createRemoteProxy(now = Date.now) {
  const tickets = new Map<string, { base: string; path: string; expires: number; auth: string }>()
  return async function remote(
    req: Request,
    path: string,
    upgrade: (socket: RemoteSocket) => boolean,
  ): Promise<Response | true | undefined> {
    if (!path.startsWith("/api/remote/")) return
    const url = new URL(req.url)
    if (!isSameOriginRequest(req, url)) return response("Cross-origin request denied", 403)
    const match = /^\/api\/remote\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(path)
    if (!match) return response("Invalid remote route", 400)
    const base = (() => {
      try {
        return normalizeRemoteUrl(Buffer.from(match[1], "base64url").toString("utf8"))
      } catch {
        return undefined
      }
    })()
    if (!base) return response("Invalid remote server URL", 400)
    const api = match[2] || "/"
    if (api.startsWith("/api/ext/"))
      return response("This feature requires the local UI filesystem API and is unavailable on external servers", 501)
    if (!isApiPath(api)) return response("Not an OpenCode API route", 404)
    const auth = req.headers.get(REMOTE_AUTH_HEADER) ?? ""
    if (auth && (!/^(Basic|Bearer) [A-Za-z0-9._~+/=-]+$/.test(auth) || auth.length > 16_384))
      return response("Invalid remote credentials", 400)
    for (const [key, value] of tickets) if (value.expires <= now()) tickets.delete(key)

    if (/^\/pty\/[^/]+\/connect-ticket$/.test(api)) {
      if (req.method !== "POST") return response("Method not allowed", 405)
      if (tickets.size >= 256) return response("Too many pending terminal connections", 429)
      const ticket = crypto.randomUUID()
      const socketPath = api.replace(/connect-ticket$/, "connect")
      tickets.set(ticket, { base, path: socketPath, auth, expires: now() + 30_000 })
      return Response.json({ ticket }, { headers: { "Cache-Control": "no-store" } })
    }

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (!/^\/pty\/[^/]+\/connect$/.test(api)) return response("Invalid terminal route", 400)
      const key = url.searchParams.get("ticket") ?? ""
      const ticket = tickets.get(key)
      tickets.delete(key)
      if (!ticket || ticket.base !== base || ticket.path !== api || ticket.expires <= now())
        return response("Invalid terminal ticket", 401)
      url.searchParams.delete("ticket")
      const target = remoteTarget(base, api, url.search)
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:"
      return (
        upgrade({ target: target.href, headers: ticket.auth ? { Authorization: ticket.auth } : {} }) ||
        response("WebSocket upgrade failed", 500)
      )
    }

    const target = (() => {
      try {
        return remoteTarget(base, api, url.search)
      } catch {
        return undefined
      }
    })()
    if (!target) return response("Invalid remote API path", 400)
    // Forward only API transport headers, never the platform Cookie/JWT or
    // authenticated-user headers from our ingress to a user-selected server.
    const headers = new Headers()
    for (const key of [
      "accept",
      "content-type",
      "range",
      "if-none-match",
      "last-event-id",
      "x-opencode-directory",
      "x-opencode-workspace",
    ]) {
      const value = req.headers.get(key)
      if (value) headers.set(key, value)
    }
    if (auth) headers.set("Authorization", auth)
    const abort = new AbortController()
    const cancel = () => abort.abort(req.signal.reason)
    req.signal.addEventListener("abort", cancel, { once: true })
    if (req.signal.aborted) cancel()
    try {
      const result = await fetch(target, {
        method: req.method,
        headers,
        redirect: "manual",
        signal: abort.signal,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      })
      if (result.status >= 300 && result.status < 400) {
        await result.body?.cancel()
        return response("Remote server redirected; use its final API URL", 502)
      }
      if (isEventStreamPath(api) && result.ok) return proxyEventResponse(result, req.signal, abort)
      const normalized = normalizeProxiedResponse(result)
      normalized.headers.delete("set-cookie")
      normalized.headers.delete("www-authenticate")
      normalized.headers.set("Cache-Control", "no-store")
      normalized.headers.set("X-Content-Type-Options", "nosniff")
      normalized.headers.set("Content-Security-Policy", "default-src 'none'; sandbox")
      return normalized
    } catch {
      return response("Remote OpenCode server is unreachable", 502)
    } finally {
      req.signal.removeEventListener("abort", cancel)
    }
  }
}
