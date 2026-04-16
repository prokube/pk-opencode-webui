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

  test("skips cleanup when navigator is missing", async () => {
    globals.window = {
      location: { href: "https://example.test/notebook/ns/a/session" },
    } as unknown as Window & typeof globalThis
    delete globals.navigator

    const res = await preventLegacyServiceWorkerCaching()

    expect(res).toEqual({ registrations: 0, unregistered: 0, caches: 0 })
  })

  test("unregisters workers that control app scope when legacy caches exist", async () => {
    let currentUnregisters = 0
    let broadUnregisters = 0
    let otherUnregisters = 0
    const deleted: string[] = []

    const current = {
      scope: "https://example.test/notebook/ns/a/",
      active: { scriptURL: "https://example.test/sw.js" },
      unregister: async () => {
        currentUnregisters += 1
        return true
      },
    } as ServiceWorkerRegistration

    const other = {
      scope: "https://example.test/notebook/ns/other/",
      active: { scriptURL: "https://example.test/sw.js" },
      unregister: async () => {
        otherUnregisters += 1
        return true
      },
    } as ServiceWorkerRegistration

    const broad = {
      scope: "https://example.test/",
      active: { scriptURL: "https://example.test/sw.js" },
      unregister: async () => {
        broadUnregisters += 1
        return true
      },
    } as ServiceWorkerRegistration

    const navigator = {
      serviceWorker: {
        getRegistrations: async () => [current, broad, other],
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

    expect(res).toEqual({ registrations: 2, unregistered: 2, caches: 2 })
    expect(currentUnregisters).toBe(1)
    expect(broadUnregisters).toBe(1)
    expect(otherUnregisters).toBe(0)
    expect(deleted).toEqual(["workbox-runtime-v1", "opencode-precache-v2"])
  })

  test("keeps non-legacy workers when there are no legacy caches", async () => {
    let currentUnregisters = 0
    let broadUnregisters = 0

    const current = {
      scope: "https://example.test/notebook/ns/a/",
      active: { scriptURL: "https://example.test/sw.js" },
      unregister: async () => {
        currentUnregisters += 1
        return true
      },
    } as ServiceWorkerRegistration

    const broad = {
      scope: "https://example.test/",
      active: { scriptURL: "https://example.test/sw.js" },
      unregister: async () => {
        broadUnregisters += 1
        return true
      },
    } as ServiceWorkerRegistration

    const navigator = {
      serviceWorker: {
        getRegistrations: async () => [current, broad],
      },
    } as Navigator

    const cacheStorage = {
      keys: async () => ["misc-cache"],
      delete: async () => true,
    } as unknown as CacheStorage

    globals.window = {
      location: { href: "https://example.test/notebook/ns/a/session" },
      caches: cacheStorage,
    } as unknown as Window & typeof globalThis
    globals.navigator = navigator
    globals.caches = cacheStorage

    const res = await preventLegacyServiceWorkerCaching()

    expect(res).toEqual({ registrations: 0, unregistered: 0, caches: 0 })
    expect(currentUnregisters).toBe(0)
    expect(broadUnregisters).toBe(0)
  })

  test("unregisters legacy script workers that control app scope", async () => {
    let broadUnregisters = 0
    let nonLegacyUnregisters = 0

    const broadLegacy = {
      scope: "https://example.test/",
      active: { scriptURL: "https://example.test/assets/workbox-sw.js" },
      unregister: async () => {
        broadUnregisters += 1
        return true
      },
    } as ServiceWorkerRegistration

    const appNonLegacy = {
      scope: "https://example.test/notebook/ns/a/",
      active: { scriptURL: "https://example.test/sw.js" },
      unregister: async () => {
        nonLegacyUnregisters += 1
        return true
      },
    } as ServiceWorkerRegistration

    const navigator = {
      serviceWorker: {
        getRegistrations: async () => [broadLegacy, appNonLegacy],
      },
    } as Navigator

    const cacheStorage = {
      keys: async () => ["misc-cache"],
      delete: async () => true,
    } as unknown as CacheStorage

    globals.window = {
      location: { href: "https://example.test/notebook/ns/a/session" },
      caches: cacheStorage,
    } as unknown as Window & typeof globalThis
    globals.navigator = navigator
    globals.caches = cacheStorage

    const res = await preventLegacyServiceWorkerCaching()

    expect(res).toEqual({ registrations: 1, unregistered: 1, caches: 0 })
    expect(broadUnregisters).toBe(1)
    expect(nonLegacyUnregisters).toBe(0)
  })

  test("clears legacy caches from window when global caches is unavailable", async () => {
    const deleted: string[] = []

    const cacheStorage = {
      keys: async () => ["misc-cache", "opencode-runtime-v3"],
      delete: async (key: string) => {
        deleted.push(key)
        return true
      },
    } as unknown as CacheStorage

    globals.window = {
      location: { href: "https://example.test/notebook/ns/a/session" },
      caches: cacheStorage,
    } as unknown as Window & typeof globalThis
    globals.navigator = {
      serviceWorker: { getRegistrations: async () => [] },
    } as Navigator
    delete globals.caches

    const res = await preventLegacyServiceWorkerCaching()

    expect(res).toEqual({ registrations: 0, unregistered: 0, caches: 1 })
    expect(deleted).toEqual(["opencode-runtime-v3"])
  })
})
