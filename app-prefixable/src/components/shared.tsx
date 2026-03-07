import { Show } from "solid-js"
import { Folder, ShieldAlert, CircleHelp, Loader2 } from "lucide-solid"
import type { AlertKind } from "../context/global-events"

export interface Project {
  worktree: string
  name?: string
}

export function getFilename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path
}

export function getInitials(name: string): string {
  // Only use ASCII letters for initials
  const clean = name.replace(/[^a-zA-Z0-9\s_-]/g, "")
  if (!clean) return ""
  const parts = clean
    .split(/[-_\s]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || "")
    .join("")
  return parts
}

export function OpenCodeLogo(props: { class?: string }) {
  return (
    <svg class={props.class} viewBox="0 0 240 300" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ color: "var(--text-strong)" }}>
      <path d="M180 240H60V120H180V240Z" fill="var(--icon-weak)" />
      <path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="currentColor" />
    </svg>
  )
}

export function ProjectAvatar(props: {
  project: Project
  size?: "small" | "large"
  selected?: boolean
  badge?: { kind: AlertKind; count: number }
}) {
  const name = () => props.project.name || getFilename(props.project.worktree)
  const initials = () => getInitials(name())
  const size = () => (props.size === "large" ? "w-10 h-10" : "w-8 h-8")
  const iconSize = () => (props.size === "large" ? "w-5 h-5" : "w-4 h-4")

  // pkui button style: white bg, gray border, brand color when selected/hovered
  return (
    <div class="relative shrink-0">
      <div
        class={`${size()} rounded-xl flex items-center justify-center font-medium text-sm shrink-0 transition-all border-2`}
        style={{
          background: props.selected ? "var(--surface-inset)" : "var(--background-base)",
          color: props.selected ? "var(--interactive-base)" : "var(--text-base)",
          "border-color": props.selected ? "var(--interactive-base)" : "var(--border-base)",
          "box-shadow": props.selected ? "0 4px 6px -1px rgb(0 0 0 / 0.1)" : "none",
        }}
      >
        {initials() || <Folder class={iconSize()} />}
      </div>
      <Show when={props.badge}>
        {(b) => <AlertBadge kind={b().kind} count={b().count} />}
      </Show>
    </div>
  )
}

function AlertBadge(props: { kind: AlertKind; count: number }) {
  const color = () => {
    if (props.kind === "permission") return "var(--interactive-base)"
    if (props.kind === "question") return "var(--icon-warning-base)"
    return "var(--text-weak)"
  }

  const Icon = () => {
    if (props.kind === "permission") return <ShieldAlert class="w-2.5 h-2.5" />
    if (props.kind === "question") return <CircleHelp class="w-2.5 h-2.5" />
    return <Loader2 class="w-2.5 h-2.5 animate-spin" />
  }

  const label = () => {
    const k = props.kind === "permission" ? "permission request" : props.kind === "question" ? "question" : "busy session"
    return props.count === 1 ? `1 ${k}` : `${props.count} ${k}s`
  }

  return (
    <div
      class="absolute -top-1.5 -right-1.5 flex items-center gap-px rounded-full px-0.5 min-w-4 h-4 justify-center"
      role="status"
      aria-label={label()}
      style={{
        background: "var(--background-base)",
        color: color(),
        border: `1.5px solid ${color()}`,
        "font-size": "9px",
        "font-weight": "600",
        "line-height": "1",
      }}
    >
      <Icon />
      <Show when={props.count > 1}>
        <span aria-hidden="true">{props.count}</span>
      </Show>
    </div>
  )
}
