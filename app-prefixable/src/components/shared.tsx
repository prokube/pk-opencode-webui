import { Folder } from "lucide-solid"

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

export function ProjectAvatar(props: { project: Project; size?: "small" | "large"; selected?: boolean }) {
  const name = () => props.project.name || getFilename(props.project.worktree)
  const initials = () => getInitials(name())
  const size = () => (props.size === "large" ? "w-10 h-10" : "w-8 h-8")
  const iconSize = () => (props.size === "large" ? "w-5 h-5" : "w-4 h-4")

  // pkui button style: white bg, gray border, brand color when selected/hovered
  return (
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
  )
}
