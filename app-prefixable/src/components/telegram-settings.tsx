import { createMemo, createSignal, onMount, Show, type ParentProps } from "solid-js"
import { AlertTriangle, Check, RefreshCw, Save } from "lucide-solid"
import { Spinner } from "./ui/spinner"
import { Button } from "./ui/button"
import {
  createTelegramForm,
  createTelegramPatch,
  type TelegramSettingsResponse,
  type TelegramUpdateFailure,
  type TelegramUpdateSuccess,
  type TelegramValidationError,
  type TelegramForm,
  validateTelegramForm,
} from "../utils/telegram-settings"

type Props = {
  serverUrl: string
}

function mergeValidationErrors(base: Record<string, string>, extra: TelegramValidationError[] | undefined) {
  if (!extra?.length) return base
  const next = { ...base }
  for (const item of extra) {
    if (next[item.field]) continue
    next[item.field] = item.message
  }
  return next
}

export function TelegramSettings(props: Props) {
  const [loading, setLoading] = createSignal(true)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [success, setSuccess] = createSignal<string | null>(null)
  const [fieldErrors, setFieldErrors] = createSignal<Record<string, string>>({})
  const [restartFields, setRestartFields] = createSignal<string[]>([])
  const [tokenConfigured, setTokenConfigured] = createSignal(false)
  const [webhookSecretConfigured, setWebhookSecretConfigured] = createSignal(false)
  const [initial, setInitial] = createSignal<TelegramForm | null>(null)
  const [form, setForm] = createSignal<TelegramForm | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    setSuccess(null)
    setRestartFields([])
    const res = await fetch(`${props.serverUrl}/api/ext/telegram/settings`).catch(() => null)
    if (!res?.ok) {
      setLoading(false)
      setError("Failed to load Telegram settings")
      return
    }
    const data = (await res.json().catch(() => null)) as TelegramSettingsResponse | null
    if (!data?.settings) {
      setLoading(false)
      setError("Failed to load Telegram settings")
      return
    }
    const next = createTelegramForm(data.settings)
    setInitial(next)
    setForm(next)
    setTokenConfigured(data.settings.tokenConfigured)
    setWebhookSecretConfigured(data.settings.webhookSecretConfigured)
    setRestartFields([])
    setFieldErrors({})
    setLoading(false)
  }

  onMount(load)

  const dirty = createMemo(() => {
    const current = form()
    const seed = initial()
    if (!current || !seed) return false
    return Object.keys(createTelegramPatch(current, seed)).length > 0
  })

  async function save() {
    const current = form()
    const seed = initial()
    if (!current || !seed) return
    setRestartFields([])

    const localErrors = validateTelegramForm(current)
    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors)
      setError("Please fix the highlighted fields.")
      setSuccess(null)
      return
    }

    const settings = createTelegramPatch(current, seed)
    if (Object.keys(settings).length === 0) {
      setSuccess("No changes to save.")
      setError(null)
      setFieldErrors({})
      setRestartFields([])
      return
    }

    setSaving(true)
    setError(null)
    setSuccess(null)
    setFieldErrors({})

    const res = await fetch(`${props.serverUrl}/api/ext/telegram/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    }).catch(() => null)

    setSaving(false)
    if (!res) {
      setError("Failed to save Telegram settings")
      return
    }

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as TelegramUpdateFailure
      const merged = mergeValidationErrors({}, data.errors)
      setFieldErrors(merged)
      setError(data.error === "validation_failed" ? "Validation failed. Please review each field." : "Failed to save Telegram settings")
      return
    }

    const data = (await res.json().catch(() => null)) as TelegramUpdateSuccess | null
    if (!data?.settings) {
      setError("Failed to save Telegram settings")
      return
    }
    const next = createTelegramForm(data.settings)
    setInitial(next)
    setForm(next)
    setTokenConfigured(data.settings.tokenConfigured)
    setWebhookSecretConfigured(data.settings.webhookSecretConfigured)
    setRestartFields(data.restartRequired ? data.restartRequiredFields : [])
    setFieldErrors({})
    setError(null)
    setSuccess("Telegram settings saved.")
  }

  function setField<K extends keyof TelegramForm>(key: K, value: TelegramForm[K]) {
    setForm((prev) => {
      if (!prev) return prev
      return { ...prev, [key]: value }
    })
    setFieldErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  function fieldError(name: string) {
    return fieldErrors()[name]
  }

  return (
    <div class="space-y-6">
      <header>
        <h1 class="text-lg font-medium" style={{ color: "var(--text-strong)" }}>
          Telegram
        </h1>
        <p class="text-sm mt-1" style={{ color: "var(--text-weak)" }}>
          Configure Telegram bridge runtime settings. Saving changes writes persisted values and may require restarting the bridge service.
        </p>
      </header>

      <Show when={loading()}>
        <div class="flex items-center gap-2" style={{ color: "var(--text-weak)" }}>
          <Spinner class="w-4 h-4" />
          <span class="text-sm">Loading Telegram settings...</span>
        </div>
      </Show>

      <Show when={!loading() && form()}>
        {(state) => (
          <>
            <Show when={error()}>
              <div class="p-3 rounded-md text-sm" role="alert" aria-live="assertive" style={{ background: "var(--surface-inset)", border: "1px solid var(--border-base)", "border-left": "3px solid var(--interactive-critical)", color: "var(--interactive-critical)" }}>
                {error()}
              </div>
            </Show>

            <Show when={success()}>
              <div class="p-3 rounded-md text-sm flex items-center gap-2" role="status" aria-live="polite" style={{ background: "var(--surface-inset)", border: "1px solid var(--border-base)", "border-left": "3px solid var(--icon-success-base)", color: "var(--icon-success-base)" }}>
                <Check class="w-4 h-4" />
                {success()}
              </div>
            </Show>

            <Show when={restartFields().length > 0}>
              <div class="p-3 rounded-md text-sm" role="status" aria-live="polite" style={{ background: "var(--surface-inset)", border: "1px solid var(--border-base)", "border-left": "3px solid var(--icon-warning-base)", color: "var(--text-base)" }}>
                <div class="flex items-center gap-2" style={{ color: "var(--icon-warning-base)" }}>
                  <AlertTriangle class="w-4 h-4" />
                  Restart required
                </div>
                <p class="mt-1 text-xs" style={{ color: "var(--text-weak)" }}>
                  Changed fields: {restartFields().join(", ")}
                </p>
              </div>
            </Show>

            <section class="rounded-lg overflow-hidden" style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}>
              <div class="px-4 py-3" style={{ "border-bottom": "1px solid var(--border-base)" }}>
                <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                  Bridge Configuration
                </h2>
              </div>
              <div class="p-4 space-y-4">
                <Field label="Mode">
                  <select class="w-full px-3 py-2 rounded-md text-sm" value={state().mode} onInput={(e) => setField("mode", e.currentTarget.value as TelegramForm["mode"])} style={{ background: "var(--surface-inset)", border: `1px solid ${fieldError("mode") ? "var(--interactive-critical)" : "var(--border-base)"}`, color: "var(--text-base)" }}>
                    <option value="polling">polling</option>
                    <option value="webhook">webhook</option>
                  </select>
                  <FieldError text={fieldError("mode")} />
                </Field>

                <Field label="OpenCode API URL" hint="Base URL used by the Telegram bridge to access OpenCode API.">
                  <input class="w-full px-3 py-2 rounded-md text-sm" value={state().openCodeUrl} onInput={(e) => setField("openCodeUrl", e.currentTarget.value)} style={{ background: "var(--surface-inset)", border: `1px solid ${fieldError("openCodeUrl") ? "var(--interactive-critical)" : "var(--border-base)"}`, color: "var(--text-base)" }} />
                  <FieldError text={fieldError("openCodeUrl")} />
                </Field>

                <div class="grid gap-4 md:grid-cols-2">
                  <Field label="Session cache max">
                    <input class="w-full px-3 py-2 rounded-md text-sm" value={state().sessionCacheMax} onInput={(e) => setField("sessionCacheMax", e.currentTarget.value)} style={{ background: "var(--surface-inset)", border: `1px solid ${fieldError("sessionCacheMax") ? "var(--interactive-critical)" : "var(--border-base)"}`, color: "var(--text-base)" }} />
                    <FieldError text={fieldError("sessionCacheMax")} />
                  </Field>
                  <Field label="Session cache TTL (ms)">
                    <input class="w-full px-3 py-2 rounded-md text-sm" value={state().sessionCacheTtlMs} onInput={(e) => setField("sessionCacheTtlMs", e.currentTarget.value)} style={{ background: "var(--surface-inset)", border: `1px solid ${fieldError("sessionCacheTtlMs") ? "var(--interactive-critical)" : "var(--border-base)"}`, color: "var(--text-base)" }} />
                    <FieldError text={fieldError("sessionCacheTtlMs")} />
                  </Field>
                </div>

                <div class="grid gap-4 md:grid-cols-2">
                  <Field label="Notification debounce (ms)">
                    <input class="w-full px-3 py-2 rounded-md text-sm" value={state().notificationDebounceMs} onInput={(e) => setField("notificationDebounceMs", e.currentTarget.value)} style={{ background: "var(--surface-inset)", border: `1px solid ${fieldError("notificationDebounceMs") ? "var(--interactive-critical)" : "var(--border-base)"}`, color: "var(--text-base)" }} />
                    <FieldError text={fieldError("notificationDebounceMs")} />
                  </Field>
                  <Field label="Port">
                    <input class="w-full px-3 py-2 rounded-md text-sm" value={state().port} onInput={(e) => setField("port", e.currentTarget.value)} style={{ background: "var(--surface-inset)", border: `1px solid ${fieldError("port") ? "var(--interactive-critical)" : "var(--border-base)"}`, color: "var(--text-base)" }} />
                    <FieldError text={fieldError("port")} />
                  </Field>
                </div>

                <Field label="Webhook path" hint="Path should start with '/'.">
                  <input class="w-full px-3 py-2 rounded-md text-sm" value={state().webhookPath} onInput={(e) => setField("webhookPath", e.currentTarget.value)} style={{ background: "var(--surface-inset)", border: `1px solid ${fieldError("webhookPath") ? "var(--interactive-critical)" : "var(--border-base)"}`, color: "var(--text-base)" }} />
                  <FieldError text={fieldError("webhookPath")} />
                </Field>

                <div class="grid gap-4 md:grid-cols-2">
                  <Field label="Webhook URL (optional)">
                    <input class="w-full px-3 py-2 rounded-md text-sm" value={state().webhookUrl} onInput={(e) => setField("webhookUrl", e.currentTarget.value)} style={{ background: "var(--surface-inset)", border: `1px solid ${fieldError("webhookUrl") ? "var(--interactive-critical)" : "var(--border-base)"}`, color: "var(--text-base)" }} />
                    <FieldError text={fieldError("webhookUrl")} />
                  </Field>
                  <Field label="Session link base (optional)">
                    <input class="w-full px-3 py-2 rounded-md text-sm" value={state().sessionLinkBase} onInput={(e) => setField("sessionLinkBase", e.currentTarget.value)} style={{ background: "var(--surface-inset)", border: `1px solid ${fieldError("sessionLinkBase") ? "var(--interactive-critical)" : "var(--border-base)"}`, color: "var(--text-base)" }} />
                    <FieldError text={fieldError("sessionLinkBase")} />
                  </Field>
                </div>

                <Field label="OpenCode directory (optional)">
                  <input class="w-full px-3 py-2 rounded-md text-sm" value={state().directory} onInput={(e) => setField("directory", e.currentTarget.value)} style={{ background: "var(--surface-inset)", border: "1px solid var(--border-base)", color: "var(--text-base)" }} />
                </Field>

                <Field label="Session store path">
                  <input class="w-full px-3 py-2 rounded-md text-sm" value={state().sessionStorePath} onInput={(e) => setField("sessionStorePath", e.currentTarget.value)} style={{ background: "var(--surface-inset)", border: `1px solid ${fieldError("sessionStorePath") ? "var(--interactive-critical)" : "var(--border-base)"}`, color: "var(--text-base)" }} />
                  <FieldError text={fieldError("sessionStorePath")} />
                </Field>
              </div>
            </section>

            <section class="rounded-lg overflow-hidden" style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}>
              <div class="px-4 py-3" style={{ "border-bottom": "1px solid var(--border-base)" }}>
                <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
                  Secrets
                </h2>
              </div>
              <div class="p-4 space-y-4">
                <SecretField
                  label="Bot token"
                  configured={tokenConfigured()}
                  mode={state().tokenMode}
                  value={state().token}
                  helper="Token values are never read back from the API."
                  error={fieldError("token")}
                  onModeChange={(value) => setField("tokenMode", value)}
                  onValueChange={(value) => setField("token", value)}
                />
                <SecretField
                  label="Webhook secret"
                  configured={webhookSecretConfigured()}
                  mode={state().webhookSecretMode}
                  value={state().webhookSecret}
                  helper="Used to verify incoming webhook requests."
                  error={fieldError("webhookSecret")}
                  onModeChange={(value) => setField("webhookSecretMode", value)}
                  onValueChange={(value) => setField("webhookSecret", value)}
                />
              </div>
            </section>

            <div class="flex items-center gap-3">
              <Button variant="primary" disabled={saving() || !dirty()} onClick={() => void save()}>
                <Show when={saving()} fallback={<><Save class="w-4 h-4" /> Save Telegram Settings</>}>
                  <Spinner class="w-4 h-4" /> Saving...
                </Show>
              </Button>
              <Button variant="secondary" disabled={saving()} onClick={() => void load()}>
                <RefreshCw class="w-4 h-4" /> Reload
              </Button>
            </div>
          </>
        )}
      </Show>

      <Show when={!loading() && !form()}>
        <div class="space-y-3">
          <div class="p-3 rounded-md text-sm" role="alert" aria-live="assertive" style={{ background: "var(--surface-inset)", border: "1px solid var(--border-base)", "border-left": "3px solid var(--interactive-critical)", color: "var(--interactive-critical)" }}>
            {error() || "Unable to load Telegram settings."}
          </div>

          <Button type="button" variant="outline" onClick={() => void load()}>
            <RefreshCw class="w-4 h-4 mr-2" />
            Reload
          </Button>
        </div>
      </Show>
    </div>
  )
}

function Field(props: ParentProps<{ label: string; hint?: string }>) {
  return (
    <label class="block space-y-1">
      <span class="text-sm" style={{ color: "var(--text-base)" }}>{props.label}</span>
      {props.children}
      <Show when={props.hint}>
        <span class="text-xs" style={{ color: "var(--text-weak)" }}>{props.hint}</span>
      </Show>
    </label>
  )
}

function FieldError(props: { text?: string }) {
  return (
    <Show when={props.text}>
      <span class="text-xs" style={{ color: "var(--interactive-critical)" }}>{props.text}</span>
    </Show>
  )
}

function SecretField(props: {
  label: string
  configured: boolean
  mode: "unchanged" | "set" | "clear"
  value: string
  helper: string
  error?: string
  onModeChange: (value: "unchanged" | "set" | "clear") => void
  onValueChange: (value: string) => void
}) {
  const isSet = () => props.mode === "set"
  const status = () => (props.configured ? "Configured" : "Not configured")

  return (
    <div class="space-y-2">
      <div class="flex items-center gap-2">
        <span class="text-sm" style={{ color: "var(--text-base)" }}>{props.label}</span>
        <span class="text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--surface-inset)", color: "var(--text-weak)" }}>{status()}</span>
      </div>
      <div class="flex gap-2">
        <button type="button" class="px-2 py-1 rounded text-xs" aria-pressed={props.mode === "unchanged"} onClick={() => props.onModeChange("unchanged")} style={{ background: props.mode === "unchanged" ? "var(--surface-inset)" : "transparent", border: "1px solid var(--border-base)", color: "var(--text-base)" }}>
          Keep
        </button>
        <button type="button" class="px-2 py-1 rounded text-xs" aria-pressed={props.mode === "set"} onClick={() => props.onModeChange("set")} style={{ background: props.mode === "set" ? "var(--surface-inset)" : "transparent", border: "1px solid var(--border-base)", color: "var(--text-base)" }}>
          {props.configured ? "Replace" : "Set"}
        </button>
        <button type="button" class="px-2 py-1 rounded text-xs" aria-pressed={props.mode === "clear"} onClick={() => props.onModeChange("clear")} style={{ background: props.mode === "clear" ? "var(--surface-inset)" : "transparent", border: "1px solid var(--border-base)", color: "var(--text-base)" }}>
          Clear
        </button>
      </div>
      <Show when={isSet()}>
        <input type="password" class="w-full px-3 py-2 rounded-md text-sm" value={props.value} onInput={(e) => props.onValueChange(e.currentTarget.value)} placeholder="Enter new secret value" style={{ background: "var(--surface-inset)", border: `1px solid ${props.error ? "var(--interactive-critical)" : "var(--border-base)"}`, color: "var(--text-base)" }} />
      </Show>
      <Show when={props.error}>
        <span class="text-xs" style={{ color: "var(--interactive-critical)" }}>{props.error}</span>
      </Show>
      <p class="text-xs" style={{ color: "var(--text-weak)" }}>{props.helper}</p>
    </div>
  )
}
