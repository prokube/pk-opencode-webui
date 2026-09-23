import { afterEach, describe, expect, test } from "bun:test"

import { implementationPrompt, OpenCodeClient, sessionPermissions } from "../src/opencode"

const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

const input = {
  repository: "prokube/example",
  worktree: "/tmp/worktree",
  validationCommands: ["bun test"],
  issue: {
    number: 42,
    title: "Implement prototype",
    body: "Acceptance criteria",
    state: "open",
    labels: ["ready"],
    assignees: [],
    comments: [],
    openBlockers: [],
    url: "https://github.com/prokube/example/issues/42",
  },
}

describe("OpenCodeClient", () => {
  test("requires unambiguous semantic selectors in generated tests", () => {
    const prompt = implementationPrompt(input)
    expect(prompt).toContain("unique semantic selectors")
    expect(prompt).toContain("Do not use unscoped getByRole or getByText")
  })

  test("uses the OpenCode permission ruleset and recognizes absent idle status", async () => {
    let createBody: Record<string, unknown> | undefined
    let promptBody: Record<string, unknown> | undefined
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/global/health") return Response.json({ healthy: true })
        if (url.pathname === "/session" && request.method === "POST") {
          createBody = await request.json() as Record<string, unknown>
          return Response.json({ id: "session-1" })
        }
        if (url.pathname === "/session/session-1/prompt_async") {
          promptBody = await request.json() as Record<string, unknown>
          return new Response(null, { status: 204 })
        }
        if (url.pathname === "/question" || url.pathname === "/permission") return Response.json([])
        if (url.pathname === "/session/status") return Response.json({})
        if (url.pathname === "/session/session-1/message") {
          return Response.json([{
            info: { role: "assistant", time: { created: 1, completed: 2 } },
            parts: [{ type: "text", text: "Complete" }],
          }])
        }
        return new Response("Not found", { status: 404 })
      },
    })
    servers.push(server)

    const result = await new OpenCodeClient(
      `http://127.0.0.1:${server.port}`,
      1_000,
      1,
      { providerID: "prokube", modelID: "qwen/qwen3.6-flash" },
    ).implement(input)
    expect(result).toEqual({ status: "completed", sessionId: "session-1" })
    expect(createBody?.permission).toEqual(sessionPermissions())
    expect(sessionPermissions()).toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
    expect(promptBody?.model).toEqual({ providerID: "prokube", modelID: "qwen/qwen3.6-flash" })
  })

  test("aborts and returns blocked when OpenCode asks a question", async () => {
    let aborted = false
    let questionDirectory: string | null = null
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/global/health") return Response.json({ healthy: true })
        if (url.pathname === "/session" && request.method === "POST") return Response.json({ id: "session-2" })
        if (url.pathname === "/session/session-2/prompt_async") return new Response(null, { status: 204 })
        if (url.pathname === "/question") {
          questionDirectory = url.searchParams.get("directory")
          return Response.json([{ sessionID: "session-2", questions: [{ question: "Which design?" }] }])
        }
        if (url.pathname === "/permission") return Response.json([])
        if (url.pathname === "/session/session-2/abort") {
          aborted = true
          return Response.json(true)
        }
        return Response.json({ "session-2": { type: "busy" } })
      },
    })
    servers.push(server)

    const result = await new OpenCodeClient(`http://127.0.0.1:${server.port}`, 1_000, 1).implement(input)
    expect(result).toEqual({
      status: "blocked",
      sessionId: "session-2",
      question: "Which design?",
    })
    expect(aborted).toBe(true)
    expect(String(questionDirectory)).toBe("/tmp/worktree")
  })

  test("continues remediation in an existing session and waits for a new response", async () => {
    let createdSessions = 0
    let prompts = 0
    let messageReads = 0
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/global/health") return Response.json({ healthy: true })
        if (url.pathname === "/session" && request.method === "POST") {
          createdSessions += 1
          return Response.json({ id: "unexpected" })
        }
        if (url.pathname === "/session/session-existing/prompt_async") {
          prompts += 1
          return new Response(null, { status: 204 })
        }
        if (url.pathname === "/question" || url.pathname === "/permission") return Response.json([])
        if (url.pathname === "/session/status") return Response.json({ "session-existing": { type: "idle" } })
        if (url.pathname === "/session/session-existing/message") {
          messageReads += 1
          return Response.json([{
            info: { role: "assistant", time: { created: 1, completed: messageReads === 1 ? 2 : 3 } },
            parts: [{ type: "text", text: messageReads === 1 ? "Initial change" : "Repair complete" }],
          }])
        }
        return new Response("Not found", { status: 404 })
      },
    })
    servers.push(server)

    const result = await new OpenCodeClient(`http://127.0.0.1:${server.port}`, 1_000, 1).implement({
      ...input,
      validationFeedback: "TypeScript failed",
      sessionId: "session-existing",
    })

    expect(result).toEqual({ status: "completed", sessionId: "session-existing" })
    expect(createdSessions).toBe(0)
    expect(prompts).toBe(1)
    expect(messageReads).toBe(2)
  })

  test("does not treat a failed assistant message as success", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/global/health") return Response.json({ healthy: true })
        if (url.pathname === "/session" && request.method === "POST") return Response.json({ id: "session-3" })
        if (url.pathname === "/session/session-3/prompt_async") return new Response(null, { status: 204 })
        if (url.pathname === "/question" || url.pathname === "/permission") return Response.json([])
        if (url.pathname === "/session/status") return Response.json({ "session-3": { type: "idle" } })
        if (url.pathname === "/session/session-3/message") {
          return Response.json([{
            info: {
              role: "assistant",
              time: { created: 1, completed: 2 },
              error: { name: "ApiError", data: { message: "provider unavailable" } },
            },
            parts: [{ type: "text", text: "Partial output" }],
          }])
        }
        return new Response("Not found", { status: 404 })
      },
    })
    servers.push(server)

    await expect(new OpenCodeClient(`http://127.0.0.1:${server.port}`, 1_000, 1).implement(input))
      .rejects.toThrow("provider unavailable")
  })
})
