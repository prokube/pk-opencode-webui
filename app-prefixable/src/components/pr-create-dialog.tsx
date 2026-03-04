import { createSignal, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useBasePath } from "../context/base-path"
import { useSDK } from "../context/sdk"
import { usePr } from "../context/pr"
import { Spinner } from "./ui/spinner"

interface Props {
  open: boolean
  branch: string
  dirty: number
  onClose: () => void
}

export function PrCreateDialog(props: Props) {
  const { prefix } = useBasePath()
  const { directory } = useSDK()
  const pr = usePr()

  const [title, setTitle] = createSignal("")
  const [body, setBody] = createSignal("")
  const [draft, setDraft] = createSignal(false)
  const [commitMsg, setCommitMsg] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal("")

  const hasDirty = () => props.dirty > 0

  async function post(path: string, data: Record<string, unknown>) {
    const res = await fetch(prefix(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory, ...data }),
    })
    const json = await res.json() as Record<string, unknown>
    if (!res.ok || json.error) throw new Error((json.error as string) || res.statusText)
    return json
  }

  async function handleSubmit() {
    if (!title().trim()) { setError("Title is required"); return }
    setError("")
    setSubmitting(true)
    try {
      // Commit dirty files first if needed
      if (hasDirty() && commitMsg().trim()) {
        await post("/api/ext/pr/commit", { message: commitMsg().trim() })
      }
      // Push branch
      await post("/api/ext/pr/push", {})
      // Create PR
      await post("/api/ext/pr/create", {
        title: title().trim(),
        body: body().trim() || undefined,
        draft: draft(),
      })
      await pr.refresh()
      props.onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSubmitting(false)
    }
  }

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
            aria-label="Create pull request"
            class="w-full max-w-lg rounded-lg shadow-xl overflow-hidden"
            style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}
          >
            {/* Header */}
            <div class="px-4 py-3" style={{ "border-bottom": "1px solid var(--border-base)" }}>
              <h2 class="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>
                Create pull request
              </h2>
              <p class="text-xs mt-0.5" style={{ color: "var(--text-weak)" }}>
                {props.branch}
              </p>
            </div>

            <div class="p-4 flex flex-col gap-3">
              {/* Dirty files warning + commit */}
              <Show when={hasDirty()}>
                <div
                  class="rounded-md p-3 text-xs flex flex-col gap-2"
                  style={{ background: "var(--surface-inset)", border: "1px solid var(--border-base)" }}
                >
                  <p style={{ color: "var(--text-base)" }}>
                    You have {props.dirty} uncommitted file{props.dirty === 1 ? "" : "s"}.
                    Add a commit message to include them, or leave blank to push as-is.
                  </p>
                  <input
                    type="text"
                    placeholder="Commit message (optional)"
                    value={commitMsg()}
                    onInput={(e) => setCommitMsg(e.currentTarget.value)}
                    class="w-full px-3 py-1.5 text-xs rounded-md outline-none"
                    style={{
                      background: "var(--background-base)",
                      border: "1px solid var(--border-base)",
                      color: "var(--text-base)",
                    }}
                  />
                </div>
              </Show>

              {/* PR title */}
              <div class="flex flex-col gap-1">
                <label class="text-xs font-medium" style={{ color: "var(--text-base)" }}>Title</label>
                <input
                  type="text"
                  placeholder="PR title"
                  value={title()}
                  onInput={(e) => setTitle(e.currentTarget.value)}
                  class="w-full px-3 py-2 text-sm rounded-md outline-none"
                  style={{
                    background: "var(--surface-inset)",
                    border: "1px solid var(--border-base)",
                    color: "var(--text-base)",
                  }}
                  autofocus
                />
              </div>

              {/* PR body */}
              <div class="flex flex-col gap-1">
                <label class="text-xs font-medium" style={{ color: "var(--text-base)" }}>Description (optional)</label>
                <textarea
                  placeholder="What does this PR do?"
                  value={body()}
                  onInput={(e) => setBody(e.currentTarget.value)}
                  rows={4}
                  class="w-full px-3 py-2 text-sm rounded-md outline-none resize-none"
                  style={{
                    background: "var(--surface-inset)",
                    border: "1px solid var(--border-base)",
                    color: "var(--text-base)",
                  }}
                />
              </div>

              {/* Draft toggle */}
              <label class="flex items-center gap-2 text-xs cursor-pointer" style={{ color: "var(--text-base)" }}>
                <input
                  type="checkbox"
                  checked={draft()}
                  onChange={(e) => setDraft(e.currentTarget.checked)}
                />
                Create as draft
              </label>

              {/* Error */}
              <Show when={error()}>
                <p class="text-xs rounded-md px-3 py-2" style={{ background: "var(--surface-inset)", color: "var(--icon-critical-base)" }}>
                  {error()}
                </p>
              </Show>
            </div>

            {/* Footer */}
            <div class="px-4 py-3 flex justify-end gap-2" style={{ "border-top": "1px solid var(--border-base)" }}>
              <button
                type="button"
                onClick={props.onClose}
                disabled={submitting()}
                class="px-4 py-2 text-xs font-medium rounded-md"
                style={{ background: "var(--surface-inset)", color: "var(--text-base)" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting() || !title().trim()}
                class="px-4 py-2 text-xs font-medium rounded-md flex items-center gap-1.5"
                style={{
                  background: submitting() || !title().trim() ? "var(--surface-inset)" : "var(--interactive-base)",
                  color: submitting() || !title().trim() ? "var(--text-weak)" : "white",
                  cursor: submitting() || !title().trim() ? "not-allowed" : "pointer",
                }}
              >
                <Show when={submitting()}>
                  <Spinner class="w-3 h-3" />
                </Show>
                {submitting() ? "Creating…" : "Push & Create PR"}
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  )
}
