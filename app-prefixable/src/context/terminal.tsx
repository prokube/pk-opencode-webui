import { createContext, useContext, createSignal, onCleanup, onMount, type ParentProps } from "solid-js"
import { useSDK } from "./sdk"
import { useEvents } from "./events"
import { mkdir } from "../utils/extended-api"

interface PTYSession {
  id: string
  title: string
}

interface TerminalContextValue {
  sessions: () => PTYSession[]
  active: () => string | null
  opened: () => boolean
  height: () => number
  error: () => string | null
  creating: () => boolean
  create: (cwd?: string) => Promise<string | null>
  close: (id: string) => Promise<void>
  setActive: (id: string | null) => void
  toggle: (cwd?: string) => void
  open: (cwd?: string) => void
  setHeight: (h: number) => void
  clearError: () => void
}

const TerminalContext = createContext<TerminalContextValue>()

export function TerminalProvider(props: ParentProps) {
  const { client, url } = useSDK()
  const events = useEvents()
  const [sessions, setSessions] = createSignal<PTYSession[]>([])
  const [active, setActive] = createSignal<string | null>(null)
  const [opened, setOpened] = createSignal(false)
  const [height, setHeight] = createSignal(280)
  const [error, setError] = createSignal<string | null>(null)
  const [creating, setCreating] = createSignal(false)
  let disposed = false

  function drop(id: string) {
    setSessions((prev) => prev.filter((session) => session.id !== id))
    if (active() !== id) return
    const next = sessions()[0]?.id ?? null
    setActive(next)
    if (!next) setOpened(false)
  }

  const unsub = events.subscribe((event) => {
    if (event.type === "pty.exited" || event.type === "pty.deleted") drop(event.properties.id)
  })

  onMount(() => {
    client.pty.list().then((res) => {
      if (disposed || !res.data) return
      const restored = res.data.map((pty, index) => ({ id: pty.id, title: pty.title || `Terminal ${index + 1}` }))
      setSessions((current) => {
        const ids = new Set(restored.map((session) => session.id))
        const merged = [...restored, ...current.filter((session) => !ids.has(session.id))]
        if (!active() || !merged.some((session) => session.id === active())) setActive(merged[0]?.id ?? null)
        return merged
      })
    }).catch(() => undefined)
  })

  onCleanup(() => {
    disposed = true
    unsub()
  })

  async function create(cwd?: string): Promise<string | null> {
    setCreating(true)
    setError(null)
    try {
      // Ensure the directory exists before creating the PTY
      if (cwd) {
        console.log("[Terminal] Ensuring directory exists:", cwd)
        await mkdir(url, cwd)
      }

      console.log("[Terminal] Creating PTY session, cwd:", cwd)
      const res = await client.pty.create({ cwd })
      console.log("[Terminal] PTY create response:", res)
      if (res.data) {
        if (disposed) return res.data.id
        const session: PTYSession = {
          id: res.data.id,
          title: `Terminal ${sessions().length + 1}`,
        }
        setSessions((prev) => [...prev, session])
        setActive(session.id)
        setOpened(true)
        return session.id
      }
      setError("Failed to create terminal: No data in response")
    } catch (e: any) {
      console.error("[Terminal] Failed to create PTY:", e)
      const msg = e?.message || e?.toString() || "Unknown error"
      setError(`Failed to create terminal: ${msg}`)
    } finally {
      setCreating(false)
    }
    return null
  }

  async function close(id: string): Promise<void> {
    try {
      await client.pty.remove({ ptyID: id })
    } catch (e) {
      console.error("Failed to close PTY:", e)
    } finally {
      drop(id)
    }
  }

  function toggle(cwd?: string) {
    if (opened()) {
      setOpened(false)
    } else {
      if (sessions().length === 0) {
        create(cwd)
      } else {
        setOpened(true)
      }
    }
  }

  function open(cwd?: string) {
    if (sessions().length === 0) {
      create(cwd)
    } else {
      setOpened(true)
    }
  }

  return (
    <TerminalContext.Provider
      value={{
        sessions,
        active,
        opened,
        height,
        error,
        creating,
        create,
        close,
        setActive,
        toggle,
        open,
        setHeight,
        clearError: () => setError(null),
      }}
    >
      {props.children}
    </TerminalContext.Provider>
  )
}

export function useTerminal() {
  const ctx = useContext(TerminalContext)
  if (!ctx) throw new Error("useTerminal must be used within TerminalProvider")
  return ctx
}
