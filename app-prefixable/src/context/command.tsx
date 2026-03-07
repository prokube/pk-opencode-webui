import { createContext, useContext, createSignal, createEffect, onCleanup, type ParentProps } from "solid-js"
import { tinykeys } from "tinykeys"

export interface Command {
  id: string
  title: string
  description?: string
  slash?: string
  keybind?: string
  /** When true, the shortcut fires even from inputs, textareas, and terminals */
  global?: boolean
  /** When true, preventDefault is NOT called automatically — the handler receives the event */
  passive?: boolean
  /** When true, the command is hidden from the shortcut reference and command palette */
  hidden?: boolean
  onSelect: (e?: KeyboardEvent) => void
}

interface CommandContextValue {
  commands: Command[]
  register: (commands: Command[]) => void
  unregister: (ids: string[]) => void
  trigger: (id: string) => void
  getSlashCommands: () => Command[]
  filterSlashCommands: (query: string) => Command[]
  getKeyboardShortcuts: () => Command[]
  shortcutRefOpen: () => boolean
  setShortcutRefOpen: (open: boolean) => void
  paletteOpen: () => boolean
  setPaletteOpen: (open: boolean) => void
  /** Initial filter to apply when the palette opens (e.g. "#" for projects) */
  paletteFilter: () => string
  setPaletteFilter: (filter: string) => void
}

const CommandContext = createContext<CommandContextValue>()

// Convert our keybind format to tinykeys format
// Our format: "mod+shift+r" -> tinykeys: "$mod+Shift+r"
// Our format: "ctrl+`" -> tinykeys: "Control+`"
// Our format: "?" -> tinykeys: "?"
function toTinykeysBinding(keybind: string): string {
  return keybind
    .split("+")
    .map((part) => {
      const lower = part.toLowerCase()
      if (lower === "mod") return "$mod"
      if (lower === "shift") return "Shift"
      if (lower === "alt") return "Alt"
      if (lower === "ctrl") return "Control"
      return part
    })
    .join("+")
}

// Format a keybind string for display in the cheat sheet
export function formatKeybind(keybind: string): string {
  const isMac = typeof navigator !== "undefined" && navigator.platform.includes("Mac")
  return keybind
    .split("+")
    .map((part) => {
      const lower = part.toLowerCase()
      if (lower === "mod") return isMac ? "⌘" : "Ctrl"
      if (lower === "shift") return isMac ? "⇧" : "Shift"
      if (lower === "alt") return isMac ? "⌥" : "Alt"
      if (lower === "ctrl") return isMac ? "⌃" : "Ctrl"
      if (part === "`") return "`"
      if (part === "?") return "?"
      if (part === "/") return "/"
      if (part === "ArrowUp") return "↑"
      if (part === "ArrowDown") return "↓"
      if (part === "ArrowLeft") return "←"
      if (part === "ArrowRight") return "→"
      if (part === "Escape") return "Esc"
      return part.toUpperCase()
    })
    .join(isMac ? "" : "+")
}

function shouldSuppressShortcut(e: KeyboardEvent): boolean {
  const target = e.target
  if (!(target instanceof HTMLElement)) return false
  // Suppress in text inputs, textareas, contenteditable, and terminal
  const tag = target.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  if (target.isContentEditable) return true
  if (target.closest(".xterm")) return true
  return false
}

/** Check if a dialog or modal is currently open in the DOM */
export function isDialogOpen(): boolean {
  return !!document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')
}

export function CommandProvider(props: ParentProps) {
  const [commands, setCommands] = createSignal<Command[]>([])
  const [shortcutRefOpen, setShortcutRefOpen] = createSignal(false)
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const [paletteFilter, setPaletteFilter] = createSignal("")

  function register(newCommands: Command[]) {
    setCommands((prev) => {
      const ids = new Set(newCommands.map((c) => c.id))
      return [...prev.filter((c) => !ids.has(c.id)), ...newCommands]
    })
  }

  function unregister(ids: string[]) {
    const idSet = new Set(ids)
    setCommands((prev) => prev.filter((c) => !idSet.has(c.id)))
  }

  function trigger(id: string) {
    const cmd = commands().find((c) => c.id === id)
    cmd?.onSelect()
  }

  function getSlashCommands() {
    return commands().filter((c) => c.slash)
  }

  function filterSlashCommands(query: string) {
    const q = query.toLowerCase()
    return getSlashCommands().filter(
      (c) =>
        c.slash?.toLowerCase().startsWith(q) ||
        c.title.toLowerCase().includes(q) ||
        c.description?.toLowerCase().includes(q),
    )
  }

  function getKeyboardShortcuts() {
    return commands().filter((c) => c.keybind && !c.hidden)
  }

  // Reactively bind shortcuts via tinykeys whenever commands change
  createEffect(() => {
    const cmds = commands()
    const bindings: Record<string, (e: KeyboardEvent) => void> = {}

    for (const cmd of cmds) {
      if (!cmd.keybind) continue
      const key = toTinykeysBinding(cmd.keybind)
      bindings[key] = (e) => {
        if (!cmd.global && shouldSuppressShortcut(e)) return
        // Suppress non-global shortcuts while a modal dialog is open
        if (!cmd.global && isDialogOpen()) return
        if (cmd.passive) {
          cmd.onSelect(e)
          return
        }
        e.preventDefault()
        cmd.onSelect()
      }
    }

    // Shortcut reference: ? (only when not in input) and $mod+/
    bindings["?"] = (e) => {
      if (shouldSuppressShortcut(e)) return
      // Allow toggling the shortcut reference closed via its own shortcut
      if (isDialogOpen() && !shortcutRefOpen()) return
      e.preventDefault()
      setShortcutRefOpen((v) => !v)
    }
    bindings["$mod+/"] = (e) => {
      if (shouldSuppressShortcut(e)) return
      // Allow toggling the shortcut reference closed via its own shortcut
      if (isDialogOpen() && !shortcutRefOpen()) return
      e.preventDefault()
      setShortcutRefOpen((v) => !v)
    }

    const unsub = tinykeys(window, bindings)
    onCleanup(unsub)
  })

  const value: CommandContextValue = {
    get commands() {
      return commands()
    },
    register,
    unregister,
    trigger,
    getSlashCommands,
    filterSlashCommands,
    getKeyboardShortcuts,
    shortcutRefOpen,
    setShortcutRefOpen,
    paletteOpen,
    setPaletteOpen,
    paletteFilter,
    setPaletteFilter,
  }

  return <CommandContext.Provider value={value}>{props.children}</CommandContext.Provider>
}

export function useCommand() {
  const ctx = useContext(CommandContext)
  if (!ctx) throw new Error("useCommand must be used within CommandProvider")
  return ctx
}
