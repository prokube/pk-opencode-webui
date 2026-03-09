import type { QuestionRequest, Session } from "../sdk/client"

/**
 * Generic BFS tree-walk through session hierarchy.
 * Starting from `sessionID`, walks through all descendant sessions
 * (children, grandchildren, etc.) and returns the first matching request.
 * The current session's own requests take priority over children's.
 */
function sessionTreeRequest<T>(
  sessions: Session[],
  requests: Record<string, T | undefined>,
  sessionID?: string,
) {
  if (!sessionID) return

  // Build parent→children lookup map
  const children = sessions.reduce((acc, s) => {
    if (!s.parentID) return acc
    const list = acc.get(s.parentID)
    if (list) list.push(s.id)
    if (!list) acc.set(s.parentID, [s.id])
    return acc
  }, new Map<string, string[]>())

  // BFS: current session first, then children, then grandchildren
  const seen = new Set([sessionID])
  const queue = [sessionID]
  for (const id of queue) {
    const list = children.get(id)
    if (!list) continue
    for (const child of list) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }

  // Return first matching request found in BFS order
  const match = queue.find((id) => requests[id] !== undefined)
  if (!match) return
  return requests[match]
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
