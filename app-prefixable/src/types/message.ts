import type { Part } from "../sdk/client"

export interface DisplayMessage {
  id: string
  role: "user" | "assistant"
  parts: Part[]
  error?: { name: string; data?: { message?: string } }
  time?: {
    created: number
    completed?: number
  }
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
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
