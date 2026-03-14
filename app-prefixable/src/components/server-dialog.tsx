import { createSignal, Show, For } from "solid-js"
import { useServer, serverDisplayName, type ServerConnection, type ServerHealth } from "../context/server"
import { X, ChevronLeft, Server, Plus, Check, Trash2, Edit2, Wifi, WifiOff, Loader2 } from "lucide-solid"
import { Button } from "./ui/button"

interface Props {
  onClose: () => void
}

type Mode = "list" | "add" | "edit"

function HealthIndicator(props: { health: ServerHealth }) {
  return (
    <div class="flex items-center justify-center w-5 h-5">
      <Show when={props.health === "healthy"}>
        <Wifi class="w-4 h-4" style={{ color: "var(--text-success-base)" }} />
      </Show>
      <Show when={props.health === "unhealthy"}>
        <WifiOff class="w-4 h-4" style={{ color: "var(--text-critical-base)" }} />
      </Show>
      <Show when={props.health === "checking"}>
        <Loader2 class="w-4 h-4 animate-spin" style={{ color: "var(--text-weak)" }} />
      </Show>
    </div>
  )
}

export function ServerDialog(props: Props) {
  const server = useServer()
  const [mode, setMode] = createSignal<Mode>("list")
  const [editingUrl, setEditingUrl] = createSignal<string | null>(null)

  // Form state
  const [url, setUrl] = createSignal("")
  const [name, setName] = createSignal("")
  const [username, setUsername] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)

  const resetForm = () => {
    setUrl("")
    setName("")
    setUsername("")
    setPassword("")
    setError("")
    setLoading(false)
  }

  const startAdd = () => {
    resetForm()
    setMode("add")
  }

  const startEdit = (conn: ServerConnection) => {
    setEditingUrl(conn.url)
    setUrl(conn.url)
    setName(conn.name || "")
    setUsername(conn.username || "")
    setPassword(conn.password || "")
    setError("")
    setMode("edit")
  }

  const goBack = () => {
    resetForm()
    setEditingUrl(null)
    setMode("list")
  }

  const handleSubmit = async (e: SubmitEvent) => {
    e.preventDefault()
    setError("")

    const serverUrl = url().trim()
    if (!serverUrl) {
      setError("URL is required")
      return
    }

    setLoading(true)
    
    // Check health before adding
    const healthy = await server.checkHealth(serverUrl, username() || undefined, password() || undefined)
    
    if (!healthy) {
      setError("Could not connect to server. Please check the URL and credentials.")
      setLoading(false)
      return
    }

    const conn: ServerConnection = {
      url: serverUrl,
      name: name().trim() || undefined,
      username: username().trim() || undefined,
      password: password() || undefined,
    }

    if (mode() === "edit" && editingUrl()) {
      server.update(editingUrl()!, conn)
    } else {
      server.add(conn)
    }

    setLoading(false)
    goBack()
  }

  const handleRemove = (serverUrl: string) => {
    server.remove(serverUrl)
  }

  const handleSelect = (serverUrl: string | null) => {
    server.setActive(serverUrl)
    props.onClose()
  }

  const inputStyle = {
    background: "var(--background-base)",
    border: "1px solid var(--border-base)",
    color: "var(--text-base)",
  }

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div
        class="w-full max-w-lg max-h-[90vh] rounded-lg shadow-xl overflow-hidden flex flex-col"
        style={{
          background: "var(--background-base)",
          border: "1px solid var(--border-base)",
        }}
      >
        {/* Header */}
        <div
          class="px-4 py-3 flex items-center gap-3 shrink-0"
          style={{ "border-bottom": "1px solid var(--border-base)" }}
        >
          <Show when={mode() !== "list"}>
            <button
              onClick={goBack}
              class="p-1 rounded transition-colors"
              style={{ color: "var(--icon-weak)" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-inset)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <ChevronLeft class="w-5 h-5" />
            </button>
          </Show>
          <div class="flex-1">
            <h2 class="text-base font-medium" style={{ color: "var(--text-strong)" }}>
              {mode() === "list" ? "Select Server" : mode() === "add" ? "Add Server" : "Edit Server"}
            </h2>
          </div>
          <button
            onClick={props.onClose}
            class="p-1 rounded transition-colors"
            style={{ color: "var(--icon-weak)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-inset)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <X class="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <Show when={mode() === "list"}>
          <div class="p-4 space-y-2 overflow-y-auto flex-1">
            {/* Local Server Option */}
            <button
              onClick={() => handleSelect(null)}
              class="w-full flex items-center gap-3 p-3 rounded-lg transition-colors text-left"
              style={{
                background: server.activeKey() === null ? "var(--surface-inset)" : "transparent",
                border: "1px solid var(--border-base)",
              }}
              onMouseEnter={(e) => {
                if (server.activeKey() !== null) e.currentTarget.style.background = "var(--surface-hover)"
              }}
              onMouseLeave={(e) => {
                if (server.activeKey() !== null) e.currentTarget.style.background = "transparent"
              }}
            >
              <Server class="w-5 h-5" style={{ color: "var(--icon-base)" }} />
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium" style={{ color: "var(--text-base)" }}>
                  Local Server
                </div>
                <div class="text-xs truncate" style={{ color: "var(--text-weak)" }}>
                  Built-in server running in this notebook
                </div>
              </div>
              <Show when={server.activeKey() === null}>
                <Check class="w-5 h-5" style={{ color: "var(--text-success-base)" }} />
              </Show>
            </button>

            {/* External Servers */}
            <For each={server.servers()}>
              {(conn) => (
                <div
                  class="w-full flex items-center gap-3 p-3 rounded-lg transition-colors"
                  style={{
                    background: server.activeKey() === conn.url ? "var(--surface-inset)" : "transparent",
                    border: "1px solid var(--border-base)",
                  }}
                >
                  <button
                    onClick={() => handleSelect(conn.url)}
                    class="flex-1 flex items-center gap-3 text-left min-w-0"
                  >
                    <HealthIndicator health={server.health(conn.url)} />
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-medium" style={{ color: "var(--text-base)" }}>
                        {serverDisplayName(conn)}
                      </div>
                      <div class="text-xs truncate" style={{ color: "var(--text-weak)" }}>
                        {conn.url}
                      </div>
                    </div>
                    <Show when={server.activeKey() === conn.url}>
                      <Check class="w-5 h-5" style={{ color: "var(--text-success-base)" }} />
                    </Show>
                  </button>
                  <div class="flex items-center gap-1">
                    <button
                      onClick={() => startEdit(conn)}
                      class="p-1.5 rounded transition-colors"
                      style={{ color: "var(--icon-weak)" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-inset)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <Edit2 class="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleRemove(conn.url)}
                      class="p-1.5 rounded transition-colors"
                      style={{ color: "var(--icon-critical-base)" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-critical-weak)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <Trash2 class="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </For>

            {/* Add Server Button */}
            <button
              onClick={startAdd}
              class="w-full flex items-center justify-center gap-2 p-3 rounded-lg transition-colors"
              style={{
                border: "1px dashed var(--border-base)",
                color: "var(--text-interactive-base)",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <Plus class="w-4 h-4" />
              <span class="text-sm">Add External Server</span>
            </button>
          </div>
        </Show>

        {/* Add/Edit Form */}
        <Show when={mode() === "add" || mode() === "edit"}>
          <form onSubmit={handleSubmit} class="p-4 space-y-4 overflow-y-auto flex-1">
            {/* URL Field */}
            <div>
              <label class="block text-sm font-medium mb-1" style={{ color: "var(--text-base)" }}>
                Server URL <span style={{ color: "var(--text-critical-base)" }}>*</span>
              </label>
              <input
                type="text"
                value={url()}
                onInput={(e) => setUrl(e.currentTarget.value)}
                placeholder="http://sandbox-service:4096"
                class="w-full px-3 py-2 rounded-md text-sm"
                style={inputStyle}
                autofocus
              />
              <p class="text-xs mt-1" style={{ color: "var(--text-weak)" }}>
                The URL of the external OpenCode server
              </p>
            </div>

            {/* Name Field */}
            <div>
              <label class="block text-sm font-medium mb-1" style={{ color: "var(--text-base)" }}>
                Display Name
              </label>
              <input
                type="text"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                placeholder="My Sandbox"
                class="w-full px-3 py-2 rounded-md text-sm"
                style={inputStyle}
              />
            </div>

            {/* Credentials */}
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-sm font-medium mb-1" style={{ color: "var(--text-base)" }}>
                  Username
                </label>
                <input
                  type="text"
                  value={username()}
                  onInput={(e) => setUsername(e.currentTarget.value)}
                  placeholder="opencode"
                  class="w-full px-3 py-2 rounded-md text-sm"
                  style={inputStyle}
                />
              </div>
              <div>
                <label class="block text-sm font-medium mb-1" style={{ color: "var(--text-base)" }}>
                  Password
                </label>
                <input
                  type="password"
                  value={password()}
                  onInput={(e) => setPassword(e.currentTarget.value)}
                  placeholder="••••••••"
                  class="w-full px-3 py-2 rounded-md text-sm"
                  style={inputStyle}
                />
              </div>
            </div>

            {/* Error */}
            <Show when={error()}>
              <div
                class="px-3 py-2 rounded-md text-sm"
                style={{
                  background: "var(--surface-critical-base)",
                  color: "var(--text-critical-base)",
                }}
              >
                {error()}
              </div>
            </Show>

            {/* Submit */}
            <Button type="submit" disabled={loading() || !url().trim()} variant="ghost" class="w-full">
              {loading() ? "Connecting..." : mode() === "edit" ? "Save" : "Add Server"}
            </Button>
          </form>
        </Show>
      </div>
    </div>
  )
}
