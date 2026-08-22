/**
 * Production UI Server for OpenCode Prefixable
 *
 * This server:
 * 1. Serves static files from /opt/opencode-ui/dist
 * 2. Proxies API requests to the OpenCode API server (localhost:4096)
 * 3. Proxies WebSocket connections for PTY terminal sessions
 * 4. Injects NB_PREFIX into index.html at runtime
 * 5. Provides extended API endpoints (/api/ext/*)
 */

import { handleExtendedEndpoint, isApiPath, isMutation, isSameOriginRequest } from "../shared/extended-api"
import { matchesBasePath, stripBasePath } from "../shared/base-path"
import { normalizeProxiedResponse } from "../shared/proxy"

const BASE_PATH = process.env.NB_PREFIX || process.env.BASE_PATH || "/"
const PORT = parseInt(process.env.PORT || "8080", 10)
const API_URL = process.env.API_URL || "http://127.0.0.1:4096"
const WS_API_URL = API_URL.replace(/^http/, "ws")
const DIST_DIR = process.env.DIST_DIR || "/opt/opencode-ui/dist"
const BRANDING_NAME = process.env.BRANDING_NAME || ""
const BRANDING_URL = process.env.BRANDING_URL || ""
const BRANDING_ICON = process.env.BRANDING_ICON || ""

console.log(`OpenCode UI Server starting...`)
console.log(`  BASE_PATH: ${BASE_PATH}`)
console.log(`  API_URL: ${API_URL}`)
console.log(`  WS_API_URL: ${WS_API_URL}`)
console.log(`  PORT: ${PORT}`)
console.log(`  DIST_DIR: ${DIST_DIR}`)
if (BRANDING_NAME) console.log(`  BRANDING: ${BRANDING_NAME}`)

// Normalize and validate base path (must be a valid path-only prefix)
function validateBasePath(path: string): string {
  // Must start with /, must not contain protocol or double slashes at start
  if (!path.startsWith("/") || path.includes("://") || path.startsWith("//")) {
    console.warn(`[WARN] Invalid BASE_PATH "${path}", falling back to "/"`)
    return "/"
  }
  // Remove HTML-sensitive characters and collapse multiple slashes
  const sanitized = path.replace(/[<>"'&]/g, "").replace(/\/+/g, "/")
  return sanitized || "/"
}
const validatedBasePath = validateBasePath(BASE_PATH)
const basePathWithoutTrailing = validatedBasePath.endsWith("/") ? validatedBasePath.slice(0, -1) : validatedBasePath
const basePathWithTrailing = validatedBasePath.endsWith("/") ? validatedBasePath : validatedBasePath + "/"
const isNotebookBasePath = /^\/notebook\//.test(basePathWithTrailing)
const OPENAI_BROWSER_OAUTH_UNSUPPORTED_MESSAGE = "OpenAI browser authentication uses a localhost callback and is not supported in notebooks. Use headless/code or API key authentication instead."

// MIME types for static files
const mimeTypes: Record<string, string> = {
  js: "application/javascript",
  mjs: "application/javascript",
  css: "text/css",
  html: "text/html",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  eot: "application/vnd.ms-fontobject",
  map: "application/json",
}

// Check if this is a PTY WebSocket connection request
function isPtyWebSocket(path: string): boolean {
  return /^\/pty\/[^/]+\/connect/.test(path)
}

// Track last non-polling activity for Kubeflow idle culling
let lastActivity = Date.now()
let blockedOpenAIMethods: Promise<Set<number>> | undefined

// Store for backend WebSocket connections (keyed by client WebSocket)
const backendConnections = new WeakMap<object, WebSocket>()

function withNoStoreHeaders(response: Response) {
  const headers = new Headers(response.headers)
  headers.set("Cache-Control", "no-store")
  headers.set("Pragma", "no-cache")
  headers.set("Expires", "0")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function rejectUnsupportedAuth(path: string, req: Request) {
  if (!isNotebookBasePath) return undefined
  if (req.method !== "POST") return undefined
  if (path !== "/provider/openai/oauth/authorize") return undefined

  const body = await req.clone().json().catch(() => null) as { method?: unknown } | null
  if (typeof body?.method !== "number") return undefined
  const blocked = await openAIBrowserOAuthMethods()
  if (!blocked.has(body.method)) return undefined

  return withNoStoreHeaders(new Response(JSON.stringify({
    error: OPENAI_BROWSER_OAUTH_UNSUPPORTED_MESSAGE,
  }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  }))
}

async function openAIBrowserOAuthMethods() {
  blockedOpenAIMethods ??= fetch(new URL("/provider/auth", API_URL).toString())
    .then((res) => {
      if (res.ok) return res.json()
      throw new Error(`OpenAI auth methods request failed: ${res.status} ${res.statusText}`)
    })
    .then((data) => {
      const methods = Array.isArray(data?.openai) ? data.openai : []
      return new Set<number>(methods.flatMap((method: { type?: string; label?: string }, index: number) => {
        if (method.type !== "oauth") return []
        return /\b(browser|local)\b/i.test(method.label ?? "") ? [index] : []
      }))
    })
    .catch((e) => {
      console.error("[Proxy] Failed to fetch OpenAI auth methods:", e)
      blockedOpenAIMethods = undefined
      return new Set<number>()
    })
  return blockedOpenAIMethods
}

function shouldDisposeAfterAuthMutation(path: string, req: Request, response: Response) {
  if (!response.ok) return false
  if (!AUTH_MUTATION_METHODS.has(req.method)) return false
  if (/^\/auth\/[^/]+$/.test(path)) return true
  return /^\/provider\/[^/]+\/oauth\/callback$/.test(path)
}

const AUTH_MUTATION_METHODS = new Set(["POST", "PUT", "DELETE"])

async function disposeInstanceAfterAuthMutation(path: string, req: Request, response: Response) {
  if (!shouldDisposeAfterAuthMutation(path, req, response)) return
  const dispose = new URL("/instance/dispose", API_URL)
  const res = await fetch(dispose.toString(), { method: "POST" }).catch((e) => {
    console.error("[Proxy] Failed to dispose instance after auth mutation:", e)
    return undefined
  })
  if (res && !res.ok) console.error("[Proxy] Failed to dispose instance after auth mutation:", res.status, res.statusText)
}

const server = Bun.serve<{ path: string; search: string }>({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 0, // Disable timeout for SSE connections

  async fetch(req, server) {
    const url = new URL(req.url)
    if (!matchesBasePath(url.pathname, basePathWithoutTrailing)) {
      return new Response("Not Found", { status: 404 })
    }

    // Strip only a complete base-path segment.
    let path = stripBasePath(url.pathname, basePathWithoutTrailing)
    if (!path.startsWith("/")) {
      path = "/" + path
    }

    // Kubeflow idle culling: /api/kernels must never update activity timestamp
    if (path === "/api/kernels") {
      if (req.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } })
      }
      const idle = Date.now() - lastActivity >= 60_000
      const kernel = {
        id: "opencode-activity",
        name: "opencode",
        last_activity: new Date(lastActivity).toISOString(),
        execution_state: idle ? "idle" : "busy",
        connections: 0,
      }
      return new Response(JSON.stringify([kernel]), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      })
    }

    // Update activity timestamp for all non-polling requests
    lastActivity = Date.now()

    // Handle WebSocket upgrade for PTY connections
    if (isPtyWebSocket(path)) {
      const upgradeHeader = req.headers.get("Upgrade")
      if (upgradeHeader?.toLowerCase() === "websocket") {
        if (!isSameOriginRequest(req, url)) return new Response("Cross-origin request denied", { status: 403 })
        console.log("[Proxy] WebSocket upgrade for PTY:", path)
        const success = server.upgrade(req, {
          data: { path, search: url.search },
        })
        if (success) {
          return undefined // Bun handles the response
        }
        return new Response("WebSocket upgrade failed", { status: 500 })
      }
    }

    // Extended API endpoints (handled locally, not proxied)
    const extResponse = await handleExtendedEndpoint(path, req.method, url, req)
    if (extResponse) return withNoStoreHeaders(extResponse)

    // Check if this is an API request (after stripping prefix)
    if (isApiPath(path)) {
      if (isMutation(req.method) && !isSameOriginRequest(req, url)) {
        return new Response("Cross-origin request denied", { status: 403 })
      }
      const target = new URL(path + url.search, API_URL)
      const headers = new Headers(req.headers)

      // SSE requests need special handling
      if (path.startsWith("/event")) {
        console.log("[Proxy] SSE request to:", target.toString())
        try {
          const response = await fetch(target.toString(), {
            method: req.method,
            headers,
          })

          if (!response.ok) {
            console.error("[Proxy] SSE error:", response.status, response.statusText)
            return withNoStoreHeaders(
              new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              }),
            )
          }

          return new Response(response.body, {
            status: response.status,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-store",
              Pragma: "no-cache",
              Expires: "0",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            },
          })
        } catch (e) {
          console.error("[Proxy] SSE connection error:", e)
          return withNoStoreHeaders(new Response("SSE proxy error", { status: 502 }))
        }
      }

      // Regular API requests
      console.log("[Proxy] API:", req.method, path)
      const rejected = await rejectUnsupportedAuth(path, req)
      if (rejected) return rejected

      try {
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : req.body
        const response = await fetch(target.toString(), {
          method: req.method,
          headers,
          body,
        })
        await disposeInstanceAfterAuthMutation(path, req, response)
        return withNoStoreHeaders(normalizeProxiedResponse(response))
      } catch (e) {
        console.error("[Proxy] API error:", e)
        return withNoStoreHeaders(new Response("API proxy error", { status: 502 }))
      }
    }

    // Frontend routes - path is already stripped above
    // Try to serve static file
    const filePath = `${DIST_DIR}${path}`
    const file = Bun.file(filePath)

    if (await file.exists()) {
      const ext = path.split(".").pop()?.toLowerCase() || ""
      const contentType = mimeTypes[ext] || "application/octet-stream"

      const cacheControl = ext === "js" || ext === "css" || ext === "map"
        ? "no-cache"
        : "public, max-age=31536000, immutable"
      return new Response(file, {
        headers: {
          "Content-Type": contentType,
          ...(ext !== "html" && { "Cache-Control": cacheControl }),
        },
      })
    }

    // SPA fallback - serve index.html with injected base path
    const indexPath = `${DIST_DIR}/index.html`
    const indexFile = Bun.file(indexPath)

    if (!(await indexFile.exists())) {
      console.error("index.html not found at:", indexPath)
      return new Response("Not Found", { status: 404 })
    }

    const indexHtml = await indexFile.text()
    // Use JSON.stringify for safe encoding to prevent XSS
    const config = JSON.stringify({
      basePath: basePathWithTrailing,
      branding: { name: BRANDING_NAME, url: BRANDING_URL, icon: BRANDING_ICON },
    })
    // HTML-escape basePath for safe insertion into the <base href> attribute
    const escapedBasePath = basePathWithTrailing.replace(/[&<>"']/g, (ch) => {
      const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
      return map[ch] ?? ch
    })
    const injected = indexHtml.replace('<base href="/" />', `<base href="${escapedBasePath}" />`).replace(
      "window.__OPENCODE__ = window.__OPENCODE__ || {}",
      // Don't set serverUrl - let the browser use window.location.origin
      // API requests will be proxied through this server
      `window.__OPENCODE__ = ${config}`,
    )

    return new Response(injected, {
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "no-cache",
      },
    })
  },

  // WebSocket handler for PTY proxy
  websocket: {
    open(ws) {
      const { path, search } = ws.data
      const targetUrl = `${WS_API_URL}${path}${search}`
      console.log("[Proxy] Opening backend WebSocket to:", targetUrl)

      const backend = new WebSocket(targetUrl)

      backend.addEventListener("open", () => {
        console.log("[Proxy] Backend WebSocket connected")
      })

      backend.addEventListener("message", (event) => {
        // Forward backend messages to client
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(event.data)
        }
      })

      backend.addEventListener("close", (event) => {
        console.log("[Proxy] Backend WebSocket closed:", event.code, event.reason)
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(event.code, event.reason)
        }
      })

      backend.addEventListener("error", (error) => {
        console.error("[Proxy] Backend WebSocket error:", error)
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1011, "Backend connection error")
        }
      })

      backendConnections.set(ws, backend)
    },

    message(ws, message) {
      // Forward client messages to backend
      lastActivity = Date.now()
      const backend = backendConnections.get(ws)
      if (backend?.readyState === WebSocket.OPEN) {
        backend.send(message)
      }
    },

    close(ws, code, reason) {
      console.log("[Proxy] Client WebSocket closed:", code, reason)
      const backend = backendConnections.get(ws)
      if (backend?.readyState === WebSocket.OPEN) {
        backend.close(code, reason)
      }
      backendConnections.delete(ws)
    },
  },
})

console.log(`\nOpenCode UI Server running at http://0.0.0.0:${PORT}${basePathWithTrailing}`)
console.log(`Proxying API requests to ${API_URL}`)
