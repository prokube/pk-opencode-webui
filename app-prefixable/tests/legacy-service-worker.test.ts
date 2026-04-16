import { afterEach, describe, expect, test } from "bun:test"
import { preventLegacyServiceWorkerCaching } from "../src/utils/legacy-service-worker"

const globals = globalThis as {
  window?: Window & typeof globalThis
  navigator?: Navigator
  caches?: CacheStorage
}

const originalWindow = globals.window
const originalNavigator = globals.navigator
const originalCaches = globals.caches

afterEach(() => {
  if (originalWindow === undefined) {
    delete globals.window
  } else {
    globals.window = originalWindow
  }
  if (originalNavigator === undefined) {
    delete globals.navigator
  } else {
    globals.navigator = originalNavigator
  }
  if (originalCaches === undefined) {
    delete globals.caches
  } else {
    globals.caches = originalCaches
  }
})

describe("preventLegacyServiceWorkerCaching", () => {
  test("skips cleanup when service workers are unavailable", async () => {
    delete globals.window
    delete globals.navigator

    const res = await preventLegacyServiceWorkerCaching()

    expect(res).toEqual({ registrations: 0, unregistered: 0, caches: 0 })
  })

  test("unregisters scoped workers and clears legacy workbox caches", async () => {
    let currentUnregisters = 0
    let otherUnregisters = 0
    const deleted: string[] = []

    const current = {
      scope: "https://example.test/notebook/ns/a/",
      unregister: async () => {
        currentUnregisters += 1
        return true
      },
    } as ServiceWorkerRegistration

    const other = {
      scope: "https://example.test/notebook/ns/other/",
      unregister: async () => {
        otherUnregisters += 1
        return true
      },
    } as ServiceWorkerRegistration

    const navigator = {
      serviceWorker: {
        getRegistrations: async () => [current, other],
      },
    } as Navigator

    const cacheStorage = {
      keys: async () => ["workbox-runtime-v1", "misc-cache", "opencode-precache-v2"],
      delete: async (key: string) => {
        deleted.push(key)
        return true
      },
    } as unknown as CacheStorage

    globals.window = {
      location: { href: "https://example.test/notebook/ns/a/session" },
      caches: cacheStorage,
    } as unknown as Window & typeof globalThis
    globals.navigator = navigator
    globals.caches = cacheStorage

    const res = await preventLegacyServiceWorkerCaching()

    expect(res).toEqual({ registrations: 1, unregistered: 1, caches: 2 })
    expect(currentUnregisters).toBe(1)
    expect(otherUnregisters).toBe(0)
    expect(deleted).toEqual(["workbox-runtime-v1", "opencode-precache-v2"])
  })
})
