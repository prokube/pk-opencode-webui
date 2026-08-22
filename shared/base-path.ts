export function matchesBasePath(path: string, base: string) {
  const normalized = base.length > 1 && base.endsWith("/") ? base.slice(0, -1) : base
  if (!normalized || normalized === "/") return true
  return path === normalized || path.startsWith(normalized + "/")
}

export function stripBasePath(path: string, base: string) {
  const normalized = base.length > 1 && base.endsWith("/") ? base.slice(0, -1) : base
  if (!matchesBasePath(path, normalized) || !normalized || normalized === "/") return path
  return path.slice(normalized.length) || "/"
}
