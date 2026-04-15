import { createSignal, createEffect, createMemo, Show, onMount, onCleanup, For, Index } from "solid-js"
import { Portal } from "solid-js/web"
import { X, Search } from "lucide-solid"
import { createBackdropDismiss } from "../utils/backdrop"

interface PickerItem {
  id: string
  title: string
  description?: string
  group?: string
}

interface Props {
  title: string
  items: PickerItem[]
  onSelect: (item: PickerItem) => void
  onClose: () => void
  emptyMessage?: string
  placeholder?: string
  initialFilter?: string
}

export function PickerDialog(props: Props) {
  const [filter, setFilter] = createSignal(props.initialFilter ?? "")
  const [activeIndex, setActiveIndex] = createSignal(0)
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined
  let closeButtonRef: HTMLButtonElement | undefined

  const filtered = createMemo(() => {
    const q = filter().toLowerCase()
    if (!q) return props.items
    return props.items.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.description?.toLowerCase().includes(q) ||
        item.group?.toLowerCase().includes(q),
    )
  })

  const sections = createMemo(() => {
    const items = filtered()
    const rows = items.map((item, index) => ({ item, index }))
    const keys = rows.reduce((acc, row) => {
      const key = row.item.group?.trim() || ""
      if (acc.includes(key)) return acc
      return [...acc, key]
    }, [] as string[])

    return keys.map((key) => ({
      key,
      label: key || undefined,
      rows: rows.filter((row) => (row.item.group?.trim() || "") === key),
    }))
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
      } else if (e.key === "ArrowDown" && items.length > 0) {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % items.length)
      } else if (e.key === "ArrowUp" && items.length > 0) {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + items.length) % items.length)
      } else if (e.key === "Enter" && items.length > 0) {
        e.preventDefault()
        const item = items[activeIndex()]
        if (item) {
          props.onSelect(item)
          props.onClose()
        }
      } else if (e.key === "Tab") {
        e.preventDefault()
        if (document.activeElement === inputRef) {
          closeButtonRef?.focus()
        } else {
          inputRef?.focus()
        }
      }
    }
    window.addEventListener("keydown", handler, true)
    onCleanup(() => window.removeEventListener("keydown", handler, true))
  })

  const backdrop = createBackdropDismiss(() => props.onClose())

  return (
    <Portal>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center"
        style={{ background: "rgba(0,0,0,0.5)" }}
        onMouseDown={backdrop.onMouseDown}
        onClick={backdrop.onClick}
        role="presentation"
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="picker-title"
          class="w-full max-w-md rounded-lg shadow-xl overflow-hidden flex flex-col"
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
            <h2 id="picker-title" class="text-base font-medium" style={{ color: "var(--text-strong)" }}>
              {props.title}
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
                aria-controls="picker-listbox"
                aria-expanded="true"
                aria-activedescendant={`picker-option-${activeIndex()}`}
                placeholder={props.placeholder || "Filter..."}
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
            id="picker-listbox"
            role="listbox"
            aria-label={props.title}
            class="flex-1 overflow-y-auto min-h-0"
          >
            <Show when={filtered().length === 0}>
              <div class="px-4 py-8 text-center" style={{ color: "var(--text-weak)" }}>
                {props.emptyMessage || "No items found"}
              </div>
            </Show>

            <For each={sections()}>
              {(section) => (
                <>
                  <Show when={section.label}>
                    <div
                      class="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide"
                      style={{ color: "var(--text-weak)", opacity: 0.9 }}
                    >
                      {section.label}
                    </div>
                  </Show>

                  <Index each={section.rows}>
                    {(row) => {
                      const isActive = () => row().index === activeIndex()
                      return (
                        <button
                          type="button"
                          id={`picker-option-${row().index}`}
                          role="option"
                          aria-selected={isActive()}
                          data-index={row().index}
                          onClick={() => {
                            props.onSelect(row().item)
                            props.onClose()
                          }}
                          onMouseEnter={() => setActiveIndex(row().index)}
                          class="w-full px-4 py-2.5 text-left flex flex-col gap-0.5 transition-colors"
                          style={{
                            background: isActive()
                              ? "color-mix(in srgb, var(--interactive-base) 15%, transparent)"
                              : "transparent",
                            "border-left": isActive() ? "3px solid var(--interactive-base)" : "3px solid transparent",
                          }}
                        >
                          <span class="font-medium text-sm" style={{ color: "var(--text-strong)" }}>
                            {row().item.title}
                          </span>
                          <Show when={row().item.description}>
                            <span class="text-xs" style={{ color: "var(--text-weak)" }}>
                              {row().item.description}
                            </span>
                          </Show>
                        </button>
                      )
                    }}
                  </Index>
                </>
              )}
            </For>
          </div>
        </div>
      </div>
    </Portal>
  )
}
