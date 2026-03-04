import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  confirmDisabled?: boolean
  cancelDisabled?: boolean
  variant?: "danger" | "warning" | "default"
  error?: string | null
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog(props: Props) {
  const [container, setContainer] = createSignal<HTMLDivElement>()

  createEffect(() => {
    if (!props.open) return

    const el = container()
    if (!el) return

    // Focus first enabled button on open
    const firstEnabled = el.querySelector<HTMLButtonElement>("button:not([disabled])")
    firstEnabled?.focus()

    // Trap focus within enabled buttons only
    function handleTab(e: KeyboardEvent) {
      if (e.key !== "Tab") return

      const buttons = Array.from(
        el!.querySelectorAll<HTMLButtonElement>("button:not([disabled])")
      )
      if (!buttons.length) return // nothing to trap focus within
      const first = buttons[0]
      const last = buttons[buttons.length - 1]

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last?.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first?.focus()
      }
    }

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault()
        if (!props.cancelDisabled) props.onCancel()
      } else if (e.key === "Enter" && document.activeElement?.tagName === "BUTTON") {
        // Let the button handle its own click
      }
      handleTab(e)
    }

    document.addEventListener("keydown", handleKey)
    onCleanup(() => document.removeEventListener("keydown", handleKey))
  })

  const confirmStyle = () => {
    if (props.variant === "danger") {
      return {
        background: "var(--interactive-critical)",
        color: "white",
        border: "none",
      }
    }
    if (props.variant === "warning") {
      return {
        background: "var(--interactive-warning)",
        color: "white",
        border: "none",
      }
    }
    return {
      background: "var(--interactive-base)",
      color: "white",
      border: "none",
    }
  }

  return (
    <Show when={props.open}>
      <Portal>
        <div
          class="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !props.cancelDisabled) props.onCancel()
          }}
          role="presentation"
        >
          <div
            ref={setContainer}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-message"
            class="w-full max-w-sm rounded-lg shadow-xl overflow-hidden"
            style={{
              background: "var(--background-base)",
              border: "1px solid var(--border-base)",
            }}
          >
            <div class="p-4">
              <h2 id="confirm-title" class="text-base font-medium mb-2" style={{ color: "var(--text-strong)" }}>
                {props.title}
              </h2>
              <p id="confirm-message" class="text-sm" style={{ color: "var(--text-base)" }}>
                {props.message}
              </p>
            </div>

            <div class="px-4 py-3 flex flex-col gap-2" style={{ "border-top": "1px solid var(--border-base)" }}>
              <Show when={props.error}>
                <p class="text-xs" style={{ color: "var(--text-critical-base)" }}>{props.error}</p>
              </Show>
              <div class="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={props.onCancel}
                  disabled={props.cancelDisabled}
                  class="px-4 py-2 text-sm font-medium rounded-md transition-colors"
                  style={{
                    background: "var(--surface-inset)",
                    color: "var(--text-base)",
                    ...(props.cancelDisabled ? { opacity: "0.6", cursor: "not-allowed" } : {}),
                  }}
                >
                  {props.cancelLabel ?? "Cancel"}
                </button>
                <button
                  type="button"
                  onClick={props.onConfirm}
                  disabled={props.confirmDisabled}
                  class="px-4 py-2 text-sm font-medium rounded-md transition-colors"
                  style={{
                    ...confirmStyle(),
                    ...(props.confirmDisabled ? { opacity: "0.6", cursor: "not-allowed" } : {}),
                  }}
                >
                  {props.confirmLabel ?? "Confirm"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  )
}
