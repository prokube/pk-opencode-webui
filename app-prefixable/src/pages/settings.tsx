import { createSignal, For, Show, type JSX, createMemo, onMount, onCleanup, createEffect } from "solid-js"
import { Portal } from "solid-js/web"
import { Spinner } from "../components/ui/spinner"
import { useProviders } from "../context/providers"
import { useMCP } from "../context/mcp"
import { useSDK } from "../context/sdk"
import { MCPAddDialog } from "../components/mcp-add-dialog"
import { ConfirmDialog } from "../components/confirm-dialog"
import { Button } from "../components/ui/button"
import { Check, Copy, Plug, GitBranch, Server, ExternalLink, Key, Search, X, Plus, Trash2, BookmarkPlus, Pencil, Palette, Sun, Moon, Monitor } from "lucide-solid"
import { useSavedPrompts } from "../context/saved-prompts"
import { useTheme } from "../context/theme"

export function Settings() {
  const providers = useProviders()
  const mcp = useMCP()
  const { client, global, url, directory } = useSDK()
  const theme = useTheme()
  const [selectedProvider, setSelectedProvider] = createSignal<string | null>(null)
  const [apiKey, setApiKey] = createSignal("")
  const [connecting, setConnecting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [success, setSuccess] = createSignal<string | null>(null)
  // Initialize tab from URL hash, default to "providers"
  const getInitialTab = () => {
    const hash = window.location.hash.slice(1)
    const validTabs = ["providers", "git", "mcp", "prompts", "appearance"]
    return validTabs.includes(hash) ? hash : "providers"
  }
  const [activeTab, setActiveTab] = createSignal(getInitialTab())
  const [showMCPAddDialog, setShowMCPAddDialog] = createSignal(false)
  const [mcpLoading, setMcpLoading] = createSignal<string | null>(null)
  const [mcpDeleting, setMcpDeleting] = createSignal<string | null>(null)
  const [mcpToDelete, setMcpToDelete] = createSignal<string | null>(null)

  // Saved prompts
  const savedPrompts = useSavedPrompts()
  const [promptDialogOpen, setPromptDialogOpen] = createSignal(false)
  const [editingPromptId, setEditingPromptId] = createSignal<string | null>(null)
  const [promptTitle, setPromptTitle] = createSignal("")
  const [promptText, setPromptText] = createSignal("")
  const [promptToDelete, setPromptToDelete] = createSignal<string | null>(null)

  // Provider search
  const [providerSearch, setProviderSearch] = createSignal("")

  // OAuth state
  const [oauthPending, setOauthPending] = createSignal<{
    providerID: string
    providerName: string
    methodIndex: number
    method: "auto" | "code"
    instructions: string
    code: string // Extracted code from instructions (e.g., "XXXX-YYYY")
  } | null>(null)
  const [oauthCode, setOauthCode] = createSignal("")
  const [codeCopied, setCodeCopied] = createSignal(false)

  // Git SSH Key state - read-only, display all existing keys
  interface SshKey {
    name: string // e.g. "id_ed25519"
    content: string // public key content
  }
  const [sshKeys, setSshKeys] = createSignal<SshKey[]>([])
  const [sshKeyLoading, setSshKeyLoading] = createSignal(false)
  const [sshKeyError, setSshKeyError] = createSignal<string | null>(null)
  const [sshKeyCopied, setSshKeyCopied] = createSignal<string | null>(null) // tracks which key was copied
  const [sshCommandCopied, setSshCommandCopied] = createSignal(false)
  const [sshKeyLoaded, setSshKeyLoaded] = createSignal(false)

  // Get auth methods for selected provider
  const selectedProviderAuthMethods = createMemo(() => {
    const id = selectedProvider()
    if (!id) return []
    return providers.authMethods[id] || []
  })

  // Popular providers shown first
  const popularProviders = ["opencode", "anthropic", "github-copilot", "openai", "google", "openrouter"]

  // Filtered and sorted providers for display
  const filteredProviders = createMemo(() => {
    const search = providerSearch().toLowerCase().trim()
    const unconnected = providers.providers.filter((p) => !providers.connected.includes(p.id))

    // Filter by search
    const filtered = search
      ? unconnected.filter((p) => p.name.toLowerCase().includes(search) || p.id.toLowerCase().includes(search))
      : unconnected

    // Sort: popular first, then alphabetically
    return filtered.sort((a, b) => {
      const aPopular = popularProviders.indexOf(a.id)
      const bPopular = popularProviders.indexOf(b.id)
      if (aPopular >= 0 && bPopular >= 0) return aPopular - bPopular
      if (aPopular >= 0) return -1
      if (bPopular >= 0) return 1
      return a.name.localeCompare(b.name)
    })
  })

  // Load SSH key when Git tab is first accessed
  function onTabChange(tabId: string) {
    setActiveTab(tabId)
    // Persist tab in URL hash for refresh persistence
    window.history.replaceState(null, "", `#${tabId}`)
    if (tabId === "git" && !sshKeyLoaded()) {
      setSshKeyLoaded(true)
      loadSshKey()
    }
  }

  // Load SSH key on mount if starting on git tab
  onMount(() => {
    if (activeTab() === "git" && !sshKeyLoaded()) {
      setSshKeyLoaded(true)
      loadSshKey()
    }
  })

  async function runPtyCommand(command: string, timeout = 5000): Promise<string> {
    console.log("[runPtyCommand] Starting with command:", command)
    try {
      // Create PTY that directly runs the command via sh -c
      // Add a sleep at the end to give us time to connect and read the output
      // The sleep keeps the process alive until we've read all data
      // cd to $HOME first to ensure we're in a valid directory for SSH operations
      const marker = `__DONE_${Date.now()}__`
      const fullCommand = `cd ~ && ${command}; echo "${marker}"; sleep 2`

      // Use global client (no directory header) to avoid project context issues
      // Use /usr/bin/env sh instead of /bin/sh to avoid the PTY code
      // appending -l flag which breaks -c execution
      // Use /tmp as cwd - it always exists and is writable
      const ptyRes = await global.pty.create({
        command: "/usr/bin/env",
        args: ["sh", "-c", fullCommand],
        cwd: "/tmp",
      })

      console.log("[runPtyCommand] PTY create response:", ptyRes)

      if (!ptyRes.data?.id) {
        console.error("[runPtyCommand] Failed to create PTY:", ptyRes)
        return ""
      }

      const ptyId = ptyRes.data.id
      const wsUrl = url.replace(/^http/, "ws") + `/pty/${ptyId}/connect`
      console.log("[runPtyCommand] Connecting to:", wsUrl)

      const output = await new Promise<string>((resolve) => {
        let data = ""
        const ws = new WebSocket(wsUrl)

        const timeoutId = setTimeout(() => {
          console.log("[runPtyCommand] Timeout reached. Data collected:", data)
          ws.close()
          resolve(data)
        }, timeout)

        ws.addEventListener("open", () => {
          console.log("[runPtyCommand] WebSocket connected")
        })

        ws.addEventListener("message", async (event) => {
          const text = event.data instanceof Blob ? await event.data.text() : String(event.data)
          console.log("[runPtyCommand] Received message:", text)
          data += text

          // Check if we got the completion marker
          if (data.includes(marker)) {
            console.log("[runPtyCommand] Marker found, closing")
            clearTimeout(timeoutId)
            ws.close()
            resolve(data)
          }
        })

        ws.addEventListener("close", () => {
          console.log("[runPtyCommand] WebSocket closed, total output length:", data.length)
          clearTimeout(timeoutId)
          resolve(data)
        })

        ws.addEventListener("error", (e) => {
          console.error("[runPtyCommand] WebSocket error:", e)
          clearTimeout(timeoutId)
          resolve(data)
        })
      })

      console.log("[runPtyCommand] Final output:", output)
      await global.pty.remove({ ptyID: ptyId }).catch(() => {})
      return output
    } catch (e) {
      console.error("[runPtyCommand] Error:", e)
      return ""
    }
  }

  // Strip ANSI escape codes and PTY protocol artifacts from terminal output
  function stripTerminalArtifacts(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str
      .replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[\?[0-9;]*[a-zA-Z]/g, "") // ANSI codes
      .replace(/[\x00-\x1f\uFFFD]*\{"cursor":\d+\}/g, "") // PTY cursor position JSON with any leading control chars
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "") // Remove remaining control characters (except \t \n \r)
  }

  // Load SSH keys - read-only, find all .pub files in ~/.ssh/
  async function loadSshKey() {
    setSshKeyLoading(true)
    setSshKeyError(null)
    console.log("[loadSshKey] Starting")
    try {
      // List all .pub files in ~/.ssh/
      const lsOutput = await runPtyCommand(`ls -1 ~/.ssh/*.pub 2>/dev/null`)
      const cleanLsOutput = stripTerminalArtifacts(lsOutput)

      // Extract filenames from ls output
      const pubFiles = cleanLsOutput
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.endsWith(".pub") && !line.includes("*"))

      console.log("[loadSshKey] Found .pub files:", pubFiles)

      const foundKeys: SshKey[] = []

      for (const pubFile of pubFiles) {
        const content = await runPtyCommand(`cat "${pubFile}" 2>/dev/null`)
        const cleanContent = stripTerminalArtifacts(content)
        const keyContent = cleanContent
          .split("\n")
          .find((line) => {
            const trimmed = line.trim()
            return trimmed.startsWith("ssh-") || trimmed.startsWith("ecdsa-")
          })
          ?.trim()

        if (keyContent) {
          // Extract just the filename without path and .pub extension
          const keyName =
            pubFile
              .split("/")
              .pop()
              ?.replace(/\.pub$/, "") || pubFile
          console.log("[loadSshKey] Found key:", keyName)
          foundKeys.push({ name: keyName, content: keyContent })
        }
      }

      // Sort keys: standard names first, then alphabetically
      const standardOrder = ["id_ed25519", "id_ecdsa", "id_rsa", "id_dsa"]
      foundKeys.sort((a, b) => {
        const aIdx = standardOrder.indexOf(a.name)
        const bIdx = standardOrder.indexOf(b.name)
        if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx
        if (aIdx >= 0) return -1
        if (bIdx >= 0) return 1
        return a.name.localeCompare(b.name)
      })

      console.log("[loadSshKey] Total keys found:", foundKeys.length)
      setSshKeys(foundKeys)
    } catch (e) {
      console.error("[loadSshKey] Failed to load SSH keys:", e)
      setSshKeyError("Failed to check for SSH keys")
    } finally {
      setSshKeyLoading(false)
    }
  }

  async function copySshKey(keyName: string, keyContent: string) {
    try {
      await navigator.clipboard.writeText(keyContent)
      setSshKeyCopied(keyName)
      setTimeout(() => setSshKeyCopied(null), 2000)
    } catch (e) {
      console.error("Failed to copy:", e)
    }
  }

  async function copySshCommand() {
    const cmd = "ssh-keygen -t ed25519"
    try {
      await navigator.clipboard.writeText(cmd)
      setSshCommandCopied(true)
      setTimeout(() => setSshCommandCopied(false), 2000)
    } catch (e) {
      console.error("Failed to copy:", e)
    }
  }

  async function handleConnect(e: SubmitEvent) {
    e.preventDefault()
    const providerID = selectedProvider()
    const key = apiKey().trim()

    if (!providerID || !key) return

    setConnecting(true)
    setError(null)
    setSuccess(null)

    const ok = await providers.connectProvider(providerID, key)

    setConnecting(false)

    if (ok) {
      setSuccess(`Connected to ${providerID}!`)
      setApiKey("")
      setSelectedProvider(null)
    } else {
      setError("Failed to connect. Please check your API key.")
    }
  }

  async function handleOAuthStart(providerID: string, methodIndex: number) {
    setError(null)
    setSuccess(null)

    const result = await providers.startOAuth(providerID, methodIndex)

    if (result) {
      // Extract code from instructions (e.g., "Enter code: XXXX-YYYY" -> "XXXX-YYYY")
      const codeMatch = result.instructions.match(/:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i)
      const code = codeMatch ? codeMatch[1] : ""

      const providerName = getProviderDisplayName(providerID)

      if (result.method === "code") {
        // User needs to enter a code manually
        setOauthPending({
          providerID,
          providerName,
          methodIndex,
          method: "code",
          instructions: result.instructions,
          code,
        })
        // Open the authorization URL
        window.open(result.url, "_blank")
      } else {
        // Auto method (device flow) - show code immediately, then start polling
        setOauthPending({
          providerID,
          providerName,
          methodIndex,
          method: "auto",
          instructions: result.instructions,
          code,
        })

        // Open the authorization URL
        window.open(result.url, "_blank")

        // Start the callback immediately - it will poll until user authorizes
        // This call blocks until authorization succeeds or fails
        console.log("[OAuth] Starting auto callback for", providerID, "with code:", code)
        setConnecting(true)
        const ok = await providers.completeOAuth(providerID, methodIndex)
        console.log("[OAuth] Callback result:", ok)
        setConnecting(false)

        if (ok) {
          setSuccess(`Connected to ${providerName}!`)
          setOauthPending(null)
          setSelectedProvider(null)
          setProviderSearch("")
        } else {
          setError("Authentication failed or was cancelled. Please try again.")
          setOauthPending(null)
        }
      }
    } else {
      setError("Failed to start authentication.")
    }
  }

  async function handleOAuthComplete() {
    const pending = oauthPending()
    if (!pending) return

    setConnecting(true)
    setError(null)

    const code = pending.method === "code" ? oauthCode().trim() : undefined
    const ok = await providers.completeOAuth(pending.providerID, pending.methodIndex, code)

    setConnecting(false)

    if (ok) {
      setSuccess(`Connected to ${pending.providerName}!`)
      setOauthPending(null)
      setOauthCode("")
      setSelectedProvider(null)
      setProviderSearch("")
    } else {
      setError("Failed to complete authentication. Please try again.")
    }
  }

  function cancelOAuth() {
    setOauthPending(null)
    setOauthCode("")
    setCodeCopied(false)
    setConnecting(false)
  }

  async function copyCode() {
    const pending = oauthPending()
    if (!pending?.code) return
    try {
      await navigator.clipboard.writeText(pending.code)
      setCodeCopied(true)
      setTimeout(() => setCodeCopied(false), 2000)
    } catch (e) {
      console.error("Failed to copy code:", e)
    }
  }

  function getProviderDisplayName(id: string): string {
    const provider = providers.providers.find((p) => p.id === id)
    return provider?.name ?? id
  }

  async function confirmMcpDelete() {
    const name = mcpToDelete()
    if (!name) return
    setMcpToDelete(null)
    setMcpDeleting(name)
    try {
      await mcp.remove(name)
    } catch (e) {
      console.error("[Settings] Failed to remove MCP server:", e)
    } finally {
      setMcpDeleting(null)
    }
  }

  function openAddPromptDialog() {
    setEditingPromptId(null)
    setPromptTitle("")
    setPromptText("")
    setPromptDialogOpen(true)
  }

  function openEditPromptDialog(id: string) {
    const prompt = savedPrompts.prompts().find((p) => p.id === id)
    if (!prompt) return
    setEditingPromptId(id)
    setPromptTitle(prompt.title)
    setPromptText(prompt.text)
    setPromptDialogOpen(true)
  }

  function savePromptDialog() {
    const title = promptTitle().trim()
    const text = promptText().trim()
    if (!title || !text) return
    const editing = editingPromptId()
    if (editing) {
      savedPrompts.update(editing, { title, text })
    } else {
      savedPrompts.add(title, text)
    }
    setPromptDialogOpen(false)
    setEditingPromptId(null)
    setPromptTitle("")
    setPromptText("")
  }

  function confirmPromptDelete() {
    const id = promptToDelete()
    if (!id) return
    savedPrompts.remove(id)
    setPromptToDelete(null)
  }

  const tabs: Array<{ id: string; label: string; icon: () => JSX.Element }> = [
    { id: "providers", label: "Providers", icon: () => <Plug class="w-4 h-4" /> },
    { id: "git", label: "Git", icon: () => <GitBranch class="w-4 h-4" /> },
    { id: "mcp", label: "MCP Servers", icon: () => <Server class="w-4 h-4" /> },
    { id: "prompts", label: "Prompts", icon: () => <BookmarkPlus class="w-4 h-4" /> },
    { id: "appearance", label: "Appearance", icon: () => <Palette class="w-4 h-4" /> },
  ]

  return (
    <div class="h-full flex" style={{ background: "var(--background-stronger)" }}>
      {/* Tabs sidebar */}
      <div
        class="w-48 shrink-0 flex flex-col py-3 px-2"
        style={{
          background: "var(--background-base)",
          "border-right": "1px solid var(--border-base)",
        }}
      >
        <div class="text-xs font-medium uppercase tracking-wide px-3 py-2" style={{ color: "var(--text-weak)" }}>
          Settings
        </div>
        <div class="space-y-0.5">
          <For each={tabs}>
            {(tab) => (
              <button
                onClick={() => onTabChange(tab.id)}
                class="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors text-left"
                style={{
                  color: activeTab() === tab.id ? "var(--text-interactive-base)" : "var(--text-base)",
                  background: activeTab() === tab.id ? "var(--surface-inset)" : "transparent",
                }}
                onMouseEnter={(e) => {
                  if (activeTab() !== tab.id) e.currentTarget.style.background = "var(--surface-inset)"
                }}
                onMouseLeave={(e) => {
                  if (activeTab() !== tab.id) e.currentTarget.style.background = "transparent"
                }}
              >
                {tab.icon()}
                {tab.label}
              </button>
            )}
          </For>
        </div>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-y-auto">
        <div class="max-w-2xl p-6 space-y-6">
          {/* Providers Tab */}
          <Show when={activeTab() === "providers"}>
            <div class="space-y-6">
              <header>
                <h1 class="text-lg font-medium" style={{ color: "var(--text-strong)" }}>
                  Providers
                </h1>
                <p class="text-sm mt-1" style={{ color: "var(--text-weak)" }}>
                  Connect AI providers to enable chat functionality
                </p>
              </header>

              {/* Connected Providers */}
              <section
                class="rounded-lg overflow-hidden"
                style={{
                  background: "var(--background-base)",
                  border: "1px solid var(--border-base)",
                }}
              >
                <div class="px-4 py-3" style={{ "border-bottom": "1px solid var(--border-base)" }}>
                  <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                    Connected Providers
                  </h2>
                </div>
                <div class="p-4">
                  <Show when={providers.loading}>
                    <div class="flex items-center gap-2" style={{ color: "var(--text-weak)" }}>
                      <Spinner class="w-4 h-4" />
                      <span class="text-sm">Loading connected providers...</span>
                    </div>
                  </Show>

                  <Show when={!providers.loading && providers.connected.length === 0}>
                    <p class="text-sm" style={{ color: "var(--text-weak)" }}>
                      No providers connected yet.
                    </p>
                  </Show>

                  <Show when={!providers.loading && providers.connected.length > 0}>
                    <div class="space-y-2">
                      <For each={providers.connected}>
                        {(providerID) => (
                          <div
                            class="flex items-center justify-between p-3 rounded-md"
                            style={{ background: "var(--surface-inset)" }}
                          >
                            <div class="flex items-center gap-3">
                              <div class="w-6 h-6 bg-green-100 rounded flex items-center justify-center">
                                <Check class="w-3 h-3 text-green-600" />
                              </div>
                              <span class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                                {getProviderDisplayName(providerID)}
                              </span>
                            </div>
                            <span class="text-xs" style={{ color: "var(--text-weak)" }}>
                              Connected
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </section>

              {/* Add Provider */}
              <section
                class="rounded-lg overflow-hidden"
                style={{
                  background: "var(--background-base)",
                  border: "1px solid var(--border-base)",
                }}
              >
                <div class="px-4 py-3" style={{ "border-bottom": "1px solid var(--border-base)" }}>
                  <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                    Add Provider
                  </h2>
                </div>
                <div class="p-4">
                  {/* Success/Error messages at top */}
                  <Show when={success()}>
                    <div class="mb-4 p-3 bg-green-50 border border-green-200 text-green-800 rounded-md text-sm flex items-center justify-between">
                      <span>{success()}</span>
                      <button onClick={() => setSuccess(null)} class="ml-2">
                        <X class="w-4 h-4" />
                      </button>
                    </div>
                  </Show>

                  <Show when={error()}>
                    <div class="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded-md text-sm flex items-center justify-between">
                      <span>{error()}</span>
                      <button onClick={() => setError(null)} class="ml-2">
                        <X class="w-4 h-4" />
                      </button>
                    </div>
                  </Show>

                  {/* OAuth Pending - show prominently at top */}
                  <Show when={oauthPending()}>
                    {(pending) => (
                      <div
                        class="mb-4 p-4 rounded-lg"
                        style={{
                          background: "var(--surface-inset)",
                          border: "1px solid var(--border-base)",
                        }}
                      >
                        <div class="flex items-center justify-between mb-3">
                          <span class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                            Connecting to {pending().providerName}
                          </span>
                          <Show when={!connecting()}>
                            <button
                              onClick={cancelOAuth}
                              class="text-xs px-2 py-1 rounded"
                              style={{ color: "var(--text-weak)" }}
                            >
                              Cancel
                            </button>
                          </Show>
                        </div>

                        {/* Show the code prominently with copy button */}
                        <Show when={pending().code}>
                          <div class="mb-3">
                            <div class="text-xs mb-1" style={{ color: "var(--text-weak)" }}>
                              Enter this code on GitHub:
                            </div>
                            <div class="flex items-center gap-2">
                              <code
                                class="text-2xl font-mono font-bold tracking-wider px-4 py-2 rounded"
                                style={{
                                  background: "var(--background-base)",
                                  color: "var(--text-strong)",
                                  border: "1px solid var(--border-base)",
                                }}
                              >
                                {pending().code}
                              </code>
                              <button
                                onClick={copyCode}
                                class="p-2 rounded transition-colors"
                                style={{
                                  background: "var(--background-base)",
                                  border: "1px solid var(--border-base)",
                                  color: codeCopied() ? "var(--icon-success-base)" : "var(--icon-base)",
                                }}
                                title="Copy code"
                              >
                                <Show when={codeCopied()} fallback={<Copy class="w-4 h-4" />}>
                                  <Check class="w-4 h-4" />
                                </Show>
                              </button>
                            </div>
                          </div>
                        </Show>

                        {/* Auto method - show waiting spinner */}
                        <Show when={pending().method === "auto"}>
                          <div class="flex items-center gap-2">
                            <Spinner class="w-4 h-4" />
                            <span class="text-sm" style={{ color: "var(--text-weak)" }}>
                              Waiting for authorization...
                            </span>
                          </div>
                        </Show>

                        {/* Code method - show input */}
                        <Show when={pending().method === "code"}>
                          <div class="space-y-2">
                            <input
                              type="text"
                              value={oauthCode()}
                              onInput={(e) => setOauthCode(e.currentTarget.value)}
                              placeholder="Paste authorization code here..."
                              class="w-full px-3 py-2 rounded-md text-sm font-mono"
                              style={{
                                background: "var(--background-base)",
                                border: "1px solid var(--border-base)",
                                color: "var(--text-base)",
                              }}
                            />
                            <button
                              type="button"
                              disabled={connecting() || !oauthCode().trim()}
                              onClick={handleOAuthComplete}
                              class="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
                              style={{
                                background: "var(--interactive-base)",
                                color: "white",
                              }}
                            >
                              <Show when={connecting()} fallback="Complete Authentication">
                                <Spinner class="w-4 h-4" />
                                Verifying...
                              </Show>
                            </button>
                          </div>
                        </Show>
                      </div>
                    )}
                  </Show>

                  <form onSubmit={handleConnect} class="space-y-4">
                    {/* Search and Provider Selection */}
                    <Show when={!oauthPending()}>
                      <div>
                        {/* Search input */}
                        <div class="relative mb-3">
                          <Search
                            class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
                            style={{ color: "var(--text-weak)" }}
                          />
                          <input
                            type="text"
                            value={providerSearch()}
                            onInput={(e) => setProviderSearch(e.currentTarget.value)}
                            placeholder="Search providers..."
                            class="w-full pl-9 pr-8 py-2 rounded-md text-sm"
                            style={{
                              background: "var(--background-base)",
                              border: "1px solid var(--border-base)",
                              color: "var(--text-base)",
                            }}
                          />
                          <Show when={providerSearch()}>
                            <button
                              type="button"
                              onClick={() => setProviderSearch("")}
                              class="absolute right-2 top-1/2 -translate-y-1/2 p-1"
                              style={{ color: "var(--text-weak)" }}
                            >
                              <X class="w-4 h-4" />
                            </button>
                          </Show>
                        </div>

                        {/* Provider grid - max height with scroll */}
                        <div class="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto">
                          <For each={filteredProviders()}>
                            {(provider) => (
                              <button
                                type="button"
                                onClick={() => setSelectedProvider(provider.id)}
                                class="p-3 rounded-md text-left transition-colors"
                                style={{
                                  border:
                                    selectedProvider() === provider.id
                                      ? "1px solid var(--interactive-base)"
                                      : "1px solid var(--border-base)",
                                  background:
                                    selectedProvider() === provider.id ? "var(--surface-inset)" : "transparent",
                                }}
                              >
                                <div class="flex items-center gap-2">
                                  <span class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                                    {provider.name}
                                  </span>
                                  <Show when={provider.id === "opencode"}>
                                    <span
                                      class="text-xs px-1.5 py-0.5 rounded"
                                      style={{
                                        background: "var(--interactive-base)",
                                        color: "white",
                                      }}
                                    >
                                      Recommended
                                    </span>
                                  </Show>
                                </div>
                                <div class="text-xs" style={{ color: "var(--text-weak)" }}>
                                  {Object.keys(provider.models).length} models
                                </div>
                              </button>
                            )}
                          </For>
                        </div>

                        <Show when={filteredProviders().length === 0 && providerSearch()}>
                          <p class="text-sm text-center py-4" style={{ color: "var(--text-weak)" }}>
                            No providers found matching "{providerSearch()}"
                          </p>
                        </Show>

                        <Show
                          when={
                            providers.providers.filter((p) => !providers.connected.includes(p.id)).length === 0 &&
                            !providerSearch()
                          }
                        >
                          <p class="text-sm" style={{ color: "var(--text-weak)" }}>
                            All available providers are connected!
                          </p>
                        </Show>
                      </div>
                    </Show>

                    {/* Auth Methods for Selected Provider */}
                    <Show when={selectedProvider() && !oauthPending()}>
                      <div class="space-y-3">
                        <label class="block text-sm font-medium" style={{ color: "var(--text-base)" }}>
                          Connect {getProviderDisplayName(selectedProvider()!)}
                        </label>

                        {/* Show auth method buttons */}
                        <Show
                          when={selectedProviderAuthMethods().length > 0}
                          fallback={
                            /* Fallback to API key input if no auth methods defined */
                            <div class="space-y-3">
                              <input
                                type="password"
                                value={apiKey()}
                                onInput={(e) => setApiKey(e.currentTarget.value)}
                                placeholder="Enter your API key..."
                                class="w-full px-3 py-2 rounded-md text-sm"
                                style={{
                                  background: "var(--background-base)",
                                  border: "1px solid var(--border-base)",
                                  color: "var(--text-base)",
                                }}
                              />
                              <button
                                type="submit"
                                disabled={connecting() || !apiKey().trim()}
                                class="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
                                style={{
                                  background: "var(--interactive-base)",
                                  color: "white",
                                }}
                              >
                                <Show when={connecting()} fallback="Connect with API Key">
                                  <Spinner class="w-4 h-4" />
                                  Connecting...
                                </Show>
                              </button>
                            </div>
                          }
                        >
                          <div class="space-y-2">
                            <For each={selectedProviderAuthMethods()}>
                              {(method, index) => (
                                <Show
                                  when={method.type === "oauth"}
                                  fallback={
                                    /* API key method */
                                    <div class="space-y-2">
                                      <div
                                        class="flex items-center gap-2 text-xs"
                                        style={{ color: "var(--text-weak)" }}
                                      >
                                        <Key class="w-3 h-3" />
                                        <span>{method.label}</span>
                                      </div>
                                      <input
                                        type="password"
                                        value={apiKey()}
                                        onInput={(e) => setApiKey(e.currentTarget.value)}
                                        placeholder="Enter your API key..."
                                        class="w-full px-3 py-2 rounded-md text-sm"
                                        style={{
                                          background: "var(--background-base)",
                                          border: "1px solid var(--border-base)",
                                          color: "var(--text-base)",
                                        }}
                                      />
                                      <button
                                        type="submit"
                                        disabled={connecting() || !apiKey().trim()}
                                        class="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
                                        style={{
                                          background: "var(--interactive-base)",
                                          color: "white",
                                        }}
                                      >
                                        <Show when={connecting()} fallback="Connect">
                                          <Spinner class="w-4 h-4" />
                                          Connecting...
                                        </Show>
                                      </button>
                                    </div>
                                  }
                                >
                                  {/* OAuth method */}
                                  <button
                                    type="button"
                                    disabled={connecting()}
                                    onClick={() => handleOAuthStart(selectedProvider()!, index())}
                                    class="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
                                    style={{
                                      background: "var(--interactive-base)",
                                      color: "white",
                                    }}
                                  >
                                    <Show when={connecting()} fallback={<ExternalLink class="w-4 h-4" />}>
                                      <Spinner class="w-4 h-4" />
                                    </Show>
                                    {method.label}
                                  </button>
                                </Show>
                              )}
                            </For>
                          </div>
                        </Show>

                        <p class="text-xs" style={{ color: "var(--text-weak)" }}>
                          Your credentials are stored securely and never shared.
                        </p>
                      </div>
                    </Show>
                  </form>
                </div>
              </section>
            </div>
          </Show>

          {/* Git Tab */}
          <Show when={activeTab() === "git"}>
            <div class="space-y-6">
              <header>
                <h1 class="text-lg font-medium" style={{ color: "var(--text-strong)" }}>
                  Git Authentication
                </h1>
                <p class="text-sm mt-1" style={{ color: "var(--text-weak)" }}>
                  Configure SSH keys to push and pull from remote repositories
                </p>
              </header>

              {/* SSH Key Section */}
              <section
                class="rounded-lg overflow-hidden"
                style={{
                  background: "var(--background-base)",
                  border: "1px solid var(--border-base)",
                }}
              >
                <div class="px-4 py-3" style={{ "border-bottom": "1px solid var(--border-base)" }}>
                  <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                    SSH Key
                  </h2>
                </div>
                <div class="p-4">
                  <Show when={sshKeyLoading()}>
                    <div class="flex items-center gap-2" style={{ color: "var(--text-weak)" }}>
                      <Spinner class="w-4 h-4" />
                      <span class="text-sm">Checking for SSH key...</span>
                    </div>
                  </Show>

                  <Show when={sshKeyError()}>
                    <div class="p-3 bg-red-50 border border-red-200 text-red-800 rounded-md text-sm mb-4">
                      {sshKeyError()}
                    </div>
                  </Show>

                  {/* No keys found */}
                  <Show when={!sshKeyLoading() && sshKeys().length === 0}>
                    <div class="space-y-4">
                      <p class="text-sm" style={{ color: "var(--text-weak)" }}>
                        No SSH keys found. Generate one using the terminal:
                      </p>

                      {/* Command to copy */}
                      <div class="relative">
                        <pre
                          class="p-3 rounded-md text-sm font-mono"
                          style={{
                            background: "var(--surface-inset)",
                            color: "var(--text-base)",
                          }}
                        >
                          ssh-keygen -t ed25519
                        </pre>
                        <button
                          onClick={copySshCommand}
                          class="absolute top-2 right-2 p-1.5 rounded transition-colors"
                          style={{
                            background: "var(--background-base)",
                            border: "1px solid var(--border-base)",
                            color: sshCommandCopied() ? "var(--icon-success-base)" : "var(--icon-base)",
                          }}
                          title="Copy command"
                        >
                          <Show when={sshCommandCopied()} fallback={<Copy class="w-4 h-4" />}>
                            <Check class="w-4 h-4" />
                          </Show>
                        </button>
                      </div>

                      <p class="text-xs" style={{ color: "var(--text-weak)" }}>
                        Run this command in the terminal, then click Refresh.
                        <br />
                        To use an existing key, copy it to ~/.ssh/ via the terminal.
                      </p>

                      <Button onClick={loadSshKey} variant="secondary" size="sm">
                        Refresh
                      </Button>
                    </div>
                  </Show>

                  {/* Keys found */}
                  <Show when={!sshKeyLoading() && sshKeys().length > 0}>
                    <div class="space-y-4">
                      <div class="flex items-center gap-2 text-sm" style={{ color: "var(--text-base)" }}>
                        <Check class="w-4 h-4" style={{ color: "var(--icon-success-base)" }} />
                        <span>
                          {sshKeys().length} SSH key{sshKeys().length > 1 ? "s" : ""} found
                        </span>
                      </div>

                      {/* All Keys Display */}
                      <div class="space-y-3">
                        <For each={sshKeys()}>
                          {(key) => (
                            <div>
                              <label class="block text-sm font-medium mb-2" style={{ color: "var(--text-base)" }}>
                                {key.name}.pub
                              </label>
                              <div class="relative">
                                <pre
                                  class="p-3 rounded-md text-xs overflow-x-auto"
                                  style={{
                                    background: "var(--surface-inset)",
                                    color: "var(--text-base)",
                                    "word-break": "break-all",
                                    "white-space": "pre-wrap",
                                  }}
                                >
                                  {key.content}
                                </pre>
                                <button
                                  onClick={() => copySshKey(key.name, key.content)}
                                  class="absolute top-2 right-2 p-1.5 rounded transition-colors"
                                  style={{
                                    background: "var(--background-base)",
                                    border: "1px solid var(--border-base)",
                                    color:
                                      sshKeyCopied() === key.name ? "var(--icon-success-base)" : "var(--icon-base)",
                                  }}
                                  title="Copy to clipboard"
                                >
                                  <Show when={sshKeyCopied() === key.name} fallback={<Copy class="w-4 h-4" />}>
                                    <Check class="w-4 h-4" />
                                  </Show>
                                </button>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>

                      <Button onClick={loadSshKey} variant="secondary" size="sm">
                        Refresh
                      </Button>
                    </div>
                  </Show>
                </div>
              </section>

              {/* Instructions Section */}
              <section
                class="rounded-lg p-4"
                style={{
                  background: "var(--surface-inset)",
                  border: "1px solid var(--border-base)",
                }}
              >
                <h3 class="text-sm font-medium mb-3" style={{ color: "var(--text-strong)" }}>
                  Add your key to a Git provider
                </h3>
                <div class="space-y-2 text-sm" style={{ color: "var(--text-weak)" }}>
                  <p>Copy your public key above and add it to:</p>
                  <ul class="list-disc list-inside space-y-1 ml-2">
                    <li>
                      <a
                        href="https://github.com/settings/ssh/new"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="hover:underline"
                        style={{ color: "var(--text-interactive-base)" }}
                      >
                        GitHub
                      </a>
                      {" → Settings → SSH and GPG keys → New SSH key"}
                    </li>
                    <li>
                      <a
                        href="https://gitlab.com/-/user_settings/ssh_keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="hover:underline"
                        style={{ color: "var(--text-interactive-base)" }}
                      >
                        GitLab
                      </a>
                      {" → Preferences → SSH Keys"}
                    </li>
                    <li>
                      <a
                        href="https://bitbucket.org/account/settings/ssh-keys/"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="hover:underline"
                        style={{ color: "var(--text-interactive-base)" }}
                      >
                        Bitbucket
                      </a>
                      {" → Personal settings → SSH keys"}
                    </li>
                  </ul>
                </div>
              </section>
            </div>
          </Show>

          {/* MCP Servers Tab */}
          <Show when={activeTab() === "mcp"}>
            <div class="space-y-6">
              <header>
                <h1 class="text-lg font-medium" style={{ color: "var(--text-strong)" }}>
                  MCP Servers
                </h1>
                <p class="text-sm mt-1" style={{ color: "var(--text-weak)" }}>
                  Model Context Protocol servers extend AI capabilities with tools and resources
                </p>
              </header>

              {/* Server List */}
              <section
                class="rounded-lg overflow-hidden"
                style={{
                  background: "var(--background-base)",
                  border: "1px solid var(--border-base)",
                }}
              >
                <div
                  class="px-4 py-3 flex items-center justify-between"
                  style={{ "border-bottom": "1px solid var(--border-base)" }}
                >
                  <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                    Configured Servers ({mcp.stats().enabled}/{mcp.stats().total} connected)
                  </h2>
                  <Button onClick={() => setShowMCPAddDialog(true)} variant="primary" size="sm">
                    + Add Server
                  </Button>
                </div>

                <Show when={mcp.loading()}>
                  <div class="p-6 flex items-center justify-center gap-2" style={{ color: "var(--text-weak)" }}>
                    <Spinner class="w-4 h-4" />
                    <span class="text-sm">Loading MCP servers...</span>
                  </div>
                </Show>

                <Show when={!mcp.loading() && Object.keys(mcp.servers).length === 0}>
                  <div class="p-6 text-center">
                    <p class="text-sm" style={{ color: "var(--text-weak)" }}>
                      No MCP servers configured yet.
                    </p>
                    <button
                      onClick={() => setShowMCPAddDialog(true)}
                      class="mt-2 text-sm hover:underline"
                      style={{ color: "var(--text-interactive-base)" }}
                    >
                      Add your first server
                    </button>
                  </div>
                </Show>

                <Show when={!mcp.loading() && Object.keys(mcp.servers).length > 0}>
                  <div class="divide-y" style={{ "border-color": "var(--border-base)" }}>
                    <For each={Object.entries(mcp.servers).sort((a, b) => a[0].localeCompare(b[0]))}>
                      {([name, status]) => {
                        const isConnected = () => status.status === "connected"
                        const isFailed = () => status.status === "failed"
                        const needsAuth = () => status.status === "needs_auth"
                        const errorMsg = () => (status.status === "failed" ? (status as any).error : undefined)

                        return (
                          <div class="px-4 py-3 flex items-center justify-between gap-4">
                            <div class="flex-1 min-w-0">
                              <div class="flex items-center gap-2">
                                <span class="font-medium text-sm" style={{ color: "var(--text-strong)" }}>
                                  {name}
                                </span>
                                <span
                                  class="text-xs px-1.5 py-0.5 rounded"
                                  style={{
                                    background: "var(--surface-inset)",
                                    color: isConnected()
                                      ? "var(--icon-success-base)"
                                      : isFailed()
                                        ? "var(--icon-critical-base)"
                                        : needsAuth()
                                          ? "var(--icon-warning-base)"
                                          : "var(--text-weak)",
                                  }}
                                >
                                  {status.status === "connected"
                                    ? "Connected"
                                    : status.status === "disabled"
                                      ? "Disabled"
                                      : status.status === "failed"
                                        ? "Failed"
                                        : status.status === "needs_auth"
                                          ? "Needs Auth"
                                          : status.status}
                                </span>
                                <Show when={mcpLoading() === name}>
                                  <Spinner class="w-3 h-3" />
                                </Show>
                              </div>
                              <Show when={errorMsg()}>
                                <p class="text-xs mt-0.5 truncate" style={{ color: "var(--text-weak)" }}>
                                  {errorMsg()}
                                </p>
                              </Show>
                            </div>

                            <div class="flex items-center gap-2">
                              <Show when={needsAuth()}>
                                <button
                                  onClick={async () => {
                                    setMcpLoading(name)
                                    const result = await mcp.startAuth(name)
                                    if (result?.authorizationUrl) {
                                      window.open(result.authorizationUrl, "_blank")
                                    }
                                    setMcpLoading(null)
                                  }}
                                  class="text-xs px-2 py-1 rounded"
                                  style={{
                                    background: "var(--surface-inset)",
                                    color: "var(--text-interactive-base)",
                                  }}
                                >
                                  Authenticate
                                </button>
                              </Show>

                              {/* Toggle Switch */}
                              <button
                                onClick={async () => {
                                  setMcpLoading(name)
                                  if (isConnected()) {
                                    await mcp.disconnect(name)
                                  } else {
                                    await mcp.connect(name)
                                  }
                                  setMcpLoading(null)
                                }}
                                disabled={mcpLoading() === name || mcpDeleting() === name}
                                class="relative w-10 h-5 rounded-full transition-colors disabled:opacity-50"
                                style={{
                                  background: isConnected() ? "var(--interactive-base)" : "var(--surface-inset)",
                                }}
                              >
                                <div
                                  class="absolute top-0.5 w-4 h-4 rounded-full transition-all"
                                  style={{
                                    background: "white",
                                    left: isConnected() ? "calc(100% - 18px)" : "2px",
                                  }}
                                />
                              </button>

                              {/* Delete Button */}
                              <button
                                onClick={() => {
                                  if (mcpLoading() || mcpDeleting()) return
                                  setMcpToDelete(name)
                                }}
                                disabled={mcpLoading() === name || mcpDeleting() === name}
                                class="p-1 rounded transition-colors opacity-50 hover:opacity-100 disabled:opacity-30"
                                style={{ color: "var(--icon-critical-base)" }}
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
                </Show>
              </section>

              {/* Info Section */}
              <section
                class="rounded-lg p-4"
                style={{
                  background: "var(--surface-inset)",
                  border: "1px solid var(--border-base)",
                }}
              >
                <h3 class="text-sm font-medium mb-2" style={{ color: "var(--text-strong)" }}>
                  About MCP
                </h3>
                <p class="text-xs" style={{ color: "var(--text-weak)" }}>
                  The Model Context Protocol (MCP) allows AI assistants to access external tools, APIs, and data
                  sources. Servers can be local (running commands on your machine) or remote (connecting to hosted
                  services).
                </p>
                <a
                  href="https://modelcontextprotocol.io"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs mt-2 inline-block hover:underline"
                  style={{ color: "var(--text-interactive-base)" }}
                >
                  Learn more about MCP →
                </a>
              </section>
            </div>
          </Show>

          {/* Prompts Tab */}
          <Show when={activeTab() === "prompts"}>
            <div class="space-y-6">
              <header>
                <h1 class="text-lg font-medium" style={{ color: "var(--text-strong)" }}>
                  Saved Prompts
                </h1>
                <p class="text-sm mt-1" style={{ color: "var(--text-weak)" }}>
                  Create reusable prompts for quick access from the welcome screen or /prompt command
                </p>
              </header>

              <section
                class="rounded-lg overflow-hidden"
                style={{
                  background: "var(--background-base)",
                  border: "1px solid var(--border-base)",
                }}
              >
                <div
                  class="px-4 py-3 flex items-center justify-between"
                  style={{ "border-bottom": "1px solid var(--border-base)" }}
                >
                  <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                    Prompts ({savedPrompts.prompts().length})
                  </h2>
                  <Button onClick={openAddPromptDialog} variant="primary" size="sm">
                    + Add Prompt
                  </Button>
                </div>

                <Show when={savedPrompts.prompts().length === 0}>
                  <div class="p-6 text-center">
                    <p class="text-sm" style={{ color: "var(--text-weak)" }}>
                      No saved prompts yet.
                    </p>
                    <button
                      onClick={openAddPromptDialog}
                      class="mt-2 text-sm hover:underline"
                      style={{ color: "var(--text-interactive-base)" }}
                    >
                      Create your first prompt
                    </button>
                  </div>
                </Show>

                <Show when={savedPrompts.prompts().length > 0}>
                  <div class="divide-y" style={{ "border-color": "var(--border-base)" }}>
                    <For each={savedPrompts.prompts()}>
                      {(prompt) => (
                        <div class="px-4 py-3 flex items-start justify-between gap-4">
                          <div class="flex-1 min-w-0">
                            <div class="font-medium text-sm" style={{ color: "var(--text-strong)" }}>
                              {prompt.title}
                            </div>
                            <p
                              class="text-xs mt-0.5 line-clamp-2"
                              style={{ color: "var(--text-weak)" }}
                            >
                              {prompt.text.length > 120 ? prompt.text.slice(0, 120) + "..." : prompt.text}
                            </p>
                          </div>
                          <div class="flex items-center gap-1 shrink-0">
                            <button
                              onClick={() => openEditPromptDialog(prompt.id)}
                              class="p-1.5 rounded transition-colors"
                              style={{ color: "var(--text-weak)" }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.background = "var(--surface-inset)"
                                e.currentTarget.style.color = "var(--text-strong)"
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.background = "transparent"
                                e.currentTarget.style.color = "var(--text-weak)"
                              }}
                              title="Edit prompt"
                              aria-label="Edit prompt"
                            >
                              <Pencil class="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => setPromptToDelete(prompt.id)}
                              class="p-1.5 rounded transition-colors opacity-50 hover:opacity-100"
                              style={{ color: "var(--icon-critical-base)" }}
                              title="Delete prompt"
                              aria-label="Delete prompt"
                            >
                              <Trash2 class="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </section>
            </div>
          </Show>

          {/* Appearance Tab */}
          <Show when={activeTab() === "appearance"}>
            <div class="space-y-6">
              <header>
                <h1 class="text-lg font-medium" style={{ color: "var(--text-strong)" }}>
                  Appearance
                </h1>
                <p class="text-sm mt-1" style={{ color: "var(--text-weak)" }}>
                  Customize the look and feel of the interface
                </p>
              </header>

              <section
                class="rounded-lg overflow-hidden"
                style={{
                  background: "var(--background-base)",
                  border: "1px solid var(--border-base)",
                }}
              >
                <div class="px-4 py-3" style={{ "border-bottom": "1px solid var(--border-base)" }}>
                  <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                    Theme
                  </h2>
                </div>
                <div class="p-4">
                  <div class="flex gap-2">
                    <For each={[
                      { value: "light" as const, label: "Light", icon: () => <Sun class="w-4 h-4" /> },
                      { value: "dark" as const, label: "Dark", icon: () => <Moon class="w-4 h-4" /> },
                      { value: "system" as const, label: "System", icon: () => <Monitor class="w-4 h-4" /> },
                    ]}>
                      {(option) => (
                        <button
                          onClick={() => theme.setTheme(option.value)}
                          class="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors"
                          style={{
                            background: theme.theme() === option.value ? "var(--interactive-base)" : "var(--surface-inset)",
                            color: theme.theme() === option.value ? "white" : "var(--text-base)",
                            border: theme.theme() === option.value ? "1px solid var(--interactive-base)" : "1px solid var(--border-base)",
                          }}
                        >
                          {option.icon()}
                          {option.label}
                        </button>
                      )}
                    </For>
                  </div>
                  <p class="text-xs mt-3" style={{ color: "var(--text-weak)" }}>
                    {theme.theme() === "system"
                      ? `System preference detected: ${theme.resolved()}`
                      : `Current theme: ${theme.theme()}`}
                  </p>
                </div>
              </section>
            </div>
          </Show>
        </div>
      </div>

      {/* MCP Add Dialog */}
      <Show when={showMCPAddDialog()}>
        <MCPAddDialog onClose={() => setShowMCPAddDialog(false)} onBack={() => setShowMCPAddDialog(false)} />
      </Show>

      {/* MCP Delete Confirmation */}
      <ConfirmDialog
        open={!!mcpToDelete()}
        title="Remove MCP Server"
        message={`Are you sure you want to remove "${mcpToDelete()}"?`}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={confirmMcpDelete}
        onCancel={() => setMcpToDelete(null)}
      />

      {/* Prompt Add/Edit Dialog */}
      <Show when={promptDialogOpen()}>
        <PromptDialog
          editing={editingPromptId()}
          title={promptTitle}
          setTitle={setPromptTitle}
          text={promptText}
          setText={setPromptText}
          onSave={savePromptDialog}
          onClose={() => setPromptDialogOpen(false)}
        />
      </Show>

      {/* Prompt Delete Confirmation */}
      <ConfirmDialog
        open={!!promptToDelete()}
        title="Delete Prompt"
        message="Are you sure you want to delete this saved prompt?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={confirmPromptDelete}
        onCancel={() => setPromptToDelete(null)}
      />
    </div>
  )
}

function PromptDialog(props: {
  editing: string | null
  title: () => string
  setTitle: (v: string) => void
  text: () => string
  setText: (v: string) => void
  onSave: () => void
  onClose: () => void
}) {
  const [container, setContainer] = createSignal<HTMLDivElement>()
  let titleRef: HTMLInputElement | undefined

  createEffect(() => {
    const el = container()
    if (!el) return

    // Focus title input on open
    titleRef?.focus()

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault()
        props.onClose()
        return
      }
      if (e.key !== "Tab") return

      const focusable = el!.querySelectorAll<HTMLElement>(
        'input, textarea, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last?.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first?.focus()
      }
    }

    document.addEventListener("keydown", handleKey)
    onCleanup(() => document.removeEventListener("keydown", handleKey))
  })

  return (
    <Portal>
      <div
        class="fixed inset-0 z-[100] flex items-center justify-center"
        style={{ background: "rgba(0,0,0,0.5)" }}
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose()
        }}
        role="presentation"
      >
        <div
          ref={setContainer}
          role="dialog"
          aria-modal="true"
          aria-labelledby="prompt-dialog-title"
          class="w-full max-w-md rounded-lg shadow-xl overflow-hidden"
          style={{
            background: "var(--background-base)",
            border: "1px solid var(--border-base)",
          }}
        >
          <div class="px-4 py-3" style={{ "border-bottom": "1px solid var(--border-base)" }}>
            <h2 id="prompt-dialog-title" class="text-base font-medium" style={{ color: "var(--text-strong)" }}>
              {props.editing ? "Edit Prompt" : "Add Prompt"}
            </h2>
          </div>
          <div class="p-4 space-y-4">
            <div>
              <label class="block text-sm font-medium mb-1" style={{ color: "var(--text-base)" }}>
                Title
              </label>
              <input
                ref={titleRef}
                type="text"
                value={props.title()}
                onInput={(e) => props.setTitle(e.currentTarget.value)}
                placeholder="e.g. Code Review"
                class="w-full px-3 py-2 rounded-md text-sm"
                style={{
                  background: "var(--background-base)",
                  border: "1px solid var(--border-base)",
                  color: "var(--text-base)",
                }}
              />
            </div>
            <div>
              <label class="block text-sm font-medium mb-1" style={{ color: "var(--text-base)" }}>
                Prompt Text
              </label>
              <textarea
                value={props.text()}
                onInput={(e) => props.setText(e.currentTarget.value)}
                placeholder="Enter the prompt text..."
                rows={6}
                class="w-full px-3 py-2 rounded-md text-sm resize-y"
                style={{
                  background: "var(--background-base)",
                  border: "1px solid var(--border-base)",
                  color: "var(--text-base)",
                  "min-height": "120px",
                }}
              />
            </div>
          </div>
          <div
            class="px-4 py-3 flex justify-end gap-2"
            style={{ "border-top": "1px solid var(--border-base)" }}
          >
            <button
              type="button"
              onClick={props.onClose}
              class="px-4 py-2 text-sm font-medium rounded-md transition-colors"
              style={{
                background: "var(--surface-inset)",
                color: "var(--text-base)",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={props.onSave}
              disabled={!props.title().trim() || !props.text().trim()}
              class="px-4 py-2 text-sm font-medium rounded-md transition-colors disabled:opacity-50"
              style={{
                background: "var(--interactive-base)",
                color: "white",
              }}
            >
              {props.editing ? "Save Changes" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  )
}
