export function stripHopByHopHeaders(headers: Headers, preserveContentLength = false) {
  const connection = headers.get("connection")
  if (connection) {
    for (const name of connection.split(",")) {
      const trimmed = name.trim()
      if (trimmed) headers.delete(trimmed)
    }
  }
  for (const name of [
    "connection",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) headers.delete(name)
  if (!preserveContentLength) headers.delete("content-length")
  return headers
}

export function serializeScriptData(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

export function normalizeProxiedResponse(response: Response) {
  const responseHeaders = stripHopByHopHeaders(new Headers(response.headers), true)
  // Bun fetch may return a decoded body while preserving original encoding headers.
  // Remove encoding/length headers only when a non-identity encoding is present.
  const encoding = responseHeaders.get("content-encoding")?.trim().toLowerCase()
  if (encoding && encoding !== "identity") {
    responseHeaders.delete("content-encoding")
    responseHeaders.delete("content-length")
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  })
}
