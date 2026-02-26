import { onCleanup } from "solid-js"

export interface ResizeHandleProps {
  direction: "horizontal" | "vertical"
  edge?: "start" | "end"
  size: number
  min: number
  max: number
  onResize: (size: number) => void
  onCollapse?: () => void
  collapseThreshold?: number
  class?: string
}

export function ResizeHandle(props: ResizeHandleProps) {
  let cleanup: (() => void) | null = null

  onCleanup(() => {
    if (cleanup) cleanup()
  })

  const handleMouseDown = (e: MouseEvent) => {
    e.preventDefault()
    const edge = props.edge ?? (props.direction === "vertical" ? "start" : "end")
    const start = props.direction === "horizontal" ? e.clientX : e.clientY
    const startSize = props.size
    let current = startSize

    document.body.style.userSelect = "none"
    document.body.style.overflow = "hidden"

    const onMouseMove = (moveEvent: MouseEvent) => {
      const pos = props.direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY
      const delta =
        props.direction === "vertical"
          ? edge === "end"
            ? pos - start
            : start - pos
          : edge === "start"
            ? start - pos
            : pos - start
      current = startSize + delta
      const clamped = Math.min(props.max, Math.max(props.min, current))
      props.onResize(clamped)
    }

    const onMouseUp = () => {
      document.body.style.userSelect = ""
      document.body.style.overflow = ""
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
      cleanup = null

      const threshold = props.collapseThreshold ?? 0
      if (props.onCollapse && threshold > 0 && current < threshold) {
        props.onCollapse()
      }
    }

    cleanup = () => {
      document.body.style.userSelect = ""
      document.body.style.overflow = ""
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
    }

    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", onMouseUp)
  }

  const isHorizontal = () => props.direction === "horizontal"

  return (
    <div
      class={`${props.class ?? ""} group flex items-center justify-center`}
      style={{
        cursor: isHorizontal() ? "col-resize" : "row-resize",
        width: isHorizontal() ? "4px" : "100%",
        height: isHorizontal() ? "100%" : "4px",
        "flex-shrink": 0,
      }}
      onMouseDown={handleMouseDown}
    >
      <div
        class="transition-colors group-hover:bg-[var(--interactive-base)]"
        style={{
          width: isHorizontal() ? "2px" : "40px",
          height: isHorizontal() ? "40px" : "2px",
          "border-radius": "2px",
          background: "var(--border-base)",
        }}
      />
    </div>
  )
}
