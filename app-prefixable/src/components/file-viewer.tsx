import { createMemo, createEffect, Show, Match, Switch } from "solid-js"
import { useFile } from "../context/file"
import { ContentCode } from "./diff/content-code"
import { Spinner } from "./ui/spinner"
import { FileCode } from "lucide-solid"

interface FileViewerProps {
  path: string
}

function getLanguage(path: string) {
  // Extract basename first to handle files like "dir/Dockerfile"
  const idx = path.lastIndexOf("/")
  const filename = idx === -1 ? path : path.slice(idx + 1)
  const lower = filename.toLowerCase()

  // Handle extensionless files
  if (lower === "dockerfile") return "dockerfile"
  if (lower === "makefile") return "makefile"

  const ext = filename.split(".").pop()?.toLowerCase()
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript"
    case "js":
    case "jsx":
      return "javascript"
    case "py":
      return "python"
    case "go":
      return "go"
    case "rs":
      return "rust"
    case "md":
      return "markdown"
    case "json":
      return "json"
    case "css":
      return "css"
    case "html":
      return "html"
    case "yaml":
    case "yml":
      return "yaml"
    case "sh":
    case "bash":
      return "bash"
    case "sql":
      return "sql"
    case "toml":
      return "toml"
    case "xml":
      return "xml"
    case "java":
      return "java"
    case "c":
      return "c"
    case "cpp":
    case "cc":
    case "cxx":
      return "cpp"
    case "h":
    case "hpp":
      return "cpp"
    case "rb":
      return "ruby"
    case "php":
      return "php"
    case "swift":
      return "swift"
    case "kt":
    case "kts":
      return "kotlin"
    case "scala":
      return "scala"
    case "vue":
      return "vue"
    case "svelte":
      return "svelte"
    case "dockerfile":
      return "dockerfile"
    default:
      return undefined
  }
}

export function FileViewer(props: FileViewerProps) {
  const file = useFile()

  // Load file when path changes
  createEffect(() => {
    if (props.path) {
      void file.load(props.path)
    }
  })

  const state = createMemo(() => file.get(props.path))
  const content = createMemo(() => state()?.content?.content ?? "")
  const lang = createMemo(() => getLanguage(props.path))

  // Safe image formats - block SVG to prevent XSS
  const SAFE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

  const isImage = createMemo(() => {
    const s = state()
    const mime = s?.content?.mimeType
    return s?.content?.encoding === "base64" && mime && SAFE_IMAGE_TYPES.has(mime)
  })

  const imageUrl = createMemo(() => {
    if (!isImage()) return undefined
    const s = state()
    return `data:${s?.content?.mimeType};base64,${s?.content?.content}`
  })

  const isBinary = createMemo(() => state()?.content?.type === "binary")

  return (
    <div class="flex-1 overflow-auto min-h-0">
      <Switch>
        <Match when={state()?.loading}>
          <div class="flex items-center justify-center gap-2 p-8">
            <Spinner class="w-4 h-4" />
            <span class="text-xs" style={{ color: "var(--text-weak)" }}>
              Loading file...
            </span>
          </div>
        </Match>
        <Match when={state()?.error}>
          {(err) => (
            <div class="flex flex-col items-center justify-center h-full text-center px-4">
              <FileCode class="w-8 h-8 mb-2" style={{ color: "var(--icon-critical-base)", opacity: 0.5 }} />
              <span class="text-xs" style={{ color: "var(--text-weak)" }}>
                {err()}
              </span>
            </div>
          )}
        </Match>
        <Match when={state()?.loaded && isImage()}>
          <div class="p-4 flex justify-center">
            <img src={imageUrl()} alt={props.path} class="max-w-full max-h-[60vh]" />
          </div>
        </Match>
        <Match when={state()?.loaded && isBinary()}>
          <div class="flex flex-col items-center justify-center h-full text-center px-4">
            <FileCode class="w-8 h-8 mb-2" style={{ color: "var(--icon-weak)", opacity: 0.3 }} />
            <div class="text-xs" style={{ color: "var(--text-weak)" }}>
              Binary file cannot be displayed
            </div>
          </div>
        </Match>
        <Match when={state()?.loaded}>
          <div class="p-2">
            <div class="rounded overflow-hidden" style={{ border: "1px solid var(--border-base)" }}>
              <div
                class="px-3 py-1.5 text-xs truncate"
                style={{ background: "var(--surface-inset)", color: "var(--text-base)" }}
              >
                {props.path}
              </div>
              <div class="overflow-x-auto">
                <Show when={content()} fallback={<div class="p-4 text-xs" style={{ color: "var(--text-weak)" }}>Empty file</div>}>
                  <ContentCode code={content()} lang={lang()} />
                </Show>
              </div>
            </div>
          </div>
        </Match>
        <Match when={!state()}>
          <div class="flex flex-col items-center justify-center h-full text-center px-4">
            <FileCode class="w-8 h-8 mb-2" style={{ color: "var(--icon-weak)", opacity: 0.3 }} />
            <span class="text-xs" style={{ color: "var(--text-weak)" }}>
              Select a file to view
            </span>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
