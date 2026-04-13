import { startTelegramBridge } from "../shared/telegram-bridge"

console.log("[TelegramBridge] starting")

startTelegramBridge().catch((error) => {
  console.error("[TelegramBridge] fatal error", error)
  process.exit(1)
})
