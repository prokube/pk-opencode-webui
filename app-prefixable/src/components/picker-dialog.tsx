import { createSignal, createEffect, createMemo, Show, onMount, onCleanup, For, Index } from "solid-js"
import { Portal } from "solid-js/web"
import { X, Search, ChevronDown, ChevronRight } from "lucide-solid"
import { createBackdropDismiss } from "../utils/backdrop"

interface PickerItem {
  id: string
  title: string
  description?: string
  group?: string
  groupKey?: string
}

interface Props {
  title: string
  items: PickerItem[]
  onSelect: (item: PickerItem) => void
  onClose: () => void
  emptyMessage?: string
  placeholder?: string
  initialFilter?: string
  collapsibleGroups?: boolean
}

export function PickerDialog(props: Props) {
  const [filter, setFilter] = createSignal(props.initialFilter ?? "")
  const [activeIndex, setActiveIndex] = createSignal(0)
  const [activeId, setActiveId] = createSignal<string>()
  const [collapsed, setCollapsed] = createSignal(new Set<string>())
  const [keyboardSection, setKeyboardSection] = createSignal<string>()
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined
  let closeButtonRef: HTMLButtonElement | undefined

  const query = createMemo(() => filter().trim().toLowerCase())

  const filtered = createMemo(() => {
    const q = query()
    if (!q) return props.items
    return props.items.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.description?.toLowerCase().includes(q) ||
        item.group?.toLowerCase().includes(q) ||
        item.groupKey?.toLowerCase().includes(q),
    )
  })

  const isGrouped = createMemo(() => props.items.some((item) => !!item.groupKey?.trim()))

  const sections = createMemo(() => {
    const map = new Map<string, { key: string; label?: string; rows: PickerItem[] }>()

    filtered().forEach((item) => {
      const key = item.groupKey?.trim() || item.id
      const section = map.get(key)
      if (section) {
        section.rows.push(item)
        return
      }

      map.set(key, {
        key,
        label: item.group?.trim() || undefined,
        rows: [item],
      })
    })

    return Array.from(map.values())
  })

  const sectionKeys = createMemo(() => new Set(props.items.map((item) => item.groupKey?.trim() || item.id)))

  const visibleSections = createMemo(() => {
    const canCollapse = !!props.collapsibleGroups && !query()
    let index = 0

    return sections().map((section) => {
      const isCollapsed = canCollapse && !!section.label && collapsed().has(section.key)
      const rows = isCollapsed
        ? []
        : section.rows.map((item) => ({ item, index: index++ }))

      return {
        key: section.key,
        label: section.label,
        rows,
        canCollapse: canCollapse && !!section.label,
        isCollapsed,
      }
    })
  })

  const visibleItems = createMemo(() => {
    if (!isGrouped()) return filtered()
    return visibleSections().flatMap((section) => section.rows.map((row) => row.item))
  })

  const activeDescendant = createMemo(() => {
    if (visibleItems().length === 0) return
    return `picker-option-${activeIndex()}`
  })

  const showCollapseHint = createMemo(() => visibleSections().some((section) => section.canCollapse))

  const keyboardSectionKey = createMemo(() => {
    if (!props.collapsibleGroups || query()) return

    const key = keyboardSection()
    if (key && visibleSections().some((section) => section.key === key && section.canCollapse)) return key

    const idx = activeIndex()
    const active = visibleSections().find((section) => section.rows.some((row) => row.index === idx))
    if (active?.canCollapse) return active.key

    return visibleSections().find((section) => section.canCollapse)?.key
  })

  const keyboardSectionCollapsed = createMemo(() => {
    const key = keyboardSectionKey()
    if (!key) return false
    return !!visibleSections().find((section) => section.key === key)?.isCollapsed
  })

  createEffect(() => {
    query()
    setActiveIndex(0)
    setActiveId()
  })

  createEffect(() => {
    const keys = sectionKeys()
    setCollapsed((prev) => new Set(Array.from(prev).filter((key) => keys.has(key))))
  })

  createEffect(() => {
    const key = keyboardSection()
    if (!key) return
    if (query()) {
      setKeyboardSection()
      return
    }
    if (visibleSections().some((section) => section.key === key && section.canCollapse)) return
    setKeyboardSection()
  })

  createEffect(() => {
    const count = visibleItems().length
    const idx = activeIndex()
    if (count === 0) {
      if (idx !== 0) setActiveIndex(0)
      return
    }
    if (idx >= count) setActiveIndex(count - 1)
  })

  createEffect(() => {
    if (activeId()) return
    const item = visibleItems()[activeIndex()] || visibleItems()[0]
    if (item) setActiveId(item.id)
  })

  createEffect(() => {
    const id = activeId()
    if (!id) return
    const idx = visibleItems().findIndex((item) => item.id === id)
    if (idx >= 0 && idx !== activeIndex()) setActiveIndex(idx)
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
      const items = visibleItems()
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        props.onClose()
      } else if (e.key === "ArrowLeft") {
        const key = keyboardSectionKey()
        if (!key || keyboardSectionCollapsed()) return
        e.preventDefault()
        setSectionCollapsed(key, true)
        setKeyboardSection(key)
      } else if (e.key === "ArrowRight") {
        const key = keyboardSectionKey()
        if (!key || !keyboardSectionCollapsed()) return
        e.preventDefault()
        setSectionCollapsed(key, false)
        setKeyboardSection()
        setSectionActiveIndex(key)
      } else if (e.key === "ArrowDown" && items.length > 0) {
        e.preventDefault()
        setKeyboardSection()
        setActive((activeIndex() + 1) % items.length)
      } else if (e.key === "ArrowUp" && items.length > 0) {
        e.preventDefault()
        setKeyboardSection()
        setActive((activeIndex() - 1 + items.length) % items.length)
      } else if (e.key === "Enter" && items.length > 0) {
        if (!isSelectableEnterTarget(e.target)) return
        const key = keyboardSectionKey()
        if (key && keyboardSectionCollapsed()) {
          e.preventDefault()
          setSectionCollapsed(key, false)
          setKeyboardSection()
          setSectionActiveIndex(key)
          return
        }
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

  function setSectionCollapsed(key: string, value: boolean) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (value) next.add(key)
      if (!value) next.delete(key)
      return next
    })
  }

  function toggleSection(key: string) {
    if (!props.collapsibleGroups || query()) return
    const item = visibleItems()[activeIndex()]
    if (item) setActiveId(item.id)
    const next = !collapsed().has(key)
    const activeKey = item?.groupKey?.trim() || item?.id
    if (next && activeKey === key) setKeyboardSection(key)
    if (!next && keyboardSection() === key) setKeyboardSection()
    setSectionCollapsed(key, next)
  }

  function setSectionActiveIndex(key: string) {
    const row = visibleSections().find((section) => section.key === key)?.rows[0]
    if (row) setActive(row.index)
  }

  function setActive(index: number) {
    const item = visibleItems()[index]
    if (item) setActiveId(item.id)
    setActiveIndex(index)
  }

  function isSelectableEnterTarget(target: EventTarget | null) {
    if (!(target instanceof Element)) return true
    if (target.closest('[role="option"]')) return true
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
  }

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
                aria-activedescendant={activeDescendant()}
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
              <Show when={showCollapseHint()}>
                <span class="mx-1.5">-</span>
                <span class="opacity-70">Left/right to collapse or expand groups</span>
              </Show>
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

            <Show
              when={isGrouped()}
              fallback={
                <Index each={filtered()}>
                  {(item, idx) => {
                    const isActive = () => idx === activeIndex()
                    return (
                      <button
                        type="button"
                        id={`picker-option-${idx}`}
                        role="option"
                        aria-selected={isActive()}
                        data-index={idx}
                        onClick={() => {
                          props.onSelect(item())
                          props.onClose()
                        }}
                        onMouseEnter={() => {
                          setKeyboardSection()
                          setActive(idx)
                        }}
                        class="w-full px-4 py-2.5 text-left flex flex-col gap-0.5 transition-colors"
                        style={{
                          background: isActive()
                            ? "color-mix(in srgb, var(--interactive-base) 15%, transparent)"
                            : "transparent",
                          "border-left": isActive() ? "3px solid var(--interactive-base)" : "3px solid transparent",
                        }}
                      >
                        <span class="font-medium text-sm" style={{ color: "var(--text-strong)" }}>
                          {item().title}
                        </span>
                        <Show when={item().description}>
                          <span class="text-xs" style={{ color: "var(--text-weak)" }}>
                            {item().description}
                          </span>
                        </Show>
                        <Show when={item().group}>
                          <span class="text-xs" style={{ color: "var(--text-weak)", opacity: 0.7 }}>
                            {item().group}
                          </span>
                        </Show>
                      </button>
                    )
                  }}
                </Index>
              }
            >
              <For each={visibleSections()}>
                {(section) => (
                  <div role={section.label ? "group" : "presentation"} aria-label={section.label || undefined}>
                    <Show when={section.label}>
                      <Show
                        when={section.canCollapse}
                        fallback={
                          <div
                            role="presentation"
                            aria-hidden="true"
                            class="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide"
                            style={{ color: "var(--text-weak)", opacity: 0.9 }}
                          >
                            {section.label}
                          </div>
                        }
                      >
                        <div
                          role="presentation"
                          class="w-full px-4 pt-3 pb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide transition-colors select-none cursor-pointer"
                          style={{ color: "var(--text-weak)", opacity: 0.9 }}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => toggleSection(section.key)}
                        >
                          <Show when={section.isCollapsed} fallback={<ChevronDown class="w-3 h-3 shrink-0" />}>
                            <ChevronRight class="w-3 h-3 shrink-0" />
                          </Show>
                          <span>{section.label}</span>
                          <span class="ml-auto text-[10px] tracking-normal normal-case opacity-70">
                            {section.isCollapsed ? "Collapsed" : "Expanded"}
                          </span>
                        </div>
                      </Show>
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
                            onMouseEnter={() => {
                              setKeyboardSection()
                              setActive(row().index)
                            }}
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
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  )
}
