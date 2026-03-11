import type { PermissionRequest, QuestionRequest, Session } from "../sdk/client"

/**
 * Build a parent->children lookup map from a session list.
 * Exported so callers can compute it once and pass to multiple helpers.
 */
export function buildChildMap(sessions: Session[]) {
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
 * Accepts an optional precomputed child map to avoid rebuilding it per call.
 */
export function sessionDescendantIds(
  sessions: Session[],
  sessionID?: string,
  children?: Map<string, string[]>,
): Set<string> {
  const result = new Set<string>()
  if (!sessionID) return result
  result.add(sessionID)
  const map = children ?? buildChildMap(sessions)
  const queue = [sessionID]
  for (let i = 0; i < queue.length; i++) {
    const list = map.get(queue[i])
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
 * Accepts an optional precomputed child map to avoid rebuilding it per call.
 */
function sessionTreeRequest<T>(
  sessions: Session[],
  requests: Record<string, T | undefined>,
  sessionID?: string,
  children?: Map<string, string[]>,
) {
  if (!sessionID) return

  // Check the current session first (highest priority)
  if (requests[sessionID] !== undefined) return requests[sessionID]

  const map = children ?? buildChildMap(sessions)

  // BFS through descendants, returning on first match
  const seen = new Set([sessionID])
  const queue = [sessionID]
  for (let i = 0; i < queue.length; i++) {
    const list = map.get(queue[i])
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
  children?: Map<string, string[]>,
) {
  return sessionTreeRequest(sessions, requests, sessionID, children)
}

/**
 * Collect ALL pending permissions from a session and all its descendants.
 * Permissions are keyed by permission ID with sessionID as a field, so we
 * need to collect all of them (not just the first).
 * Accepts an optional precomputed child map to avoid rebuilding it per call.
 */
export function sessionPermissionRequests(
  sessions: Session[],
  permissions: PermissionRequest[],
  sessionID?: string,
  children?: Map<string, string[]>,
): PermissionRequest[] {
  if (!sessionID) return []
  const ids = sessionDescendantIds(sessions, sessionID, children)
  return permissions.filter((p) => ids.has(p.sessionID))
}

/**
 * Check whether a session or any of its descendants has a pending question.
 * Returns true/false without allocating the full request object.
 * Accepts an optional precomputed child map to avoid rebuilding it per call.
 */
export function sessionHasQuestion(
  sessions: Session[],
  requests: Record<string, QuestionRequest | undefined>,
  sessionID?: string,
  children?: Map<string, string[]>,
): boolean {
  return sessionTreeRequest(sessions, requests, sessionID, children) !== undefined
}

/**
 * Walk up the parentID chain from a session to find the root ancestor.
 * Useful for checking bell/notification state which is set on the root session.
 * Returns the original sessionID if no parent chain is found.
 */
export function rootAncestorId(
  getSession: (id: string) => Session | undefined,
  sessionID: string,
): string {
  const visited = new Set<string>([sessionID])
  let root = sessionID
  let walk = getSession(sessionID)
  while (walk?.parentID) {
    if (visited.has(walk.parentID)) break // cycle protection
    visited.add(walk.parentID)
    const parent = getSession(walk.parentID)
    if (!parent) break
    root = walk.parentID
    walk = parent
  }
  return root
}
