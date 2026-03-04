/**
 * PR button shown in the session header.
 *
 * States:
 *  - No PR: shows "Create PR" button
 *  - PR open/draft: shows PR number pill with dropdown (merge, mark ready, address comments, open in browser)
 *  - PR merged/closed: shows status pill, no actions
 */

import { createSignal, Show, onCleanup } from "solid-js"
import { GitPullRequest, GitMerge, ChevronDown, ExternalLink, MessageSquare, GitBranchPlus, CheckCircle2, XCircle } from "lucide-solid"
import { useBasePath } from "../context/base-path"
import { useSDK } from "../context/sdk"
import { usePr } from "../context/pr"
import { PrCreateDialog } from "./pr-create-dialog"
import { PrMergeDialog } from "./pr-merge-dialog"
import { PrCommentsDialog } from "./pr-comments-dialog"
import type { PrInfo } from "../context/pr"

interface Props {
  /** Called with a pre-filled prompt to send to the agent */
  onSendPrompt: (prompt: string) => void
}

export function PrButton(props: Props) {
  const { prefix } = useBasePath()
  const { directory } = useSDK()
  const pr = usePr()

  const [showCreate, setShowCreate] = createSignal(false)
  const [showMerge, setShowMerge] = createSignal(false)
  const [showComments, setShowComments] = createSignal(false)
  const [dropdownOpen, setDropdownOpen] = createSignal(false)

  let dropdownRef: HTMLDivElement | undefined

  function closeDropdown(e: MouseEvent) {
    if (dropdownRef && !dropdownRef.contains(e.target as Node)) {
      setDropdownOpen(false)
    }
  }

  // Close dropdown when clicking outside
  document.addEventListener("mousedown", closeDropdown)
  onCleanup(() => document.removeEventListener("mousedown", closeDropdown))

  const info = () => pr.info()
  const prData = () => info()?.pr as PrInfo | null | undefined

  function prColor() {
    const p = prData()
    if (!p) return "var(--text-weak)"
    if (p.state === "MERGED") return "#8957e5"
    if (p.state === "CLOSED") return "var(--icon-critical-base)"
    if (p.isDraft) return "var(--text-weak)"
    return "var(--icon-success-base)"
  }

  function prIcon() {
    const p = prData()
    if (!p) return null
    if (p.state === "MERGED") return <GitMerge class="w-3.5 h-3.5" />
    if (p.state === "CLOSED") return <XCircle class="w-3.5 h-3.5" />
    return <GitPullRequest class="w-3.5 h-3.5" />
  }

  function prLabel() {
    const p = prData()
    if (!p) return null
    if (p.state === "MERGED") return "Merged"
    if (p.state === "CLOSED") return "Closed"
    if (p.isDraft) return `Draft #${p.number}`
    return `#${p.number}`
  }

  const canAct = () => {
    const p = prData()
    return p && p.state === "OPEN"
  }

  const hasUnresolvedComments = () => (prData()?.unresolvedReviewThreadCount ?? 0) > 0

  return (
    <>
      {/* No PR — show create button */}
      <Show when={info() && !prData()}>
        <button
          onClick={() => setShowCreate(true)}
          class="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors"
          style={{ border: "1px solid var(--border-base)", color: "var(--text-base)" }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "var(--surface-inset)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
          title="Create pull request"
        >
          <GitBranchPlus class="w-3.5 h-3.5" />
          <span>Create PR</span>
        </button>
      </Show>

      {/* PR exists — show pill + optional dropdown */}
      <Show when={prData()}>
        <div class="relative flex items-center" ref={dropdownRef}>
          {/* PR pill */}
          <button
            onClick={() => canAct() ? setDropdownOpen(!dropdownOpen()) : window.open(prData()!.url, "_blank")}
            class="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors relative"
            style={{ border: "1px solid var(--border-base)", color: prColor() }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "var(--surface-inset)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
            title={prData()!.title}
          >
            {prIcon()}
            <span>{prLabel()}</span>

            {/* Unresolved comments badge */}
            <Show when={hasUnresolvedComments() && !dropdownOpen()}>
              <span
                class="absolute -top-1 -right-1 w-2 h-2 rounded-full"
                style={{ background: "var(--interactive-base)" }}
                title={`${prData()!.unresolvedReviewThreadCount} unresolved comments`}
              />
            </Show>

            <Show when={canAct()}>
              <ChevronDown class="w-3 h-3 ml-0.5" />
            </Show>
          </button>

          {/* Dropdown menu */}
          <Show when={dropdownOpen() && canAct()}>
            <div
              class="absolute top-full right-0 mt-1 w-52 rounded-md shadow-lg z-50 overflow-hidden"
              style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}
            >
              {/* Open in GitHub */}
              <DropdownItem
                icon={<ExternalLink class="w-3.5 h-3.5" />}
                label="Open in GitHub"
                onClick={() => { window.open(prData()!.url, "_blank"); setDropdownOpen(false) }}
              />

              {/* Address comments */}
              <Show when={hasUnresolvedComments()}>
                <DropdownItem
                  icon={<MessageSquare class="w-3.5 h-3.5" />}
                  label={`Address comments (${prData()!.unresolvedReviewThreadCount})`}
                  onClick={() => { setShowComments(true); setDropdownOpen(false) }}
                  highlight
                />
              </Show>

              {/* Mark as ready */}
              <Show when={prData()!.isDraft}>
                <DropdownItem
                  icon={<CheckCircle2 class="w-3.5 h-3.5" />}
                  label="Mark as ready"
                  onClick={async () => {
                    setDropdownOpen(false)
                    // Handled inline via fetch — simple enough not to need a dialog
                    try {
                      await fetch(prefix("/api/ext/pr/ready"), {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ directory }),
                      })
                      await pr.refresh()
                    } catch (e) { console.error(e) }
                  }}
                />
              </Show>

              {/* Merge */}
              <Show when={!prData()!.isDraft}>
                <DropdownItem
                  icon={<GitMerge class="w-3.5 h-3.5" />}
                  label="Merge pull request"
                  onClick={() => { setShowMerge(true); setDropdownOpen(false) }}
                />
              </Show>
            </div>
          </Show>
        </div>
      </Show>

      {/* Dialogs */}
      <Show when={info()}>
        <PrCreateDialog
          open={showCreate()}
          branch={info()!.branch ?? ""}
          dirty={info()!.dirty}
          onClose={() => setShowCreate(false)}
        />
      </Show>

      <Show when={prData() && showMerge()}>
        <PrMergeDialog
          open={showMerge()}
          pr={prData()!}
          onClose={() => setShowMerge(false)}
          onAskAgentToFix={props.onSendPrompt}
        />
      </Show>

      <Show when={prData() && showComments()}>
        <PrCommentsDialog
          open={showComments()}
          pr={prData()!}
          onClose={() => setShowComments(false)}
          onAskAgent={props.onSendPrompt}
        />
      </Show>
    </>
  )
}

function DropdownItem(props: {
  icon: unknown
  label: string
  onClick: () => void
  highlight?: boolean
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left transition-colors"
      style={{ color: props.highlight ? "var(--text-interactive-base)" : "var(--text-base)" }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "var(--surface-inset)")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
    >
      {props.icon as Element}
      {props.label}
    </button>
  )
}
