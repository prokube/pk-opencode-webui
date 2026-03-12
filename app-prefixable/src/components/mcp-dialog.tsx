import { createSignal, createMemo, Show, For } from "solid-js"
import { useMCP } from "../context/mcp"
import { X, Plus, Trash2 } from "lucide-solid"
import { Button } from "./ui/button"
import { ConfirmDialog } from "./confirm-dialog"

interface Props {
  onClose: () => void
  onAddServer: () => void
}

export function MCPDialog(props: Props) {
  const mcp = useMCP()
  const [loading, setLoading] = createSignal<string | null>(null)
  const [deleting, setDeleting] = createSignal<string | null>(null)
  const [toDelete, setToDelete] = createSignal<string | null>(null)

  const items = createMemo(() =>
    Object.entries(mcp.servers)
      .map(([name, status]) => ({ name, status }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  async function toggle(name: string) {
    if (loading() || deleting()) return
    setLoading(name)

    const status = mcp.servers[name]
    if (status?.status === "connected") {
      await mcp.disconnect(name)
    } else if (status?.status === "needs_auth") {
      // Start OAuth flow
      const result = await mcp.startAuth(name)
      if (result?.authorizationUrl) {
        window.open(result.authorizationUrl, "_blank")
      }
    } else {
      await mcp.connect(name)
    }

    setLoading(null)
  }

  function requestDelete(name: string) {
    if (loading() || deleting()) return
    setToDelete(name)
  }

  async function confirmDelete() {
    const name = toDelete()
    if (!name) return
    setToDelete(null)
    setDeleting(name)
    try {
      await mcp.remove(name)
    } catch (e) {
      console.error("[MCPDialog] Failed to remove server:", e)
    } finally {
      setDeleting(null)
    }
  }

  function getStatusLabel(status: { status: string; error?: string }) {
    switch (status.status) {
      case "connected":
        return "Connected"
      case "disabled":
        return "Disabled"
      case "failed":
        return "Failed"
      case "needs_auth":
        return "Needs Auth"
      case "needs_client_registration":
        return "Needs Registration"
      default:
        return status.status
    }
  }

  function getStatusColor(status: { status: string }) {
    switch (status.status) {
      case "connected":
        return "var(--icon-success-base)"
      case "failed":
      case "needs_client_registration":
        return "var(--icon-critical-base)"
      case "needs_auth":
        return "var(--icon-warning-base)"
      default:
        return "var(--icon-weak)"
    }
  }

  let mouseDownOnBackdrop = false

  return (
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
    >
      <div
        class="w-full max-w-md rounded-lg shadow-xl overflow-hidden"
        style={{
          background: "var(--background-base)",
          border: "1px solid var(--border-base)",
        }}
      >
        {/* Header */}
        <div
          class="px-4 py-3 flex items-center justify-between"
          style={{ "border-bottom": "1px solid var(--border-base)" }}
        >
          <div>
            <h2 class="text-base font-medium" style={{ color: "var(--text-strong)" }}>
              MCP Servers
            </h2>
            <p class="text-xs" style={{ color: "var(--text-weak)" }}>
              {mcp.stats().enabled} of {mcp.stats().total} connected
            </p>
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

        {/* Server List */}
        <div class="max-h-80 overflow-y-auto">
          <Show when={mcp.loading()}>
            <div class="px-4 py-8 text-center" style={{ color: "var(--text-weak)" }}>
              Loading...
            </div>
          </Show>

          <Show when={!mcp.loading() && items().length === 0}>
            <div class="px-4 py-8 text-center" style={{ color: "var(--text-weak)" }}>
              <p>No MCP servers configured.</p>
              <button
                onClick={props.onAddServer}
                class="mt-2 text-sm hover:underline"
                style={{ color: "var(--text-interactive-base)" }}
              >
                Add a server
              </button>
            </div>
          </Show>

          <For each={items()}>
            {(item) => {
              const enabled = () => item.status.status === "connected"
              const error = () => (item.status.status === "failed" ? (item.status as any).error : undefined)

              return (
                <div
                  class="px-4 py-3 flex items-center justify-between gap-3 transition-colors cursor-pointer"
                  style={{ "border-bottom": "1px solid var(--border-base)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-inset)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  onClick={() => toggle(item.name)}
                >
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="font-medium truncate" style={{ color: "var(--text-strong)" }}>
                        {item.name}
                      </span>
                      <span
                        class="text-xs px-1.5 py-0.5 rounded"
                        style={{
                          color: getStatusColor(item.status),
                          background: "var(--surface-inset)",
                        }}
                      >
                        {getStatusLabel(item.status)}
                      </span>
                      <Show when={loading() === item.name}>
                        <span class="text-xs" style={{ color: "var(--text-weak)" }}>
                          ...
                        </span>
                      </Show>
                    </div>
                    <Show when={error()}>
                      <p class="text-xs truncate mt-0.5" style={{ color: "var(--text-weak)" }}>
                        {error()}
                      </p>
                    </Show>
                  </div>

                  <div class="flex items-center gap-2">
                    {/* Toggle Switch */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        toggle(item.name)
                      }}
                      class="relative w-10 h-5 rounded-full transition-colors"
                      style={{
                        background: enabled() ? "var(--interactive-base)" : "var(--surface-inset)",
                      }}
                      disabled={loading() === item.name || deleting() === item.name}
                    >
                      <div
                        class="absolute top-0.5 w-4 h-4 rounded-full transition-transform"
                        style={{
                          background: "var(--background-base)",
                          left: enabled() ? "calc(100% - 18px)" : "2px",
                        }}
                      />
                    </button>

                    {/* Delete Button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        requestDelete(item.name)
                      }}
                      class="p-1 rounded transition-colors opacity-50 hover:opacity-100"
                      style={{ color: "var(--icon-critical-base)" }}
                      disabled={loading() === item.name || deleting() === item.name}
                      title="Remove server"
                    >
                      <Trash2 class="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )
            }}
          </For>
        </div>

        {/* Footer */}
        <div class="px-4 py-3" style={{ "border-top": "1px solid var(--border-base)" }}>
          <Button onClick={props.onAddServer} variant="secondary" class="w-full">
            <Plus class="w-4 h-4" />
            Add MCP Server
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={!!toDelete()}
        title="Remove MCP Server"
        message={`Are you sure you want to remove "${toDelete()}"?`}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
      />
    </div>
  )
}
