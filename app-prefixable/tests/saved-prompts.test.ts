import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleExtendedEndpoint, parsePromptList } from "../../shared/extended-api"
import { parseSavedPromptState, readSavedPrompts } from "../src/utils/extended-api"

const originalRoot = process.env.OPENCODE_WORKSPACE_ROOT
const originalConfig = process.env.OPENCODE_CONFIG_DIR
let root = ""
let outside = ""
let project = ""

function request(path: string, method = "GET", body?: unknown, directory = project) {
  const query = directory ? `?${new URLSearchParams({ directory })}` : ""
  const url = new URL(`https://ui.example/prefix${path}${query}`)
  const req = new Request(url, {
    method,
    headers: { Origin: url.origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return handleExtendedEndpoint(path, method, url, req)
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "saved-prompts-root-"))
  outside = await mkdtemp(join(tmpdir(), "saved-prompts-outside-"))
  project = join(root, "project")
  await mkdir(project)
  process.env.OPENCODE_WORKSPACE_ROOT = root
  process.env.OPENCODE_CONFIG_DIR = join(root, "config")
})

afterAll(async () => {
  if (originalRoot === undefined) delete process.env.OPENCODE_WORKSPACE_ROOT
  if (originalRoot !== undefined) process.env.OPENCODE_WORKSPACE_ROOT = originalRoot
  if (originalConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR
  if (originalConfig !== undefined) process.env.OPENCODE_CONFIG_DIR = originalConfig
  await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })])
})

describe("saved prompt parsing", () => {
  test("reads historical arrays and wrappers while skipping malformed rows", () => {
    expect(parsePromptList(JSON.stringify([
      { id: "one", name: "Legacy", prompt: "Text", created: "1713000000000" },
      { id: "bad", title: "Missing text", createdAt: 1 },
    ]), "global")).toEqual([
      { id: "one", title: "Legacy", text: "Text", createdAt: 1713000000000, scope: "global" },
    ])
    expect(parsePromptList(JSON.stringify({ prompts: { project: [
      { id: "two", title: "Wrapped", content: "Body", timestamp: "2026-04-13T20:00:00.000Z" },
    ] } }), "project")[0]?.scope).toBe("project")
  })

  test("normalizes compatible response contracts", () => {
    expect(parseSavedPromptState({
      prompts: {
        global: [{ id: "g", title: "Global", text: "G", createdAt: 1 }],
        project: [{ id: "p", name: "Project", content: "P", created: "2" }],
      },
    })).toEqual({
      global: [{ id: "g", title: "Global", text: "G", createdAt: 1, scope: "global" }],
      project: [{ id: "p", title: "Project", text: "P", createdAt: 2, scope: "project" }],
    })
  })
})

describe("saved prompt client contract", () => {
  test("keeps the configured prefix and encodes the project directory", async () => {
    const original = globalThis.fetch
    let requested = ""
    globalThis.fetch = (async (input) => {
      requested = String(input)
      return Response.json({ global: [], project: [] })
    }) as typeof fetch
    try {
      await readSavedPrompts("https://ui.example/notebook/user/app", "/workspace/a b")
      expect(requested).toBe("https://ui.example/notebook/user/app/api/ext/saved-prompts?directory=%2Fworkspace%2Fa+b")
    } finally {
      globalThis.fetch = original
    }
  })
})

describe("saved prompt API", () => {
  test("serializes item mutations without losing concurrent creates", async () => {
    const responses = await Promise.all([
      request("/api/ext/saved-prompts", "POST", { title: "One", text: "First", scope: "global" }),
      request("/api/ext/saved-prompts", "POST", { title: "Two", text: "Second", scope: "global" }),
    ])
    expect(responses.every((response) => response?.status === 200)).toBe(true)
    const read = await request("/api/ext/saved-prompts")
    const state = await read?.json() as { global: Array<{ title: string }> }
    expect(state.global.map((prompt) => prompt.title).sort()).toEqual(["One", "Two"])
  })

  test("updates, moves, and deletes one prompt without replacing unrelated prompts", async () => {
    const created = await request("/api/ext/saved-prompts", "POST", { title: "Move", text: "Before", scope: "global" })
    const state = await created?.json() as { global: Array<{ id: string }> }
    const id = state.global.find((prompt) => prompt.id)?.id
    expect(id).toBeTruthy()

    const moved = await request(`/api/ext/saved-prompts/${encodeURIComponent(id!)}`, "PATCH", { text: "After", scope: "project" })
    const movedState = await moved?.json() as { global: Array<{ id: string }>; project: Array<{ id: string; text: string }> }
    expect(movedState.global.some((prompt) => prompt.id === id)).toBe(false)
    expect(movedState.project.find((prompt) => prompt.id === id)?.text).toBe("After")

    const removed = await request(`/api/ext/saved-prompts/${encodeURIComponent(id!)}`, "DELETE")
    const removedState = await removed?.json() as { project: Array<{ id: string }> }
    expect(removedState.project.some((prompt) => prompt.id === id)).toBe(false)
  })

  test("rejects traversal and symlink escapes for project storage", async () => {
    const traversal = await request("/api/ext/saved-prompts", "GET", undefined, join(root, "..", "escape"))
    expect(traversal?.status).toBe(403)

    const link = join(root, "linked-project")
    await symlink(outside, link)
    const escaped = await request("/api/ext/saved-prompts", "POST", { title: "No", text: "Escape", scope: "project" }, link)
    expect(escaped?.status).toBe(403)

    const linkedParent = join(root, "linked-parent-project")
    await mkdir(linkedParent)
    await symlink(outside, join(linkedParent, ".opencode"))
    const parentEscape = await request("/api/ext/saved-prompts", "POST", { title: "No", text: "Escape", scope: "project" }, linkedParent)
    expect(parentEscape?.status).toBe(403)

    const linkedFileProject = join(root, "linked-file-project")
    await mkdir(join(linkedFileProject, ".opencode"), { recursive: true })
    await symlink(join(outside, "prompts.json"), join(linkedFileProject, ".opencode", "saved-prompts.json"))
    const fileEscape = await request("/api/ext/saved-prompts", "GET", undefined, linkedFileProject)
    expect(fileEscape?.status).toBe(403)
  })

  test("preserves and canonicalizes an existing wrapped project file", async () => {
    const path = join(project, ".opencode", "saved-prompts.json")
    await mkdir(join(project, ".opencode"), { recursive: true })
    await writeFile(path, JSON.stringify({ prompts: [{ id: "legacy", name: "Old", content: "Body", created: 3 }] }))
    const response = await request("/api/ext/saved-prompts", "POST", { title: "New", text: "Body", scope: "project" })
    const state = await response?.json() as { project: Array<{ id: string }> }
    expect(state.project.map((prompt) => prompt.id)).toContain("legacy")
    expect(await Bun.file(path).json()).toEqual(state.project)
  })

  test("refuses to rewrite malformed or ambiguous existing data", async () => {
    const globalPath = join(root, "config", "saved-prompts.json")
    const malformed = JSON.stringify([{ id: "broken", title: "Missing text", createdAt: 1 }])
    await writeFile(globalPath, malformed)
    const invalid = await request("/api/ext/saved-prompts", "POST", { title: "New", text: "Body", scope: "global" })
    expect(invalid?.status).toBe(409)
    expect(await Bun.file(globalPath).text()).toBe(malformed)

    const duplicate = JSON.stringify([
      { id: "same", title: "One", text: "First", createdAt: 1, scope: "global" },
      { id: "same", title: "Two", text: "Second", createdAt: 2, scope: "global" },
    ])
    await writeFile(globalPath, duplicate)
    const ambiguous = await request("/api/ext/saved-prompts/same", "DELETE")
    expect(ambiguous?.status).toBe(409)
    expect(await Bun.file(globalPath).text()).toBe(duplicate)
  })
})
