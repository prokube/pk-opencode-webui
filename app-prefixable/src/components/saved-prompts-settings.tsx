import { createSignal, For, Show } from "solid-js"
import { Pencil, Plus, Trash2, X } from "lucide-solid"
import { useSavedPrompts } from "../context/saved-prompts"
import type { PromptScope, SavedPrompt } from "../utils/extended-api"
import { Button } from "./ui/button"

export function SavedPromptsSettings(props: { directory?: string }) {
  const prompts = useSavedPrompts()
  const [editing, setEditing] = createSignal<SavedPrompt | null>(null)
  const [adding, setAdding] = createSignal(false)
  const [title, setTitle] = createSignal("")
  const [text, setText] = createSignal("")
  const [scope, setScope] = createSignal<PromptScope>(props.directory ? "project" : "global")

  function reset() {
    setAdding(false)
    setEditing(null)
    setTitle("")
    setText("")
    setScope(props.directory ? "project" : "global")
  }

  function edit(prompt: SavedPrompt) {
    setAdding(false)
    setEditing(prompt)
    setTitle(prompt.title)
    setText(prompt.text)
    setScope(prompt.scope)
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    const nextTitle = title().trim()
    const nextText = text()
    if (!nextTitle || !nextText.trim() || prompts.saving()) return
    const current = editing()
    const ok = current
      ? await prompts.update(current.id, { title: nextTitle, text: nextText, scope: scope() })
      : await prompts.create(nextTitle, nextText, scope())
    if (ok) reset()
  }

  function remove(prompt: SavedPrompt) {
    if (!window.confirm(`Delete saved prompt "${prompt.title}"?`)) return
    void prompts.remove(prompt.id)
  }

  return (
    <div class="space-y-6">
      <header class="flex items-start justify-between gap-4">
        <div>
          <h1 class="text-lg font-medium" style={{ color: "var(--text-strong)" }}>Saved Prompts</h1>
          <p class="text-sm mt-1" style={{ color: "var(--text-weak)" }}>
            Reuse prompts from the composer with <code>/prompt</code>. Global prompts work everywhere; project prompts stay in this project.
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          disabled={prompts.loading() || prompts.saving() || adding()}
          onClick={() => {
            setEditing(null)
            setAdding(true)
          }}
        >
          <Plus class="w-4 h-4" /> Add
        </Button>
      </header>

      <Show when={prompts.error()}>
        <div class="px-3 py-2 rounded-md text-sm" style={{ color: "var(--interactive-critical)", background: "var(--surface-inset)" }}>
          {prompts.error()}
        </div>
      </Show>

      <Show when={adding() || editing()}>
        <form onSubmit={save} class="rounded-lg p-4 space-y-3" style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}>
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-medium" style={{ color: "var(--text-strong)" }}>{editing() ? "Edit prompt" : "New prompt"}</h2>
            <button type="button" onClick={reset} aria-label="Close prompt editor" style={{ color: "var(--icon-weak)" }}><X class="w-4 h-4" /></button>
          </div>
           <label for="saved-prompt-title" class="text-xs font-medium" style={{ color: "var(--text-weak)" }}>Title</label>
           <input
             id="saved-prompt-title"
            value={title()}
            onInput={(event) => setTitle(event.currentTarget.value)}
            placeholder="Title"
            maxlength={200}
            class="w-full px-3 py-2 rounded-md text-sm outline-none"
            style={{ background: "var(--surface-inset)", border: "1px solid var(--border-base)", color: "var(--text-base)" }}
          />
           <label for="saved-prompt-text" class="text-xs font-medium" style={{ color: "var(--text-weak)" }}>Prompt text</label>
           <textarea
             id="saved-prompt-text"
            value={text()}
            onInput={(event) => setText(event.currentTarget.value)}
            placeholder="Prompt text"
            rows={6}
            class="w-full px-3 py-2 rounded-md text-sm resize-y outline-none"
            style={{ background: "var(--surface-inset)", border: "1px solid var(--border-base)", color: "var(--text-base)" }}
          />
          <div class="flex items-center justify-between gap-3">
             <label for="saved-prompt-scope" class="sr-only">Scope</label>
             <select
               id="saved-prompt-scope"
              value={scope()}
              onChange={(event) => setScope(event.currentTarget.value as PromptScope)}
              class="px-3 py-2 rounded-md text-sm"
              style={{ background: "var(--surface-inset)", border: "1px solid var(--border-base)", color: "var(--text-base)" }}
            >
              <option value="global">Global</option>
              <option value="project" disabled={!props.directory}>Project</option>
            </select>
            <div class="flex gap-2">
              <Button type="button" size="sm" onClick={reset}>Cancel</Button>
              <Button type="submit" variant="primary" size="sm" disabled={!title().trim() || !text().trim() || prompts.saving()}>
                {prompts.saving() ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </form>
      </Show>

      <section class="rounded-lg overflow-hidden" style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}>
        <Show when={prompts.loading()}>
          <p class="p-4 text-sm" style={{ color: "var(--text-weak)" }}>Loading saved prompts...</p>
        </Show>
        <Show when={!prompts.loading() && prompts.prompts().length === 0}>
          <p class="p-6 text-center text-sm" style={{ color: "var(--text-weak)" }}>No saved prompts yet.</p>
        </Show>
        <For each={prompts.prompts()}>
          {(prompt) => (
            <div class="px-4 py-3 flex items-start gap-3 border-b last:border-b-0" style={{ "border-color": "var(--border-base)" }}>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium truncate" style={{ color: "var(--text-strong)" }}>{prompt.title}</span>
                  <span class="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text-weak)", background: "var(--surface-inset)" }}>
                    {prompt.scope === "project" ? "Project" : "Global"}
                  </span>
                </div>
                <p class="text-xs mt-1 whitespace-pre-wrap line-clamp-3" style={{ color: "var(--text-weak)" }}>{prompt.text}</p>
              </div>
              <button type="button" onClick={() => edit(prompt)} disabled={prompts.saving()} aria-label={`Edit ${prompt.title}`} class="p-1.5 rounded" style={{ color: "var(--icon-weak)" }}>
                <Pencil class="w-4 h-4" />
              </button>
               <button type="button" onClick={() => remove(prompt)} disabled={prompts.saving()} aria-label={`Delete ${prompt.title}`} class="p-1.5 rounded" style={{ color: "var(--interactive-critical)" }}>
                <Trash2 class="w-4 h-4" />
              </button>
            </div>
          )}
        </For>
      </section>
    </div>
  )
}
