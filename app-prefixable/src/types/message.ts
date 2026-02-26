import type { Part } from "../sdk/client"

export interface DisplayMessage {
  id: string
  role: "user" | "assistant"
  parts: Part[]
  error?: { name: string; data?: { message?: string } }
}

export interface Turn {
  id: string
  userMessage: DisplayMessage
  assistantMessages: DisplayMessage[]
}
