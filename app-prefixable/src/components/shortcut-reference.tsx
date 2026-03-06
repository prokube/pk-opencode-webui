import { Show, For, onMount, onCleanup } from "solid-js"
import { useCommand, formatKeybind } from "../context/command"
import { X } from "lucide-solid"

export function ShortcutReference() {
  const cmd = useCommand()
  let ref: HTMLDivElement | undefined

  function close() {
    cmd.setShortcutRefOpen(false)
  }

  // Close on Escape
  onMount(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault()
        close()
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown))
  })

  return (
    <Show when={cmd.shortcutRefOpen()}>
      {/* Backdrop */}
      <div
        class="fixed inset-0 z-50 flex items-center justify-center"
        style={{ background: "rgba(0,0,0,0.5)" }}
        onClick={(e) => {
          if (e.target === e.currentTarget) close()
        }}
      >
        {/* Dialog */}
        <div
          ref={ref}
          class="w-full max-w-md mx-4 rounded-lg shadow-xl overflow-hidden"
          style={{
            background: "var(--background-base)",
            border: "1px solid var(--border-base)",
          }}
        >
          {/* Header */}
          <div
            class="flex items-center justify-between px-5 py-3"
            style={{ "border-bottom": "1px solid var(--border-base)" }}
          >
            <h2
              class="text-sm font-semibold"
              style={{ color: "var(--text-strong)" }}
            >
              Keyboard Shortcuts
            </h2>
            <button
              onClick={close}
              class="p-1 rounded transition-colors"
              style={{ color: "var(--icon-base)" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-inset)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <X class="w-4 h-4" />
            </button>
          </div>

          {/* Shortcut list */}
          <div class="px-5 py-3 max-h-80 overflow-y-auto">
            <For each={cmd.getKeyboardShortcuts()}>
              {(command) => (
                <div
                  class="flex items-center justify-between py-2"
                  style={{ "border-bottom": "1px solid var(--border-base)" }}
                >
                  <div class="flex flex-col gap-0.5">
                    <span
                      class="text-sm"
                      style={{ color: "var(--text-base)" }}
                    >
                      {command.title}
                    </span>
                    <Show when={command.description}>
                      <span
                        class="text-xs"
                        style={{ color: "var(--text-weak)" }}
                      >
                        {command.description}
                      </span>
                    </Show>
                  </div>
                  <kbd
                    class="ml-4 shrink-0 inline-flex items-center gap-0.5 px-2 py-1 text-xs font-mono rounded"
                    style={{
                      background: "var(--surface-inset)",
                      color: "var(--text-strong)",
                      border: "1px solid var(--border-base)",
                    }}
                  >
                    {formatKeybind(command.keybind!)}
                  </kbd>
                </div>
              )}
            </For>

            {/* Always show the meta shortcut for this dialog */}
            <div
              class="flex items-center justify-between py-2"
              style={{ "border-bottom": "1px solid var(--border-base)" }}
            >
              <div class="flex flex-col gap-0.5">
                <span
                  class="text-sm"
                  style={{ color: "var(--text-base)" }}
                >
                  Show keyboard shortcuts
                </span>
              </div>
              <div class="ml-4 shrink-0 flex items-center gap-1.5">
                <kbd
                  class="inline-flex items-center px-2 py-1 text-xs font-mono rounded"
                  style={{
                    background: "var(--surface-inset)",
                    color: "var(--text-strong)",
                    border: "1px solid var(--border-base)",
                  }}
                >
                  ?
                </kbd>
                <span
                  class="text-xs"
                  style={{ color: "var(--text-weak)" }}
                >
                  or
                </span>
                <kbd
                  class="inline-flex items-center px-2 py-1 text-xs font-mono rounded"
                  style={{
                    background: "var(--surface-inset)",
                    color: "var(--text-strong)",
                    border: "1px solid var(--border-base)",
                  }}
                >
                  {formatKeybind("mod+/")}
                </kbd>
              </div>
            </div>
          </div>

          {/* Footer hint */}
          <div
            class="px-5 py-2 text-xs"
            style={{
              color: "var(--text-weak)",
              "border-top": "1px solid var(--border-base)",
            }}
          >
            Shortcuts are suppressed when a text input or terminal is focused.
          </div>
        </div>
      </div>
    </Show>
  )
}
