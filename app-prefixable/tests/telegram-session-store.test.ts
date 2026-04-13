import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createTelegramSessionStore, telegramSessionKey } from "../../shared/telegram-session-store"

const files: string[] = []

async function cleanup(path: string) {
  await rm(path, { force: true, recursive: true }).catch(() => undefined)
  await rm(`${path}.tmp`, { force: true, recursive: true }).catch(() => undefined)
}

afterEach(async () => {
  for (const file of files) {
    await cleanup(file)
  }
  files.length = 0
})

describe("telegram session store", () => {
  test("persists mappings across store instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-session-store-"))
    const path = join(dir, "sessions.json")
    files.push(path)
    files.push(dir)
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
    expect(telegramSessionKey(123, 0)).toBe("chat:123:user:0")
    expect(telegramSessionKey(123, 456)).toBe("chat:123:user:456")
  })

  test("set rolls back in-memory value when flush fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-session-store-"))
    const blocked = join(dir, "blocked-parent")
    const path = join(blocked, "telegram-session-store.json")
    files.push(dir)
    await Bun.write(blocked, "blocked")
    const store = createTelegramSessionStore(path)
    const key = telegramSessionKey(222, 7)

    await expect(store.set(key, "session-a")).rejects.toThrow()
    expect(await store.get(key)).toBeUndefined()
  })

  test("delete restores in-memory value when flush fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-session-store-"))
    const parent = join(dir, "sessions")
    const path = join(parent, "store.json")
    files.push(path)
    files.push(dir)

    const key = telegramSessionKey(333, 8)
    const store = createTelegramSessionStore(path)
    await store.set(key, "session-a")
    await rm(parent, { force: true, recursive: true })
    await Bun.write(parent, "blocked")

    await expect(store.delete(key)).rejects.toThrow()
    expect(await store.get(key)).toBe("session-a")
  })

  test("recovers from backup when primary file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-session-store-"))
    const path = join(dir, "sessions.json")
    const backup = `${path}.bak.${Date.now()}.recover`
    files.push(dir)

    await Bun.write(
      backup,
      `${JSON.stringify({ version: 1, sessions: { [telegramSessionKey(777, 42)]: "session-recovered" } }, null, 2)}\n`,
    )

    const store = createTelegramSessionStore(path)
    expect(await store.get(telegramSessionKey(777, 42))).toBe("session-recovered")
    expect(await Bun.file(path).exists()).toBe(true)
    expect(await Bun.file(backup).exists()).toBe(false)
  })

  test("skips invalid backup and recovers from next valid backup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-session-store-"))
    const path = join(dir, "sessions.json")
    const badBackup = `${path}.bak.${Date.now() + 1}.bad`
    const goodBackup = `${path}.bak.${Date.now()}.good`
    files.push(dir)

    await Bun.write(badBackup, "{invalid json")
    await Bun.write(
      goodBackup,
      `${JSON.stringify({ version: 1, sessions: { [telegramSessionKey(778, 43)]: "session-good" } }, null, 2)}\n`,
    )

    const store = createTelegramSessionStore(path)
    expect(await store.get(telegramSessionKey(778, 43))).toBe("session-good")
    expect(await Bun.file(path).exists()).toBe(true)
  })

  test("recovers from backup when primary file is corrupt JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-session-store-"))
    const path = join(dir, "sessions.json")
    const backup = `${path}.bak.${Date.now()}.recover`
    const key = telegramSessionKey(779, 44)
    files.push(dir)

    await Bun.write(path, "{invalid json")
    await Bun.write(
      backup,
      `${JSON.stringify({ version: 1, sessions: { [key]: "session-recovered" } }, null, 2)}\n`,
    )

    const store = createTelegramSessionStore(path)
    expect(await store.get(key)).toBe("session-recovered")
    expect(await Bun.file(path).exists()).toBe(true)
    expect(await Bun.file(backup).exists()).toBe(false)
    const stored = JSON.parse(await Bun.file(path).text()) as { sessions?: Record<string, string> }
    expect(stored.sessions?.[key]).toBe("session-recovered")
    const leftovers = (await readdir(dir)).filter((entry) => entry.includes("sessions.json.corrupt."))
    expect(leftovers).toEqual([])
  })
})
