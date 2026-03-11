import type { PermissionRequest, QuestionRequest, Session } from "../sdk/client"

/**
 * Build a parent->children lookup map from a session list.
 */
function buildChildMap(sessions: Session[]) {
  return sessions.reduce((acc, s) => {
    if (!s.parentID) return acc
    const list = acc.get(s.parentID)
    if (list) list.push(s.id)
    if (!list) acc.set(s.parentID, [s.id])
    return acc
  }, new Map<string, string[]>())
}

/**
 * Collect all descendant session IDs (including the session itself) via BFS.
 */
export function sessionDescendantIds(sessions: Session[], sessionID?: string): Set<string> {
  const result = new Set<string>()
  if (!sessionID) return result
  result.add(sessionID)
  const children = buildChildMap(sessions)
  const queue = [sessionID]
  for (let i = 0; i < queue.length; i++) {
    const list = children.get(queue[i])
    if (!list) continue
    for (const child of list) {
      if (result.has(child)) continue
      result.add(child)
      queue.push(child)
    }
  }
  return result
}

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

  const children = buildChildMap(sessions)

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

/**
 * Collect ALL pending permissions from a session and all its descendants.
 * Permissions are keyed by permission ID with sessionID as a field, so we
 * need to collect all of them (not just the first).
 */
export function sessionPermissionRequests(
  sessions: Session[],
  permissions: PermissionRequest[],
  sessionID?: string,
): PermissionRequest[] {
  if (!sessionID) return []
  const ids = sessionDescendantIds(sessions, sessionID)
  return permissions.filter((p) => ids.has(p.sessionID))
}

/**
 * Check whether a session or any of its descendants has a pending question.
 * Returns true/false without allocating the full request object.
 */
export function sessionHasQuestion(
  sessions: Session[],
  requests: Record<string, QuestionRequest | undefined>,
  sessionID?: string,
): boolean {
  return sessionTreeRequest(sessions, requests, sessionID) !== undefined
}
