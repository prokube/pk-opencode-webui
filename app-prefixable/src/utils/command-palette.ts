export type PaletteCategory = "command" | "session" | "project"

export interface PaletteEntry {
  id: string
  title: string
  description?: string
  category: PaletteCategory
  keybind?: string
  run: () => void
}

export function paletteQuery(value: string) {
  const query = value.trim()
  const prefix = query[0]
  return {
    category: prefix === ">" ? "command" as const : prefix === "@" ? "session" as const : prefix === "#" ? "project" as const : undefined,
    text: prefix === ">" || prefix === "@" || prefix === "#" ? query.slice(1).trim() : query,
  }
}

export function filterPaletteEntries(entries: PaletteEntry[], value: string) {
  const query = paletteQuery(value)
  const pool = query.category ? entries.filter((entry) => entry.category === query.category) : entries
  if (!query.text) return pool
  const terms = query.text.toLowerCase().split(/\s+/).filter(Boolean)
  return pool
    .map((entry) => {
      const title = entry.title.toLowerCase()
      const content = `${title} ${entry.description ?? ""}`.toLowerCase()
      if (!terms.every((term) => content.includes(term))) return
      const exact = title === query.text.toLowerCase() ? 0 : title.startsWith(query.text.toLowerCase()) ? 1 : 2
      return { entry, exact }
    })
    .filter((item): item is { entry: PaletteEntry; exact: number } => !!item)
    .sort((a, b) => a.exact - b.exact || a.entry.title.localeCompare(b.entry.title))
    .map((item) => item.entry)
}
