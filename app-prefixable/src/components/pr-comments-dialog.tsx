import { createSignal, createResource, For, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useBasePath } from "../context/base-path"
import { useSDK } from "../context/sdk"
import { Spinner } from "./ui/spinner"
import type { PrInfo } from "../context/pr"

interface ReviewThread {
  id: string
  path: string
  comments: {
    id: string
    body: string
    url: string
    author: { login: string; __typename: string } | null
    authorIsBot: boolean
  }[]
}

interface CommentsData {
  threads: ReviewThread[]
  prNumber: number
  owner: string
  repo: string
}

interface Props {
  open: boolean
  pr: PrInfo
  onClose: () => void
  onAskAgent: (prompt: string) => void
}

export function PrCommentsDialog(props: Props) {
  const { prefix } = useBasePath()
  const { directory } = useSDK()

  const [selected, setSelected] = createSignal<Set<string>>(new Set())

  const [data] = createResource(
    () => props.open,
    async (open) => {
      if (!open) return null
      const dirParam = directory ? `directory=${encodeURIComponent(directory)}` : ""
      const res = await fetch(prefix(`/api/ext/pr/comments${dirParam ? `?${dirParam}` : ""}`))
      if (!res.ok) throw new Error(await res.text())
      return res.json() as Promise<CommentsData>
    },
  )

  function toggleThread(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function buildPrompt(threads: ReviewThread[]) {
    const chosen = threads.filter((t) => selected().has(t.id))
    if (!chosen.length) return ""

    const lines = [
      `Address the following unresolved PR review comments in PR #${props.pr.number} "${props.pr.title}".`,
      `For each comment: fix the issue, then commit and push the fix.`,
      ``,
    ]

    for (const thread of chosen) {
      lines.push(`### ${thread.path}`)
      for (const c of thread.comments) {
        const author = c.authorIsBot ? "[bot]" : (c.author?.login ?? "reviewer")
        lines.push(`**${author}**: ${c.body}`)
      }
      lines.push("")
    }

    return lines.join("\n")
  }

  function handleAskAgent() {
    const threads = data()?.threads ?? []
    const prompt = buildPrompt(threads)
    if (!prompt) return
    props.onAskAgent(prompt)
    props.onClose()
  }

  const selectedCount = () => selected().size

  return (
    <Show when={props.open}>
      <Portal>
        <div
          class="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={(e) => { if (e.target === e.currentTarget) props.onClose() }}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Address review comments"
            class="w-full max-w-lg rounded-lg shadow-xl overflow-hidden flex flex-col"
            style={{
              background: "var(--background-base)",
              border: "1px solid var(--border-base)",
              "max-height": "80vh",
            }}
          >
            {/* Header */}
            <div class="px-4 py-3 shrink-0" style={{ "border-bottom": "1px solid var(--border-base)" }}>
              <h2 class="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>
                Address review comments
              </h2>
              <p class="text-xs mt-0.5 truncate" style={{ color: "var(--text-weak)" }}>
                #{props.pr.number} {props.pr.title}
              </p>
            </div>

            {/* Body */}
            <div class="overflow-y-auto flex-1 p-4 flex flex-col gap-2">
              <Show when={data.loading}>
                <div class="flex items-center justify-center py-8 gap-2" style={{ color: "var(--text-weak)" }}>
                  <Spinner class="w-4 h-4" />
                  <span class="text-xs">Loading review threads…</span>
                </div>
              </Show>

              <Show when={data.error}>
                <p class="text-xs" style={{ color: "var(--icon-critical-base)" }}>
                  Failed to load comments: {String(data.error)}
                </p>
              </Show>

              <Show when={data() && !data.loading}>
                <Show
                  when={(data()?.threads?.length ?? 0) > 0}
                  fallback={
                    <p class="text-xs text-center py-8" style={{ color: "var(--text-weak)" }}>
                      No unresolved review threads.
                    </p>
                  }
                >
                  <p class="text-xs mb-1" style={{ color: "var(--text-weak)" }}>
                    Select threads to address. The agent will be prompted to fix each one.
                  </p>
                  <For each={data()!.threads}>
                    {(thread) => {
                      const isSelected = () => selected().has(thread.id)
                      const humanComments = thread.comments.filter((c) => !c.authorIsBot)
                      return (
                        <div
                          onClick={() => toggleThread(thread.id)}
                          class="rounded-md p-3 cursor-pointer flex flex-col gap-2 transition-opacity"
                          style={{
                            border: `1px solid ${isSelected() ? "var(--interactive-base)" : "var(--border-base)"}`,
                            background: isSelected() ? "var(--surface-inset)" : "transparent",
                            opacity: !isSelected() && selectedCount() > 0 ? "0.55" : "1",
                          }}
                        >
                          {/* File path */}
                          <div class="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={isSelected()}
                              onChange={() => toggleThread(thread.id)}
                              onClick={(e) => e.stopPropagation()}
                              class="rounded"
                            />
                            <span class="text-xs font-mono truncate" style={{ color: "var(--text-interactive-base)" }}>
                              {thread.path}
                            </span>
                          </div>
                          {/* Comments */}
                          <For each={humanComments}>
                            {(comment) => (
                              <div class="ml-5 text-xs" style={{ color: "var(--text-base)" }}>
                                <span class="font-medium" style={{ color: "var(--text-strong)" }}>
                                  {comment.author?.login ?? "reviewer"}:
                                </span>{" "}
                                {comment.body}
                              </div>
                            )}
                          </For>
                        </div>
                      )
                    }}
                  </For>
                </Show>
              </Show>
            </div>

            {/* Footer */}
            <div class="px-4 py-3 flex justify-end gap-2 shrink-0" style={{ "border-top": "1px solid var(--border-base)" }}>
              <button
                type="button"
                onClick={props.onClose}
                class="px-4 py-2 text-xs font-medium rounded-md"
                style={{ background: "var(--surface-inset)", color: "var(--text-base)" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAskAgent}
                disabled={selectedCount() === 0}
                class="px-4 py-2 text-xs font-medium rounded-md"
                style={{
                  background: selectedCount() === 0 ? "var(--surface-inset)" : "var(--interactive-base)",
                  color: selectedCount() === 0 ? "var(--text-weak)" : "white",
                  cursor: selectedCount() === 0 ? "not-allowed" : "pointer",
                }}
              >
                Ask agent to address {selectedCount() > 0 ? `(${selectedCount()})` : ""}
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  )
}
