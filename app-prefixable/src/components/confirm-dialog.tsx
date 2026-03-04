import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  confirmDisabled?: boolean
  variant?: "danger" | "warning" | "default"
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog(props: Props) {
  const [container, setContainer] = createSignal<HTMLDivElement>()

  createEffect(() => {
    if (!props.open) return

    const el = container()
    if (!el) return

    // Focus first button on open
    const button = el.querySelector("button")
    button?.focus()

    // Trap focus
    function handleTab(e: KeyboardEvent) {
      if (e.key !== "Tab") return

      const buttons = el!.querySelectorAll("button")
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
        props.onCancel()
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
            if (e.target === e.currentTarget) props.onCancel()
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

            <div class="px-4 py-3 flex justify-end gap-2" style={{ "border-top": "1px solid var(--border-base)" }}>
              <button
                type="button"
                onClick={props.onCancel}
                class="px-4 py-2 text-sm font-medium rounded-md transition-colors"
                style={{
                  background: "var(--surface-inset)",
                  color: "var(--text-base)",
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
      </Portal>
    </Show>
  )
}
