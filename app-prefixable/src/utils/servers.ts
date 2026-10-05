import { base64Encode } from "./path"
import { normalizeRemoteUrl as normalizeServerUrl } from "../../../shared/remote-url"
export { normalizeServerUrl }

export const LOCAL_SERVER_ID = "local"
export interface ServerConnection {
  id: string
  url: string
  name: string
  auth: "none" | "basic" | "bearer" | "session"
  username?: string
}
export interface SessionTab {
  server: string
  sessionId: string
  draftID?: string
  sidebarID?: string
  directory: string
  title: string
}

export function remoteProxyUrl(local: string, url: string) {
  return `${local}/api/remote/${base64Encode(normalizeServerUrl(url))}`
}

export function needsServerCredential(connection: ServerConnection) {
  return connection.auth === "basic" || connection.auth === "bearer"
}

export function connectionUrl(local: string, connection: ServerConnection) {
  if (connection.id === LOCAL_SERVER_ID) return local
  if (connection.auth !== "session") return remoteProxyUrl(local, connection.url)
  const url = normalizeServerUrl(connection.url)
  if (new URL(url).origin !== new URL(local).origin)
    throw new Error("Browser-Session requires a server on the same origin as this WebUI")
  return url
}

export function serverAuthHeaders(connection: ServerConnection, secret = ""): Record<string, string> {
  if (connection.id === LOCAL_SERVER_ID || !needsServerCredential(connection) || !secret) return {}
  const value =
    connection.auth === "bearer"
      ? `Bearer ${secret}`
      : `Basic ${btoa(Array.from(new TextEncoder().encode(`${connection.username || "opencode"}:${secret}`), (byte) => String.fromCharCode(byte)).join(""))}`
  return { "x-opencode-server-authorization": value }
}

export function serverHref(server: string, href: string) {
  const [path, hash] = href.split("#", 2)
  const [pathname, search] = path.split("?", 2)
  const query = new URLSearchParams(search)
  if (!query.has("server") && server !== LOCAL_SERVER_ID) query.set("server", server)
  return pathname + (query.size ? `?${query}` : "") + (hash === undefined ? "" : `#${hash}`)
}

// Settings follow the target workspace, never the source server's directory.
export function serverSettingsHref(server: string, workspace: string | undefined, hash: string) {
  const target = new URL(workspace || "/", "http://workspace.invalid")
  const project = target.pathname.match(/^\/([^/]+)\/session(?:\/|$)/)
  return serverHref(server, `${project ? `/${project[1]}` : ""}/settings${hash}`)
}

export function tabHref(tab: SessionTab) {
  if (tab.draftID)
    return serverHref(tab.server, `/${base64Encode(tab.directory)}/session?new=${encodeURIComponent(tab.draftID)}`)
  return serverHref(tab.server, `/${base64Encode(tab.directory)}/session/${encodeURIComponent(tab.sessionId)}`)
}

export function tabKey(tab: Pick<SessionTab, "server" | "sessionId" | "draftID"> & Partial<Pick<SessionTab, "directory">>) {
  return JSON.stringify([tab.server, tab.draftID ? { draft: tab.draftID, directory: tab.directory } : tab.sessionId])
}

export function parseConnections(value: string | null): ServerConnection[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]")
    if (!Array.isArray(parsed)) return []
    const unique = new Map<string, ServerConnection>()
    for (const item of parsed) {
      if (!item || typeof item.url !== "string" || typeof item.name !== "string") continue
      const url = (() => {
        try {
          return normalizeServerUrl(item.url)
        } catch {
          return undefined
        }
      })()
      if (!url) continue
      const id = base64Encode(url)
      unique.set(id, {
        id,
        url,
        name: item.name || url,
        auth: ["basic", "bearer", "session"].includes(item.auth) ? item.auth : "none",
        username: typeof item.username === "string" ? item.username : undefined,
      })
    }
    return [...unique.values()].slice(0, 20)
  } catch {
    return []
  }
}

export function parseTabs(value: string | null, servers: string[]): SessionTab[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]")
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (tab): tab is SessionTab =>
          tab &&
          typeof tab.server === "string" &&
          servers.includes(tab.server) &&
          typeof tab.sessionId === "string" &&
          (tab.draftID
            ? typeof tab.draftID === "string" && /^[\w-]+$/.test(tab.draftID) && !tab.sessionId
            : /^[\w-]+$/.test(tab.sessionId)) &&
          typeof tab.directory === "string" &&
          /^[/~]/.test(tab.directory) &&
          typeof tab.title === "string",
      )
      .map((tab) => ({
        server: tab.server,
        sessionId: tab.sessionId,
        ...(tab.draftID ? { draftID: tab.draftID } : {}),
        ...(typeof tab.sidebarID === "string" ? { sidebarID: tab.sidebarID } : {}),
        directory: tab.directory,
        title: tab.title,
      }))
      .slice(-40)
  } catch {
    return []
  }
}
