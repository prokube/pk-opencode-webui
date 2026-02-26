import type { Part } from "../sdk/client"

export function extractTextContent(parts: Part[]): string {
  return parts
    .filter((p): p is Part & { type: "text" } => p.type === "text")
    .map((p) => p.text)
    .join("")
}
