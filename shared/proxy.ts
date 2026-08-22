export function normalizeProxiedResponse(response: Response) {
  const responseHeaders = new Headers(response.headers)
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
