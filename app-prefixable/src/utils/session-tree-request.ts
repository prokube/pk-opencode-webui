import type { QuestionRequest, Session } from "../sdk/client"

/**
 * Single-pass BFS tree-walk through session hierarchy.
 * Starting from `sessionID`, checks the current session first, then walks
 * through all descendant sessions (children, grandchildren, etc.) and returns
 * the first matching request found. Returns immediately on first match.
 */
function sessionTreeRequest<T>(
  sessions: Session[],
  requests: Record<string, T | undefined>,
  sessionID?: string,
) {
  if (!sessionID) return

  // Check the current session first (highest priority)
  if (requests[sessionID] !== undefined) return requests[sessionID]

  // Build parent->children lookup map
  const children = sessions.reduce((acc, s) => {
    if (!s.parentID) return acc
    const list = acc.get(s.parentID)
    if (list) list.push(s.id)
    if (!list) acc.set(s.parentID, [s.id])
    return acc
  }, new Map<string, string[]>())

  // BFS through descendants, returning on first match
  const seen = new Set([sessionID])
  const queue = [sessionID]
  for (let i = 0; i < queue.length; i++) {
    const list = children.get(queue[i])
    if (!list) continue
    for (const child of list) {
      if (seen.has(child)) continue
      seen.add(child)
      if (requests[child] !== undefined) return requests[child]
      queue.push(child)
    }
  }
}

/**
 * Find the first pending question from a session or any of its descendants.
 */
export function sessionQuestionRequest(
  sessions: Session[],
  requests: Record<string, QuestionRequest | undefined>,
  sessionID?: string,
) {
  return sessionTreeRequest(sessions, requests, sessionID)
}
