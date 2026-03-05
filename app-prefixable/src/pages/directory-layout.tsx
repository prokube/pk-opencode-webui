import { type ParentProps, createMemo, createEffect, For } from "solid-js"
import { useParams, Navigate } from "@solidjs/router"
import { SDKProvider } from "../context/sdk"
import { EventProvider } from "../context/events"
import { SyncProvider } from "../context/sync"
import { ProviderProvider } from "../context/providers"
import { MCPProvider } from "../context/mcp"
import { TerminalProvider } from "../context/terminal"
import { PermissionProvider } from "../context/permission"
import { FileProvider } from "../context/file"
import { LayoutProvider } from "../context/layout"
import { useRecentProjects } from "../context/recent-projects"
import { base64Decode } from "../utils/path"
import { Layout } from "./layout"

/**
 * Wraps routes that need a directory context.
 * Extracts the base64-encoded directory from the URL and provides SDK context.
 * Uses a keyed For to force full remount when directory changes.
 */
export function DirectoryLayout(props: ParentProps) {
  const params = useParams<{ dir: string }>()
  const recent = useRecentProjects()

  const directory = createMemo(() => {
    try {
      const decoded = base64Decode(params.dir)
      // Validate the decoded path looks reasonable (starts with / or ~)
      if (decoded && (decoded.startsWith("/") || decoded.startsWith("~"))) {
        return decoded
      }
      console.error("[DirectoryLayout] Invalid decoded path:", decoded)
      return undefined
    } catch (e) {
      console.error("[DirectoryLayout] Failed to decode directory:", params.dir, e)
      return undefined
    }
  })

  // Add to recent projects when directory changes
  createEffect(() => {
    const dir = directory()
    if (dir) {
      recent.add(dir)
    }
  })

  // Use For with a single-element array keyed by directory to force remount
  // This ensures all providers are recreated when switching projects
  const directories = createMemo(() => {
    const dir = directory()
    return dir ? [dir] : []
  })

  return (
    <For each={directories()} fallback={<Navigate href="/" />}>
      {(dir: string) => (
        <SDKProvider directory={dir}>
          <EventProvider>
            <SyncProvider>
              <FileProvider>
                <PermissionProvider>
                  <ProviderProvider>
                    <MCPProvider>
                      <TerminalProvider>
                        <LayoutProvider>
                          <Layout>{props.children}</Layout>
                        </LayoutProvider>
                      </TerminalProvider>
                    </MCPProvider>
                  </ProviderProvider>
                </PermissionProvider>
              </FileProvider>
            </SyncProvider>
          </EventProvider>
        </SDKProvider>
      )}
    </For>
  )
}
