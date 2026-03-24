/**
 * Shared SSE (Server-Sent Events) parsing utility.
 *
 * Handles CRLF normalization, buffering until blank-line event boundaries,
 * and concatenation of multi-line `data:` fields per the SSE spec.
 */

export type SSECallback = (data: string) => void

/**
 * Creates a stateful SSE line parser. Feed it chunks from a ReadableStream
 * and it will invoke `onData` with the concatenated data payload for each
 * complete SSE event.
 */
export function createSSEParser(onData: SSECallback) {
  let buffer = ""
  let trailingCR = false

  return {
    /** Feed a raw text chunk from the stream. */
    push(chunk: string) {
      // Normalize CRLF to LF efficiently — only process the incoming chunk,
      // keeping a 1-char lookbehind for \r split across chunk boundaries.
      let normalized = ""
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i]
        if (ch === "\r") {
          if (trailingCR) normalized += "\n" // previous bare \r
          trailingCR = true
        } else if (ch === "\n") {
          normalized += "\n"
          trailingCR = false
        } else {
          if (trailingCR) { normalized += "\n"; trailingCR = false }
          normalized += ch
        }
      }
      buffer += normalized

      // SSE events are delimited by blank lines (\n\n).
      // Split on them and keep the last (possibly incomplete) fragment.
      // First, check if buffer might contain complete events —
      // if trailingCR is set, temporarily flush it to check for event boundaries
      if (trailingCR && buffer.endsWith("\n")) {
        buffer += "\n"
        trailingCR = false
      }
      const parts = buffer.split("\n\n")
      buffer = parts.pop() || ""

      for (const block of parts) {
        const dataLines: string[] = []
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) {
            dataLines.push(line.slice(6))
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5))
          }
          // Ignore other SSE fields (event:, id:, retry:, comments)
        }
        if (dataLines.length > 0) {
          onData(dataLines.join("\n"))
        }
      }
    },
  }
}
