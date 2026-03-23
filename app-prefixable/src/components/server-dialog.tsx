import { createSignal, Show, For } from "solid-js"
import { useServer } from "../context/server"
import type { ServerConfig, ServerAuth } from "../types/server"
import { X, Plus, Trash2, Check, Pencil, Server, Wifi, WifiOff } from "lucide-solid"
import { Button } from "./ui/button"
import { Spinner } from "./ui/spinner"
import { ConfirmDialog } from "./confirm-dialog"
import { createBackdropDismiss } from "../utils/backdrop"
import { getAuthHeaders } from "../types/server"

interface Props {
  open: boolean
  onClose: () => void
}

type AuthType = "none" | "api-key" | "basic"

export function ServerDialog(props: Props) {
  const server = useServer()

  // Form state
  const [showForm, setShowForm] = createSignal(false)
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [name, setName] = createSignal("")
  const [url, setUrl] = createSignal("")
  const [authType, setAuthType] = createSignal<AuthType>("none")
  const [apiKey, setApiKey] = createSignal("")
  const [username, setUsername] = createSignal("")
  const [password, setPassword] = createSignal("")

  // Test connection state
  const [testing, setTesting] = createSignal<string | null>(null)
  const [testResult, setTestResult] = createSignal<Record<string, "ok" | "fail">>({})

  // Delete confirmation
  const [toDelete, setToDelete] = createSignal<string | null>(null)

  const backdrop = createBackdropDismiss(props.onClose)

  function resetForm() {
    setShowForm(false)
    setEditingId(null)
    setName("")
    setUrl("")
    setAuthType("none")
    setApiKey("")
    setUsername("")
    setPassword("")
  }

  function startEdit(s: ServerConfig) {
    setEditingId(s.id)
    setName(s.name)
    setUrl(s.url)
    setAuthType(s.auth.type)
    if (s.auth.type === "api-key") setApiKey(s.auth.key)
    if (s.auth.type === "basic") {
      setUsername(s.auth.username)
      setPassword(s.auth.password)
    }
    setShowForm(true)
  }

  function buildAuth(): ServerAuth {
    switch (authType()) {
      case "api-key":
        return { type: "api-key", key: apiKey() }
      case "basic":
        return { type: "basic", username: username(), password: password() }
      default:
        return { type: "none" }
    }
  }

  function save() {
    const trimmedUrl = url().trim().replace(/\/+$/, "")
    if (!trimmedUrl || !name().trim()) return

    const auth = buildAuth()
    const id = editingId()

    if (id) {
      server.updateServer(id, { name: name().trim(), url: trimmedUrl, auth })
    } else {
      server.addServer({ name: name().trim(), url: trimmedUrl, auth })
    }
    resetForm()
  }

  async function testConnection(s: ServerConfig) {
    setTesting(s.id)
    setTestResult((prev) => {
      const next = { ...prev }
      delete next[s.id]
      return next
    })

    try {
      const res = await fetch(`${s.url}/session`, {
        headers: getAuthHeaders(s.auth),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setTestResult((prev) => ({ ...prev, [s.id]: "ok" }))
    } catch {
      setTestResult((prev) => ({ ...prev, [s.id]: "fail" }))
    } finally {
      setTesting(null)
    }
  }

  function handleDelete(id: string) {
    server.removeServer(id)
    setToDelete(null)
  }

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center"
        style={{ background: "rgba(0, 0, 0, 0.5)" }}
        onMouseDown={backdrop.onMouseDown}
        onClick={backdrop.onClick}
        onKeyDown={(e) => e.key === "Escape" && (showForm() ? resetForm() : props.onClose())}
      >
        <div
          class="w-full max-w-lg mx-4 rounded-xl shadow-2xl max-h-[80vh] flex flex-col"
          style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}
        >
          {/* Header */}
          <div
            class="flex items-center justify-between p-4 shrink-0"
            style={{ "border-bottom": "1px solid var(--border-base)" }}
          >
            <h2 class="text-lg font-semibold" style={{ color: "var(--text-strong)" }}>
              {showForm() ? (editingId() ? "Edit Server" : "Add Server") : "Servers"}
            </h2>
            <button
              onClick={() => (showForm() ? resetForm() : props.onClose())}
              class="p-1 rounded-md transition-colors"
              style={{ color: "var(--icon-base)" }}
            >
              <X class="w-5 h-5" />
            </button>
          </div>

          {/* Content */}
          <div class="p-4 overflow-y-auto flex-1">
            <Show when={!showForm()}>
              {/* Server list */}
              <div class="space-y-2">
                <For each={server.servers()}>
                  {(s) => {
                    const isActive = () => s.id === server.activeServerId()
                    const result = () => testResult()[s.id]

                    return (
                      <div
                        class="flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors"
                        style={{
                          background: isActive()
                            ? "color-mix(in srgb, var(--interactive-base) 15%, transparent)"
                            : "var(--surface-inset)",
                          border: isActive()
                            ? "1px solid var(--interactive-base)"
                            : "1px solid transparent",
                        }}
                        onClick={() => {
                          server.setActiveServer(s.id)
                        }}
                      >
                        {/* Status indicator */}
                        <div class="shrink-0">
                          <Show when={isActive()} fallback={
                            <Server class="w-5 h-5" style={{ color: "var(--icon-weak)" }} />
                          }>
                            <Server class="w-5 h-5" style={{ color: "var(--interactive-base)" }} />
                          </Show>
                        </div>

                        {/* Info */}
                        <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-2">
                            <span class="font-medium text-sm truncate" style={{ color: "var(--text-strong)" }}>
                              {s.name}
                            </span>
                            <Show when={isActive()}>
                              <span
                                class="text-xs px-1.5 py-0.5 rounded"
                                style={{ background: "var(--interactive-base)", color: "white" }}
                              >
                                active
                              </span>
                            </Show>
                            <Show when={s.auth.type !== "none"}>
                              <span
                                class="text-xs px-1.5 py-0.5 rounded"
                                style={{ background: "var(--surface-strong)", color: "var(--text-weak)" }}
                              >
                                {s.auth.type === "api-key" ? "API Key" : "Basic Auth"}
                              </span>
                            </Show>
                          </div>
                          <div class="text-xs truncate mt-0.5" style={{ color: "var(--text-weak)" }}>
                            {s.url}
                          </div>
                        </div>

                        {/* Test result */}
                        <Show when={testing() === s.id}>
                          <Spinner class="w-4 h-4 shrink-0" />
                        </Show>
                        <Show when={testing() !== s.id && result() === "ok"}>
                          <Wifi class="w-4 h-4 shrink-0" style={{ color: "var(--status-success-text)" }} />
                        </Show>
                        <Show when={testing() !== s.id && result() === "fail"}>
                          <WifiOff class="w-4 h-4 shrink-0" style={{ color: "var(--status-danger-text)" }} />
                        </Show>

                        {/* Actions */}
                        <div class="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => testConnection(s)}
                            class="p-1.5 rounded-md transition-colors text-xs"
                            style={{ color: "var(--text-interactive-base)" }}
                            title="Test connection"
                            disabled={testing() !== null}
                          >
                            Test
                          </button>
                          <Show when={!s.isDefault}>
                            <button
                              onClick={() => startEdit(s)}
                              class="p-1.5 rounded-md transition-colors"
                              style={{ color: "var(--icon-base)" }}
                              title="Edit"
                            >
                              <Pencil class="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setToDelete(s.id)}
                              class="p-1.5 rounded-md transition-colors"
                              style={{ color: "var(--status-danger-text)" }}
                              title="Remove"
                            >
                              <Trash2 class="w-3.5 h-3.5" />
                            </button>
                          </Show>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>

              {/* Add server button */}
              <button
                onClick={() => setShowForm(true)}
                class="w-full mt-3 flex items-center gap-2 p-3 rounded-lg text-sm transition-colors"
                style={{
                  border: "2px dashed var(--border-base)",
                  color: "var(--text-interactive-base)",
                }}
              >
                <Plus class="w-4 h-4" />
                Add Remote Server
              </button>
            </Show>

            {/* Add/Edit form */}
            <Show when={showForm()}>
              <div class="space-y-4">
                {/* Name */}
                <div>
                  <label class="block text-sm font-medium mb-1" style={{ color: "var(--text-strong)" }}>
                    Name
                  </label>
                  <input
                    type="text"
                    value={name()}
                    onInput={(e) => setName(e.currentTarget.value)}
                    placeholder="My Remote Server"
                    class="w-full px-3 py-2 rounded-md text-sm"
                    style={{
                      background: "var(--background-stronger)",
                      border: "1px solid var(--border-base)",
                      color: "var(--text-base)",
                    }}
                  />
                </div>

                {/* URL */}
                <div>
                  <label class="block text-sm font-medium mb-1" style={{ color: "var(--text-strong)" }}>
                    Server URL
                  </label>
                  <input
                    type="text"
                    value={url()}
                    onInput={(e) => setUrl(e.currentTarget.value)}
                    placeholder="https://opencode.example.com"
                    class="w-full px-3 py-2 rounded-md text-sm"
                    style={{
                      background: "var(--background-stronger)",
                      border: "1px solid var(--border-base)",
                      color: "var(--text-base)",
                    }}
                  />
                </div>

                {/* Auth type */}
                <div>
                  <label class="block text-sm font-medium mb-1" style={{ color: "var(--text-strong)" }}>
                    Authentication
                  </label>
                  <select
                    value={authType()}
                    onChange={(e) => setAuthType(e.currentTarget.value as AuthType)}
                    class="w-full px-3 py-2 rounded-md text-sm"
                    style={{
                      background: "var(--background-stronger)",
                      border: "1px solid var(--border-base)",
                      color: "var(--text-base)",
                    }}
                  >
                    <option value="none">No Authentication</option>
                    <option value="api-key">API Key (x-api-key)</option>
                    <option value="basic">Basic Auth</option>
                  </select>
                </div>

                {/* API Key field */}
                <Show when={authType() === "api-key"}>
                  <div>
                    <label class="block text-sm font-medium mb-1" style={{ color: "var(--text-strong)" }}>
                      API Key
                    </label>
                    <input
                      type="password"
                      value={apiKey()}
                      onInput={(e) => setApiKey(e.currentTarget.value)}
                      placeholder="pk_live_..."
                      class="w-full px-3 py-2 rounded-md text-sm font-mono"
                      style={{
                        background: "var(--background-stronger)",
                        border: "1px solid var(--border-base)",
                        color: "var(--text-base)",
                      }}
                    />
                  </div>
                </Show>

                {/* Basic Auth fields */}
                <Show when={authType() === "basic"}>
                  <div>
                    <label class="block text-sm font-medium mb-1" style={{ color: "var(--text-strong)" }}>
                      Username
                    </label>
                    <input
                      type="text"
                      value={username()}
                      onInput={(e) => setUsername(e.currentTarget.value)}
                      placeholder="admin"
                      class="w-full px-3 py-2 rounded-md text-sm"
                      style={{
                        background: "var(--background-stronger)",
                        border: "1px solid var(--border-base)",
                        color: "var(--text-base)",
                      }}
                    />
                  </div>
                  <div>
                    <label class="block text-sm font-medium mb-1" style={{ color: "var(--text-strong)" }}>
                      Password
                    </label>
                    <input
                      type="password"
                      value={password()}
                      onInput={(e) => setPassword(e.currentTarget.value)}
                      placeholder="Password"
                      class="w-full px-3 py-2 rounded-md text-sm"
                      style={{
                        background: "var(--background-stronger)",
                        border: "1px solid var(--border-base)",
                        color: "var(--text-base)",
                      }}
                    />
                  </div>
                </Show>

                {/* Actions */}
                <div class="flex gap-2 pt-2">
                  <Button onClick={resetForm} variant="secondary" class="flex-1">
                    Cancel
                  </Button>
                  <Button
                    onClick={save}
                    variant="primary"
                    class="flex-1"
                    disabled={!name().trim() || !url().trim()}
                  >
                    {editingId() ? "Save" : "Add Server"}
                  </Button>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </div>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!toDelete()}
        title="Remove Server"
        message="Are you sure you want to remove this server? This cannot be undone."
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => handleDelete(toDelete()!)}
        onCancel={() => setToDelete(null)}
      />
    </Show>
  )
}
