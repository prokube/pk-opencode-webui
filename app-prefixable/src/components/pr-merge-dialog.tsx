import { createSignal, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useBasePath } from "../context/base-path"
import { useSDK } from "../context/sdk"
import { usePr, type PrInfo } from "../context/pr"
import { Spinner } from "./ui/spinner"

interface Props {
  open: boolean
  pr: PrInfo
  onClose: () => void
  /** Called when user wants the agent to fix merge conflicts */
  onAskAgentToFix: (prompt: string) => void
}

type Strategy = "merge" | "squash" | "rebase"

export function PrMergeDialog(props: Props) {
  const { prefix } = useBasePath()
  const { directory } = useSDK()
  const pr = usePr()

  const [strategy, setStrategy] = createSignal<Strategy>("squash")
  const [deleteBranch, setDeleteBranch] = createSignal(true)
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal("")

  const hasConflicts = () => props.pr.mergeable === "CONFLICTING"
  const isApproved = () => props.pr.reviewDecision === "APPROVED"

  async function handleMerge() {
    setError("")
    setSubmitting(true)
    try {
      const res = await fetch(prefix("/api/ext/pr/merge"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory, strategy: strategy(), deleteBranch: deleteBranch() }),
      })
      const json = await res.json() as Record<string, unknown>
      if (!res.ok || json.error) throw new Error((json.error as string) || res.statusText)
      await pr.refresh()
      props.onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  function handleAskAgent() {
    const prompt = [
      `Fix merge conflicts in the current branch before merging PR #${props.pr.number} "${props.pr.title}" into ${props.pr.baseRefName}.`,
      `Run \`git status\` to see conflicting files, resolve them, then run \`git add\` and \`git rebase --continue\` or \`git merge --continue\` as appropriate.`,
      `After resolving, verify the branch is conflict-free with \`git diff --check\`.`,
    ].join(" ")
    props.onAskAgentToFix(prompt)
    props.onClose()
  }

  const strategies: { value: Strategy; label: string; desc: string }[] = [
    { value: "squash", label: "Squash and merge", desc: "Combine all commits into one" },
    { value: "merge", label: "Create a merge commit", desc: "Preserve all commits" },
    { value: "rebase", label: "Rebase and merge", desc: "Rebase commits onto base branch" },
  ]

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
            aria-label="Merge pull request"
            class="w-full max-w-md rounded-lg shadow-xl overflow-hidden"
            style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}
          >
            {/* Header */}
            <div class="px-4 py-3" style={{ "border-bottom": "1px solid var(--border-base)" }}>
              <h2 class="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>
                Merge pull request
              </h2>
              <p class="text-xs mt-0.5 truncate" style={{ color: "var(--text-weak)" }}>
                #{props.pr.number} {props.pr.title}
              </p>
            </div>

            <div class="p-4 flex flex-col gap-3">
              {/* Conflict warning */}
              <Show when={hasConflicts()}>
                <div
                  class="rounded-md p-3 text-xs flex flex-col gap-2"
                  style={{ background: "rgba(var(--icon-critical-base-rgb, 200,50,50),0.08)", border: "1px solid var(--icon-critical-base)" }}
                >
                  <p style={{ color: "var(--icon-critical-base)" }}>
                    This branch has merge conflicts that must be resolved before merging.
                  </p>
                  <button
                    type="button"
                    onClick={handleAskAgent}
                    class="self-start px-3 py-1 text-xs rounded-md"
                    style={{ background: "var(--interactive-base)", color: "white" }}
                  >
                    Ask agent to fix conflicts
                  </button>
                </div>
              </Show>

              {/* Review status */}
              <Show when={props.pr.reviewDecision === "CHANGES_REQUESTED"}>
                <div
                  class="rounded-md px-3 py-2 text-xs"
                  style={{ background: "var(--surface-inset)", border: "1px solid var(--border-base)", color: "var(--text-base)" }}
                >
                  Changes have been requested on this PR.
                </div>
              </Show>

              {/* Strategy selector */}
              <div class="flex flex-col gap-1.5">
                {strategies.map((s) => (
                  <label
                    class="flex items-start gap-2.5 px-3 py-2 rounded-md cursor-pointer text-xs"
                    style={{
                      border: `1px solid ${strategy() === s.value ? "var(--interactive-base)" : "var(--border-base)"}`,
                      background: strategy() === s.value ? "var(--surface-inset)" : "transparent",
                    }}
                  >
                    <input
                      type="radio"
                      name="strategy"
                      value={s.value}
                      checked={strategy() === s.value}
                      onChange={() => setStrategy(s.value)}
                      class="mt-0.5"
                    />
                    <span>
                      <span class="font-medium" style={{ color: "var(--text-strong)" }}>{s.label}</span>
                      <br />
                      <span style={{ color: "var(--text-weak)" }}>{s.desc}</span>
                    </span>
                  </label>
                ))}
              </div>

              {/* Delete branch toggle */}
              <label class="flex items-center gap-2 text-xs cursor-pointer" style={{ color: "var(--text-base)" }}>
                <input
                  type="checkbox"
                  checked={deleteBranch()}
                  onChange={(e) => setDeleteBranch(e.currentTarget.checked)}
                />
                Delete remote branch after merge
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
                onClick={handleMerge}
                disabled={submitting() || hasConflicts()}
                class="px-4 py-2 text-xs font-medium rounded-md flex items-center gap-1.5"
                style={{
                  background: submitting() || hasConflicts() ? "var(--surface-inset)" : "var(--interactive-base)",
                  color: submitting() || hasConflicts() ? "var(--text-weak)" : "white",
                  cursor: submitting() || hasConflicts() ? "not-allowed" : "pointer",
                }}
              >
                <Show when={submitting()}>
                  <Spinner class="w-3 h-3" />
                </Show>
                {submitting() ? "Merging…" : "Merge"}
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  )
}
