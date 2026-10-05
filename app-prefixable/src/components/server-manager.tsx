import { createSignal, createUniqueId, For, onCleanup, Show } from "solid-js"
import { Plus, Pencil, Trash2, Server, Check } from "lucide-solid"
import { Button } from "./ui/button"
import { useConnections } from "../context/server"
import { base64Encode, getServerUrl } from "../utils/path"
import { normalizeServerUrl, connectionUrl, needsServerCredential, serverAuthHeaders, serverHref, type ServerConnection } from "../utils/servers"
import { useLocation, useNavigate } from "@solidjs/router"

export function ServerManager() {
  const registry = useConnections()
  const location = useLocation()
  const navigate = useNavigate()
  const fieldId = createUniqueId()
  const [editing, setEditing] = createSignal<string>()
  const [url, setUrl] = createSignal("")
  const [name, setName] = createSignal("")
  const [auth, setAuth] = createSignal<ServerConnection["auth"]>("none")
  const [username, setUsername] = createSignal("opencode")
  const [password, setPassword] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const pending = { request: undefined as AbortController | undefined }
  onCleanup(() => pending.request?.abort())

  function edit(item?: ServerConnection) {
    setEditing(item?.id ?? "new")
    setUrl(item?.url ?? "")
    setName(item?.name ?? "")
    setAuth(item?.auth ?? "none")
    setUsername(item?.username || "opencode")
    setPassword(item ? registry.credentials()[item.id] || "" : "")
    setError("")
  }
  async function save(event: SubmitEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    const controller = new AbortController()
    pending.request?.abort()
    pending.request = controller
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const endpoint = normalizeServerUrl(url())
      const secret = auth() === "bearer" ? password().trim() : password()
      const item: ServerConnection = {
        id: base64Encode(endpoint),
        url: endpoint,
        name: name().trim() || endpoint.replace(/^https?:\/\//, ""),
        auth: auth(),
        username: username() || "opencode",
      }
      if (needsServerCredential(item) && !secret) throw new Error("Enter the server credential")
      const response = await fetch(connectionUrl(getServerUrl(), item) + "/global/health", {
        headers: serverAuthHeaders(item, secret),
        credentials: "same-origin",
        redirect: "manual",
        signal: controller.signal,
      })
      if (item.auth === "session" && (!response.ok || !response.headers.get("content-type")?.includes("application/json")))
        throw new Error("Browser-Session requires an active browser login and access to this server. Sign in again, then reconnect.")
      if (!response.ok) throw new Error(`Connection failed (HTTP ${response.status}). Check the URL and credentials.`)
      const health: unknown = await response.json()
      if (!health || typeof health !== "object" || !("healthy" in health) || health.healthy !== true)
        throw new Error("The URL did not return an OpenCode health response")
      if (controller.signal.aborted) return
      registry.save(item, needsServerCredential(item) ? secret : "")
      setEditing(undefined)
    } catch (failure) {
      setError(
        controller.signal.aborted
          ? "Connection timed out"
          : failure instanceof Error
            ? failure.message
            : "Connection failed",
      )
    } finally {
      clearTimeout(timeout)
      setBusy(false)
    }
  }
  const field = "w-full rounded-md px-3 py-2 text-sm border bg-transparent"
  return (
    <section class="w-full max-w-2xl">
      <div class="flex items-center justify-between mb-5">
        <h2 class="font-medium text-lg">{editing() ? "Connection settings" : "Manage servers"}</h2>
      </div>
      <p class="text-sm mb-5" style={{ color: "var(--text-weak)" }}>
        Add, edit or remove connections. Select the active server in the sidebar.
      </p>
      <Show
        when={editing()}
        fallback={
          <div class="space-y-2">
            <For each={registry.list()}>
              {(item) => (
                <div
                  class="flex items-center gap-3 rounded-lg border p-3"
                  style={{ "border-color": "var(--border-base)" }}
                >
                  <Server size={18} />
                  <div class="min-w-0 flex-1 text-left">
                    <div class="font-medium truncate">{item.name}</div>
                    <div class="text-xs truncate" style={{ color: "var(--text-weak)" }}>
                      {item.id === "local" ? "Built-in connection" : item.url}
                    </div>
                  </div>
                  <Show when={item.id !== "local"}>
                    <button type="button" aria-label={`Edit ${item.name}`} onClick={() => edit(item)}>
                      <Pencil size={16} />
                    </button>
                    <button type="button" aria-label={`Remove ${item.name}`} onClick={() => {
                      if (new URLSearchParams(location.search).get("server") === item.id)
                        navigate(serverHref(item.id, "/settings/servers"), { replace: true })
                      registry.remove(item.id)
                    }}>
                      <Trash2 size={16} />
                    </button>
                  </Show>
                </div>
              )}
            </For>
            <Button onClick={() => edit()} class="mt-3">
              <Plus size={16} />
              Add server
            </Button>
          </div>
        }
      >
        <form class="space-y-4" onSubmit={save}>
          <div>
            <label for={`${fieldId}-url`} class="block text-sm mb-1">
              Server URL
            </label>
            <input
              id={`${fieldId}-url`}
              class={field}
              value={url()}
              disabled={busy() || editing() !== "new"}
              required
              placeholder="https://opencode.example.com"
              onInput={(event) => setUrl(event.currentTarget.value)}
            />
          </div>
          <div>
            <label for={`${fieldId}-name`} class="block text-sm mb-1">
              Name
            </label>
            <input
              id={`${fieldId}-name`}
              class={field}
              value={name()}
              disabled={busy()}
              placeholder="My sandbox"
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </div>
          <div>
            <label for={`${fieldId}-auth`} class="block text-sm mb-1">
              Authentication
            </label>
            <select
              id={`${fieldId}-auth`}
              class={field}
              value={auth()}
              disabled={busy()}
              onChange={(event) => setAuth(event.currentTarget.value as ServerConnection["auth"])}
            >
              <option value="none">None</option>
              <option value="session">Browser-Session</option>
              <option value="basic">Username and password</option>
              <option value="bearer">Bearer token</option>
            </select>
          </div>
          <Show when={auth() === "basic"}>
            <div>
              <label for={`${fieldId}-username`} class="block text-sm mb-1">
                Username
              </label>
              <input
                id={`${fieldId}-username`}
                class={field}
                value={username()}
                disabled={busy()}
                onInput={(event) => setUsername(event.currentTarget.value)}
              />
            </div>
          </Show>
          <Show when={auth() === "session"}>
            <p class="text-sm" style={{ color: "var(--text-weak)" }}>Uses your existing browser login. Connects directly to a server on the same origin; no additional credentials required.</p>
          </Show>
          <Show when={auth() === "basic" || auth() === "bearer"}>
            <div>
              <label for={`${fieldId}-password`} class="block text-sm mb-1">
                {auth() === "basic" ? "Password" : "Bearer token"}
              </label>
              <input
                id={`${fieldId}-password`}
                class={field}
                type="password"
                autocomplete="off"
                value={password()}
                required
                disabled={busy()}
                onInput={(event) => setPassword(event.currentTarget.value)}
              />
              <p class="text-xs mt-1" style={{ color: "var(--text-weak)" }}>
                Credentials are kept for this browser session.
              </p>
            </div>
          </Show>
          <Show when={error()}>
            <p role="alert" class="text-sm" style={{ color: "var(--text-critical-base)" }}>
              {error()}
            </p>
          </Show>
          <div class="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={busy()} onClick={() => setEditing(undefined)}>
              Back
            </Button>
            <Button type="submit" disabled={busy()}>
              <Check size={16} />
              {busy() ? "Checking…" : "Save connection"}
            </Button>
          </div>
        </form>
      </Show>
    </section>
  )
}
