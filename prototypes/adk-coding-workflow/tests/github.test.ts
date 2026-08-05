import { afterEach, describe, expect, test } from "bun:test"

import { GitHubClient } from "../src/github"

const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

describe("GitHubClient", () => {
  test("fails closed when native dependency state cannot be read", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/repos/prokube/example/issues/42") {
          return Response.json({
            number: 42,
            title: "Issue",
            body: "Body",
            state: "open",
            html_url: "https://example.test/issues/42",
            labels: [{ name: "ready" }],
            assignees: [],
          })
        }
        if (path === "/repos/prokube/example/issues/42/comments") return Response.json([])
        if (path === "/repos/prokube/example/issues/42/dependencies/blocked_by") {
          return new Response("Not available", { status: 404 })
        }
        return new Response("Not found", { status: 404 })
      },
    })
    servers.push(server)
    const client = new GitHubClient("token", `http://127.0.0.1:${server.port}`)
    await expect(client.getIssue("prokube/example", 42)).rejects.toThrow("dependencies/blocked_by failed (404)")
  })

  test("finds pull requests that close the issue on another branch", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/repos/prokube/example/pulls") {
          return Response.json([{
            html_url: "https://github.com/prokube/example/pull/7",
            body: "Fixes #42",
            head: { ref: "human/alternative" },
          }])
        }
        return new Response("Not found", { status: 404 })
      },
    })
    servers.push(server)
    const client = new GitHubClient("token", `http://127.0.0.1:${server.port}`)
    expect(await client.findOpenPullRequest("prokube/example", "feature/issue-42", 42))
      .toBe("https://github.com/prokube/example/pull/7")
  })

  test("checks every page of open pull requests", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/repos/prokube/example/pulls") {
          if (url.searchParams.get("page") === "1") {
            return Response.json(Array.from({ length: 100 }, (_, index) => ({
              html_url: `https://github.com/prokube/example/pull/${index + 1}`,
              body: "Unrelated change",
              head: { ref: `human/change-${index + 1}` },
            })))
          }
          return Response.json([{
            html_url: "https://github.com/prokube/example/pull/101",
            body: "Resolves #42",
            head: { ref: "human/alternative" },
          }])
        }
        return new Response("Not found", { status: 404 })
      },
    })
    servers.push(server)
    const client = new GitHubClient("token", `http://127.0.0.1:${server.port}`)
    expect(await client.findOpenPullRequest("prokube/example", "feature/issue-42", 42))
      .toBe("https://github.com/prokube/example/pull/101")
  })
})
