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
const requiredKeys = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "openCodeUrl", "webhookUrl"] as const

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
        <h2 class="text-base font-medium" style={{ color: "var(--text-strong)" }}>
          {title}
        </h2>
        <p class="text-sm mt-1" style={{ color: "var(--text-weak)" }}>
          Configure the prokube.ai Telegram bridge with a quick readiness checklist, mode-specific setup, and troubleshooting checks.
        </p>
      </header>

      <section class="rounded-lg p-4 space-y-3" style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}>
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
            Readiness checklist
          </h3>
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
        <h3 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
          Prerequisites
        </h3>
        <ul class="text-sm space-y-1 list-disc pl-5" style={{ color: "var(--text-base)" }}>
          <li>
            Create your bot in Telegram with BotFather (<code>/newbot</code>) and copy the token into <code>TELEGRAM_BOT_TOKEN</code>.
          </li>
          <li>Mode choice: polling (default) or webhook.</li>
          <li>
            <code>openCodeUrl</code> should be the API endpoint the bridge can reach from inside your deployment (for example <code>http://127.0.0.1:4096</code>).
          </li>
          <li>
            Bridge runtime enabled with <code>TELEGRAM_BRIDGE_ENABLED=true</code> in supported deployments.
          </li>
        </ul>
      </section>

      <section class="rounded-lg p-4 space-y-3" style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}>
        <h3 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
          Setup steps
        </h3>
        <div class="space-y-2 text-sm" style={{ color: "var(--text-base)" }}>
          <p>
            <strong>Bot token:</strong> in BotFather run <code>/token</code> for your bot to rotate/copy credentials, then save the value as <code>TELEGRAM_BOT_TOKEN</code> or set it in the Bot token field.
          </p>
          <p>
            <strong>Webhook secret:</strong> generate a random value (for example <code>openssl rand -hex 32</code>), store it in <code>TELEGRAM_WEBHOOK_SECRET</code>, and configure your ingress to pass Telegram's <code>x-telegram-bot-api-secret-token</code> header unchanged.
          </p>
          <p>
            <strong>URL fields:</strong> set <code>openCodeUrl</code> to the bridge-reachable OpenCode API URL, and set <code>webhookUrl</code> to the public HTTPS URL Telegram can call (for example <code>https://your-domain/telegram/webhook</code>).
          </p>
          <p>
            <strong>Mode:</strong> set <code>mode=polling</code> for local/simple setups, or <code>mode=webhook</code> for production ingress. Polling clears webhook registration automatically.
          </p>
          <p>
            Persisted UI fields map to runtime settings: <code>mode</code>, <code>token</code>, <code>openCodeUrl</code>, <code>directory</code>, <code>sessionCacheMax</code>,
            <code>sessionCacheTtlMs</code>, <code>notificationDebounceMs</code>, <code>port</code>, <code>webhookPath</code>, <code>webhookSecret</code>, <code>webhookUrl</code>,
            <code>sessionStorePath</code>, and <code>sessionLinkBase</code>. Restart after saving changes.
          </p>
        </div>
      </section>

      <section class="rounded-lg p-4 space-y-3" style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}>
        <h3 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
          Command usage
        </h3>
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
        <h3 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
          Security best practices
        </h3>
        <ul class="text-sm space-y-1 list-disc pl-5" style={{ color: "var(--text-base)" }}>
          <li>
            Store <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_WEBHOOK_SECRET</code> in a secret manager, never in git.
          </li>
          <li>
            Use HTTPS-only ingress for webhook mode and limit exposure to <code>TELEGRAM_WEBHOOK_PATH</code>.
          </li>
          <li>
            Preserve the <code>x-telegram-bot-api-secret-token</code> header end-to-end when <code>TELEGRAM_WEBHOOK_SECRET</code> is set.
          </li>
          <li>
            Keep <code>sessionStorePath</code> on persistent storage for restart safety in containerized deployments.
          </li>
        </ul>
      </section>

      <section class="rounded-lg p-4 space-y-3" style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}>
        <h3 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
          Troubleshooting quick checks
        </h3>
        <ul class="text-sm space-y-1 list-disc pl-5" style={{ color: "var(--text-base)" }}>
          <li>If replies fail, look for <code>Telegram sendMessage failed</code> and verify token validity and bot chat permissions.</li>
          <li>If outbound alerts stop, check for <code>[TelegramBridge] outbound event stream error</code> and confirm OpenCode event streaming availability.</li>
          <li>
            If webhook updates are rejected, verify your secret header and confirm <code>TELEGRAM_WEBHOOK_URL</code> is publicly reachable over HTTPS.
          </li>
          <li>
            If session links are incorrect in alerts, set <code>TELEGRAM_SESSION_LINK_BASE</code> to the public prokube.ai UI base URL.
          </li>
        </ul>
      </section>
    </div>
  )
}

export const TELEGRAM_GUIDE_COMMANDS = [...commands]
export const TELEGRAM_READINESS_CHECKS = checklist
export const TELEGRAM_GUIDE_SECTIONS = [...sections]
export const TELEGRAM_GUIDE_TITLE = title
export const TELEGRAM_GUIDE_REQUIRED_KEYS = [...requiredKeys]
