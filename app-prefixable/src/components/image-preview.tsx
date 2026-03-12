import { Component, Show, createEffect, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { X } from "lucide-solid"

interface Props {
  url: string | null
  onClose: () => void
}

export const ImagePreview: Component<Props> = (props) => {
  let closeButtonRef: HTMLButtonElement | undefined

  // Close on Escape key and manage focus
  createEffect(() => {
    if (!props.url) return

    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        props.onClose()
      }
    }
    window.addEventListener("keydown", handler, true)
    onCleanup(() => window.removeEventListener("keydown", handler, true))

    // Focus the close button when modal opens
    closeButtonRef?.focus()
  })

  let mouseDownOnBackdrop = false

  return (
    <Show when={props.url}>
      {(url) => (
        <Portal>
          <div
            class="fixed inset-0 z-50 flex items-center justify-center"
            style={{ background: "rgba(0, 0, 0, 0.85)" }}
            onMouseDown={(e) => {
              mouseDownOnBackdrop = e.target === e.currentTarget
            }}
            onClick={(e) => {
              if (mouseDownOnBackdrop && e.target === e.currentTarget) props.onClose()
              mouseDownOnBackdrop = false
            }}
            role="presentation"
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Image preview"
              class="relative max-w-[90vw] max-h-[90vh]"
            >
              {/* Close button */}
              <button
                ref={closeButtonRef}
                onClick={props.onClose}
                class="absolute -top-12 right-0 p-2 rounded-full transition-colors bg-white/10 hover:bg-white/20 text-white"
                aria-label="Close preview"
              >
                <X class="w-6 h-6" />
              </button>

              {/* Image */}
              <img
                src={url()}
                alt="Full size preview"
                class="max-w-full max-h-[90vh] object-contain rounded"
                style={{ background: "var(--background-base)" }}
                onError={props.onClose}
              />
            </div>
          </div>
        </Portal>
      )}
    </Show>
  )
}
