import type { Part, AssistantMessage } from "../sdk/client"

export interface DisplayMessage {
  id: string
  role: "user" | "assistant"
  parts: Part[]
  error?: { name: string; data?: { message?: string } }
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
