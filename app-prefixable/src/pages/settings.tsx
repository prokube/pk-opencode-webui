import { createSignal, For, Show, type JSX, createMemo, onMount, onCleanup, createEffect } from "solid-js"
import { Portal } from "solid-js/web"
import { Spinner } from "../components/ui/spinner"
import { useProviders } from "../context/providers"
import { useMCP } from "../context/mcp"
import { useSDK } from "../context/sdk"
import { useBasePath } from "../context/base-path"
import { useConfig } from "../context/config"
import { MCPAddDialog } from "../components/mcp-add-dialog"
import { ConfirmDialog } from "../components/confirm-dialog"
import { Button } from "../components/ui/button"
import { Check, Copy, Plug, GitBranch, Server, ExternalLink, Key, Search, X, Trash2, BookmarkPlus, Pencil, Palette, Sun, Moon, Monitor, BookOpen, Plus, Save, Volume2, Play, Settings2, Code, Shield, Cpu, Wrench, ChevronDown, ChevronRight, Info } from "lucide-solid"
import { SOUND_OPTIONS, readSoundSettings, writeSoundSettings, playSound, primeAudioContext, SOUND_STORAGE_KEY, type SoundSettings } from "../utils/sound"
import { useSavedPrompts } from "../context/saved-prompts"
import { useTheme } from "../context/theme"
import { writeFile } from "../utils/extended-api"
import type { Config, PermissionActionConfig } from "../sdk/client"

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
    const baseTabs = ["providers", "git", "mcp", "prompts", "instructions", "appearance", "sounds"]
    const validTabs = directory ? [...baseTabs, "config"] : baseTabs
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

  // Sound settings
  const [soundSettings, setSoundSettings] = createSignal<SoundSettings>(readSoundSettings())

  // Keep soundSettings in sync with localStorage changes from other tabs
  onMount(() => {
    function handleStorage(e: StorageEvent) {
      if (e.key === SOUND_STORAGE_KEY) setSoundSettings(readSoundSettings())
    }
    window.addEventListener("storage", handleStorage)
    onCleanup(() => window.removeEventListener("storage", handleStorage))
  })

  function updateSoundSettings(patch: Partial<SoundSettings>) {
    const next = { ...soundSettings(), ...patch }
    setSoundSettings(next)
    writeSoundSettings(next)
  }

  // Provider search
  const [providerSearch, setProviderSearch] = createSignal("")

  // Instructions state
  const basePath = useBasePath()
  const [instructionPaths, setInstructionPaths] = createSignal<string[]>([])
  const [instructionContents, setInstructionContents] = createSignal<Record<string, { content: string; exists: boolean }>>({})
  const [instructionEdits, setInstructionEdits] = createSignal<Record<string, string>>({})
  const [instructionLoading, setInstructionLoading] = createSignal(false)
  const [instructionSaving, setInstructionSaving] = createSignal<string | null>(null)
  const [instructionSaved, setInstructionSaved] = createSignal<string | null>(null)
  const [instructionError, setInstructionError] = createSignal<string | null>(null)
  const [instructionCreating, setInstructionCreating] = createSignal(false)
  const [instructionLoaded, setInstructionLoaded] = createSignal(false)

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
    if (tabId === "instructions" && directory && !instructionLoaded()) {
      setInstructionLoaded(true)
      loadInstructions()
    }
  }

  // Load SSH key on mount if starting on git tab
  onMount(() => {
    if (activeTab() === "git" && !sshKeyLoaded()) {
      setSshKeyLoaded(true)
      loadSshKey()
    }
    if (activeTab() === "instructions" && directory && !instructionLoaded()) {
      setInstructionLoaded(true)
      loadInstructions()
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

  async function loadInstructions() {
    setInstructionLoading(true)
    setInstructionError(null)
    const configRes = await client.config.get().catch(() => null)
    const cfg = configRes?.data as Config | undefined
    const paths = cfg?.instructions ?? []
    setInstructionPaths(paths)

    const contents: Record<string, { content: string; exists: boolean }> = {}
    for (const p of paths) {
      const fileRes = await client.file.read({ path: p, directory }).catch(() => null)
      const data = fileRes?.data as { content?: string } | undefined
      if (data?.content !== undefined) {
        contents[p] = { content: data.content, exists: true }
      } else {
        contents[p] = { content: "", exists: false }
      }
    }
    setInstructionContents(contents)
    setInstructionEdits({})
    setInstructionLoading(false)
  }

  async function saveInstruction(path: string) {
    const edits = instructionEdits()
    const content = edits[path]
    if (content === undefined) return

    // Build absolute path if relative
    const absolute = path.startsWith("/") ? path : (directory ? `${directory.replace(/\/$/, "")}/${path}` : path)

    setInstructionSaving(path)
    setInstructionError(null)
    const ok = await writeFile(basePath.serverUrl, absolute, content)
    setInstructionSaving(null)
    if (!ok) {
      setInstructionError(`Failed to save ${path}`)
      return
    }
    // Update stored content
    setInstructionContents((prev) => ({ ...prev, [path]: { content, exists: true } }))
    setInstructionEdits((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })
    setInstructionSaved(path)
    setTimeout(() => setInstructionSaved(null), 2000)
  }

  async function createInstructionsFile() {
    if (!directory) return
    setInstructionCreating(true)
    setInstructionError(null)

    const template = `# Project Instructions

These instructions are automatically included in every session.

## Coding Conventions

- Use TypeScript for all new code
- Follow existing code style and patterns
- Prefer functional style where possible

## Project-Specific Notes

Add your project-specific instructions here.
`
    const agentsPath = `${directory.replace(/\/$/, "")}/AGENTS.md`

    // Check if AGENTS.md already exists before writing to avoid overwriting user content
    const existingAgents = await client.file.read({ path: "AGENTS.md", directory }).catch(() => null)
    const agentsData = existingAgents?.data as { content?: string } | undefined
    if (!agentsData?.content) {
      // File doesn't exist — write the template
      const ok = await writeFile(basePath.serverUrl, agentsPath, template)
      if (!ok) {
        setInstructionError("Failed to create AGENTS.md")
        setInstructionCreating(false)
        return
      }
    }

    // Update config via backend API so the change is immediately visible
    const configRes = await client.config.get().catch(() => null)
    if (!configRes?.data) {
      setInstructionError("Failed to fetch project config")
      setInstructionCreating(false)
      return
    }
    const cfg = configRes.data as Config
    const existingInstructions = cfg.instructions ?? []
    const hasAgents = existingInstructions.includes("AGENTS.md")
    if (!hasAgents) {
      const instructions = [...existingInstructions, "AGENTS.md"]
      const updateRes = await client.config.update({ config: { instructions } }).catch(() => null)
      if (!updateRes?.data) {
        setInstructionError("Failed to update project instructions. Please try again.")
        setInstructionCreating(false)
        return
      }
    }

    setInstructionCreating(false)
    // Reload instructions
    await loadInstructions()
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

  // Scope badge type for each tab
  type ScopeBadge = "Global" | "Project" | "Global + Project" | null

  const tabs = createMemo(() => {
    const base: Array<{ id: string; label: string; icon: () => JSX.Element; scope: ScopeBadge }> = [
      { id: "providers", label: "Providers", icon: () => <Plug class="w-4 h-4" />, scope: "Global" },
      { id: "git", label: "Git", icon: () => <GitBranch class="w-4 h-4" />, scope: "Global" },
      { id: "mcp", label: "MCP Servers", icon: () => <Server class="w-4 h-4" />, scope: "Global + Project" },
      { id: "prompts", label: "Prompts", icon: () => <BookmarkPlus class="w-4 h-4" />, scope: directory ? "Project" : null },
      { id: "instructions", label: "Instructions", icon: () => <BookOpen class="w-4 h-4" />, scope: directory ? "Project" : null },
    ]
    // Only show Project Config tab when a project directory is selected
    if (directory) {
      base.push({ id: "config", label: "Project Config", icon: () => <Settings2 class="w-4 h-4" />, scope: "Project" })
    }
    base.push({ id: "appearance", label: "Appearance", icon: () => <Palette class="w-4 h-4" />, scope: null })
    base.push({ id: "sounds", label: "Sounds", icon: () => <Volume2 class="w-4 h-4" />, scope: null })
    return base
  })

  return (
    <div class="h-full flex" style={{ background: "var(--background-stronger)" }}>
      {/* Tabs sidebar */}
      <div
        class="w-56 shrink-0 flex flex-col py-3 px-2"
        style={{
          background: "var(--background-base)",
          "border-right": "1px solid var(--border-base)",
        }}
      >
        <div class="text-xs font-medium uppercase tracking-wide px-3 py-2" style={{ color: "var(--text-weak)" }}>
          Settings
        </div>
        {/* Project indicator */}
        <Show when={directory}>
          <div
            class="mx-2 mb-2 px-2 py-1.5 rounded-md text-xs truncate"
            style={{
              background: "var(--surface-inset)",
              color: "var(--text-weak)",
              border: "1px solid var(--border-base)",
            }}
            title={directory}
          >
            <span style={{ color: "var(--text-base)" }}>{directory!.replace(/[\\/]+$/, "").split(/[\\/]/).pop()}</span>
          </div>
        </Show>
        <div class="space-y-0.5">
          <For each={tabs()}>
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
                <span class="flex-1 truncate">{tab.label}</span>
                <Show when={tab.scope}>
                  <span
                    class="text-[10px] px-1 py-0.5 rounded shrink-0"
                    style={{
                      background: "var(--surface-inset)",
                      color: "var(--text-weak)",
                    }}
                  >
                    {tab.scope}
                  </span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-y-auto">
        <div class="max-w-2xl p-6 space-y-6">
          {/* Project header banner */}
          <Show when={directory}>
            <div
              class="flex items-center gap-2 px-3 py-2 rounded-md text-xs"
              style={{
                background: "var(--surface-inset)",
                color: "var(--text-weak)",
                border: "1px solid var(--border-base)",
              }}
            >
              <Info class="w-3.5 h-3.5 shrink-0" />
              <span>
                Project: <span style={{ color: "var(--text-base)" }}>{directory}</span>
              </span>
            </div>
          </Show>

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
                              <div class="w-6 h-6 rounded flex items-center justify-center" style={{ background: "var(--surface-strong)" }}>
                                <Check class="w-3 h-3" style={{ color: "var(--icon-success-base)" }} />
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
                    <div
                      class="mb-4 p-3 rounded-md text-sm flex items-center justify-between"
                      style={{
                        background: "var(--surface-inset)",
                        border: "1px solid var(--border-base)",
                        "border-left": "3px solid var(--icon-success-base)",
                        color: "var(--icon-success-base)",
                      }}
                    >
                      <span>{success()}</span>
                      <button onClick={() => setSuccess(null)} class="ml-2">
                        <X class="w-4 h-4" />
                      </button>
                    </div>
                  </Show>

                  <Show when={error()}>
                    <div
                      class="mb-4 p-3 rounded-md text-sm flex items-center justify-between"
                      style={{
                        background: "var(--surface-inset)",
                        border: "1px solid var(--border-base)",
                        "border-left": "3px solid var(--interactive-critical)",
                        color: "var(--interactive-critical)",
                      }}
                    >
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
                    <div
                      class="p-3 rounded-md text-sm mb-4"
                      style={{
                        background: "var(--surface-inset)",
                        border: "1px solid var(--border-base)",
                        "border-left": "3px solid var(--interactive-critical)",
                        color: "var(--interactive-critical)",
                      }}
                    >
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
                        const disabledByProject = () => mcp.projectOverrides()[name]?.enabled === false
                        const isActive = () => isConnected() && !disabledByProject()

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
                                disabled={mcpLoading() === name || mcpDeleting() === name || disabledByProject()}
                                title={disabledByProject() ? "Disabled for this project via Project Overrides" : undefined}
                                role="switch"
                                aria-checked={isActive()}
                                aria-label={`Toggle ${name} connection`}
                                class="relative w-10 h-5 rounded-full transition-colors disabled:opacity-50"
                                style={{
                                  background: isActive() ? "var(--interactive-base)" : "var(--surface-inset)",
                                }}
                              >
                                <div
                                  class="absolute top-0.5 w-4 h-4 rounded-full transition-all"
                                  style={{
                                    background: "var(--background-base)",
                                    left: isActive() ? "calc(100% - 18px)" : "2px",
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

              {/* Project Overrides Section */}
              <Show when={directory && Object.keys(mcp.servers).length > 0}>
                <section
                  class="rounded-lg overflow-hidden"
                  style={{
                    background: "var(--background-base)",
                    border: "1px solid var(--border-base)",
                  }}
                >
                  <div
                    class="px-4 py-3"
                    style={{ "border-bottom": "1px solid var(--border-base)" }}
                  >
                    <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                      Project Overrides
                    </h2>
                    <p class="text-xs mt-0.5" style={{ color: "var(--text-weak)" }}>
                      Enable or disable globally configured servers for this project
                    </p>
                  </div>
                  <div class="divide-y" style={{ "border-color": "var(--border-base)" }}>
                    <For each={Object.entries(mcp.servers).sort((a, b) => a[0].localeCompare(b[0]))}>
                      {([name]) => {
                        const override = () => mcp.projectOverrides()[name]
                        const isEnabled = () => override()?.enabled ?? true
                        const isUpdating = () => mcp.isOverrideLoading(name)

                        return (
                          <div class="px-4 py-3 flex items-center justify-between gap-4">
                            <div class="flex-1 min-w-0">
                              <div class="flex items-center gap-2">
                                <span
                                  class="text-sm"
                                  style={{
                                    color: isEnabled() ? "var(--text-strong)" : "var(--text-weak)",
                                  }}
                                >
                                  {name}
                                </span>
                                <Show when={isUpdating()}>
                                  <Spinner class="w-3 h-3" />
                                </Show>
                                <Show when={!isEnabled() && !isUpdating()}>
                                  <span
                                    class="text-xs px-1.5 py-0.5 rounded"
                                    style={{
                                      background: "var(--surface-inset)",
                                      color: "var(--text-weak)",
                                    }}
                                  >
                                    Disabled for this project
                                  </span>
                                </Show>

                              </div>
                            </div>
                            <button
                              onClick={async () => {
                                if (isEnabled()) {
                                  // Currently enabled: set an explicit override to disable
                                  await mcp.setProjectOverride(name, false)
                                } else {
                                  // Currently disabled via override: reset to default (enabled) state
                                  await mcp.resetProjectOverride(name)
                                }
                              }}
                              disabled={isUpdating()}
                              class="relative w-10 h-5 rounded-full transition-colors disabled:opacity-50"
                              style={{
                                background: isEnabled() ? "var(--interactive-base)" : "var(--surface-inset)",
                              }}
                              role="switch"
                              aria-checked={isEnabled()}
                              aria-label={`Toggle ${name} for this project`}
                            >
                              <div
                                class="absolute top-0.5 w-4 h-4 rounded-full transition-all"
                                style={{
                                  background: "var(--background-base)",
                                  left: isEnabled() ? "calc(100% - 18px)" : "2px",
                                }}
                              />
                            </button>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </section>
              </Show>

              {/* No project message for overrides */}
              <Show when={!directory}>
                <section
                  class="rounded-lg p-4"
                  style={{
                    background: "var(--surface-inset)",
                    border: "1px solid var(--border-base)",
                  }}
                >
                  <p class="text-xs" style={{ color: "var(--text-weak)" }}>
                    Select a project to enable per-project MCP server overrides.
                  </p>
                </section>
              </Show>

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

          {/* Instructions Tab */}
          <Show when={activeTab() === "instructions"}>
            <div class="space-y-6">
              <header>
                <h1 class="text-lg font-medium" style={{ color: "var(--text-strong)" }}>
                  Project Instructions
                </h1>
                <p class="text-sm mt-1" style={{ color: "var(--text-weak)" }}>
                  Persistent instructions that are automatically included in every session for this project
                </p>
              </header>

              <Show when={!directory}>
                <section
                  class="rounded-lg overflow-hidden"
                  style={{
                    background: "var(--background-base)",
                    border: "1px solid var(--border-base)",
                  }}
                >
                  <div class="p-6 text-center space-y-2">
                    <BookOpen class="w-10 h-10 mx-auto" style={{ color: "var(--text-weak)", opacity: "0.5" }} />
                    <p class="text-sm" style={{ color: "var(--text-weak)" }}>
                      Select a project to view and edit instructions.
                    </p>
                  </div>
                </section>
              </Show>

              <Show when={directory}>
              <Show when={instructionError()}>
                <div
                  class="p-3 rounded-md text-sm"
                  style={{
                    background: "var(--surface-inset)",
                    border: "1px solid var(--border-base)",
                    "border-left": "3px solid var(--interactive-critical)",
                    color: "var(--interactive-critical)",
                  }}
                >
                  {instructionError()}
                </div>
              </Show>

              <Show when={instructionLoading()}>
                <div class="flex items-center gap-2" style={{ color: "var(--text-weak)" }}>
                  <Spinner class="w-4 h-4" />
                  <span class="text-sm">Loading instructions...</span>
                </div>
              </Show>

              {/* No instructions configured */}
              <Show when={!instructionLoading() && instructionPaths().length === 0}>
                <section
                  class="rounded-lg overflow-hidden"
                  style={{
                    background: "var(--background-base)",
                    border: "1px solid var(--border-base)",
                  }}
                >
                  <div class="p-6 text-center space-y-4">
                    <BookOpen class="w-10 h-10 mx-auto" style={{ color: "var(--text-weak)", opacity: "0.5" }} />
                    <div>
                      <p class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                        No project instructions configured
                      </p>
                      <p class="text-sm mt-1" style={{ color: "var(--text-weak)" }}>
                        Project instructions are defined in <code class="text-xs px-1 py-0.5 rounded" style={{ background: "var(--surface-inset)" }}>opencode.json</code> and included in every session automatically.
                      </p>
                    </div>
                    <Button
                      onClick={createInstructionsFile}
                      variant="primary"
                      size="sm"
                      disabled={instructionCreating()}
                    >
                      <Show when={instructionCreating()} fallback={
                        <>
                          <Plus class="w-4 h-4" />
                          Create Instructions File
                        </>
                      }>
                        <Spinner class="w-4 h-4" />
                        Creating...
                      </Show>
                    </Button>
                  </div>
                </section>

                <section
                  class="rounded-lg p-4"
                  style={{
                    background: "var(--surface-inset)",
                    border: "1px solid var(--border-base)",
                  }}
                >
                  <h3 class="text-sm font-medium mb-2" style={{ color: "var(--text-strong)" }}>
                    How instructions work
                  </h3>
                  <div class="text-xs space-y-2" style={{ color: "var(--text-weak)" }}>
                    <p>
                      Add an <code class="px-1 py-0.5 rounded" style={{ background: "var(--background-base)" }}>instructions</code> field to your project's <code class="px-1 py-0.5 rounded" style={{ background: "var(--background-base)" }}>opencode.json</code>:
                    </p>
                    <pre
                      class="p-3 rounded-md overflow-x-auto"
                      style={{ background: "var(--background-base)", color: "var(--text-base)" }}
                    >{`{
  "instructions": ["AGENTS.md", ".opencode/instructions/*.md"]
}`}</pre>
                    <p>
                      Each file path is resolved relative to the project root. The content is injected into the system prompt for every new session.
                    </p>
                  </div>
                </section>
              </Show>

              {/* Instructions configured */}
              <Show when={!instructionLoading() && instructionPaths().length > 0}>
                <For each={instructionPaths()}>
                  {(path) => {
                    const info = () => instructionContents()[path]
                    const edited = () => instructionEdits()[path]
                    const currentContent = () => edited() ?? info()?.content ?? ""
                    const isDirty = () => edited() !== undefined
                    const isSaving = () => instructionSaving() === path
                    const wasSaved = () => instructionSaved() === path

                    return (
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
                          <div class="flex items-center gap-2">
                            <BookOpen class="w-4 h-4" style={{ color: "var(--text-weak)" }} />
                            <span class="text-sm font-medium font-mono" style={{ color: "var(--text-strong)" }}>
                              {path}
                            </span>
                            <Show when={info()?.exists === false}>
                              <span
                                class="text-xs px-1.5 py-0.5 rounded"
                                style={{
                                  background: "var(--surface-inset)",
                                  color: "var(--icon-warning-base)",
                                }}
                              >
                                Missing
                              </span>
                            </Show>
                            <Show when={info()?.exists}>
                              <span
                                class="text-xs px-1.5 py-0.5 rounded"
                                style={{
                                  background: "var(--surface-inset)",
                                  color: "var(--icon-success-base)",
                                }}
                              >
                                Active
                              </span>
                            </Show>
                          </div>
                          <div class="flex items-center gap-2">
                            <Show when={wasSaved()}>
                              <span class="text-xs flex items-center gap-1" style={{ color: "var(--icon-success-base)" }}>
                                <Check class="w-3 h-3" /> Saved
                              </span>
                            </Show>
                            <Button
                              onClick={() => saveInstruction(path)}
                              variant="primary"
                              size="sm"
                              disabled={!isDirty() || isSaving()}
                            >
                              <Show when={isSaving()} fallback={
                                <>
                                  <Save class="w-3.5 h-3.5" />
                                  Save
                                </>
                              }>
                                <Spinner class="w-3.5 h-3.5" />
                                Saving...
                              </Show>
                            </Button>
                          </div>
                        </div>
                        <div class="p-4">
                          <textarea
                            value={currentContent()}
                            onInput={(e) => {
                              const val = e.currentTarget.value
                              setInstructionEdits((prev) => ({ ...prev, [path]: val }))
                            }}
                            rows={12}
                            class="w-full px-3 py-2 rounded-md text-sm font-mono resize-y"
                            style={{
                              background: "var(--surface-inset)",
                              border: "1px solid var(--border-base)",
                              color: "var(--text-base)",
                              "min-height": "160px",
                            }}
                            placeholder={info()?.exists === false ? "This file does not exist yet. Type content and save to create it." : "Enter instructions..."}
                          />
                        </div>
                      </section>
                    )
                  }}
                </For>

                <section
                  class="rounded-lg p-4"
                  style={{
                    background: "var(--surface-inset)",
                    border: "1px solid var(--border-base)",
                  }}
                >
                  <p class="text-xs" style={{ color: "var(--text-weak)" }}>
                    Instruction files are defined in your project's <code class="px-1 py-0.5 rounded" style={{ background: "var(--background-base)" }}>opencode.json</code>. Changes take effect on the next session.
                  </p>
                </section>
              </Show>
              </Show>
            </div>
          </Show>

          {/* Project Config Tab */}
          <Show when={activeTab() === "config"}>
            <ProjectConfigTab />
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
                  <div class="flex gap-2" role="group" aria-label="Theme selection">
                    <For each={[
                      { value: "light" as const, label: "Light", icon: () => <Sun class="w-4 h-4" /> },
                      { value: "dark" as const, label: "Dark", icon: () => <Moon class="w-4 h-4" /> },
                      { value: "system" as const, label: "System", icon: () => <Monitor class="w-4 h-4" /> },
                    ]}>
                      {(option) => (
                        <button
                          type="button"
                          aria-pressed={theme.theme() === option.value}
                          onClick={() => theme.setTheme(option.value)}
                          class="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors"
                          style={{
                            background: theme.theme() === option.value ? "var(--interactive-base)" : "var(--surface-inset)",
                            color: theme.theme() === option.value ? "var(--background-base)" : "var(--text-base)",
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

          {/* Sounds Tab */}
          <Show when={activeTab() === "sounds"}>
            <div class="space-y-6">
              <header>
                <h1 class="text-lg font-medium" style={{ color: "var(--text-strong)" }}>
                  Sound Notifications
                </h1>
                <p class="text-sm mt-1" style={{ color: "var(--text-weak)" }}>
                  Play a sound when notification-worthy events occur (task complete, permission request, agent question)
                </p>
              </header>

              <section
                class="rounded-lg overflow-hidden"
                style={{
                  background: "var(--background-base)",
                  border: "1px solid var(--border-base)",
                }}
              >
                <div class="px-4 py-3 flex items-center justify-between" style={{ "border-bottom": "1px solid var(--border-base)" }}>
                  <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                    Enable Sound
                  </h2>
                  <button
                    onClick={() => {
                      const enabling = !soundSettings().enabled
                      updateSoundSettings({ enabled: enabling })
                      if (enabling) primeAudioContext()
                    }}
                    class="relative w-10 h-5 rounded-full transition-colors"
                    style={{
                      background: soundSettings().enabled ? "var(--interactive-base)" : "var(--surface-inset)",
                    }}
                    role="switch"
                    aria-checked={soundSettings().enabled}
                    aria-label="Enable sound notifications"
                  >
                    <div
                      class="absolute top-0.5 w-4 h-4 rounded-full transition-all"
                      style={{
                        background: "var(--background-base)",
                        left: soundSettings().enabled ? "calc(100% - 18px)" : "2px",
                      }}
                    />
                  </button>
                </div>

                <div class="p-4">
                  <p class="text-xs mb-3" style={{ color: "var(--text-weak)" }}>
                    Sound only plays for sessions with the bell icon enabled. Enable the bell on individual sessions from the chat header.
                  </p>

                  <div class="space-y-2">
                    <label class="block text-sm font-medium" style={{ color: "var(--text-base)" }}>
                      Notification Sound
                    </label>
                    <div class="space-y-1">
                      <For each={SOUND_OPTIONS}>
                        {(option) => (
                          <label
                            for={`sound-option-${option.id}`}
                            class="flex items-center justify-between px-3 py-2 rounded-md transition-colors cursor-pointer"
                            style={{
                              background: soundSettings().sound === option.id ? "var(--surface-inset)" : "transparent",
                              border: soundSettings().sound === option.id ? "1px solid var(--interactive-base)" : "1px solid transparent",
                            }}
                            onMouseEnter={(e) => {
                              if (soundSettings().sound !== option.id) e.currentTarget.style.background = "var(--surface-inset)"
                            }}
                            onMouseLeave={(e) => {
                              if (soundSettings().sound !== option.id) e.currentTarget.style.background = "transparent"
                            }}
                          >
                            <div class="flex items-center gap-3">
                              <input
                                id={`sound-option-${option.id}`}
                                type="radio"
                                name="sound"
                                value={option.id}
                                checked={soundSettings().sound === option.id}
                                class="accent-[var(--interactive-base)]"
                                onChange={(e) => {
                                  e.stopPropagation()
                                  updateSoundSettings({ sound: option.id })
                                  playSound(option.id)
                                }}
                                onClick={(e) => e.stopPropagation()}
                              />
                              <span class="text-sm" style={{ color: "var(--text-base)" }}>{option.label}</span>
                            </div>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                playSound(option.id)
                              }}
                              class="p-1 rounded transition-colors"
                              style={{ color: "var(--icon-weak)" }}
                              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--icon-base)")}
                              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--icon-weak)")}
                              title={`Preview ${option.label}`}
                              aria-label={`Preview ${option.label} sound`}
                            >
                              <Play class="w-4 h-4" />
                            </button>
                          </label>
                        )}
                      </For>
                    </div>
                  </div>
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

// ── Known permission tools with human-friendly labels ──
// supportsPatterns: true for PermissionRuleConfig tools (allow pattern-specific rules),
// false for PermissionActionConfig-only tools (only allow/ask/deny globally)
const PERMISSION_TOOLS = [
  { key: "read", label: "Read Files", supportsPatterns: true },
  { key: "edit", label: "Edit Files", supportsPatterns: true },
  { key: "bash", label: "Bash Commands", supportsPatterns: true },
  { key: "glob", label: "Glob Search", supportsPatterns: true },
  { key: "grep", label: "Grep Search", supportsPatterns: true },
  { key: "list", label: "List Files", supportsPatterns: true },
  { key: "webfetch", label: "Web Fetch", supportsPatterns: false },
  { key: "task", label: "Task (Sub-agent)", supportsPatterns: true },
  { key: "todowrite", label: "Todo Write", supportsPatterns: false },
  { key: "todoread", label: "Todo Read", supportsPatterns: false },
  { key: "question", label: "Question", supportsPatterns: false },
  { key: "websearch", label: "Web Search", supportsPatterns: false },
  { key: "codesearch", label: "Code Search", supportsPatterns: false },
  { key: "lsp", label: "LSP", supportsPatterns: true },
  { key: "skill", label: "Skill", supportsPatterns: true },
] as const

// Known tools that can be toggled on/off
const TOGGLEABLE_TOOLS = [
  { key: "bash", label: "Bash" },
  { key: "webfetch", label: "Web Fetch" },
  { key: "websearch", label: "Web Search" },
  { key: "codesearch", label: "Code Search" },
  { key: "glob", label: "Glob" },
  { key: "grep", label: "Grep" },
  { key: "read", label: "Read" },
  { key: "edit", label: "Edit" },
  { key: "list", label: "List" },
  { key: "task", label: "Task" },
  { key: "todowrite", label: "Todo Write" },
  { key: "todoread", label: "Todo Read" },
  { key: "question", label: "Question" },
  { key: "lsp", label: "LSP" },
  { key: "skill", label: "Skill" },
] as const

const ACTION_OPTIONS: PermissionActionConfig[] = ["allow", "ask", "deny"]

function getPermissionAction(rule: unknown): PermissionActionConfig {
  if (rule === "allow" || rule === "ask" || rule === "deny") return rule
  if (typeof rule === "object" && rule !== null && "*" in rule) {
    const val = (rule as Record<string, unknown>)["*"]
    if (val === "allow" || val === "ask" || val === "deny") return val
  }
  return "ask"
}

function getPermissionPatterns(rule: unknown): Array<{ pattern: string; action: PermissionActionConfig }> {
  if (typeof rule !== "object" || rule === null) return []
  const patterns: Array<{ pattern: string; action: PermissionActionConfig }> = []
  for (const [k, v] of Object.entries(rule as Record<string, unknown>)) {
    if (k === "*" || k === "__originalKeys") continue
    if (v === "allow" || v === "ask" || v === "deny") {
      patterns.push({ pattern: k, action: v })
    }
  }
  return patterns
}

function ProjectConfigTab() {
  const config = useConfig()
  const providers = useProviders()
  const { directory } = useSDK()
  const basePath = useBasePath()
  const [view, setView] = createSignal<"form" | "json">("form")
  const [jsonText, setJsonText] = createSignal("")
  const [saveError, setSaveError] = createSignal<string | null>(null)
  const [saving, setSaving] = createSignal(false)
  const [saved, setSaved] = createSignal(false)
  const [expandedPerms, setExpandedPerms] = createSignal<string | null>(null)
  const [newPatternTool, setNewPatternTool] = createSignal<string | null>(null)
  const [newPatternValue, setNewPatternValue] = createSignal("")
  const [newPatternAction, setNewPatternAction] = createSignal<PermissionActionConfig>("deny")

  // Sync JSON text from config only when switching into JSON view,
  // not on every reactive config update (which would overwrite in-progress edits).
  // Also clear errors on any view switch.
  let prevView: "form" | "json" = "form"
  createEffect(() => {
    const current = view()
    if (current !== prevView) {
      setSaveError(null)
      if (current === "json") {
        setJsonText(JSON.stringify(config.project, null, 2))
      }
    }
    prevView = current
  })

  let savedTimer: number | undefined
  function showSaved() {
    setSaveError(null)
    setSaved(true)
    if (savedTimer !== undefined) clearTimeout(savedTimer)
    savedTimer = window.setTimeout(() => setSaved(false), 2000)
  }
  onCleanup(() => {
    if (savedTimer !== undefined) clearTimeout(savedTimer)
  })

  // ── Permission handlers ──

  // When permission is a global string (e.g. "ask"), normalize to object
  // preserving the default for all tools so per-tool edits don't drop it
  function getPermissionObject(): Record<string, unknown> {
    const perm = config.project.permission
    if (typeof perm === "string") {
      // Convert global string to per-tool object. Include all SDK-known tools
      // (not just those in our UI) so tools like external_directory, doom_loop
      // retain the global default when we patch a single tool.
      const allKeys = [
        ...PERMISSION_TOOLS.map((t) => t.key),
        "external_directory", "doom_loop",
      ]
      const obj: Record<string, unknown> = {}
      for (const k of allKeys) obj[k] = perm
      return obj
    }
    if (typeof perm === "object" && perm !== null) return perm as Record<string, unknown>
    return {}
  }

  const ACTION_ONLY_TOOLS: Set<string> = new Set(
    PERMISSION_TOOLS.filter((t) => !t.supportsPatterns).map((t) => t.key),
  )

  async function setPermissionDefault(tool: string, action: PermissionActionConfig) {
    setSaving(true)
    const permObj = getPermissionObject()

    // Action-only tools (PermissionActionConfig) must always be a plain string;
    // discard any pattern object that may exist from manual edits or older configs.
    if (ACTION_ONLY_TOOLS.has(tool)) {
      const patch: Config = {
        permission: { ...permObj, [tool]: action } as Config["permission"],
      }
      const result = await config.updateProject(patch)
      setSaving(false)
      if (result) showSaved()
      return
    }

    const currentRule = permObj[tool]
    const patterns = getPermissionPatterns(currentRule)

    // Build the new rule: if there are patterns, keep them. Otherwise just use the action string.
    const newRule = patterns.length > 0
      ? { "*": action, ...Object.fromEntries(patterns.map((p) => [p.pattern, p.action])) }
      : action

    const patch: Config = {
      permission: { ...permObj, [tool]: newRule } as Config["permission"],
    }
    const result = await config.updateProject(patch)
    setSaving(false)
    if (result) showSaved()
  }

  const RESERVED_PATTERN_KEYS = new Set(["*", "__originalKeys"])

  async function addPermissionPattern(tool: string, pattern: string, action: PermissionActionConfig) {
    const trimmed = pattern.trim()
    if (!trimmed || RESERVED_PATTERN_KEYS.has(trimmed)) return
    setSaving(true)
    const permObj = getPermissionObject()
    const currentRule = permObj[tool]
    const defaultAction = getPermissionAction(currentRule)
    const existingPatterns = getPermissionPatterns(currentRule)

    const newRule = {
      "*": defaultAction,
      ...Object.fromEntries(existingPatterns.map((p) => [p.pattern, p.action])),
      [trimmed]: action,
    }

    const patch: Config = {
      permission: { ...permObj, [tool]: newRule } as Config["permission"],
    }
    const result = await config.updateProject(patch)
    setSaving(false)
    if (result) {
      setNewPatternTool(null)
      setNewPatternValue("")
      setNewPatternAction("deny")
      showSaved()
    }
  }

  async function removePermissionPattern(tool: string, pattern: string) {
    setSaving(true)
    const permObj = getPermissionObject()
    const currentRule = permObj[tool]
    const defaultAction = getPermissionAction(currentRule)
    const existingPatterns = getPermissionPatterns(currentRule).filter((p) => p.pattern !== pattern)

    const newRule = existingPatterns.length > 0
      ? { "*": defaultAction, ...Object.fromEntries(existingPatterns.map((p) => [p.pattern, p.action])) }
      : defaultAction

    const patch: Config = {
      permission: { ...permObj, [tool]: newRule } as Config["permission"],
    }
    const result = await config.updateProject(patch)
    setSaving(false)
    if (result) showSaved()
  }

  // ── Model defaults handlers ──

  const availableModels = createMemo(() => {
    const models: Array<{ id: string; name: string; provider: string }> = []
    for (const p of providers.providers) {
      if (!providers.connected.includes(p.id)) continue
      for (const [id, m] of Object.entries(p.models)) {
        models.push({ id: `${p.id}/${id}`, name: m.name || id, provider: p.name })
      }
    }
    return models
  })

  async function setDefaultModel(value: string) {
    setSaving(true)
    if (value) {
      const result = await config.updateProject({ model: value })
      setSaving(false)
      if (result) showSaved()
      return
    }
    // To clear model, write the full config file without the key.
    // The PATCH API only does deep-merge and cannot delete keys.
    const full = JSON.parse(JSON.stringify(config.project)) as Config
    delete full.model
    await writeConfigFile(JSON.stringify(full, null, 2))
  }

  async function setDefaultAgent(value: string) {
    setSaving(true)
    if (value) {
      const result = await config.updateProject({ default_agent: value })
      setSaving(false)
      if (result) showSaved()
      return
    }
    const full = JSON.parse(JSON.stringify(config.project)) as Config
    delete full.default_agent
    await writeConfigFile(JSON.stringify(full, null, 2))
  }

  function configFilePath() {
    if (!directory) return null
    return `${directory.replace(/\/$/, "")}/opencode.json`
  }

  // Write the full config to opencode.json directly (used when clearing keys
  // or full-file saves, since the PATCH API cannot delete keys via deep-merge)
  async function writeConfigFile(content: string): Promise<boolean> {
    const path = configFilePath()
    if (!path) {
      setSaving(false)
      return false
    }
    const ok = await writeFile(basePath.serverUrl, path, content)
    setSaving(false)
    if (ok) {
      await config.refresh()
      showSaved()
      return true
    }
    setSaveError("Failed to write opencode.json. Changes were not saved.")
    return false
  }

  // ── Tool toggle handlers ──

  async function toggleTool(tool: string, enabled: boolean) {
    setSaving(true)
    const currentTools = (config.project.tools as Record<string, boolean> | undefined) ?? {}
    const patch: Config = {
      tools: { ...currentTools, [tool]: enabled },
    }
    const result = await config.updateProject(patch)
    setSaving(false)
    if (result) showSaved()
  }

  function isToolEnabled(tool: string): boolean {
    const tools = config.project.tools as Record<string, boolean> | undefined
    if (!tools || tools[tool] === undefined) return true // enabled by default
    return tools[tool]
  }

  // ── JSON save handler ──

  async function saveJson() {
    const text = jsonText()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      setSaveError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      setSaveError("Config must be a JSON object at the top level.")
      return
    }
    setSaveError(null)
    setSaving(true)
    // Write the full file directly so removed keys are actually deleted
    await writeConfigFile(text)
  }

  return (
    <div class="space-y-6">
      <header>
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-lg font-medium" style={{ color: "var(--text-strong)" }}>
              Project Config
            </h1>
            <p class="text-sm mt-1" style={{ color: "var(--text-weak)" }}>
              Configure permissions, model defaults, and tool access for this project
            </p>
          </div>
          <div class="flex items-center gap-2">
            <Show when={saving()}>
              <Spinner class="w-4 h-4" />
            </Show>
            <Show when={saved()}>
              <span class="text-xs flex items-center gap-1" style={{ color: "var(--icon-success-base)" }}>
                <Check class="w-3 h-3" /> Saved
              </span>
            </Show>
          </div>
        </div>
        {/* Scope indicator */}
        <div
          class="mt-3 flex items-center gap-2 px-3 py-2 rounded-md text-xs"
          style={{
            background: "var(--surface-inset)",
            color: "var(--text-weak)",
            border: "1px solid var(--border-base)",
          }}
        >
          <Info class="w-3.5 h-3.5 shrink-0" />
          <span>
            Saved to <code class="px-1 py-0.5 rounded" style={{ background: "var(--background-base)" }}>opencode.json</code> in your project
            {directory ? ` (${directory})` : ""}
          </span>
        </div>
      </header>

      {/* View toggle */}
      <div class="flex gap-1 p-1 rounded-md" style={{ background: "var(--surface-inset)" }}>
        <button
          onClick={() => setView("form")}
          class="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors"
          style={{
            background: view() === "form" ? "var(--background-base)" : "transparent",
            color: view() === "form" ? "var(--text-strong)" : "var(--text-weak)",
            "box-shadow": view() === "form" ? "0 1px 2px rgba(0,0,0,0.05)" : "none",
          }}
        >
          <Settings2 class="w-3.5 h-3.5" />
          Form
        </button>
        <button
          onClick={() => setView("json")}
          class="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors"
          style={{
            background: view() === "json" ? "var(--background-base)" : "transparent",
            color: view() === "json" ? "var(--text-strong)" : "var(--text-weak)",
            "box-shadow": view() === "json" ? "0 1px 2px rgba(0,0,0,0.05)" : "none",
          }}
        >
          <Code class="w-3.5 h-3.5" />
          JSON
        </button>
      </div>

      <Show when={config.error()}>
        <div
          class="p-3 rounded-md text-sm"
          style={{
            background: "var(--surface-inset)",
            border: "1px solid var(--border-base)",
            "border-left": "3px solid var(--interactive-critical)",
            color: "var(--interactive-critical)",
          }}
        >
          {config.error()}
        </div>
      </Show>

      <Show when={saveError()}>
        <div
          class="p-3 rounded-md text-sm"
          style={{
            background: "var(--surface-inset)",
            border: "1px solid var(--border-base)",
            "border-left": "3px solid var(--interactive-critical)",
            color: "var(--interactive-critical)",
          }}
        >
          {saveError()}
        </div>
      </Show>

      <Show when={config.initialLoading()}>
        <div class="flex items-center gap-2" style={{ color: "var(--text-weak)" }}>
          <Spinner class="w-4 h-4" />
          <span class="text-sm">Loading configuration...</span>
        </div>
      </Show>

      {/* Form View */}
      <Show when={!config.initialLoading() && view() === "form"}>
        <div class="space-y-6">

          {/* Permissions Section */}
          <section
            class="rounded-lg overflow-hidden"
            style={{
              background: "var(--background-base)",
              border: "1px solid var(--border-base)",
            }}
          >
            <div class="px-4 py-3 flex items-center gap-2" style={{ "border-bottom": "1px solid var(--border-base)" }}>
              <Shield class="w-4 h-4" style={{ color: "var(--text-weak)" }} />
              <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                Permissions
              </h2>
            </div>
            <div class="divide-y" style={{ "border-color": "var(--border-base)" }}>
              <For each={PERMISSION_TOOLS}>
                {(tool) => {
                  const permission = () => {
                    const p = config.project.permission
                    if (typeof p === "string") return p
                    if (typeof p === "object" && p !== null) return (p as Record<string, unknown>)[tool.key]
                    return undefined
                  }
                  const action = () => getPermissionAction(permission())
                  const patterns = () => getPermissionPatterns(permission())
                  const expanded = () => expandedPerms() === tool.key

                  return (
                    <div class="px-4 py-3">
                      <div class="flex items-center justify-between">
                        <Show when={tool.supportsPatterns} fallback={
                          <span class="flex items-center gap-2 text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                            {tool.label}
                          </span>
                        }>
                          <button
                            class="flex items-center gap-2 text-sm font-medium"
                            style={{ color: "var(--text-strong)" }}
                            onClick={() => setExpandedPerms(expanded() ? null : tool.key)}
                          >
                            <Show when={expanded()} fallback={<ChevronRight class="w-3.5 h-3.5" style={{ color: "var(--text-weak)" }} />}>
                              <ChevronDown class="w-3.5 h-3.5" style={{ color: "var(--text-weak)" }} />
                            </Show>
                            {tool.label}
                            <Show when={patterns().length > 0}>
                              <span
                                class="text-xs px-1.5 py-0.5 rounded"
                                style={{ background: "var(--surface-inset)", color: "var(--text-weak)" }}
                              >
                                {patterns().length} rule{patterns().length > 1 ? "s" : ""}
                              </span>
                            </Show>
                          </button>
                        </Show>
                        {/* Default action segmented control */}
                        <div class="flex gap-0.5 p-0.5 rounded" style={{ background: "var(--surface-inset)" }}>
                          <For each={ACTION_OPTIONS}>
                            {(opt) => (
                              <button
                                onClick={() => setPermissionDefault(tool.key, opt)}
                                disabled={saving()}
                                class="px-2.5 py-1 rounded text-xs font-medium transition-colors capitalize disabled:opacity-50"
                                style={{
                                  background: action() === opt ? actionColor(opt) : "transparent",
                                  color: action() === opt ? "white" : "var(--text-weak)",
                                }}
                              >
                                {opt}
                              </button>
                            )}
                          </For>
                        </div>
                      </div>

                      {/* Expanded: show patterns (only for tools that support pattern rules) */}
                      <Show when={expanded() && tool.supportsPatterns}>
                        <div class="mt-3 ml-5 space-y-2">
                          <Show when={patterns().length > 0}>
                            <div class="space-y-1">
                              <For each={patterns()}>
                                {(p) => (
                                  <div
                                    class="flex items-center justify-between px-3 py-1.5 rounded text-xs"
                                    style={{ background: "var(--surface-inset)" }}
                                  >
                                    <code class="font-mono" style={{ color: "var(--text-base)" }}>{p.pattern}</code>
                                    <div class="flex items-center gap-2">
                                      <span
                                        class="px-1.5 py-0.5 rounded capitalize font-medium"
                                        style={{
                                          background: actionColor(p.action),
                                          color: "white",
                                        }}
                                      >
                                        {p.action}
                                      </span>
                                      <button
                                        onClick={() => removePermissionPattern(tool.key, p.pattern)}
                                        disabled={saving()}
                                        class="p-0.5 rounded transition-colors opacity-50 hover:opacity-100 disabled:opacity-30"
                                        style={{ color: "var(--icon-critical-base)" }}
                                        title="Remove rule"
                                      >
                                        <X class="w-3 h-3" />
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </For>
                            </div>
                          </Show>

                          {/* Add pattern form */}
                          <Show when={newPatternTool() === tool.key} fallback={
                            <button
                              onClick={() => setNewPatternTool(tool.key)}
                              class="text-xs hover:underline"
                              style={{ color: "var(--text-interactive-base)" }}
                            >
                              + Add pattern rule
                            </button>
                          }>
                            <div class="flex items-center gap-2">
                              <input
                                type="text"
                                value={newPatternValue()}
                                onInput={(e) => setNewPatternValue(e.currentTarget.value)}
                                placeholder="e.g. *.env or src/**"
                                class="flex-1 px-2 py-1 rounded text-xs font-mono"
                                style={{
                                  background: "var(--background-base)",
                                  border: "1px solid var(--border-base)",
                                  color: "var(--text-base)",
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && !saving()) {
                                    addPermissionPattern(tool.key, newPatternValue(), newPatternAction())
                                  }
                                  if (e.key === "Escape") {
                                    setNewPatternTool(null)
                                    setNewPatternValue("")
                                  }
                                }}
                              />
                              <select
                                value={newPatternAction()}
                                onChange={(e) => setNewPatternAction(e.currentTarget.value as PermissionActionConfig)}
                                class="px-2 py-1 rounded text-xs"
                                style={{
                                  background: "var(--background-base)",
                                  border: "1px solid var(--border-base)",
                                  color: "var(--text-base)",
                                }}
                              >
                                <For each={ACTION_OPTIONS}>
                                  {(opt) => <option value={opt}>{opt}</option>}
                                </For>
                              </select>
                              <Button
                                onClick={() => addPermissionPattern(tool.key, newPatternValue(), newPatternAction())}
                                variant="primary"
                                size="sm"
                                disabled={!newPatternValue().trim() || saving()}
                              >
                                Add
                              </Button>
                              <button
                                onClick={() => { setNewPatternTool(null); setNewPatternValue("") }}
                                class="p-1 rounded"
                                style={{ color: "var(--text-weak)" }}
                              >
                                <X class="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </section>

          {/* Model Defaults Section */}
          <section
            class="rounded-lg overflow-hidden"
            style={{
              background: "var(--background-base)",
              border: "1px solid var(--border-base)",
            }}
          >
            <div class="px-4 py-3 flex items-center gap-2" style={{ "border-bottom": "1px solid var(--border-base)" }}>
              <Cpu class="w-4 h-4" style={{ color: "var(--text-weak)" }} />
              <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                Model Defaults
              </h2>
            </div>
            <div class="p-4 space-y-4">
              <div>
                <label class="block text-sm font-medium mb-1.5" style={{ color: "var(--text-base)" }}>
                  Default Model
                </label>
                <select
                  value={config.project.model ?? ""}
                  onChange={(e) => setDefaultModel(e.currentTarget.value)}
                  disabled={saving()}
                  class="w-full px-3 py-2 rounded-md text-sm disabled:opacity-50"
                  style={{
                    background: "var(--background-base)",
                    border: "1px solid var(--border-base)",
                    color: "var(--text-base)",
                  }}
                >
                  <option value="">Use system default</option>
                  <For each={availableModels()}>
                    {(m) => (
                      <option value={m.id}>
                        {m.provider} / {m.name}
                      </option>
                    )}
                  </For>
                </select>
                <p class="text-xs mt-1" style={{ color: "var(--text-weak)" }}>
                  Format: <code class="px-1 py-0.5 rounded" style={{ background: "var(--surface-inset)" }}>provider/model</code> (e.g. anthropic/claude-sonnet-4-5)
                </p>
              </div>

              <div>
                <label class="block text-sm font-medium mb-1.5" style={{ color: "var(--text-base)" }}>
                  Default Agent
                </label>
                <select
                  value={config.project.default_agent ?? ""}
                  onChange={(e) => setDefaultAgent(e.currentTarget.value)}
                  disabled={saving()}
                  class="w-full px-3 py-2 rounded-md text-sm disabled:opacity-50"
                  style={{
                    background: "var(--background-base)",
                    border: "1px solid var(--border-base)",
                    color: "var(--text-base)",
                  }}
                >
                  <option value="">Use system default</option>
                  <For each={providers.agents}>
                    {(agent) => (
                      <option value={agent.name}>{agent.name}</option>
                    )}
                  </For>
                </select>
              </div>
            </div>
          </section>

          {/* Tool Access Section */}
          <section
            class="rounded-lg overflow-hidden"
            style={{
              background: "var(--background-base)",
              border: "1px solid var(--border-base)",
            }}
          >
            <div class="px-4 py-3 flex items-center gap-2" style={{ "border-bottom": "1px solid var(--border-base)" }}>
              <Wrench class="w-4 h-4" style={{ color: "var(--text-weak)" }} />
              <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                Tool Access
              </h2>
            </div>
            <div class="divide-y" style={{ "border-color": "var(--border-base)" }}>
              <For each={TOGGLEABLE_TOOLS}>
                {(tool) => {
                  const enabled = () => isToolEnabled(tool.key)

                  return (
                    <div class="px-4 py-3 flex items-center justify-between">
                      <span class="text-sm" style={{ color: "var(--text-base)" }}>{tool.label}</span>
                      <button
                        onClick={() => toggleTool(tool.key, !enabled())}
                        disabled={saving()}
                        class="relative w-10 h-5 rounded-full transition-colors disabled:opacity-50"
                        role="switch"
                        aria-checked={enabled()}
                        aria-label={`Toggle ${tool.label} access`}
                        style={{
                          background: enabled() ? "var(--interactive-base)" : "var(--surface-inset)",
                        }}
                      >
                        <div
                          class="absolute top-0.5 w-4 h-4 rounded-full transition-all"
                          style={{
                            background: "var(--background-base)",
                            left: enabled() ? "calc(100% - 18px)" : "2px",
                          }}
                        />
                      </button>
                    </div>
                  )
                }}
              </For>
            </div>
          </section>

        </div>
      </Show>

      {/* JSON View */}
      <Show when={!config.initialLoading() && view() === "json"}>
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
            <div class="flex items-center gap-2">
              <Code class="w-4 h-4" style={{ color: "var(--text-weak)" }} />
              <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                opencode.json
              </h2>
            </div>
            <Button
              onClick={saveJson}
              variant="primary"
              size="sm"
              disabled={saving()}
            >
              <Show when={saving()} fallback={
                <>
                  <Save class="w-3.5 h-3.5" />
                  Save
                </>
              }>
                <Spinner class="w-3.5 h-3.5" />
                Saving...
              </Show>
            </Button>
          </div>

          <div class="p-4">
            <textarea
              value={jsonText()}
              onInput={(e) => {
                setJsonText(e.currentTarget.value)
                setSaveError(null)
              }}
              rows={20}
              class="w-full px-3 py-2 rounded-md text-sm font-mono resize-y"
              style={{
                background: "var(--surface-inset)",
                border: "1px solid var(--border-base)",
                color: "var(--text-base)",
                "min-height": "300px",
                "tab-size": "2",
              }}
              spellcheck={false}
            />
            <p class="text-xs mt-2" style={{ color: "var(--text-weak)" }}>
              Schema: <code class="px-1 py-0.5 rounded" style={{ background: "var(--surface-inset)" }}>https://opencode.ai/config.json</code>
            </p>
          </div>
        </section>
      </Show>
    </div>
  )
}

function actionColor(action: PermissionActionConfig): string {
  if (action === "allow") return "var(--icon-success-base)"
  if (action === "deny") return "var(--interactive-critical)"
  return "var(--icon-warning-base)"
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
