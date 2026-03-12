import type { Part, AssistantMessage } from "../sdk/client"

// Extract a human-readable message from the SDK error union.
export function errorText(err: NonNullable<AssistantMessage["error"]>): string {
  const data = err.data as Record<string, unknown>
  if (typeof data?.message === "string") return data.message
  return err.name
}

export interface DisplayMessage {
  id: string
  role: "user" | "assistant"
  parts: Part[]
  error?: AssistantMessage["error"]
  time?: AssistantMessage["time"]
  tokens?: AssistantMessage["tokens"]
  modelID?: string
  providerID?: string
}

export interface Turn {
  id: string
  userMessage: DisplayMessage
  assistantMessages: DisplayMessage[]
  time?: {
    started: number
    completed?: number
    duration?: number
  }
}
