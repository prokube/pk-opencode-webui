/**
 * Shared proxy handler for remote OpenCode server connections.
 *
 * Reads `X-Proxy-Target` header to determine the remote base URL,
 * then forwards the request (including auth headers) to the target.
 * Handles both regular API requests and SSE streaming.
 */

/**
 * Handle a proxied request to a remote server.
 * @param path - The API path after /__proxy (e.g. "/session", "/event?directory=...")
 * @param req - The incoming request
 * @returns Response or null if not a proxy request
 */
export async function handleProxyRequest(path: string, req: Request): Promise<Response> {
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

    if (isSSE) {
      if (!response.ok) {
        console.error("[Proxy] SSE error:", response.status, response.statusText)
        return new Response(response.body, { status: response.status })
      }

      return new Response(response.body, {
        status: response.status,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        },
      })
    }

    // Forward the response with CORS-safe headers
    const responseHeaders = new Headers(response.headers)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  } catch (e) {
    console.error("[Proxy] Connection error:", e)
    return new Response(JSON.stringify({ error: "Proxy connection failed" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    })
  }
}
