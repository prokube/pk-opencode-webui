import { onMount, onCleanup, createSignal } from "solid-js"
import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { useSDK } from "../context/sdk"

export interface TerminalProps {
  ptyId: string
  onClose?: () => void
}

export function Terminal(props: TerminalProps) {
  const { client, url, directory } = useSDK()
  let container!: HTMLDivElement
  let term: XTerm | undefined
  let fitAddon: FitAddon | undefined
  let ws: WebSocket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const [status, setStatus] = createSignal<"connecting" | "connected" | "error" | "disconnected">("connecting")
  const [error, setError] = createSignal<string | null>(null)

  function writeStatus(message: string, type: "info" | "error" | "success" = "info") {
    if (!term) return
    const colors = {
      info: "\x1b[90m", // gray
      error: "\x1b[31m", // red
      success: "\x1b[32m", // green
    }
    term.write(`${colors[type]}${message}\x1b[0m\r\n`)
  }

  function connect() {
    if (disposed || !term) return

    // Build WebSocket URL
    const wsUrl =
      url.replace(/^http/, "ws") + `/pty/${props.ptyId}/connect?directory=${encodeURIComponent(directory || "")}`
    console.log("[Terminal] Connecting to:", wsUrl)

    setStatus("connecting")
    setError(null)

    ws = new WebSocket(wsUrl)

    ws.addEventListener("open", () => {
      console.log("[Terminal] WebSocket connected")
      setStatus("connected")

      // Send initial size after connection
      if (term) {
        client.pty
          .update({
            ptyID: props.ptyId,
            size: { cols: term.cols, rows: term.rows },
          })
          .then(() => {
            console.log("[Terminal] Size updated:", term?.cols, "x", term?.rows)
          })
          .catch((e) => {
            console.error("[Terminal] Failed to update size:", e)
            writeStatus(`Warning: Failed to update terminal size: ${e.message || e}`, "error")
          })
      }
    })

    ws.addEventListener("message", (event) => {
      term?.write(event.data)
    })

    ws.addEventListener("error", (e) => {
      console.error("[Terminal] WebSocket error:", e)
      setStatus("error")
      setError("WebSocket connection error")
      writeStatus("WebSocket error - check browser console for details", "error")
    })

    ws.addEventListener("close", (event) => {
      console.log("[Terminal] WebSocket closed:", event.code, event.reason)
      setStatus("disconnected")

      if (event.code === 1000) {
        writeStatus("Connection closed normally", "info")
      } else if (event.code === 1006) {
        writeStatus(`Connection lost (code: ${event.code}) - server may have closed the PTY`, "error")
      } else {
        writeStatus(`Connection closed: code=${event.code}, reason=${event.reason || "unknown"}`, "error")
      }

      // Reconnect on abnormal close (but not if we're disposing)
      if (!disposed && event.code !== 1000) {
        console.log("[Terminal] Scheduling reconnect...")
        writeStatus("Reconnecting in 2 seconds...", "info")
        reconnectTimer = setTimeout(() => connect(), 2000)
      }
    })
  }

  onMount(() => {
    console.log("[Terminal] Mounting, ptyId:", props.ptyId)

    // Create terminal with light theme
    term = new XTerm({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 14,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      theme: {
        background: "#ffffff",
        foreground: "#1f2937",
        cursor: "#1f2937",
        cursorAccent: "#ffffff",
        selectionBackground: "rgba(59, 130, 246, 0.3)",
        selectionForeground: "#1f2937",
        black: "#1f2937",
        red: "#dc2626",
        green: "#16a34a",
        yellow: "#ca8a04",
        blue: "#2563eb",
        magenta: "#9333ea",
        cyan: "#0891b2",
        white: "#f3f4f6",
        brightBlack: "#6b7280",
        brightRed: "#ef4444",
        brightGreen: "#22c55e",
        brightYellow: "#eab308",
        brightBlue: "#3b82f6",
        brightMagenta: "#a855f7",
        brightCyan: "#06b6d4",
        brightWhite: "#ffffff",
      },
      scrollback: 10000,
    })

    // Add fit addon
    fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    // Open terminal in container
    term.open(container)
    console.log("[Terminal] Terminal opened in container")

    // Show initializing message
    writeStatus("Initializing terminal...", "info")

    // Send terminal input to WebSocket
    term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    })

    // Handle resize
    term.onResize((size) => {
      console.log("[Terminal] Resize:", size.cols, "x", size.rows)
      if (ws?.readyState === WebSocket.OPEN) {
        client.pty
          .update({
            ptyID: props.ptyId,
            size: { cols: size.cols, rows: size.rows },
          })
          .catch(() => {})
      }
    })

    // Delay fit and connect to ensure container is properly sized
    setTimeout(() => {
      if (fitAddon && container.offsetWidth > 0 && container.offsetHeight > 0) {
        console.log("[Terminal] Container size:", container.offsetWidth, "x", container.offsetHeight)
        fitAddon.fit()
        console.log("[Terminal] Terminal size after fit:", term?.cols, "x", term?.rows)
      } else {
        console.warn("[Terminal] Container has no size yet")
        writeStatus("Warning: Terminal container has no size yet", "error")
      }
      connect()
    }, 100)

    // Window resize handler
    const handleResize = () => {
      if (fitAddon && container.offsetWidth > 0 && container.offsetHeight > 0) {
        fitAddon.fit()
      }
    }
    window.addEventListener("resize", handleResize)

    // Use ResizeObserver to detect container size changes
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
          setTimeout(() => fitAddon?.fit(), 10)
        }
      }
    })
    resizeObserver.observe(container)

    // Focus terminal
    term.focus()

    onCleanup(() => {
      console.log("[Terminal] Cleaning up")
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      window.removeEventListener("resize", handleResize)
      resizeObserver.disconnect()
      ws?.close()
      term?.dispose()
    })
  })

  return (
    <div
      class="size-full"
      style={{
        background: "#ffffff",
        padding: "8px",
        "min-height": "100px",
      }}
    >
      <div ref={container} class="size-full" style={{ "min-height": "100px" }} />
    </div>
  )
}
