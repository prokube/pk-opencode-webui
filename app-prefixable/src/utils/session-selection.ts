import type { Session } from "../sdk/client"

export function toggleSessionSelection(selected: Set<string>, id: string) {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function selectSessionRange(selected: Set<string>, order: string[], anchor: string, target: string) {
  const start = order.indexOf(anchor)
  const end = order.indexOf(target)
  if (start === -1 || end === -1) return toggleSessionSelection(selected, target)
  const next = new Set(selected)
  for (const id of order.slice(Math.min(start, end), Math.max(start, end) + 1)) next.add(id)
  return next
}

export function selectedRootSessions(sessions: Session[], selected: Set<string>) {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  return sessions.filter((session) => {
    if (!selected.has(session.id)) return false
    const seen = new Set<string>()
    for (let parentID = session.parentID; parentID;) {
      if (seen.has(parentID)) break
      seen.add(parentID)
      if (selected.has(parentID)) return false
      parentID = byID.get(parentID)?.parentID
    }
    return true
  })
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length)
  let index = 0
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const current = index++
      if (current >= items.length) return
      results[current] = await run(items[current])
    }
  }))
  return results
}

export function isSessionNotFound(error: unknown) {
  if (!error || typeof error !== "object") return false
  const value = error as { name?: unknown; status?: unknown; data?: { status?: unknown; statusCode?: unknown } }
  return value.name === "NotFound" || value.name === "NotFoundError" || value.status === 404 || value.data?.status === 404 || value.data?.statusCode === 404
}
