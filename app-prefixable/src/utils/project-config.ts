import type { Config } from "../sdk/client"

export type ProjectConfigRewrite = {
  config: Config
  changed: boolean
}

export function parseProjectConfig(content: string): Config | null {
  try {
    const value: unknown = JSON.parse(content)
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    return value as Config
  } catch {
    return null
  }
}

export function removeProjectDefault(config: Config, key: "model" | "default_agent"): ProjectConfigRewrite {
  if (!(key in config)) return { config, changed: false }
  const next = { ...config }
  delete next[key]
  return { config: next, changed: true }
}

export function removeProjectPermissionPattern(
  config: Config,
  tool: string,
  pattern: string,
): ProjectConfigRewrite {
  if (!config.permission || typeof config.permission === "string") return { config, changed: false }
  const permission = config.permission as Record<string, unknown>
  const rule = permission[tool]
  if (!rule || typeof rule !== "object" || Array.isArray(rule) || !(pattern in rule)) {
    return { config, changed: false }
  }

  const nextRule = { ...rule } as Record<string, unknown>
  delete nextRule[pattern]
  return {
    config: {
      ...config,
      permission: {
        ...permission,
        [tool]: nextRule,
      } as Config["permission"],
    },
    changed: true,
  }
}
