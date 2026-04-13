import { For, createMemo, createSignal } from "solid-js"

type ChecklistItem = {
  id: string
  label: string
}

const checklist = Object.freeze([
  Object.freeze({ id: "token", label: "Bot token is set with TELEGRAM_BOT_TOKEN or persisted token." }),
  Object.freeze({ id: "mode", label: "Bridge mode is selected: polling or webhook." }),
  Object.freeze({ id: "api", label: "openCodeUrl points to your reachable OpenCode API." }),
  Object.freeze({ id: "path", label: "sessionStorePath points to a persistent writable location." }),
  Object.freeze({ id: "webhook", label: "For webhook mode: TELEGRAM_WEBHOOK_URL, TELEGRAM_WEBHOOK_PATH, and HTTPS ingress are configured." }),
  Object.freeze({ id: "notify", label: "Notifications are enabled per chat with /notify on after a test message." }),
]) as readonly Readonly<ChecklistItem>[]

const commands = ["/notify on", "/notify off", "/notify status", "/new", "/status", "/help"] as const
const sections = ["Readiness checklist", "Prerequisites", "Setup steps", "Command usage", "Security best practices", "Troubleshooting quick checks"] as const
const title = "Telegram Setup Guide"

export function TelegramSetupGuide() {
  const [done, setDone] = createSignal(new Set<string>())
  const ready = createMemo(() => done().size === checklist.length)

  function toggle(id: string) {
    setDone((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
        return next
      }
      next.add(id)
      return next
    })
  }

  return (
    <div class="space-y-6">
      <header>
        <h1 class="text-lg font-medium" style={{ color: "var(--text-strong)" }}>
          {title}
        </h1>
        <p class="text-sm mt-1" style={{ color: "var(--text-weak)" }}>
          Configure the prokube.ai Telegram bridge with a quick readiness checklist, mode-specific setup, and troubleshooting checks.
        </p>
      </header>

      <section class="rounded-lg p-4 space-y-3" style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}>
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
            Readiness checklist
          </h2>
          <span class="text-xs px-2 py-1 rounded" style={{ background: "var(--surface-inset)", color: "var(--text-weak)" }}>
            {done().size}/{checklist.length}
          </span>
        </div>
        <For each={checklist}>
          {(item) => (
            <label class="flex items-start gap-2 text-sm cursor-pointer" style={{ color: "var(--text-base)" }}>
              <input type="checkbox" checked={done().has(item.id)} onChange={() => toggle(item.id)} class="mt-0.5 accent-[var(--interactive-base)]" />
              <span>{item.label}</span>
            </label>
          )}
        </For>
        <p class="text-xs" style={{ color: ready() ? "var(--status-success-text)" : "var(--text-weak)" }}>
          {ready() ? "Ready: start the bridge and verify commands in Telegram." : "Complete each item before enabling notifications in production chats."}
        </p>
      </section>

      <section class="rounded-lg p-4 space-y-3" style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}>
        <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
          Prerequisites
        </h2>
        <ul class="text-sm space-y-1 list-disc pl-5" style={{ color: "var(--text-base)" }}>
          <li>Telegram bot created with BotFather and a valid bot token.</li>
          <li>Mode choice: polling (default) or webhook.</li>
          <li>OpenCode API reachable from the bridge via openCodeUrl (from OPENCODE_API_URL or API_URL by default).</li>
          <li>Bridge runtime enabled with TELEGRAM_BRIDGE_ENABLED=true in supported deployments.</li>
        </ul>
      </section>

      <section class="rounded-lg p-4 space-y-3" style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}>
        <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
          Setup steps
        </h2>
        <div class="space-y-2 text-sm" style={{ color: "var(--text-base)" }}>
          <p>
            <strong>Polling mode:</strong> set <code>mode=polling</code> (or TELEGRAM_MODE=polling), configure token, and start the bridge. Polling clears webhook
            registration automatically.
          </p>
          <p>
            <strong>Webhook mode:</strong> set <code>mode=webhook</code>, configure <code>webhookUrl</code>, <code>webhookPath</code>, and optional <code>webhookSecret</code>.
            Expose only HTTPS ingress and forward <code>x-telegram-bot-api-secret-token</code> unchanged.
          </p>
          <p>
            Persisted UI fields map to runtime settings: <code>mode</code>, <code>token</code>, <code>openCodeUrl</code>, <code>directory</code>, <code>sessionCacheMax</code>,
            <code>sessionCacheTtlMs</code>, <code>notificationDebounceMs</code>, <code>port</code>, <code>webhookPath</code>, <code>webhookSecret</code>, <code>webhookUrl</code>,
            <code>sessionStorePath</code>, and <code>sessionLinkBase</code>. Restart after saving changes.
          </p>
        </div>
      </section>

      <section class="rounded-lg p-4 space-y-3" style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}>
        <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
          Command usage
        </h2>
        <div class="flex flex-wrap gap-2">
          <For each={commands}>
            {(command) => (
              <span class="text-xs px-2 py-1 rounded" style={{ background: "var(--surface-inset)", color: "var(--text-base)", border: "1px solid var(--border-base)" }}>
                {command}
              </span>
            )}
          </For>
        </div>
      </section>

      <section class="rounded-lg p-4 space-y-3" style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}>
        <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
          Security best practices
        </h2>
        <ul class="text-sm space-y-1 list-disc pl-5" style={{ color: "var(--text-base)" }}>
          <li>Store TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in a secret manager, never in git.</li>
          <li>Use HTTPS-only ingress for webhook mode and limit exposure to TELEGRAM_WEBHOOK_PATH.</li>
          <li>Preserve the x-telegram-bot-api-secret-token header end-to-end when TELEGRAM_WEBHOOK_SECRET is set.</li>
          <li>Keep sessionStorePath on persistent storage for restart safety in containerized deployments.</li>
        </ul>
      </section>

      <section class="rounded-lg p-4 space-y-3" style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}>
        <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
          Troubleshooting quick checks
        </h2>
        <ul class="text-sm space-y-1 list-disc pl-5" style={{ color: "var(--text-base)" }}>
          <li>If replies fail, look for <code>Telegram sendMessage failed</code> and verify token validity and bot chat permissions.</li>
          <li>If outbound alerts stop, check for <code>[TelegramBridge] outbound event stream error</code> and confirm OpenCode event streaming availability.</li>
          <li>If webhook updates are rejected, verify your secret header and confirm TELEGRAM_WEBHOOK_URL is publicly reachable over HTTPS.</li>
          <li>If session links are incorrect in alerts, set TELEGRAM_SESSION_LINK_BASE to the public prokube.ai UI base URL.</li>
        </ul>
      </section>
    </div>
  )
}

export const TELEGRAM_GUIDE_COMMANDS = [...commands]
export const TELEGRAM_READINESS_CHECKS = checklist
export const TELEGRAM_GUIDE_SECTIONS = [...sections]
export const TELEGRAM_GUIDE_TITLE = title
