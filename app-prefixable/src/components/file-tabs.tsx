import { For, Show, createMemo } from "solid-js"
import type { FileDiff } from "../sdk/client"
import { File, FilePlus, FileMinus, FileText } from "lucide-solid"

interface FileTabsProps {
  diffs: FileDiff[]
  selected: string | null
  onSelect: (file: string) => void
}

export function FileTabs(props: FileTabsProps) {
  const sorted = createMemo(() => {
    return [...props.diffs].sort((a, b) => a.file.localeCompare(b.file))
  })

  const statusIcon = (status?: FileDiff["status"]) => {
    switch (status) {
      case "added":
        return <FilePlus class="w-3.5 h-3.5 shrink-0" style={{ color: "var(--icon-success-base)" }} />
      case "deleted":
        return <FileMinus class="w-3.5 h-3.5 shrink-0" style={{ color: "var(--icon-critical-base)" }} />
      case "modified":
        return <FileText class="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-interactive-base)" }} />
      default:
        return <File class="w-3.5 h-3.5 shrink-0" style={{ color: "var(--icon-weak)" }} />
    }
  }

  const filename = (path: string) => {
    const parts = path.split("/")
    return parts[parts.length - 1]
  }

  const dirname = (path: string) => {
    const parts = path.split("/")
    if (parts.length <= 1) return ""
    return parts.slice(0, -1).join("/")
  }

  return (
    <div class="flex flex-col gap-0.5 p-2">
      <Show
        when={sorted().length > 0}
        fallback={
          <div class="px-3 py-4 text-center text-xs" style={{ color: "var(--text-weak)" }}>
            No changes
          </div>
        }
      >
        <For each={sorted()}>
          {(diff) => {
            const isSelected = () => props.selected === diff.file
            return (
              <button
                type="button"
                onClick={() => props.onSelect(diff.file)}
                class="flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors w-full"
                style={{
                  background: isSelected() ? "var(--surface-inset)" : "transparent",
                  border: isSelected() ? "1px solid var(--border-base)" : "1px solid transparent",
                }}
                onMouseEnter={(e) => {
                  if (!isSelected()) e.currentTarget.style.background = "var(--surface-interactive-hover)"
                }}
                onMouseLeave={(e) => {
                  if (!isSelected()) e.currentTarget.style.background = "transparent"
                }}
              >
                {statusIcon(diff.status)}
                <div class="flex-1 min-w-0">
                  <div class="text-xs truncate" style={{ color: "var(--text-strong)" }}>
                    {filename(diff.file)}
                  </div>
                  <Show when={dirname(diff.file)}>
                    <div class="text-[10px] truncate" style={{ color: "var(--text-weak)", opacity: 0.7 }}>
                      {dirname(diff.file)}
                    </div>
                  </Show>
                </div>
                <div class="flex items-center gap-1 shrink-0 text-[10px]">
                  <Show when={diff.additions > 0}>
                    <span style={{ color: "var(--icon-success-base)" }}>+{diff.additions}</span>
                  </Show>
                  <Show when={diff.deletions > 0}>
                    <span style={{ color: "var(--icon-critical-base)" }}>-{diff.deletions}</span>
                  </Show>
                </div>
              </button>
            )
          }}
        </For>
      </Show>
    </div>
  )
}
