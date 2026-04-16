const LEGACY_CACHE_PATTERN = /(workbox|opencode-(precache|runtime))/i

export async function preventLegacyServiceWorkerCaching() {
  if (typeof window === "undefined") {
    return { registrations: 0, unregistered: 0, caches: 0 }
  }
  if (!("serviceWorker" in navigator)) {
    return { registrations: 0, unregistered: 0, caches: 0 }
  }

  const url = window.location.href
  const regs = await navigator.serviceWorker.getRegistrations().catch(() => [] as ServiceWorkerRegistration[])
  const scoped = regs.filter((item) => url.startsWith(item.scope))
  const results = await Promise.allSettled(scoped.map((item) => item.unregister()))
  const unregistered = results.reduce((count, item) => {
    if (item.status === "fulfilled" && item.value) return count + 1
    return count
  }, 0)

  if (!("caches" in window)) {
    return { registrations: scoped.length, unregistered, caches: 0 }
  }

  const keys = await caches.keys().catch(() => [] as string[])
  const stale = keys.filter((key) => LEGACY_CACHE_PATTERN.test(key))
  await Promise.allSettled(stale.map((key) => caches.delete(key)))

  return { registrations: scoped.length, unregistered, caches: stale.length }
}
