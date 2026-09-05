import { For, Show } from "solid-js"
import type { FollowupItem } from "../utils/followups"

export function FollowupDock(props: {
  items: FollowupItem[]
  sending: boolean
  paused: boolean
  onResume: () => void
  onRetry: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}) {
  return (
    <Show when={props.items.length > 0}>
      <div class="px-4 pt-3" style={{ background: "var(--background-base)" }}>
        <div class="rounded-lg overflow-hidden" style={{ border: "1px solid var(--border-base)", background: "var(--surface-inset)" }}>
          <div class="px-3 py-2 text-xs font-medium flex items-center gap-2" style={{ color: "var(--text-base)", "border-bottom": "1px solid var(--border-base)" }}>
            <span class="flex-1">{props.items.length} queued follow-up{props.items.length === 1 ? "" : "s"}</span>
            <Show when={props.paused}><button onClick={props.onResume} style={{ color: "var(--text-interactive-base)" }}>Resume</button></Show>
          </div>
          <For each={props.items}>
            {(item, index) => (
              <div class="px-3 py-2 flex items-center gap-2 text-xs" style={{ "border-top": index() ? "1px solid var(--border-base)" : "none" }}>
                <span class="min-w-0 flex-1 truncate" style={{ color: item.failed ? "var(--text-critical-base)" : "var(--text-base)" }}>
                  {item.failed ? "Failed: " : ""}{item.text}
                </span>
                <Show when={item.failed}><button disabled={props.sending} onClick={() => props.onRetry(item.id)} style={{ color: "var(--text-interactive-base)" }}>Retry</button></Show>
                <button disabled={props.sending} onClick={() => props.onEdit(item.id)} style={{ color: "var(--text-weak)" }}>Edit</button>
                <button disabled={props.sending} onClick={() => props.onDelete(item.id)} style={{ color: "var(--text-critical-base)" }}>Delete</button>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}
