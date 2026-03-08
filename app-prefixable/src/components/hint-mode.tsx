import { createSignal, createEffect, onCleanup, Show, For } from "solid-js"
import { Portal } from "solid-js/web"
import { useCommand, isDialogOpen } from "../context/command"

// Home row keys preferred for ergonomic single-key hints
const HINT_CHARS = "asdfghjklqwertyuiopzxcvbnm"

interface Hint {
  label: string
  rect: DOMRect
  element: HTMLElement
}

// Generate hint labels: single letters for <= 26 elements, two-letter combos for more
function generateLabels(count: number): string[] {
  if (count <= HINT_CHARS.length) {
    return HINT_CHARS.slice(0, count).split("")
  }
  // Two-letter combos from home row prefix keys
  const prefix = "asdfghjkl"
  const labels: string[] = []
  for (const p of prefix) {
    for (const c of HINT_CHARS) {
      labels.push(p + c)
      if (labels.length >= count) return labels
    }
  }
  return labels
}

function isElementVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect()
  // Skip hidden/offscreen elements
  if (rect.width === 0 || rect.height === 0) return false
  if (rect.bottom < 0 || rect.top > window.innerHeight) return false
  if (rect.right < 0 || rect.left > window.innerWidth) return false
  // Check if element is actually visible (not behind overflow:hidden parent)
  const style = getComputedStyle(el)
  if (style.visibility === "hidden" || style.display === "none") return false
  // Check if the element's center point is reachable (not clipped by an ancestor)
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const topEl = document.elementFromPoint(cx, cy)
  if (topEl && !el.contains(topEl) && !topEl.contains(el)) return false
  return true
}

function discoverTargets(): HTMLElement[] {
  // First collect explicitly marked hint targets
  const explicit = document.querySelectorAll("[data-hint-target]")
  const visible: HTMLElement[] = []
  const seen = new Set<HTMLElement>()
  for (const el of explicit) {
    if (!(el instanceof HTMLElement)) continue
    if (!isElementVisible(el)) continue
    visible.push(el)
    seen.add(el)
  }
  // Also discover interactive elements (buttons, links) that aren't explicitly marked
  const interactive = document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
  for (const el of interactive) {
    if (!(el instanceof HTMLElement)) continue
    if (seen.has(el)) continue
    // Skip elements inside hint-mode overlay itself
    if (el.closest("[data-hint-overlay]")) continue
    if (!isElementVisible(el)) continue
    visible.push(el)
    seen.add(el)
  }
  return visible
}

function buildHints(targets: HTMLElement[]): Hint[] {
  const labels = generateLabels(targets.length)
  // Cap to the number of labels generated (avoids undefined labels for >234 targets)
  const capped = targets.slice(0, labels.length)
  return capped.map((element, i) => ({
    label: labels[i],
    rect: element.getBoundingClientRect(),
    element,
  }))
}

export function HintMode() {
  const command = useCommand()
  const [active, setActive] = createSignal(false)
  const [hints, setHints] = createSignal<Hint[]>([])
  const [typed, setTyped] = createSignal("")
  const [multiChar, setMultiChar] = createSignal(false)

  // Auto-exit timeout handle
  const timeout = { id: undefined as ReturnType<typeof setTimeout> | undefined }

  function enter() {
    if (isDialogOpen()) return
    if (command.paletteOpen()) return
    if (command.shortcutRefOpen()) return
    const targets = discoverTargets()
    if (!targets.length) return
    const built = buildHints(targets)
    setHints(built)
    setMultiChar(built[0]?.label.length > 1)
    setTyped("")
    setActive(true)
    // Auto-exit after 5 seconds
    timeout.id = setTimeout(exit, 5000)
  }

  function exit() {
    setActive(false)
    setHints([])
    setTyped("")
    if (timeout.id !== undefined) {
      clearTimeout(timeout.id)
      timeout.id = undefined
    }
  }

  function activate(hint: Hint) {
    exit()
    // Click the element (works for buttons, links, etc.)
    hint.element.click()
  }

  // Register the hint-mode trigger command
  command.register([
    {
      id: "hints.toggle",
      title: "Hint Mode",
      description: "Show letter hints to navigate by keyboard",
      keybind: "mod+shift+h",
      global: true,
      onSelect: () => {
        if (active()) {
          exit()
          return
        }
        enter()
      },
    },
  ])

  onCleanup(() => command.unregister(["hints.toggle"]))

  // Keyboard handler while hint mode is active
  createEffect(() => {
    if (!active()) return
    function handleKeyDown(e: KeyboardEvent) {
      if (!active()) return

      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        exit()
        return
      }

      // Only accept lowercase letter keys
      if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (!HINT_CHARS.includes(key)) return

      e.preventDefault()
      e.stopPropagation()

      const next = typed() + key
      setTyped(next)

      // Find exact match
      const match = hints().find((h) => h.label === next)
      if (match) {
        activate(match)
        return
      }

      // For multi-char mode, check if any hints still start with the typed prefix
      if (multiChar()) {
        const remaining = hints().filter((h) => h.label.startsWith(next))
        if (!remaining.length) {
          // No matches — exit
          exit()
          return
        }
        // Keep filtering — user needs to type more
        return
      }

      // Single-char mode: no match found — exit
      exit()
    }

    // Use capture so we intercept before other handlers
    document.addEventListener("keydown", handleKeyDown, true)
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown, true))
  })

  // Clean up timeout on unmount
  onCleanup(() => {
    if (timeout.id !== undefined) clearTimeout(timeout.id)
  })

  // Compute which hints are still matching the typed prefix
  function visibleHints() {
    const prefix = typed()
    if (!prefix) return hints()
    return hints().filter((h) => h.label.startsWith(prefix))
  }

  return (
    <Show when={active()}>
      <Portal>
        {/* Transparent backdrop to catch clicks and exit */}
        <div
          data-hint-overlay
          class="fixed inset-0 z-[100]"
          onClick={(e) => {
            e.preventDefault()
            exit()
          }}
          style={{ background: "rgba(0,0,0,0.08)" }}
        />
        {/* Hint labels */}
        <For each={visibleHints()}>
          {(hint) => {
            const prefix = typed()
            const remaining = hint.label.slice(prefix.length)
            return (
              <div
                class="fixed z-[101] pointer-events-none flex items-center justify-center"
                style={{
                  // Position to the left of the element when there's room, otherwise overlay the top-left corner
                  top: `${hint.rect.top + hint.rect.height / 2 - 10}px`,
                  left: hint.rect.left >= 28
                    ? `${hint.rect.left - 4}px`
                    : `${hint.rect.left + 2}px`,
                  transform: hint.rect.left >= 28 ? "translate(-100%, 0)" : "none",
                  animation: "hint-fade-in 100ms ease-out",
                }}
              >
                <span
                  class="inline-flex items-center px-1 py-0.5 text-[11px] font-bold font-mono uppercase rounded shadow-sm"
                  style={{
                    background: "var(--interactive-base)",
                    color: "#fff",
                    "min-width": "16px",
                    "text-align": "center",
                    "line-height": "1",
                    "letter-spacing": "0.05em",
                    "box-shadow": "0 1px 3px rgba(0,0,0,0.3)",
                  }}
                >
                  <Show when={prefix}>
                    <span style={{ opacity: "0.4" }}>{prefix}</span>
                  </Show>
                  {remaining}
                </span>
              </div>
            )
          }}
        </For>
        {/* Inject keyframe animation */}
        <style>{`
          @keyframes hint-fade-in {
            from { opacity: 0; scale: 0.8; }
            to { opacity: 1; scale: 1; }
          }
        `}</style>
      </Portal>
    </Show>
  )
}
