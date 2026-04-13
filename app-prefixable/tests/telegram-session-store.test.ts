import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { createTelegramSessionStore, telegramSessionKey } from "../../shared/telegram-session-store"

const files: string[] = []

async function cleanup(path: string) {
  await rm(path, { force: true }).catch(() => undefined)
  await rm(`${path}.tmp`, { force: true }).catch(() => undefined)
}

afterEach(async () => {
  for (const file of files) {
    await cleanup(file)
  }
  files.length = 0
})

describe("telegram session store", () => {
  test("persists mappings across store instances", async () => {
    const path = `/tmp/telegram-session-store-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    files.push(path)
    const key = telegramSessionKey(1001, 99)

    const first = createTelegramSessionStore(path)
    await first.set(key, "session-a")
    expect(await first.get(key)).toBe("session-a")

    const second = createTelegramSessionStore(path)
    expect(await second.get(key)).toBe("session-a")
    await second.delete(key)

    const third = createTelegramSessionStore(path)
    expect(await third.get(key)).toBeUndefined()
  })

  test("telegramSessionKey uses chat-only key without user id", () => {
    expect(telegramSessionKey(123)).toBe("chat:123")
    expect(telegramSessionKey(123, 456)).toBe("chat:123:user:456")
  })
})
