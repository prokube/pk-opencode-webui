import { createContext, useContext, type ParentProps } from "solid-js"

interface BrandingConfig {
  name: string
  url: string
  icon: string
}

interface BrandingContextValue {
  name: string
  url: string
  icon: string
  enabled: boolean
}

const BrandingContext = createContext<BrandingContextValue>()

/**
 * Validate that a URL is safe (http/https only, no javascript:/data: etc.)
 */
function isSafeUrl(url: string): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * Validate that an icon URL is safe (http/https or relative path)
 */
function isSafeIconUrl(url: string): boolean {
  if (!url) return false
  // Allow relative paths starting with /
  if (url.startsWith("/") && !url.startsWith("//")) return true
  // Allow data URLs for inline SVGs/images
  if (url.startsWith("data:image/")) return true
  return isSafeUrl(url)
}

function getBranding(): BrandingConfig {
  const config = (window as unknown as Record<string, unknown>).__OPENCODE__ as Record<string, unknown> | undefined
  const branding = config?.branding as Record<string, unknown> | undefined
  const rawUrl = (branding?.url as string) || ""
  const rawIcon = (branding?.icon as string) || ""
  return {
    name: (branding?.name as string) || "",
    url: isSafeUrl(rawUrl) ? rawUrl : "",
    icon: isSafeIconUrl(rawIcon) ? rawIcon : "",
  }
}

export function BrandingProvider(props: ParentProps) {
  const config = getBranding()

  const value: BrandingContextValue = {
    name: config.name,
    url: config.url,
    icon: config.icon,
    enabled: !!config.name,
  }

  return <BrandingContext.Provider value={value}>{props.children}</BrandingContext.Provider>
}

export function useBranding() {
  const ctx = useContext(BrandingContext)
  if (!ctx) throw new Error("useBranding must be used within BrandingProvider")
  return ctx
}
