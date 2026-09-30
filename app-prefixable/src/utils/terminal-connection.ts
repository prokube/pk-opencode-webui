export async function terminalSocketUrl(input: {
  url: string
  id: string
  directory?: string
  cursor?: number
  remote: boolean
  headers: Record<string, string>
}) {
  const base = input.url.replace(/\/$/, "") + `/pty/${encodeURIComponent(input.id)}`
  const url = new URL(base + "/connect")
  if (input.directory !== undefined) url.searchParams.set("directory", input.directory)
  if (input.cursor !== undefined) url.searchParams.set("cursor", String(input.cursor))
  if (input.remote) {
    const response = await fetch(base + "/connect-ticket", {
      method: "POST",
      headers: input.headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Terminal authorization failed (HTTP ${response.status})`)
    const body: unknown = await response.json()
    if (!body || typeof body !== "object" || !("ticket" in body) || typeof body.ticket !== "string")
      throw new Error("Missing terminal connection ticket")
    url.searchParams.set("ticket", body.ticket)
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.href
}

export function terminalFrame(data: string | ArrayBuffer): { output?: string | Uint8Array; cursor?: number } {
  if (typeof data === "string") return { output: data }
  const bytes = new Uint8Array(data)
  if (bytes[0] !== 0) return { output: bytes }
  try {
    const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as { cursor?: unknown }
    if (typeof metadata.cursor === "number" && Number.isSafeInteger(metadata.cursor) && metadata.cursor >= 0)
      return { cursor: metadata.cursor }
  } catch {
    /* Ignore malformed control frames, never render them as terminal text. */
  }
  return {}
}
