const LEGACY_CACHE_PATTERN = /(workbox|opencode-(precache|runtime))/i
const LEGACY_SCRIPT_PATTERN = /(workbox|opencode)/i

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
  const origin = new URL(window.location.href).origin

  const keys = "caches" in window ? await window.caches.keys().catch(() => [] as string[]) : []
  const stale = keys.filter((key) => LEGACY_CACHE_PATTERN.test(key))
  const hasLegacyCaches = stale.length > 0

  const regs = await navigator.serviceWorker.getRegistrations().catch(() => [] as ServiceWorkerRegistration[])
  const scoped = regs.filter((item) => appScope.startsWith(item.scope))
  const targets = scoped.filter((item) => {
    const worker = item.active ?? item.waiting ?? item.installing
    const scriptUrl = worker?.scriptURL
    const isLegacyScript = typeof scriptUrl === "string" && LEGACY_SCRIPT_PATTERN.test(scriptUrl)
    if (isLegacyScript) return true
    if (!hasLegacyCaches) return false
    const regOrigin = new URL(item.scope).origin
    if (regOrigin !== origin) return false
    return item.scope === appScope || appScope.startsWith(item.scope)
  })
  const results = await Promise.allSettled(targets.map((item) => item.unregister()))
  const unregistered = results.reduce((count, item) => {
    if (item.status === "fulfilled" && item.value) return count + 1
    return count
  }, 0)

  await Promise.allSettled(stale.map((key) => window.caches.delete(key)))

  return { registrations: targets.length, unregistered, caches: stale.length }
}
