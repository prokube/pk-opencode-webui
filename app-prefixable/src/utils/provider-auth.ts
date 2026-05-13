export function isLocalBrowserHost(hostname: string) {
  const host = hostname.toLowerCase()
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "[::1]"
}

function urlHasLoopbackTarget(value: string): boolean {
  try {
    const url = new URL(value)
    if (isLocalBrowserHost(url.hostname)) return true
    for (const param of url.searchParams.values()) {
      if (urlHasLoopbackTarget(param)) return true
    }
  } catch {
    return /(?:^|[^a-z0-9.-])(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(?::\d+)?(?:\/|$)/i.test(value)
  }
  return false
}

export function browserOAuthUnsupported(input: { authUrl: string; method: "auto" | "code"; browserHostname: string }) {
  if (input.method !== "auto") return false
  if (isLocalBrowserHost(input.browserHostname)) return false
  return urlHasLoopbackTarget(input.authUrl)
}

export function providerOAuthMethodUnsupported(input: { providerID: string; label: string; browserHostname: string }) {
  if (isLocalBrowserHost(input.browserHostname)) return false
  if (input.providerID !== "openai") return false
  return /\b(browser|local)\b/i.test(input.label)
}

export function extractProviderAuthCode(instructions: string) {
  const text = instructions.replace(/https?:\/\/\S+/gi, " ")
  const labeled = text.match(/:\s*([A-Z0-9][A-Z0-9-]{5,20}[A-Z0-9])/i)
  if (labeled) return labeled[1].toUpperCase()

  const fallback = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b|\b[A-Z0-9]{9}\b/i)
  return fallback?.[0].toUpperCase() ?? ""
}
