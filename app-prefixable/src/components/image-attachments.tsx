import { Component, For, Show } from "solid-js"
import { X, FileText } from "lucide-solid"

export interface ImageAttachment {
  id: string
  name: string
  mime: string
  dataUrl: string
}

interface Props {
  attachments: ImageAttachment[]
  onRemove: (id: string) => void
}

export const ImageAttachments: Component<Props> = (props) => {
  const isImage = (mime: string) => mime.startsWith("image/")

  return (
    <Show when={props.attachments.length > 0}>
      <div class="flex flex-nowrap items-start gap-2 p-2 overflow-x-auto">
        <For each={props.attachments}>
          {(attachment) => (
            <div
              class="group relative shrink-0 rounded-md overflow-hidden transition-all"
              style={{
                background: "var(--surface-inset)",
                border: "1px solid var(--border-base)",
              }}
              title={attachment.name}
            >
              {/* Thumbnail or icon */}
              <Show
                when={isImage(attachment.mime)}
                fallback={
                  <div class="w-16 h-16 flex items-center justify-center">
                    <FileText class="w-6 h-6" style={{ color: "var(--icon-weak)" }} />
                  </div>
                }
              >
                <img src={attachment.dataUrl} alt={attachment.name} class="w-16 h-16 object-cover" />
              </Show>

              {/* Remove button overlay */}
              <button
                type="button"
                onClick={() => props.onRemove(attachment.id)}
                class="absolute top-0.5 right-0.5 p-0.5 rounded-full transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                style={{
                  background: "rgba(0, 0, 0, 0.6)",
                  color: "white",
                }}
                aria-label={`Remove ${attachment.name}`}
              >
                <X class="w-3 h-3" />
              </button>

              {/* File name */}
              <div
                class="absolute bottom-0 left-0 right-0 px-1 py-0.5 text-[9px] truncate"
                style={{
                  background: "rgba(0, 0, 0, 0.5)",
                  color: "white",
                }}
              >
                {attachment.name}
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
