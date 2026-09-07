/* @refresh reload */
import { render } from "solid-js/web"
import { App } from "./app"
import { preventLegacyServiceWorkerCaching } from "./utils/legacy-service-worker"

const root = document.getElementById("root")

if (!root) {
  throw new Error("Root element not found")
}

const mount = root

// Clear the loading text first
mount.innerHTML = ""

async function start() {
  const cleanup = await preventLegacyServiceWorkerCaching().catch((e) => {
    console.warn("[OpenCode] Legacy service worker cleanup failed:", e)
    return null
  })
  if (cleanup && (cleanup.registrations > 0 || cleanup.caches > 0)) {
    console.warn(
      "[OpenCode] Cleared legacy service worker state:",
      `${cleanup.unregistered}/${cleanup.registrations} registrations, ${cleanup.caches} caches`,
    )
  }

  render(() => <App />, mount)
}

start().catch((e) => {
  console.error("[OpenCode] Render error:", e)
  mount.innerHTML = ""
  const message = document.createElement("div")
  message.style.color = "red"
  message.style.padding = "20px"
  message.textContent = `Error: ${e instanceof Error && e.message.trim() ? e.message : String(e)}`
  mount.appendChild(message)
})
