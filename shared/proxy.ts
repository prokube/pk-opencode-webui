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

export function isEventStreamPath(path: string) {
  return path === "/event" || path === "/global/event"
}

export function proxyEventResponse(response: Response, signal: AbortSignal, upstream: AbortController) {
  if (!response.body) return normalizeProxiedResponse(response)
  const reader = response.body.getReader()
  let closed = false
  const abort = () => upstream.abort(signal.reason)
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()

  function release() {
    try {
      reader.releaseLock()
    } catch {
      // A pending read releases the lock after it rejects from the abort.
    }
  }

  function cleanup(reason?: unknown) {
    if (closed) return
    closed = true
    signal.removeEventListener("abort", abort)
    upstream.abort(reason)
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (!chunk.done) {
          controller.enqueue(chunk.value)
          return
        }
        cleanup()
        release()
        controller.close()
      } catch (error) {
        cleanup(error)
        release()
        controller.error(error)
      }
    },
    async cancel(reason) {
      cleanup(reason)
      await reader.cancel(reason).catch(() => undefined)
      release()
    },
  })

  return new Response(body, {
    status: response.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      Expires: "0",
      "X-Accel-Buffering": "no",
    },
  })
}
