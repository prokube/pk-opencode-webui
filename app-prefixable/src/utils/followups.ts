import { ascendingID } from "./id"
import { workspaceStorageKey } from "./storage"

interface ModelRef {
  providerID: string
  modelID: string
}

export interface FollowupItem {
  id: string
  messageID: string
  text: string
  agent: string
  model: ModelRef
  variant?: string
  createdAt: number
  failed?: boolean
}

export function followupStorageKey(serverID: string, directory: string, sessionID: string) {
  return workspaceStorageKey(serverID, directory, `followups.${sessionID}`)
}

export function parseFollowups(value: string | null, defaults?: { agent: string; model: ModelRef; variant?: string }) {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item): FollowupItem[] => {
      if (!item || typeof item !== "object") return []
      const entry = item as Partial<FollowupItem>
      if (typeof entry.text !== "string" || !entry.text.trim()) return []
      const model = entry.model?.providerID && entry.model.modelID ? entry.model : defaults?.model
      if (!model) return []
      return [{
        id: typeof entry.id === "string" ? entry.id : crypto.randomUUID(),
        messageID: typeof entry.messageID === "string" ? entry.messageID : ascendingID("msg"),
        text: entry.text,
        agent: typeof entry.agent === "string" ? entry.agent : defaults?.agent ?? "build",
        model,
        ...(typeof entry.variant === "string" ? { variant: entry.variant } : defaults?.variant ? { variant: defaults.variant } : {}),
        createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
        ...(entry.failed === true ? { failed: true } : {}),
      }]
    })
  } catch {
    return []
  }
}

export function parseLegacyFollowupMap(value: string | null, sessionID: string, defaults: { agent: string; model: ModelRef; variant?: string }) {
  if (!value) return { items: [] as FollowupItem[], remaining: undefined as string | undefined }
  try {
    const map = JSON.parse(value) as Record<string, unknown>
    if (!map || typeof map !== "object" || Array.isArray(map)) return { items: [], remaining: undefined }
    const items = parseFollowups(map[sessionID] ? JSON.stringify(map[sessionID]) : null, defaults)
    delete map[sessionID]
    return { items, remaining: Object.keys(map).length ? JSON.stringify(map) : undefined }
  } catch {
    return { items: [], remaining: value }
  }
}

export function canDispatchFollowup(input: {
  ready: boolean
  working: boolean
  processing: boolean
  loading: boolean
  blocked: boolean
  historyLoading: boolean
  loadError: boolean
  child: boolean
  composerEmpty: boolean
  dispatching: boolean
  paused: boolean
  reverting: boolean
  providerConnected: boolean
  item?: FollowupItem
}) {
  return !!input.item && !input.item.failed && input.ready && !input.working && !input.processing && !input.loading &&
    !input.blocked && !input.historyLoading && !input.loadError && !input.child && input.composerEmpty && !input.dispatching &&
    !input.paused && !input.reverting && input.providerConnected
}
