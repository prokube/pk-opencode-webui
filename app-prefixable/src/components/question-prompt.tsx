import { createSignal, createMemo, For, Show, onMount, onCleanup } from "solid-js"
import { Button } from "./ui/button"
import { Markdown } from "./markdown"
import type { QuestionRequest } from "../sdk/client"
import { Users } from "lucide-solid"

interface Props {
  request: QuestionRequest
  onReply: (answers: string[][]) => void
  onReject: () => void
  /** When true, shows a sub-agent indicator in the header */
  fromSubAgent?: boolean
}

export function QuestionPrompt(props: Props) {
  const questions = createMemo(() => props.request.questions)
  const single = createMemo(() => questions().length === 1 && questions()[0]?.multiple !== true)
  const tabs = createMemo(() => (single() ? 1 : questions().length + 1))

  const [tab, setTab] = createSignal(0)
  const [answers, setAnswers] = createSignal<string[][]>([])
  const [custom, setCustom] = createSignal<string[]>([])
  const [selected, setSelected] = createSignal(0)
  const [editing, setEditing] = createSignal(false)

  let inputRef: HTMLInputElement | undefined

  const question = createMemo(() => questions()[tab()])
  const confirm = createMemo(() => !single() && tab() === questions().length)
  const options = createMemo(() => question()?.options ?? [])
  const allowCustom = createMemo(() => question()?.custom !== false)
  const other = createMemo(() => allowCustom() && selected() === options().length)
  const input = createMemo(() => custom()[tab()] ?? "")
  const multi = createMemo(() => question()?.multiple === true)
  const customPicked = createMemo(() => {
    const value = input()
    if (!value) return false
    return answers()[tab()]?.includes(value) ?? false
  })

  function submit() {
    const result = questions().map((_, i) => answers()[i] ?? [])
    props.onReply(result)
  }

  function pick(answer: string, isCustom = false) {
    const newAnswers = [...answers()]
    newAnswers[tab()] = [answer]
    setAnswers(newAnswers)

    if (isCustom) {
      const inputs = [...custom()]
      inputs[tab()] = answer
      setCustom(inputs)
    }

    if (single()) {
      props.onReply([[answer]])
      return
    }

    setTab(tab() + 1)
    setSelected(0)
  }

  function toggle(answer: string) {
    const existing = answers()[tab()] ?? []
    const next = [...existing]
    const index = next.indexOf(answer)
    if (index === -1) next.push(answer)
    else next.splice(index, 1)

    const newAnswers = [...answers()]
    newAnswers[tab()] = next
    setAnswers(newAnswers)
  }

  function selectOption() {
    if (other()) {
      if (!multi()) {
        setEditing(true)
        setTimeout(() => inputRef?.focus(), 50)
        return
      }
      const value = input()
      if (value && customPicked()) {
        toggle(value)
        return
      }
      setEditing(true)
      setTimeout(() => inputRef?.focus(), 50)
      return
    }

    const opt = options()[selected()]
    if (!opt) return

    if (multi()) {
      toggle(opt.label)
      return
    }

    pick(opt.label)
  }

  function handleCustomSubmit() {
    const text = input().trim()
    if (!text) {
      setEditing(false)
      return
    }

    if (multi()) {
      const inputs = [...custom()]
      inputs[tab()] = text
      setCustom(inputs)

      const existing = answers()[tab()] ?? []
      if (!existing.includes(text)) {
        const newAnswers = [...answers()]
        newAnswers[tab()] = [...existing, text]
        setAnswers(newAnswers)
      }
      setEditing(false)
      return
    }

    pick(text, true)
    setEditing(false)
  }

  function handleKeyDown(e: KeyboardEvent) {
    // Ignore when focus is on input elements
    const target = e.target as HTMLElement
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
      return
    }

    if (editing()) {
      if (e.key === "Escape") {
        e.preventDefault()
        setEditing(false)
      } else if (e.key === "Enter") {
        e.preventDefault()
        handleCustomSubmit()
      }
      return
    }

    const opts = options()
    const total = opts.length + (allowCustom() ? 1 : 0)

    if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault()
      setSelected((s) => (s - 1 + total) % total)
    } else if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault()
      setSelected((s) => (s + 1) % total)
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (confirm()) submit()
      else selectOption()
    } else if (e.key === "Escape") {
      e.preventDefault()
      props.onReject()
    } else if (e.key === "Tab") {
      e.preventDefault()
      const direction = e.shiftKey ? -1 : 1
      setTab((t) => (t + direction + tabs()) % tabs())
      setSelected(0)
    } else if (e.key >= "1" && e.key <= "9") {
      const digit = parseInt(e.key)
      if (digit <= total) {
        e.preventDefault()
        setSelected(digit - 1)
        selectOption()
      }
    }
  }

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown)
  })

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown)
  })

  return (
    <div
      class="rounded-lg overflow-hidden"
      style={{
        background: "var(--background-base)",
        border: "2px solid var(--interactive-base)",
        "box-shadow": "0 4px 20px rgba(0, 0, 0, 0.15)",
      }}
    >
      {/* Header */}
      <div
        class="px-4 py-2 flex items-center justify-between"
        style={{
          background: "var(--surface-inset)",
          "border-bottom": "1px solid var(--border-base)",
        }}
      >
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium" style={{ color: "var(--text-interactive-base)" }}>
            Question from AI
          </span>
          <Show when={props.fromSubAgent}>
            <span
              class="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded"
              style={{ background: "var(--background-base)", color: "var(--text-interactive-base)" }}
            >
              <Users class="w-3 h-3" />
              sub-agent
            </span>
          </Show>
        </div>
        <button
          onClick={props.onReject}
          class="text-xs px-2 py-1 rounded transition-colors"
          style={{ color: "var(--text-weak)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-inset)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          Dismiss (Esc)
        </button>
      </div>

      {/* Tabs for multi-question */}
      <Show when={!single()}>
        <div class="flex gap-1 px-4 py-2 overflow-x-auto" style={{ "border-bottom": "1px solid var(--border-base)" }}>
          <For each={questions()}>
            {(q, index) => {
              const isActive = () => index() === tab()
              const isAnswered = () => (answers()[index()]?.length ?? 0) > 0
              return (
                <button
                  onClick={() => {
                    setTab(index())
                    setSelected(0)
                  }}
                  class="px-3 py-1.5 text-sm rounded-md transition-colors shrink-0"
                  style={{
                    background: isActive() ? "var(--interactive-base)" : "var(--surface-inset)",
                    color: isActive() ? "white" : isAnswered() ? "var(--text-strong)" : "var(--text-weak)",
                  }}
                >
                  {q.header}
                </button>
              )
            }}
          </For>
          <button
            onClick={() => {
              setTab(questions().length)
              setSelected(0)
            }}
            class="px-3 py-1.5 text-sm rounded-md transition-colors shrink-0"
            style={{
              background: confirm() ? "var(--interactive-base)" : "var(--surface-inset)",
              color: confirm() ? "white" : "var(--text-weak)",
            }}
          >
            Confirm
          </button>
        </div>
      </Show>

      {/* Question content */}
      <div class="p-4">
        <Show when={!confirm()}>
          {/* Question text */}
          <div class="mb-4">
            <Markdown
              content={`${question()?.question ?? ""}${multi() ? " *(select all that apply)*" : ""}`}
              class="text-sm font-medium"
              style={{ color: "var(--text-strong)" }}
            />
          </div>

          {/* Options */}
          <div class="space-y-2">
            <For each={options()}>
              {(opt, i) => {
                const active = () => i() === selected()
                const picked = () => answers()[tab()]?.includes(opt.label) ?? false
                return (
                  <button
                    onClick={() => {
                      setSelected(i())
                      selectOption()
                    }}
                    onMouseEnter={() => setSelected(i())}
                    class="w-full text-left px-3 py-2 rounded-md transition-colors"
                    style={{
                      background: active() ? "var(--surface-inset)" : "transparent",
                      border: `1px solid ${active() ? "var(--interactive-base)" : "var(--border-base)"}`,
                    }}
                  >
                    <div class="flex items-center gap-2">
                      <span
                        class="text-xs font-mono w-5 h-5 flex items-center justify-center rounded"
                        style={{
                          background: active() ? "var(--interactive-base)" : "var(--surface-inset)",
                          color: active() ? "white" : "var(--text-weak)",
                        }}
                      >
                        {i() + 1}
                      </span>
                      <span class="flex-1" style={{ color: "var(--text-strong)" }}>
                        {multi() && (
                          <span style={{ color: picked() ? "var(--icon-success-base)" : "var(--text-weak)" }}>
                            [{picked() ? "\u2713" : " "}]{" "}
                          </span>
                        )}
                        {opt.label}
                      </span>
                      <Show when={!multi() && picked()}>
                        <span style={{ color: "var(--icon-success-base)" }}>{"\u2713"}</span>
                      </Show>
                    </div>
                    <Show when={opt.description}>
                      <p class="text-xs mt-1 ml-7" style={{ color: "var(--text-weak)" }}>
                        {opt.description}
                      </p>
                    </Show>
                  </button>
                )
              }}
            </For>

            {/* Custom answer option */}
            <Show when={allowCustom()}>
              <div
                class="px-3 py-2 rounded-md transition-colors"
                style={{
                  background: other() ? "var(--surface-inset)" : "transparent",
                  border: `1px solid ${other() ? "var(--interactive-base)" : "var(--border-base)"}`,
                }}
              >
                <button
                  onClick={() => {
                    setSelected(options().length)
                    selectOption()
                  }}
                  onMouseEnter={() => setSelected(options().length)}
                  class="w-full text-left"
                >
                  <div class="flex items-center gap-2">
                    <span
                      class="text-xs font-mono w-5 h-5 flex items-center justify-center rounded"
                      style={{
                        background: other() ? "var(--interactive-base)" : "var(--surface-inset)",
                        color: other() ? "white" : "var(--text-weak)",
                      }}
                    >
                      {options().length + 1}
                    </span>
                    <span style={{ color: "var(--text-strong)" }}>
                      {multi() && (
                        <span style={{ color: customPicked() ? "var(--icon-success-base)" : "var(--text-weak)" }}>
                          [{customPicked() ? "\u2713" : " "}]{" "}
                        </span>
                      )}
                      Type your own answer
                    </span>
                    <Show when={!multi() && customPicked()}>
                      <span style={{ color: "var(--icon-success-base)" }}>{"\u2713"}</span>
                    </Show>
                  </div>
                </button>

                <Show when={editing()}>
                  <div class="mt-2 ml-7 flex gap-2">
                    <input
                      ref={inputRef}
                      type="text"
                      value={input()}
                      onInput={(e) => {
                        const inputs = [...custom()]
                        inputs[tab()] = e.currentTarget.value
                        setCustom(inputs)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault()
                          e.stopImmediatePropagation()
                          handleCustomSubmit()
                        } else if (e.key === "Escape") {
                          e.preventDefault()
                          e.stopImmediatePropagation()
                          setEditing(false)
                        }
                      }}
                      placeholder="Type your answer..."
                      class="flex-1 px-3 py-1.5 text-sm rounded-md"
                      style={{
                        background: "var(--background-base)",
                        border: "1px solid var(--border-base)",
                        color: "var(--text-base)",
                      }}
                    />
                    <Button onClick={handleCustomSubmit} size="small">
                      OK
                    </Button>
                  </div>
                </Show>

                <Show when={!editing() && input()}>
                  <p class="text-xs mt-1 ml-7" style={{ color: "var(--text-weak)" }}>
                    {input()}
                  </p>
                </Show>
              </div>
            </Show>
          </div>
        </Show>

        {/* Confirm view for multi-question */}
        <Show when={confirm()}>
          <div class="mb-4">
            <p class="text-sm font-medium mb-3" style={{ color: "var(--text-strong)" }}>
              Review your answers
            </p>
            <div class="space-y-2">
              <For each={questions()}>
                {(q, index) => {
                  const value = () => answers()[index()]?.join(", ") ?? ""
                  const answered = () => Boolean(value())
                  return (
                    <div class="px-3 py-2 rounded-md" style={{ background: "var(--surface-inset)" }}>
                      <span class="text-xs" style={{ color: "var(--text-weak)" }}>
                        {q.header}:
                      </span>{" "}
                      <span
                        style={{
                          color: answered() ? "var(--text-strong)" : "var(--icon-critical-base)",
                        }}
                      >
                        {answered() ? value() : "(not answered)"}
                      </span>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>

          <Button onClick={submit} variant="primary" class="w-full">
            Submit Answers
          </Button>
        </Show>
      </div>

      {/* Footer with keyboard hints */}
      <div
        class="px-4 py-2 flex gap-4 text-xs"
        style={{
          background: "var(--surface-inset)",
          "border-top": "1px solid var(--border-base)",
          color: "var(--text-weak)",
        }}
      >
        <Show when={!single()}>
          <span>
            <kbd class="px-1 rounded" style={{ background: "var(--background-base)" }}>
              Tab
            </kbd>{" "}
            switch
          </span>
        </Show>
        <Show when={!confirm()}>
          <span>
            <kbd class="px-1 rounded" style={{ background: "var(--background-base)" }}>
              {"\u2191\u2193"}
            </kbd>{" "}
            select
          </span>
        </Show>
        <span>
          <kbd class="px-1 rounded" style={{ background: "var(--background-base)" }}>
            Enter
          </kbd>{" "}
          {confirm() ? "submit" : multi() ? "toggle" : single() ? "submit" : "confirm"}
        </span>
        <span>
          <kbd class="px-1 rounded" style={{ background: "var(--background-base)" }}>
            Esc
          </kbd>{" "}
          dismiss
        </span>
      </div>
    </div>
  )
}
