import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readSavedPrompts } from "../src/utils/extended-api"

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

beforeEach(() => {
  globalThis.fetch = (async () => jsonResponse({ global: [], project: [] })) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("saved prompts response contract", () => {
  test("accepts root global/project arrays with legacy prompt values", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        global: [{ id: "g1", title: "global", prompt: "hello", createdAt: "1713000000000" }],
        project: [{ id: "p1", name: "project", content: "world", createdAt: "2026-04-13T20:00:00.000Z" }],
      })) as typeof fetch

    const data = await readSavedPrompts("http://localhost:3000")
    expect(data.global).toEqual([
      { id: "g1", title: "global", text: "hello", createdAt: 1713000000000, scope: "global" },
    ])
    expect(data.project).toEqual([
      { id: "p1", title: "project", text: "world", createdAt: 1776110400000, scope: "project" },
    ])
  })

  test("accepts nested prompts contract", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        prompts: {
          global: [{ id: "g1", title: "global", text: "hello", createdAt: 1 }],
          project: [{ id: "p1", title: "project", text: "world", createdAt: 2, scope: "project" }],
        },
      })) as typeof fetch

    const data = await readSavedPrompts("http://localhost:3000")
    expect(data.global[0]?.scope).toBe("global")
    expect(data.project[0]?.scope).toBe("project")
  })

  test("accepts scope wrappers with prompts arrays", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        global: { prompts: [{ id: "g1", title: "global", text: "hello", createdAt: 1 }] },
        project: { prompts: [{ id: "p1", title: "project", text: "world", createdAt: 2 }] },
      })) as typeof fetch

    const data = await readSavedPrompts("http://localhost:3000")
    expect(data.global).toHaveLength(1)
    expect(data.project).toHaveLength(1)
  })

  test("skips malformed prompt entries instead of failing all loads", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        global: [{ id: "bad", title: "bad", createdAt: 1 }, { id: "g1", title: "ok", text: "ok", createdAt: 2 }],
        project: [{ id: "p1", title: "ok", text: "ok", createdAt: 3 }],
      })) as typeof fetch

    const data = await readSavedPrompts("http://localhost:3000")
    expect(data.global).toHaveLength(1)
    expect(data.global[0]?.id).toBe("g1")
    expect(data.project).toHaveLength(1)
  })

  test("throws when response has no compatible contract", async () => {
    globalThis.fetch = (async () => jsonResponse({ items: [] })) as typeof fetch

    await expect(readSavedPrompts("http://localhost:3000")).rejects.toThrow("invalid saved prompts response")
  })
})
