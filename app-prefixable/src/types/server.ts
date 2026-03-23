export interface ServerConfig {
  id: string
  name: string
  url: string
  auth: ServerAuth
  isDefault?: boolean
}

export type ServerAuth =
  | { type: "none" }
  | { type: "api-key"; key: string }
  | { type: "basic"; username: string; password: string }

export function getAuthHeaders(auth: ServerAuth): Record<string, string> {
  switch (auth.type) {
    case "none":
      return {}
    case "api-key":
      return { "x-api-key": auth.key }
    case "basic":
      return { Authorization: `Basic ${btoa(`${auth.username}:${auth.password}`)}` }
  }
}
