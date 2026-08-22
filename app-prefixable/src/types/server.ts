export interface ServerConfig {
  id: string
  name: string
  url: string
  auth: ServerAuth
}

export type ServerAuth =
  | { type: "none" }
  | { type: "api-key"; key: string }
  | { type: "basic"; username: string; password: string }

export function isLocalServer(server: Pick<ServerConfig, "id">) {
  return server.id === "local"
}

export function getAuthHeaders(auth: ServerAuth): Record<string, string> {
  switch (auth.type) {
    case "none":
      return {}
    case "api-key":
      return { "x-api-key": auth.key }
    case "basic": {
      const encoded = new TextEncoder().encode(`${auth.username}:${auth.password}`)
      const binary = Array.from(encoded, (b) => String.fromCharCode(b)).join("")
      return { Authorization: `Basic ${btoa(binary)}` }
    }
  }
}
