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

  test("reads and upgrades v1 store while defaulting notifications to off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-session-store-"))
    const path = join(dir, "sessions.json")
    const keyA = telegramSessionKey(2001, 11)
    const keyB = telegramSessionKey(2002, 12)
    const session = "session-v1"
    files.push(path)
    files.push(dir)

    await Bun.write(
      path,
      `${JSON.stringify({ version: 1, sessions: { [keyA]: session, [keyB]: session } }, null, 2)}\n`,
    )

    const store = createTelegramSessionStore(path)
    expect(await store.get(keyA)).toBe(session)
    expect(await store.get(keyB)).toBe(session)
    expect(await store.sessionKeys?.(session)).toEqual(expect.arrayContaining([keyA, keyB]))
    expect(await store.notificationGet?.(keyA)).toBe(false)
    expect(await store.notificationGet?.(telegramSessionKey(2999, 99))).toBe(false)

    await store.set(telegramSessionKey(2003, 13), "session-new")

    const stored = JSON.parse(await Bun.file(path).text()) as {
      version?: number
      sessions?: Record<string, string>
      notifications?: Record<string, boolean>
    }
    expect(stored.version).toBe(2)
    expect(stored.sessions?.[keyA]).toBe(session)
    expect(stored.sessions?.[keyB]).toBe(session)
    expect(stored.notifications).toEqual({})
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
      `${JSON.stringify({ version: 2, sessions: { [telegramSessionKey(777, 42)]: "session-recovered" }, notifications: {} }, null, 2)}\n`,
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
      `${JSON.stringify({ version: 2, sessions: { [telegramSessionKey(778, 43)]: "session-good" }, notifications: {} }, null, 2)}\n`,
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
      `${JSON.stringify({ version: 2, sessions: { [key]: "session-recovered" }, notifications: {} }, null, 2)}\n`,
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

  test("persists notification opt-in flags", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-session-store-"))
    const path = join(dir, "sessions.json")
    const key = telegramSessionKey(880, 55)
    files.push(path)
    files.push(dir)

    const first = createTelegramSessionStore(path)
    await first.notificationSet?.(key, true)
    expect(await first.notificationGet?.(key)).toBe(true)

    const second = createTelegramSessionStore(path)
    expect(await second.notificationGet?.(key)).toBe(true)
    await second.notificationSet?.(key, false)
    expect(await second.notificationGet?.(key)).toBe(false)
  })

  test("sessionKeys returns all mappings for a session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-session-store-"))
    const path = join(dir, "sessions.json")
    files.push(path)
    files.push(dir)

    const first = createTelegramSessionStore(path)
    await first.set(telegramSessionKey(400, 1), "session-a")
    await first.set(telegramSessionKey(401, 2), "session-a")
    await first.set(telegramSessionKey(402, 3), "session-b")

    const keys = await first.sessionKeys?.("session-a")
    expect(keys?.sort()).toEqual([telegramSessionKey(400, 1), telegramSessionKey(401, 2)])
  })
})
