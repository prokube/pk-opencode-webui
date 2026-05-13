type ChecklistItem = {
  id: string
  label: string
}

export const TELEGRAM_READINESS_CHECKS = Object.freeze([
  Object.freeze({ id: "token", label: "Bot token is set with TELEGRAM_BOT_TOKEN or persisted token." }),
  Object.freeze({ id: "mode", label: "Bridge mode is selected: polling or webhook." }),
  Object.freeze({ id: "api", label: "openCodeUrl points to your reachable OpenCode API." }),
  Object.freeze({ id: "path", label: "sessionStorePath points to a persistent writable location." }),
  Object.freeze({ id: "webhook", label: "For webhook mode: TELEGRAM_WEBHOOK_URL, TELEGRAM_WEBHOOK_PATH, and HTTPS ingress are configured." }),
  Object.freeze({ id: "notify", label: "Notifications are enabled per chat with /notify on after a test message." }),
  Object.freeze({ id: "alarm", label: "Session bell/alarm is enabled for each OpenCode session that should emit proactive alerts." }),
]) as readonly Readonly<ChecklistItem>[]

const commands = ["/pending", "/inbox", "/notify on", "/notify off", "/notify status", "/new", "/status", "/sessions", "/switch <session-id|index>", "/help"] as const
const sections = ["Readiness checklist", "Prerequisites", "Setup steps", "Command usage", "Security best practices", "Troubleshooting quick checks"] as const
const requiredKeys = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "openCodeUrl", "webhookUrl"] as const

export const TELEGRAM_GUIDE_COMMANDS = [...commands]
export const TELEGRAM_GUIDE_SECTIONS = [...sections]
export const TELEGRAM_GUIDE_TITLE = "Telegram Setup Guide"
export const TELEGRAM_GUIDE_REQUIRED_KEYS = [...requiredKeys]
