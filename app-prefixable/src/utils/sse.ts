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

  return {
    /** Feed a raw text chunk from the stream. */
    push(chunk: string) {
      buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n")

      // SSE events are delimited by blank lines (\n\n).
      // Split on them and keep the last (possibly incomplete) fragment.
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
