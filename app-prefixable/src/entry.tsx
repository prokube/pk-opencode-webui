/* @refresh reload */
import { render } from "solid-js/web"
import { App } from "./app"

console.log("[OpenCode] Starting app...")

const root = document.getElementById("root")

if (!root) {
  throw new Error("Root element not found")
}

// Clear the loading text first
root.innerHTML = ""

try {
  console.log("[OpenCode] Rendering...")
  render(() => <App />, root)
  console.log("[OpenCode] Rendered successfully")
  console.log("[OpenCode] Root innerHTML:", root.innerHTML.slice(0, 200))
} catch (e) {
  console.error("[OpenCode] Render error:", e)
  root.innerHTML = `<div style="color: red; padding: 20px;">Error: ${e}</div>`
}
