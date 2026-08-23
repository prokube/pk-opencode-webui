import { For, Show } from "solid-js"
import { Bell, BellOff } from "lucide-solid"
import { useBrowserNotifications } from "../context/browser-notifications"
import type { BrowserNotificationSettings } from "../utils/browser-notifications"
import { Button } from "./ui/button"

export function BrowserNotificationsSettings() {
  const notifications = useBrowserNotifications()
  const rows: Array<{ key: keyof BrowserNotificationSettings; title: string; description: string }> = [
    { key: "agent", title: "Agent responses and questions", description: "Notify when a response is ready or the agent asks a question." },
    { key: "permissions", title: "Permission requests", description: "Notify when a session is waiting for approval." },
    { key: "errors", title: "Session errors", description: "Notify when a root session encounters an error." },
  ]

  return (
    <section class="rounded-lg overflow-hidden" style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}>
      <div class="px-4 py-3 flex items-center justify-between gap-4" style={{ "border-bottom": "1px solid var(--border-base)" }}>
        <div>
          <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>Browser notifications</h2>
          <p class="text-xs mt-1" style={{ color: "var(--text-weak)" }}>Shown only when this window is not in focus.</p>
        </div>
        <Show when={notifications.permission() === "default"}>
          <Button size="sm" variant="primary" onClick={() => void notifications.request()}>
            <Bell class="w-4 h-4" /> Enable
          </Button>
        </Show>
      </div>

      <Show when={!notifications.supported()}>
        <p class="px-4 py-3 text-sm" style={{ color: "var(--text-weak)" }}>This browser does not support system notifications.</p>
      </Show>
      <Show when={notifications.permission() === "denied"}>
        <div role="status" aria-live="polite" class="px-4 py-3 flex items-start gap-2 text-sm" style={{ color: "var(--text-weak)" }}>
          <BellOff class="w-4 h-4 mt-0.5 shrink-0" /> Notifications are blocked. Allow them in your browser's site settings to enable delivery.
        </div>
      </Show>
      <Show when={notifications.legacyCount() > 0}>
        <div class="px-4 py-3 flex items-center justify-between gap-4" style={{ "border-bottom": "1px solid var(--border-base)" }}>
          <p class="text-xs" style={{ color: "var(--text-weak)" }}>
            {notifications.legacyCount()} per-session alert{notifications.legacyCount() === 1 ? " remains" : "s remain"} enabled from the previous version.
          </p>
          <Button size="sm" onClick={notifications.clearLegacy}>Disable legacy alerts</Button>
        </div>
      </Show>

      <Show when={notifications.supported()}>
        <For each={rows}>
          {(row) => (
            <label class="px-4 py-3 flex items-center justify-between gap-4 border-b last:border-b-0" style={{ "border-color": "var(--border-base)" }}>
              <span>
                <span class="block text-sm font-medium" style={{ color: "var(--text-strong)" }}>{row.title}</span>
                <span class="block text-xs mt-0.5" style={{ color: "var(--text-weak)" }}>{row.description}</span>
              </span>
              <input
                type="checkbox"
                checked={notifications.settings()[row.key]}
                onChange={(event) => notifications.set(row.key, event.currentTarget.checked)}
                class="h-4 w-4 shrink-0 accent-[var(--interactive-base)]"
              />
            </label>
          )}
        </For>
      </Show>
    </section>
  )
}
