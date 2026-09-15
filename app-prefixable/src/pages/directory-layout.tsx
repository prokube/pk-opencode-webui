import { type ParentProps, createMemo, createEffect, For, on } from "solid-js"
import { useParams, Navigate } from "@solidjs/router"
import { TerminalProvider } from "../context/terminal"
import { PermissionProvider } from "../context/permission"
import { FileProvider } from "../context/file"
import { LayoutProvider } from "../context/layout"
import { CoreProviders } from "../context/core-providers"
import { useProjects } from "../context/projects"
import { base64Decode } from "../utils/path"
import { Layout } from "./layout"

/**
 * Wraps routes that need a directory context.
 * Extracts the base64-encoded directory from the URL and provides SDK context.
 * Uses a keyed For to force full remount when directory changes.
 */
export function DirectoryLayout(props: ParentProps) {
  const params = useParams<{ dir: string }>()
  const projects = useProjects()

  const decoded = createMemo(() => {
    if (!params.dir) return undefined

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

  // Keep the previous directory while params are in a transient empty state
  // during route updates so providers don't remount between session switches.
  // If the route contains an explicit invalid directory, return undefined so
  // the fallback Navigate still takes the user back to home.
  const directory = createMemo<string | undefined>((prev) => {
    if (!params.dir) return prev
    return decoded()
  })

  // Add to recent projects when directory changes
  createEffect(on(directory, (dir) => {
    if (dir) {
      projects.touch(dir)
    }
  }))

  // Use For with a single-element array keyed by directory to force remount
  // This ensures all providers are recreated when switching projects
  const directories = createMemo(() => {
    const dir = directory()
    return dir ? [dir] : []
  })

  return (
    <For each={directories()} fallback={<Navigate href="/" />}>
      {(dir: string) => (
        <CoreProviders directory={dir}>
          <FileProvider>
            <PermissionProvider>
              <TerminalProvider>
                <LayoutProvider>
                  <Layout>{props.children}</Layout>
                </LayoutProvider>
              </TerminalProvider>
            </PermissionProvider>
          </FileProvider>
        </CoreProviders>
      )}
    </For>
  )
}
