import { createMemo } from "solid-js"
import { marked } from "marked"
import DOMPurify from "dompurify"

marked.setOptions({
  gfm: true,
  breaks: true,
})

const config = {
  USE_PROFILES: { html: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style", "script"],
  FORBID_CONTENTS: ["style"],
}

function sanitize(html: string) {
  if (!DOMPurify.isSupported) {
    console.error("DOMPurify is not supported in this environment")
    return ""
  }
  return DOMPurify.sanitize(html, config)
}

interface MarkdownProps {
  content: string
  class?: string
}

export function Markdown(props: MarkdownProps) {
  const html = createMemo(() => {
    if (!props.content) return ""
    const raw = marked.parse(props.content, { async: false }) as string
    return sanitize(raw)
  })

  return <div class={`markdown-content ${props.class || ""}`} innerHTML={html()} />
}
