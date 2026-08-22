import type { Event, SessionStatus } from "../sdk/client"
import { useSync } from "./sync"

type SessionStatusEvent = {
  sessionID: string
  status: SessionStatus
}

export function sessionStatusEvent(event: { type: string; properties?: unknown }): SessionStatusEvent | undefined {
  const props = event.properties as { sessionID?: string; status?: SessionStatus } | undefined
  if (!props?.sessionID) return undefined
  if (event.type === "session.status" && props.status) return { sessionID: props.sessionID, status: props.status }
  if (event.type === "session.idle") return { sessionID: props.sessionID, status: { type: "idle" } }
  return undefined
}

/** Compatibility projection for consumers that have not moved to useSync yet. */
export function useEvents() {
  const sync = useSync()

  return {
    subscribe: (handler: (event: Event) => void) => sync.subscribe((event) => handler(event as Event)),
    get status() {
      return sync.status
    },
    statusReady: sync.statusReady,
    get pendingQuestions() {
      return sync.pendingQuestions
    },
    dismissQuestion: sync.dismissQuestion,
    setSessionStatus: sync.setSessionStatus,
  }
}
