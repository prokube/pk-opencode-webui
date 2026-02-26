import { Component, For, Show } from "solid-js"
import { X, FileText } from "lucide-solid"

export interface FileContext {
  path: string
  key: string
}

interface Props {
  items: FileContext[]
  onRemove: (key: string) => void
}

export const ContextItems: Component<Props> = (props) => {
  const filename = (path: string) => {
    const parts = path.split("/")
    return parts[parts.length - 1]
  }

  const truncate = (path: string, max: number) => {
    const name = filename(path)
    if (name.length <= max) return name
    return name.slice(0, max - 2) + "..."
  }

  return (
    <Show when={props.items.length > 0}>
      <div class="flex flex-nowrap items-start gap-2 p-2 overflow-x-auto">
        <For each={props.items}>
          {(item) => (
            <div
              class="group shrink-0 flex items-center gap-1.5 rounded-md pl-2 pr-1 py-1 h-7 transition-all"
              style={{
                background: "var(--surface-inset)",
                border: "1px solid var(--border-base)",
              }}
              title={item.path}
            >
              <FileText class="w-3.5 h-3.5 shrink-0" style={{ color: "var(--icon-weak)" }} />
              <span class="text-xs font-medium whitespace-nowrap" style={{ color: "var(--text-strong)" }}>
                {truncate(item.path, 16)}
              </span>
              <button
                type="button"
                onClick={() => props.onRemove(item.key)}
                class="ml-0.5 p-0.5 rounded transition-colors opacity-60 hover:opacity-100"
                style={{ color: "var(--text-weak)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-interactive-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                aria-label={`Remove ${filename(item.path)}`}
              >
                <X class="w-3 h-3" />
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
