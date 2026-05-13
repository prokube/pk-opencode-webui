/**
 * Shared proxy handler for remote OpenCode server connections.
 *
 * Reads `X-Proxy-Target` header to determine the remote base URL,
 * then forwards the request (including auth headers) to the target.
 * Handles both regular API requests and SSE streaming.
 */

export function normalizeProxiedResponse(response: Response, corsOrigin?: string) {
  const responseHeaders = new Headers(response.headers)
  // Bun fetch may return a decoded body while preserving original encoding headers.
  // Remove encoding/length headers only when a non-identity encoding is present.
  const encoding = responseHeaders.get("content-encoding")?.trim().toLowerCase()
  if (encoding && encoding !== "identity") {
    responseHeaders.delete("content-encoding")
    responseHeaders.delete("content-length")
  }
  if (corsOrigin) {
    responseHeaders.set("Access-Control-Allow-Origin", corsOrigin)
    const vary = responseHeaders.get("Vary")
    if (!vary) {
      responseHeaders.set("Vary", "Origin")
    } else {
      const values = vary
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
      if (values.length === 1 && values[0] === "*") {
        responseHeaders.set("Vary", "*")
      } else {
        if (!values.some((x) => x.toLowerCase() === "origin")) {
          values.push("Origin")
        }
        responseHeaders.set("Vary", values.join(", "))
      }
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  })
}

function sameOrigin(req: Request) {
  const origin = req.headers.get("origin")
  if (!origin) return
  const requestOrigin = new URL(req.url).origin
  // Intentionally restrict proxy CORS to same-origin browser requests.
  // This prevents exposing /__proxy as a generic cross-origin proxy endpoint.
  if (origin !== requestOrigin) return
  return origin
}

/**
 * Handle a proxied request to a remote server.
 * @param path - Pathname after /__proxy (for example: "/session" or "/event"). Query comes from req.url.
 * @param req - The incoming request
 * @returns {Promise<Response>} The proxied response.
 */
export async function handleProxyRequest(path: string, req: Request): Promise<Response> {
  const corsOrigin = sameOrigin(req)
  // Handle CORS preflight for custom headers (x-proxy-target, x-api-key, etc.)
  if (req.method === "OPTIONS") {
    const headers = new Headers({
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": req.headers.get("access-control-request-headers") || "*",
      "Access-Control-Max-Age": "86400",
    })
    if (corsOrigin) {
      headers.set("Access-Control-Allow-Origin", corsOrigin)
      headers.set("Vary", "Origin")
    }
    return new Response(null, {
      status: 204,
      headers,
    })
  }

  const target = req.headers.get("x-proxy-target")
  if (!target) {
    return new Response(JSON.stringify({ error: "Missing X-Proxy-Target header" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }

  // Build target URL: append path to the target base (preserving target's own path)
  let targetUrl: URL
  try {
    const base = target.endsWith("/") ? target.slice(0, -1) : target
    const suffix = path.startsWith("/") ? path : "/" + path
    targetUrl = new URL(base + suffix + (new URL(req.url).search || ""))
  } catch {
    return new Response(JSON.stringify({ error: "Invalid proxy target URL" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }

  // Forward headers, removing hop-by-hop and proxy-specific ones
  const headers = new Headers(req.headers)
  headers.delete("x-proxy-target")
  headers.delete("host")
  headers.delete("connection")

  const isSSE = path.startsWith("/event")

  try {
    console.log(`[Proxy] ${isSSE ? "SSE" : req.method} -> ${targetUrl.toString()}`)

    const response = await fetch(targetUrl.toString(), {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    })

    const corsHeaders = new Headers()
    if (corsOrigin) {
      corsHeaders.set("Access-Control-Allow-Origin", corsOrigin)
      corsHeaders.set("Vary", "Origin")
    }

    if (isSSE) {
      if (!response.ok) {
        console.error("[Proxy] SSE error:", response.status, response.statusText)
        return new Response(response.body, { status: response.status, headers: corsHeaders })
      }

      const sseHeaders = new Headers(corsHeaders)
      sseHeaders.set("Content-Type", "text/event-stream")
      sseHeaders.set("Cache-Control", "no-cache")
      sseHeaders.set("Connection", "keep-alive")
      sseHeaders.set("X-Accel-Buffering", "no")

      return new Response(response.body, {
        status: response.status,
        headers: sseHeaders,
      })
    }

    return normalizeProxiedResponse(response, corsOrigin)
  } catch (e) {
    console.error("[Proxy] Connection error:", e)
    return new Response(JSON.stringify({ error: "Proxy connection failed" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    })
  }
}
