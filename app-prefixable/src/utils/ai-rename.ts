import type { OpencodeClient, Message, Part } from "../sdk/client"

interface MessageWithParts {
  info: Message
  parts: Part[]
}

interface ModelKey {
  providerID: string
  modelID: string
}

function textOf(p: Part): string {
  if (p.type !== "text") return ""
  return p.text
}

/**
 * Suggest a session title using AI. Creates a temporary child session,
 * sends the conversation summary as a prompt, extracts the suggestion,
 * and cleans up the child session.
 *
 * Returns the suggested title string, or throws on failure.
 */
export function suggestSessionTitle(
  client: OpencodeClient,
  sessionId: string,
  messages: MessageWithParts[],
  selectedModel: ModelKey | null,
  selectedAgent: string,
): Promise<string> {
  if (!messages.length) return Promise.reject(new Error("No messages to summarize"))

  // Find last assistant message for model extraction and summary
  const ref = { msg: undefined as MessageWithParts | undefined }
  for (const m of messages) {
    if (m.info.role === "assistant") ref.msg = m
  }

  // Build summary: prefer assistant text, fall back to user messages
  const summary = ref.msg
    ? ref.msg.parts
        .map(textOf)
        .filter(Boolean)
        .join("\n")
        .slice(0, 500)
    : messages
        .filter(m => m.info.role === "user")
        .slice(0, 10)
        .map(m => m.parts
          .map(textOf)
          .filter(Boolean)
          .join(" ")
          .slice(0, 500))
        .filter(t => t.length > 0)
        .join("\n")

  if (!summary.trim()) return Promise.reject(new Error("Empty conversation summary"))

  const model = (() => {
    // Prefer the model from the last assistant message (narrowed via role check)
    const info = ref.msg?.info
    if (info?.role === "assistant" && info.providerID && info.modelID) {
      return { providerID: info.providerID, modelID: info.modelID }
    }
    // Fall back to currently selected model
    if (!selectedModel?.providerID || !selectedModel?.modelID) return undefined
    return { providerID: selectedModel.providerID, modelID: selectedModel.modelID }
  })()

  const agent = selectedAgent || "build"
  const context = ref.msg ? "assistant reply" : "user messages"
  const prompt = `Suggest a concise session title (8 words or fewer) for this conversation based on the following ${context}. Reply with ONLY the title text, nothing else.\n\n${summary}`

  // Create a child session for the rename suggestion
  const state = { childId: "" }
  return client.session.create({ parentID: sessionId })
    .then((res) => {
      if (!res.data) throw new Error("Failed to create child session")
      state.childId = res.data.id
      const payload: {
        sessionID: string
        parts: { type: "text"; text: string }[]
        agent: string
        model?: { providerID: string; modelID: string }
      } = {
        sessionID: state.childId,
        parts: [{ type: "text", text: prompt }],
        agent,
      }
      if (model) payload.model = model
      return client.session.prompt(payload)
    })
    .then((res) => {
      // Extract the suggestion text from response parts
      const parts: Part[] = res.data?.parts ?? []
      const suggestion = parts
        .map(textOf)
        .filter(Boolean)
        .join("")
        .trim()
        // Strip surrounding quotes
        .replace(/^["']|["']$/g, "")
        .trim()

      if (!suggestion) throw new Error("AI returned an empty suggestion")
      return suggestion
    })
    .finally(() => {
      // Clean up child session
      if (state.childId) {
        client.session.delete({ sessionID: state.childId })
          .catch((err: unknown) => console.warn("Failed to clean up AI rename child session", err))
      }
    })
}
