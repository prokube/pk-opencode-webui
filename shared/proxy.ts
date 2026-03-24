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
  // Handle CORS preflight for custom headers (x-proxy-target, x-api-key, etc.)
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": req.headers.get("access-control-request-headers") || "*",
        "Access-Control-Max-Age": "86400",
      },
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

    const corsHeaders = { "Access-Control-Allow-Origin": "*" }

    if (isSSE) {
      if (!response.ok) {
        console.error("[Proxy] SSE error:", response.status, response.statusText)
        return new Response(response.body, { status: response.status, headers: corsHeaders })
      }

      return new Response(response.body, {
        status: response.status,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        },
      })
    }

    // Forward the response with CORS headers.
    // Remove Content-Encoding because fetch() already decompresses the body,
    // so passing gzip/br encoding to the browser causes double-decode failures.
    const responseHeaders = new Headers(response.headers)
    responseHeaders.delete("content-encoding")
    responseHeaders.delete("content-length") // length no longer matches after decompression
    responseHeaders.set("Access-Control-Allow-Origin", "*")
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
