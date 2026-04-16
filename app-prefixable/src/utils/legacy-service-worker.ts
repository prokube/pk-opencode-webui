const LEGACY_CACHE_PATTERN = /(workbox|opencode-(precache|runtime))/i

type CleanupResult = {
  registrations: number
  unregistered: number
  caches: number
}

const EMPTY_RESULT: CleanupResult = { registrations: 0, unregistered: 0, caches: 0 }

export async function preventLegacyServiceWorkerCaching() {
  if (typeof window === "undefined") return EMPTY_RESULT
  if (typeof navigator === "undefined") return EMPTY_RESULT
  if (!("serviceWorker" in navigator)) return EMPTY_RESULT

  const appScope = new URL(".", window.location.href).href
  const regs = await navigator.serviceWorker.getRegistrations().catch(() => [] as ServiceWorkerRegistration[])
  const scoped = regs.filter((item) => item.scope.startsWith(appScope))
  const results = await Promise.allSettled(scoped.map((item) => item.unregister()))
  const unregistered = results.reduce((count, item) => {
    if (item.status === "fulfilled" && item.value) return count + 1
    return count
  }, 0)

  if (!("caches" in window)) return { registrations: scoped.length, unregistered, caches: 0 }

  const keys = await window.caches.keys().catch(() => [] as string[])
  const stale = keys.filter((key) => LEGACY_CACHE_PATTERN.test(key))
  await Promise.allSettled(stale.map((key) => window.caches.delete(key)))

  return { registrations: scoped.length, unregistered, caches: stale.length }
}
