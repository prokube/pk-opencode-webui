import { createContext, useContext, createSignal, createMemo, onMount, onCleanup, type ParentProps } from "solid-js"

export interface Command {
  id: string
  title: string
  description?: string
  slash?: string
  keybind?: string
  onSelect: () => void
}

interface CommandContextValue {
  commands: Command[]
  register: (commands: Command[]) => void
  unregister: (ids: string[]) => void
  trigger: (id: string) => void
  getSlashCommands: () => Command[]
  filterSlashCommands: (query: string) => Command[]
}

const CommandContext = createContext<CommandContextValue>()

export function CommandProvider(props: ParentProps) {
  const [commands, setCommands] = createSignal<Command[]>([])

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

  // Global keyboard shortcut handler
  onMount(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isMac = navigator.platform.includes("Mac")
      const mod = isMac ? e.metaKey : e.ctrlKey

      for (const cmd of commands()) {
        if (!cmd.keybind) continue

        const parts = cmd.keybind.toLowerCase().split("+")
        const key = parts.pop()
        const needsMod = parts.includes("mod")
        const needsShift = parts.includes("shift")
        const needsAlt = parts.includes("alt")

        if (e.key.toLowerCase() === key && mod === needsMod && e.shiftKey === needsShift && e.altKey === needsAlt) {
          e.preventDefault()
          cmd.onSelect()
          return
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown))
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
  }

  return <CommandContext.Provider value={value}>{props.children}</CommandContext.Provider>
}

export function useCommand() {
  const ctx = useContext(CommandContext)
  if (!ctx) throw new Error("useCommand must be used within CommandProvider")
  return ctx
}
