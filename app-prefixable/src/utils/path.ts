declare global {
  interface Window {
    __OPENCODE__?: {
      basePath?: string
      serverUrl?: string
    }
  }
}

export function getBasePath(): string {
  // Priority order:
  // 1. Explicit config in window.__OPENCODE__
  // 2. <base href="..."> tag
  // 3. Build-time injected value
  // 4. Default to "/"

  if (typeof window !== "undefined") {
    // From global config
    if (window.__OPENCODE__?.basePath) {
      return normalizeBasePath(window.__OPENCODE__.basePath)
    }

    // From <base> tag
    const baseTag = document.querySelector("base")
    if (baseTag?.href) {
      const url = new URL(baseTag.href)
      return normalizeBasePath(url.pathname)
    }
  }

  // Build-time value
  // @ts-ignore - injected at build time
  if (typeof import.meta.env?.BASE_PATH === "string") {
    // @ts-ignore
    return normalizeBasePath(import.meta.env.BASE_PATH)
  }

  return "/"
}

export function normalizeBasePath(path: string): string {
  // Ensure leading slash, trailing slash
  let normalized = path.trim()
  if (!normalized.startsWith("/")) normalized = "/" + normalized
  if (!normalized.endsWith("/")) normalized = normalized + "/"
  return normalized
}

export function prefixPath(path: string, basePath: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path // Absolute URLs unchanged
  }
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath
  const suffix = path.startsWith("/") ? path : "/" + path
  return base + suffix
}

export function getServerUrl(): string {
  if (typeof window !== "undefined" && window.__OPENCODE__?.serverUrl) {
    return window.__OPENCODE__.serverUrl
  }
  // Default to same origin + base path (so SDK requests go through our proxy)
  if (typeof window !== "undefined") {
    const basePath = getBasePath()
    // Remove trailing slash for server URL
    const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath
    return window.location.origin + base
  }
  return "http://localhost:4096"
}

// URL-safe Base64 encoding for directory paths
export function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("")
  // URL-safe: replace + with -, / with _, remove padding =
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

export function base64Decode(value: string): string {
  // Restore standard base64 chars
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/")
  // Restore padding (base64 must be multiple of 4)
  const pad = base64.length % 4
  if (pad) {
    base64 += "=".repeat(4 - pad)
  }
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
