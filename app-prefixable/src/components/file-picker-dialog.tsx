import { createSignal, createEffect, createMemo, Show, onMount, onCleanup, Index } from "solid-js"
import { Portal } from "solid-js/web"
import { X, Search, FileText } from "lucide-solid"
import { useSDK } from "../context/sdk"

interface Props {
  onSelect: (path: string) => void
  onClose: () => void
  placeholder?: string
  title?: string
}

export function FilePickerDialog(props: Props) {
  const { client } = useSDK()
  const [filter, setFilter] = createSignal("")
  const [files, setFiles] = createSignal<string[]>([])
  const [loading, setLoading] = createSignal(false)
  const [activeIndex, setActiveIndex] = createSignal(0)
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined
  let closeButtonRef: HTMLButtonElement | undefined

  const filtered = createMemo(() => {
    const q = filter().toLowerCase()
    if (!q) return files().slice(0, 50)
    return files()
      .filter((path) => path.toLowerCase().includes(q))
      .slice(0, 50)
  })

  const search = async (query: string) => {
    setLoading(true)
    try {
      const res = await client.find.files({ query, dirs: "false" })
      setFiles(res.data ?? [])
    } catch {
      setFiles([])
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    const q = filter()
    search(q)
  })

  createEffect(() => {
    filter()
    setActiveIndex(0)
  })

  createEffect(() => {
    const idx = activeIndex()
    if (!listRef) return
    const el = listRef.querySelector(`[data-index="${idx}"]`)
    if (el) el.scrollIntoView({ block: "nearest" })
  })

  onMount(() => {
    inputRef?.focus()

    const handler = (e: KeyboardEvent) => {
      const items = filtered()
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        props.onClose()
      }
      if (e.key === "ArrowDown" && items.length > 0) {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % items.length)
      }
      if (e.key === "ArrowUp" && items.length > 0) {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + items.length) % items.length)
      }
      if (e.key === "Enter" && items.length > 0) {
        e.preventDefault()
        const item = items[activeIndex()]
        if (item) {
          props.onSelect(item)
          props.onClose()
        }
      }
      if (e.key === "Tab") {
        e.preventDefault()
        if (document.activeElement === inputRef) {
          closeButtonRef?.focus()
          return
        }
        inputRef?.focus()
      }
    }
    window.addEventListener("keydown", handler, true)
    onCleanup(() => window.removeEventListener("keydown", handler, true))
  })

  const filename = (path: string) => {
    const parts = path.split("/")
    return parts[parts.length - 1]
  }

  const directory = (path: string) => {
    const parts = path.split("/")
    if (parts.length <= 1) return ""
    return parts.slice(0, -1).join("/") + "/"
  }

  let mouseDownOnBackdrop = false

  return (
    <Portal>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center"
        style={{ background: "rgba(0,0,0,0.5)" }}
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
          aria-labelledby="file-picker-title"
          class="w-full max-w-lg rounded-lg shadow-xl overflow-hidden flex flex-col"
          style={{
            background: "var(--background-base)",
            border: "1px solid var(--border-base)",
            height: "min(500px, 80vh)",
          }}
        >
          {/* Header */}
          <div
            class="px-4 py-3 flex items-center justify-between shrink-0"
            style={{ "border-bottom": "1px solid var(--border-base)" }}
          >
            <h2 id="file-picker-title" class="text-base font-medium" style={{ color: "var(--text-strong)" }}>
              {props.title ?? "Attach File"}
            </h2>
            <button
              ref={closeButtonRef}
              onClick={props.onClose}
              class="p-1 rounded transition-colors"
              style={{ color: "var(--icon-weak)" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-inset)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              aria-label="Close"
            >
              <X class="w-5 h-5" />
            </button>
          </div>

          {/* Search */}
          <div class="px-4 py-2 shrink-0" style={{ "border-bottom": "1px solid var(--border-base)" }}>
            <div
              class="flex items-center gap-2 px-3 py-2 rounded-lg"
              style={{
                background: "var(--surface-inset)",
                border: "1px solid var(--border-base)",
              }}
            >
              <Search class="w-4 h-4" style={{ color: "var(--icon-weak)" }} />
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-controls="file-picker-listbox"
                aria-expanded="true"
                aria-activedescendant={`file-picker-option-${activeIndex()}`}
                placeholder={props.placeholder ?? "Search files..."}
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
                class="flex-1 bg-transparent border-none outline-none text-sm"
                style={{ color: "var(--text-base)" }}
                spellcheck={false}
                autocomplete="off"
              />
            </div>
            <div class="mt-1.5 text-[10px]" style={{ color: "var(--text-weak)" }}>
              <span class="opacity-70">Arrow keys to navigate</span>
              <span class="mx-1.5">-</span>
              <span class="opacity-70">Enter to select</span>
              <span class="mx-1.5">-</span>
              <span class="opacity-70">Esc to close</span>
            </div>
          </div>

          {/* List */}
          <div
            ref={listRef}
            id="file-picker-listbox"
            role="listbox"
            aria-label="Files"
            class="flex-1 overflow-y-auto min-h-0"
          >
            <Show when={loading()}>
              <div class="px-4 py-8 text-center" style={{ color: "var(--text-weak)" }}>
                Loading...
              </div>
            </Show>

            <Show when={!loading() && filtered().length === 0}>
              <div class="px-4 py-8 text-center" style={{ color: "var(--text-weak)" }}>
                No files found
              </div>
            </Show>

            <Index each={filtered()}>
              {(path, idx) => {
                const isActive = () => idx === activeIndex()
                return (
                  <button
                    type="button"
                    id={`file-picker-option-${idx}`}
                    role="option"
                    aria-selected={isActive()}
                    data-index={idx}
                    onClick={() => {
                      props.onSelect(path())
                      props.onClose()
                    }}
                    onMouseEnter={() => setActiveIndex(idx)}
                    class="w-full px-4 py-2.5 text-left flex items-center gap-3 transition-colors"
                    style={{
                      background: isActive()
                        ? "color-mix(in srgb, var(--interactive-base) 15%, transparent)"
                        : "transparent",
                      "border-left": isActive() ? "3px solid var(--interactive-base)" : "3px solid transparent",
                    }}
                  >
                    <FileText class="w-4 h-4 shrink-0" style={{ color: "var(--icon-weak)" }} />
                    <div class="flex items-center text-sm min-w-0">
                      <span class="truncate" style={{ color: "var(--text-weak)" }}>
                        {directory(path())}
                      </span>
                      <span class="shrink-0 font-medium" style={{ color: "var(--text-strong)" }}>
                        {filename(path())}
                      </span>
                    </div>
                  </button>
                )
              }}
            </Index>
          </div>
        </div>
      </div>
    </Portal>
  )
}
