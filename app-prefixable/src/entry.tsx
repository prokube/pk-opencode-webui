/* @refresh reload */
import { render } from "solid-js/web"
import { App } from "./app"
import { preventLegacyServiceWorkerCaching } from "./utils/legacy-service-worker"

console.log("[OpenCode] Starting app...")

const root = document.getElementById("root")

if (!root) {
  throw new Error("Root element not found")
}

// Clear the loading text first
root.innerHTML = ""

async function start() {
  const cleanup = await preventLegacyServiceWorkerCaching()
  if (cleanup.registrations > 0 || cleanup.caches > 0) {
    console.log(
      "[OpenCode] Cleared legacy service worker state:",
      `${cleanup.unregistered}/${cleanup.registrations} registrations, ${cleanup.caches} caches`,
    )
  }

  console.log("[OpenCode] Rendering...")
  render(() => <App />, root)
  console.log("[OpenCode] Rendered successfully")
  console.log("[OpenCode] Root innerHTML:", root.innerHTML.slice(0, 200))
}

start().catch((e) => {
  console.error("[OpenCode] Render error:", e)
  root.innerHTML = `<div style="color: red; padding: 20px;">Error: ${e}</div>`
})
