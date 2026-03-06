import { createSignal, Show, For } from "solid-js"
import { useMCP, type McpRemoteConfig } from "../context/mcp"
import { X, ChevronLeft, ChevronRight } from "lucide-solid"
import { Button } from "./ui/button"

interface Props {
  onClose: () => void
  onBack: () => void
}

interface Header {
  key: string
  value: string
}

export function MCPAddDialog(props: Props) {
  const mcp = useMCP()
  const [name, setName] = createSignal("")
  const [url, setUrl] = createSignal("")
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [showAdvanced, setShowAdvanced] = createSignal(false)

  // Advanced options
  const [timeout, setTimeout] = createSignal("")
  const [headers, setHeaders] = createSignal<Header[]>([])
  const [oauthEnabled, setOauthEnabled] = createSignal(true)
  const [oauthClientId, setOauthClientId] = createSignal("")
  const [oauthClientSecret, setOauthClientSecret] = createSignal("")
  const [oauthScope, setOauthScope] = createSignal("")

  function addHeader() {
    setHeaders([...headers(), { key: "", value: "" }])
  }

  function removeHeader(index: number) {
    setHeaders(headers().filter((_, i) => i !== index))
  }

  function updateHeader(index: number, field: "key" | "value", value: string) {
    setHeaders(headers().map((h, i) => (i === index ? { ...h, [field]: value } : h)))
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    setError("")

    const serverName = name().trim()
    if (!serverName) {
      setError("Name is required")
      return
    }

    const serverUrl = url().trim()
    if (!serverUrl) {
      setError("URL is required")
      return
    }
    if (!serverUrl.startsWith("http://") && !serverUrl.startsWith("https://")) {
      setError("URL must start with http:// or https://")
      return
    }

    // Parse timeout
    const timeoutMs = timeout().trim() ? parseInt(timeout().trim(), 10) : undefined
    if (timeoutMs !== undefined && (isNaN(timeoutMs) || timeoutMs <= 0)) {
      setError("Timeout must be a positive number")
      return
    }

    // Build headers object
    const headersObj: Record<string, string> = {}
    for (const h of headers()) {
      if (h.key.trim()) {
        headersObj[h.key.trim()] = h.value
      }
    }

    // Build OAuth config
    let oauth: McpRemoteConfig["oauth"] = undefined
    if (!oauthEnabled()) {
      oauth = false
    } else if (oauthClientId().trim() || oauthClientSecret().trim() || oauthScope().trim()) {
      oauth = {}
      if (oauthClientId().trim()) oauth.clientId = oauthClientId().trim()
      if (oauthClientSecret().trim()) oauth.clientSecret = oauthClientSecret().trim()
      if (oauthScope().trim()) oauth.scope = oauthScope().trim()
    }

    const config: McpRemoteConfig = {
      type: "remote",
      url: serverUrl,
      enabled: true,
    }
    if (Object.keys(headersObj).length > 0) config.headers = headersObj
    if (oauth !== undefined) config.oauth = oauth
    if (timeoutMs) config.timeout = timeoutMs

    setLoading(true)
    setError("") // Clear previous errors
    try {
      console.log("[MCPAddDialog] Adding server:", serverName, config)
      await mcp.add(serverName, config)
      console.log("[MCPAddDialog] Server added successfully")
      props.onBack()
    } catch (e: any) {
      console.error("[MCPAddDialog] Failed to add server:", e)
      const errorMsg = e.message || e.toString() || "Failed to add server"
      setError(errorMsg)
    } finally {
      setLoading(false)
    }
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
          <button
            onClick={props.onBack}
            class="p-1 rounded transition-colors"
            style={{ color: "var(--icon-weak)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-inset)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <ChevronLeft class="w-5 h-5" />
          </button>
          <div class="flex-1">
            <h2 class="text-base font-medium" style={{ color: "var(--text-strong)" }}>
              Add MCP Server
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

        {/* Form - Scrollable */}
        <form onSubmit={handleSubmit} class="p-4 space-y-4 overflow-y-auto flex-1">
          {/* Name Field */}
          <div>
            <label class="block text-sm font-medium mb-1" style={{ color: "var(--text-base)" }}>
              Server Name <span style={{ color: "var(--text-critical-base)" }}>*</span>
            </label>
            <input
              type="text"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              placeholder="my-mcp-server"
              class="w-full px-3 py-2 rounded-md text-sm"
              style={inputStyle}
            />
          </div>

          {/* URL Field */}
          <div>
            <label class="block text-sm font-medium mb-1" style={{ color: "var(--text-base)" }}>
              Server URL
            </label>
            <input
              type="text"
              value={url()}
              onInput={(e) => setUrl(e.currentTarget.value)}
              placeholder="https://mcp.example.com/sse"
              class="w-full px-3 py-2 rounded-md text-sm"
              style={inputStyle}
            />
            <p class="text-xs mt-1" style={{ color: "var(--text-weak)" }}>
              The URL of the remote MCP server (SSE or HTTP endpoint)
            </p>
          </div>

          {/* Advanced Options Toggle */}
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced())}
            class="flex items-center gap-2 text-sm"
            style={{ color: "var(--text-interactive-base)" }}
          >
            <ChevronRight class="w-4 h-4 transition-transform" classList={{ "rotate-90": showAdvanced() }} />
            Advanced Options
          </button>

          <Show when={showAdvanced()}>
            <div class="space-y-4 pl-4" style={{ "border-left": "2px solid var(--border-base)" }}>
              {/* Timeout */}
              <div>
                <label class="block text-sm font-medium mb-1" style={{ color: "var(--text-base)" }}>
                  Timeout (ms)
                </label>
                <input
                  type="text"
                  value={timeout()}
                  onInput={(e) => setTimeout(e.currentTarget.value)}
                  placeholder="30000"
                  class="w-full px-3 py-2 rounded-md text-sm"
                  style={inputStyle}
                />
                <p class="text-xs mt-1" style={{ color: "var(--text-weak)" }}>
                  Request timeout in milliseconds (default: 30000)
                </p>
              </div>

              {/* Headers */}
              <div>
                <div class="flex items-center justify-between mb-2">
                  <label class="text-sm font-medium" style={{ color: "var(--text-base)" }}>
                    HTTP Headers
                  </label>
                  <Button type="button" onClick={addHeader} variant="ghost" size="sm">
                    + Add
                  </Button>
                </div>
                <div class="space-y-2">
                  <For each={headers()}>
                    {(header, index) => (
                      <div class="flex gap-2">
                        <input
                          type="text"
                          value={header.key}
                          onInput={(e) => updateHeader(index(), "key", e.currentTarget.value)}
                          placeholder="Header-Name"
                          class="flex-1 px-2 py-1.5 rounded text-sm"
                          style={inputStyle}
                        />
                        <input
                          type="text"
                          value={header.value}
                          onInput={(e) => updateHeader(index(), "value", e.currentTarget.value)}
                          placeholder="value"
                          class="flex-1 px-2 py-1.5 rounded text-sm"
                          style={inputStyle}
                        />
                        <button
                          type="button"
                          onClick={() => removeHeader(index())}
                          class="p-1.5 rounded"
                          style={{ color: "var(--icon-critical-base)" }}
                        >
                          <X class="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </For>
                </div>
                <p class="text-xs mt-1" style={{ color: "var(--text-weak)" }}>
                  Custom HTTP headers (e.g., Authorization: Bearer token)
                </p>
              </div>

              {/* OAuth Settings */}
              <div>
                <div class="flex items-center gap-3 mb-2">
                  <label class="text-sm font-medium" style={{ color: "var(--text-base)" }}>
                    OAuth Authentication
                  </label>
                  <button
                    type="button"
                    onClick={() => setOauthEnabled(!oauthEnabled())}
                    class="relative w-10 h-5 rounded-full transition-colors"
                    style={{
                      background: oauthEnabled() ? "var(--interactive-base)" : "var(--surface-inset)",
                    }}
                  >
                    <div
                      class="absolute top-0.5 w-4 h-4 rounded-full transition-transform"
                      style={{
                        background: "var(--background-base)",
                        left: oauthEnabled() ? "calc(100% - 18px)" : "2px",
                      }}
                    />
                  </button>
                </div>

                <Show when={oauthEnabled()}>
                  <div class="space-y-3 mt-3">
                    <div>
                      <input
                        type="text"
                        value={oauthClientId()}
                        onInput={(e) => setOauthClientId(e.currentTarget.value)}
                        placeholder="Client ID (optional)"
                        class="w-full px-2 py-1.5 rounded text-sm"
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <input
                        type="password"
                        value={oauthClientSecret()}
                        onInput={(e) => setOauthClientSecret(e.currentTarget.value)}
                        placeholder="Client Secret (optional)"
                        class="w-full px-2 py-1.5 rounded text-sm"
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <input
                        type="text"
                        value={oauthScope()}
                        onInput={(e) => setOauthScope(e.currentTarget.value)}
                        placeholder="Scopes (optional, space-separated)"
                        class="w-full px-2 py-1.5 rounded text-sm"
                        style={inputStyle}
                      />
                    </div>
                    <p class="text-xs" style={{ color: "var(--text-weak)" }}>
                      Leave empty for automatic client registration (RFC 7591)
                    </p>
                  </div>
                </Show>

                <Show when={!oauthEnabled()}>
                  <p class="text-xs" style={{ color: "var(--text-weak)" }}>
                    OAuth auto-detection is disabled
                  </p>
                </Show>
              </div>
            </div>
          </Show>

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
          <Button type="submit" disabled={loading() || !name().trim()} variant="ghost" class="w-full">
            {loading() ? "Adding..." : "Add Server"}
          </Button>
        </form>
      </div>
    </div>
  )
}
