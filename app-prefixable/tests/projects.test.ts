import { describe, expect, test } from "bun:test"
import { loadProjects, mergeProjects, parseProjects, projectsStorageKey, type Project } from "../src/context/projects"

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
}

describe("project persistence", () => {
  test("builds a stable server-scoped key", () => {
    expect(projectsStorageKey("server-123")).toBe("opencode.server.server-123.projects")
  })

  test("validates canonical projects and normalizes trailing slashes", () => {
    expect(parseProjects(JSON.stringify([
      { worktree: "/valid/", name: "Valid", lastOpened: 12 },
      { worktree: "/valid", lastOpened: 8 },
      { worktree: "/missing-time" },
      { worktree: 4, lastOpened: 1 },
      null,
    ]))).toEqual([{ worktree: "/valid", name: "Valid", lastOpened: 12 }])
    expect(parseProjects("invalid json")).toEqual([])
  })

  test("merges duplicate worktrees without losing order or latest timestamp", () => {
    const first: Project[] = [{ worktree: "/one", lastOpened: 1 }, { worktree: "/two", name: "Two", lastOpened: 2 }]
    const second: Project[] = [{ worktree: "/one", name: "One", lastOpened: 3 }]
    expect(mergeProjects(first, second)).toEqual([
      { worktree: "/one", name: "One", lastOpened: 3 },
      { worktree: "/two", name: "Two", lastOpened: 2 },
    ])
  })

  test("migrates both local legacy formats once", () => {
    const store = storage({
      "opencode.projects": JSON.stringify([{ worktree: "/one" }, { worktree: "/two", name: "Pinned Two" }]),
      "opencode-recent-projects": JSON.stringify([
        { path: "/two", name: "Recent Two", lastOpened: 20 },
        { path: "/three", name: "Three", lastOpened: 30 },
        { path: 10, lastOpened: 40 },
      ]),
    })

    expect(loadProjects(store, "local", 10)).toEqual([
      { worktree: "/one", lastOpened: 10 },
      { worktree: "/two", name: "Pinned Two", lastOpened: 20 },
      { worktree: "/three", name: "Three", lastOpened: 30 },
    ])
    expect(store.values.has("opencode.projects")).toBeFalse()
    expect(store.values.has("opencode-recent-projects")).toBeFalse()
    expect(parseProjects(store.values.get(projectsStorageKey("local")) ?? null)).toHaveLength(3)

    store.values.set("opencode.projects", JSON.stringify([{ worktree: "/late" }]))
    expect(loadProjects(store, "local", 50)).toHaveLength(3)
  })

  test("never imports local legacy data into remote scopes", () => {
    const store = storage({ "opencode.projects": JSON.stringify([{ worktree: "/local" }]) })
    expect(loadProjects(store, "remote", 10)).toEqual([])
    expect(store.values.has("opencode.projects")).toBeTrue()
    expect(store.values.has(projectsStorageKey("remote"))).toBeFalse()
  })
})
