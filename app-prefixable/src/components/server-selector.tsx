import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import { useLocation, useNavigate } from "@solidjs/router"
import { For, Show } from "solid-js"
import { Check, ChevronDown, Server } from "lucide-solid"
import { LOCAL_SERVER_ID, useConnections } from "../context/server"
import { serverHref, serverSettingsHref } from "../utils/servers"

export function ServerSelector(props: { compact?: boolean }) {
  const registry = useConnections()
  const location = useLocation()
  const navigate = useNavigate()
  const current = () => new URLSearchParams(location.search).get("server") || LOCAL_SERVER_ID
  const selected = () => registry.list().find(item => item.id === current())
  return (
    <DropdownMenu placement="bottom-start">
      <DropdownMenu.Trigger
        class={`${props.compact ? "w-10 justify-center" : "w-full gap-2 px-3"} h-10 rounded-lg flex items-center hover:bg-[var(--surface-inset)]`}
        style={{ color: "var(--icon-base)" }}
        title={`${selected()?.name || "Server unavailable"}${selected() ? ` — ${selected()!.url}` : ""}`}
        aria-label="Select server"
        onKeyDown={event => event.stopPropagation()}
      ><Server class="w-5 h-5 shrink-0" /><Show when={!props.compact}><span class="min-w-0 flex-1 truncate text-left text-sm">{selected()?.name || "Server unavailable"}</span><ChevronDown size={14} /></Show></DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="z-50 min-w-64 max-w-sm rounded-lg border p-1 shadow-lg" style={{ background: "var(--background-base)", color: "var(--text-base)", "border-color": "var(--border-base)" }}>
          <For each={registry.list()}>{(item) => (
            <DropdownMenu.Item
              class="flex cursor-pointer items-center gap-3 rounded p-2 outline-none data-[highlighted]:bg-[var(--surface-inset)]"
              aria-current={current() === item.id ? "true" : undefined}
              title={item.url}
              onSelect={() => {
                if (current() === item.id) return
                const workspace = registry.workspace(item.id)
                navigate(location.pathname.endsWith("/settings")
                  ? serverSettingsHref(item.id, workspace, window.location.hash)
                  : location.pathname.endsWith("/settings/servers")
                    ? serverHref(item.id, "/settings/servers")
                    : workspace || serverHref(item.id, "/"))
              }}
            >
              <span class="min-w-0 flex-1 truncate">{item.name}</span>
              <Show when={current() === item.id}><Check size={16} aria-label="Current server" /></Show>
            </DropdownMenu.Item>
          )}</For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
