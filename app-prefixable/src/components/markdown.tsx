import { createMemo } from "solid-js"
import type { JSX } from "solid-js"
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

const resetDelay = 2000

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

const renderer = new marked.Renderer()
renderer.code = ({ text, lang }) => {
  const code = escapeHtml(text)
  const className = lang ? ` class="language-${escapeHtml(lang)}"` : ""

  return `<div class="markdown-code-block"><button class="markdown-copy-button" type="button" data-state="idle" aria-label="Copy" aria-live="polite" aria-atomic="true">Copy</button><pre><code${className}>${code}</code></pre></div>`
}

function copyLabel(state: "idle" | "copied" | "failed") {
  if (state === "copied") return "Copied"
  if (state === "failed") return "Copy failed"
  return "Copy"
}

function setCopyState(button: HTMLButtonElement, state: "idle" | "copied" | "failed") {
  const timer = Number(button.dataset.copyReset || "0")
  if (timer) window.clearTimeout(timer)

  button.dataset.state = state
  const label = copyLabel(state)
  button.textContent = label
  button.setAttribute("aria-label", label)
  if (state === "idle") {
    delete button.dataset.copyReset
    return
  }

  const next = window.setTimeout(() => setCopyState(button, "idle"), resetDelay)
  button.dataset.copyReset = String(next)
}

function copyCode(button: HTMLButtonElement) {
  const block = button.closest(".markdown-code-block")
  const code = block?.querySelector("code")?.textContent

  if (code == null) {
    setCopyState(button, "failed")
    return
  }

  if (!navigator.clipboard?.writeText) {
    setCopyState(button, "failed")
    return
  }

  try {
    navigator.clipboard.writeText(code).then(
      () => setCopyState(button, "copied"),
      () => setCopyState(button, "failed"),
    )
  } catch {
    setCopyState(button, "failed")
  }
}

interface MarkdownProps {
  content: string
  class?: string
  style?: JSX.CSSProperties
}

export function Markdown(props: MarkdownProps) {
  const html = createMemo(() => {
    if (!props.content) return ""
    const raw = marked.parse(props.content, { async: false, renderer }) as string
    return sanitize(raw)
  })

  const onClick: JSX.EventHandler<HTMLDivElement, MouseEvent> = (event) => {
    const target = event.target
    if (!(target instanceof Element)) return

    const button = target.closest(".markdown-copy-button")
    if (!(button instanceof HTMLButtonElement)) return
    copyCode(button)
  }

  return <div class={`markdown-content ${props.class || ""}`} style={props.style} onClick={onClick} innerHTML={html()} />
}
