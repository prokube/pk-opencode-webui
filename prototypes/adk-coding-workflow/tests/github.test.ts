import { afterEach, describe, expect, test } from "bun:test"

import { GitHubClient } from "../src/github"

const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

describe("GitHubClient", () => {
  test("discovers eligible issues and prioritizes the authenticated author's work", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/user") return Response.json({ login: "owner" })
        if (url.pathname === "/repos/prokube/example/issues" && url.searchParams.get("labels") === "ready,automated") {
          return Response.json([
            {
              number: 1,
              title: "Critical from another author",
              body: "",
              state: "open",
              html_url: "https://github.com/prokube/example/issues/1",
              labels: [{ name: "ready" }, { name: "automated" }, { name: "priority:critical" }],
              assignees: [],
              user: { login: "someone" },
              created_at: "2026-01-01T00:00:00Z",
            },
            {
              number: 2,
              title: "Low priority from owner",
              body: "",
              state: "open",
              html_url: "https://github.com/prokube/example/issues/2",
              labels: [{ name: "ready" }, { name: "automated" }, { name: "priority:low" }],
              assignees: [],
              user: { login: "owner" },
              created_at: "2026-02-01T00:00:00Z",
            },
            {
              number: 3,
              title: "Already claimed",
              body: "",
              state: "open",
              html_url: "https://github.com/prokube/example/issues/3",
              labels: [{ name: "ready" }, { name: "automated" }],
              assignees: [],
              user: { login: "owner" },
              created_at: "2025-01-01T00:00:00Z",
            },
          ])
        }
        const issue = url.pathname.match(/^\/repos\/prokube\/example\/issues\/(\d+)$/)?.[1]
        if (issue) {
          const number = Number(issue)
          return Response.json({
            number,
            title: number === 1 ? "Critical from another author" : number === 2 ? "Low priority from owner" : "Already claimed",
            body: "",
            state: "open",
            html_url: `https://github.com/prokube/example/issues/${number}`,
            labels: [{ name: "ready" }, { name: "automated" }, ...(number < 3 ? [{ name: number === 1 ? "priority:critical" : "priority:low" }] : [])],
            assignees: [],
          })
        }
        if (/\/issues\/3\/comments$/.test(url.pathname)) {
          return Response.json([{
            user: { login: "owner" },
            body: "Coding workflow `another-run` claimed this issue.",
          }])
        }
        if (/\/issues\/\d+\/comments$/.test(url.pathname)) return Response.json([])
        if (/\/issues\/\d+\/dependencies\/blocked_by$/.test(url.pathname)) return Response.json([])
        if (url.pathname === "/repos/prokube/example/pulls") return Response.json([])
        if (url.pathname.startsWith("/repos/prokube/example/git/ref/heads/feature/issue-")) {
          return new Response("Not found", { status: 404 })
        }
        return new Response("Not found", { status: 404 })
      },
    })
    servers.push(server)
    const client = new GitHubClient("token", `http://127.0.0.1:${server.port}`)
    const result = await client.discover({
      provider: "github",
      project: "prokube/example",
      suggestedBaseBranch: "main",
    }, {
      includeLabels: ["ready", "automated"],
      excludeLabels: ["blocked"],
    })
    expect(result.candidates.map((item) => item.candidate.number)).toEqual([2, 1])
    expect(result.candidates[0]?.candidate).toEqual({
      provider: "github",
      project: "prokube/example",
      number: 2,
      title: "Low priority from owner",
      author: "owner",
      priority: "low",
      url: "https://github.com/prokube/example/issues/2",
      suggestedBaseBranch: "main",
    })
    expect(result.truncated).toBe(false)
  })

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
            labels: [{ name: "ready" }, { name: "automated" }],
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
    await expect(client.getIssue("prokube/example", 42))
      .rejects.toThrow("dependencies/blocked_by?per_page=100&page=1 failed (404)")
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

  test("revalidates issue-branch absence and the selected base branch", async () => {
    let issueBranchExists = true
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/repos/prokube/example/issues/42") {
          return Response.json({
            number: 42,
            title: "Issue",
            body: "Body",
            state: "open",
            html_url: "https://github.com/prokube/example/issues/42",
            labels: [{ name: "ready" }],
            assignees: [],
          })
        }
        if (url.pathname === "/repos/prokube/example/issues/42/dependencies/blocked_by") return Response.json([])
        if (url.pathname === "/repos/prokube/example/issues/42/comments") return Response.json([])
        if (url.pathname === "/repos/prokube/example/pulls") return Response.json([])
        if (url.pathname === "/repos/prokube/example/git/ref/heads/feature/issue-42") {
          return issueBranchExists ? Response.json({ ref: "refs/heads/feature/issue-42" }) : new Response(null, { status: 404 })
        }
        if (url.pathname === "/repos/prokube/example/git/ref/heads/main") {
          return Response.json({ ref: "refs/heads/main" })
        }
        return new Response("Not found", { status: 404 })
      },
    })
    servers.push(server)
    const client = new GitHubClient("token", `http://127.0.0.1:${server.port}`)
    const selected = {
      provider: "github",
      project: "prokube/example",
      number: 42,
      title: "Issue",
      author: "owner",
      priority: "medium" as const,
      url: "https://github.com/prokube/example/issues/42",
      suggestedBaseBranch: "main",
    }
    await expect(client.revalidate(selected, "main")).rejects.toThrow("issue branch already exists")
    issueBranchExists = false
    await expect(client.revalidate(selected, "main")).resolves.toBeUndefined()
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

  test("treats a completed claim by the same run as idempotent", async () => {
    let mutations = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (request.method !== "GET") {
          mutations += 1
          return new Response(null, { status: 204 })
        }
        if (url.pathname === "/repos/prokube/example/issues/42") {
          return Response.json({
            number: 42,
            title: "Issue",
            body: "Body",
            state: "open",
            html_url: "https://example.test/issues/42",
            labels: [{ name: "in-progress" }],
            assignees: [{ login: "prokube-bot" }],
          })
        }
        if (url.pathname === "/repos/prokube/example/issues/42/comments") {
          if (url.searchParams.get("page") === "1") {
            return Response.json(Array.from({ length: 100 }, (_, index) => ({
              user: { login: `reviewer-${index}` },
              body: "Unrelated comment",
            })))
          }
          return Response.json([{
            user: { login: "prokube-bot" },
            body: "Coding workflow `run-42` claimed this issue.",
          }])
        }
        if (url.pathname === "/repos/prokube/example/issues/42/dependencies/blocked_by") return Response.json([])
        return new Response("Not found", { status: 404 })
      },
    })
    servers.push(server)
    const client = new GitHubClient("token", `http://127.0.0.1:${server.port}`)
    await client.claimIssue("prokube/example", {
      number: 42,
      title: "Issue",
      body: "Body",
      state: "open",
      labels: ["ready"],
      assignees: [],
      comments: [],
      openBlockers: [],
      url: "https://example.test/issues/42",
    }, "prokube-bot", "run-42")
    expect(mutations).toBe(0)
  })

  test("writes and verifies the workflow marker before changing assignment or labels", async () => {
    let marked = false
    let issueReads = 0
    const mutations: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (request.method !== "GET") {
          mutations.push(`${request.method} ${url.pathname}`)
          if (url.pathname.endsWith("/comments")) marked = true
          return new Response(null, { status: 204 })
        }
        if (url.pathname === "/repos/prokube/example/issues/42") {
          issueReads += 1
          return Response.json({
            number: 42,
            title: "Issue",
            body: "Body",
            state: "open",
            html_url: "https://example.test/issues/42",
            labels: [{ name: "ready" }, { name: "automated" }],
            assignees: [],
          })
        }
        if (url.pathname === "/repos/prokube/example/issues/42/comments") {
          return Response.json(marked
            ? [{ user: { login: "prokube-bot" }, body: "Coding workflow `run-42` claimed this issue." }]
            : [])
        }
        if (url.pathname === "/repos/prokube/example/issues/42/dependencies/blocked_by") return Response.json([])
        return new Response("Not found", { status: 404 })
      },
    })
    servers.push(server)
    const client = new GitHubClient("token", `http://127.0.0.1:${server.port}`)
    await client.claimIssue("prokube/example", {
      number: 42,
      title: "Issue",
      body: "Body",
      state: "open",
      labels: ["ready", "automated"],
      assignees: [],
      comments: [],
      openBlockers: [],
      url: "https://example.test/issues/42",
    }, "prokube-bot", "run-42", {
      includeLabels: ["ready", "automated"],
      excludeLabels: ["blocked"],
    })
    expect(issueReads).toBe(2)
    expect(mutations).toEqual([
      "POST /repos/prokube/example/issues/42/comments",
      "POST /repos/prokube/example/issues/42/labels",
      "POST /repos/prokube/example/issues/42/assignees",
      "DELETE /repos/prokube/example/issues/42/labels/ready",
    ])
  })

  test("repairs a partial claim owned by the same run without duplicating its comment", async () => {
    const mutations: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (request.method !== "GET") {
          mutations.push(`${request.method} ${url.pathname}`)
          return new Response(null, { status: 204 })
        }
        if (url.pathname === "/repos/prokube/example/issues/42") {
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
        if (url.pathname === "/repos/prokube/example/issues/42/comments") {
          return Response.json([{ user: { login: "prokube-bot" }, body: "Coding workflow `run-42` claimed this issue." }])
        }
        if (url.pathname === "/repos/prokube/example/issues/42/dependencies/blocked_by") return Response.json([])
        return new Response("Not found", { status: 404 })
      },
    })
    servers.push(server)
    const client = new GitHubClient("token", `http://127.0.0.1:${server.port}`)
    await client.claimIssue("prokube/example", {
      number: 42,
      title: "Issue",
      body: "Body",
      state: "open",
      labels: ["ready"],
      assignees: [],
      comments: [],
      openBlockers: [],
      url: "https://example.test/issues/42",
    }, "prokube-bot", "run-42")
    expect(mutations).toEqual([
      "POST /repos/prokube/example/issues/42/labels",
      "POST /repos/prokube/example/issues/42/assignees",
      "DELETE /repos/prokube/example/issues/42/labels/ready",
    ])
  })

  test("rechecks configured labels before retrying an owned partial claim", async () => {
    let mutations = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (request.method !== "GET") {
          mutations += 1
          return new Response(null, { status: 204 })
        }
        if (url.pathname === "/repos/prokube/example/issues/42") {
          return Response.json({
            number: 42,
            title: "Issue",
            body: "Body",
            state: "open",
            html_url: "https://example.test/issues/42",
            labels: [{ name: "ready" }, { name: "automated" }, { name: "manual-only" }],
            assignees: [],
          })
        }
        if (url.pathname === "/repos/prokube/example/issues/42/comments") {
          return Response.json([{
            user: { login: "prokube-bot" },
            body: "Coding workflow `run-42` claimed this issue.",
          }])
        }
        if (url.pathname === "/repos/prokube/example/issues/42/dependencies/blocked_by") return Response.json([])
        return new Response("Not found", { status: 404 })
      },
    })
    servers.push(server)
    const client = new GitHubClient("token", `http://127.0.0.1:${server.port}`)
    await expect(client.claimIssue("prokube/example", {
      number: 42,
      title: "Issue",
      body: "Body",
      state: "open",
      labels: ["ready", "automated"],
      assignees: [],
      comments: [],
      openBlockers: [],
      url: "https://example.test/issues/42",
    }, "prokube-bot", "run-42", {
      includeLabels: ["ready", "automated"],
      excludeLabels: ["manual-only"],
    })).rejects.toThrow("Issue changed during claim: Issue has excluded label: manual-only")
    expect(mutations).toBe(0)
  })

  test("refuses to overwrite a conflicting workflow claim", async () => {
    let mutations = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (request.method !== "GET") {
          mutations += 1
          return new Response(null, { status: 204 })
        }
        if (url.pathname === "/repos/prokube/example/issues/42") {
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
        if (url.pathname === "/repos/prokube/example/issues/42/comments") {
          return Response.json([{ user: { login: "prokube-bot" }, body: "Coding workflow `other-run` claimed this issue." }])
        }
        if (url.pathname === "/repos/prokube/example/issues/42/dependencies/blocked_by") return Response.json([])
        return new Response("Not found", { status: 404 })
      },
    })
    servers.push(server)
    const client = new GitHubClient("token", `http://127.0.0.1:${server.port}`)
    await expect(client.claimIssue("prokube/example", {
      number: 42,
      title: "Issue",
      body: "Body",
      state: "open",
      labels: ["ready"],
      assignees: [],
      comments: [],
      openBlockers: [],
      url: "https://example.test/issues/42",
    }, "prokube-bot", "run-42")).rejects.toThrow("conflicting workflow claim")
    expect(mutations).toBe(0)
  })

  test("releases an owned claim for supervisor attention with bounded mutations", async () => {
    const mutations: Array<{ method: string; path: string; body: unknown }> = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (request.method !== "GET") {
          mutations.push({
            method: request.method,
            path: url.pathname,
            body: request.headers.get("content-type") ? await request.json() : undefined,
          })
          return new Response(null, { status: 204 })
        }
        if (url.pathname === "/repos/prokube/example/issues/42") {
          return Response.json({
            number: 42,
            title: "Issue",
            body: "Body",
            state: "open",
            html_url: "https://example.test/issues/42",
            labels: [{ name: "ready" }, { name: "in-progress" }],
            assignees: [{ login: "prokube-bot" }],
          })
        }
        if (url.pathname === "/repos/prokube/example/issues/42/comments") {
          return Response.json([{ user: { login: "prokube-bot" }, body: "Coding workflow `run-42` claimed this issue." }])
        }
        if (url.pathname === "/repos/prokube/example/issues/42/dependencies/blocked_by") return Response.json([])
        return new Response("Not found", { status: 404 })
      },
    })
    servers.push(server)
    const client = new GitHubClient("token", `http://127.0.0.1:${server.port}`)
    expect(await client.releaseIssueClaim("prokube/example", 42, "prokube-bot", "run-42", "x".repeat(1_000)))
      .toBe(true)
    expect(mutations.map((mutation) => `${mutation.method} ${mutation.path}`)).toEqual([
      "POST /repos/prokube/example/issues/42/labels",
      "DELETE /repos/prokube/example/issues/42/labels/in-progress",
      "DELETE /repos/prokube/example/issues/42/labels/ready",
      "DELETE /repos/prokube/example/issues/42/assignees",
      "POST /repos/prokube/example/issues/42/comments",
    ])
    expect(mutations[0]?.body).toEqual({ labels: ["needs-supervisor"] })
    expect(mutations[3]?.body).toEqual({ assignees: ["prokube-bot"] })
    const comment = mutations[4]?.body as { body: string }
    expect(comment.body).toStartWith("Coding workflow `run-42` stopped before creating a pull request.")
    expect(comment.body.length).toBeLessThan(450)
  })

  test("treats an already released same-run claim as cleanup-idempotent", async () => {
    let mutations = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (request.method !== "GET") {
          mutations += 1
          return new Response(null, { status: 204 })
        }
        if (url.pathname === "/repos/prokube/example/issues/42") {
          return Response.json({
            number: 42,
            title: "Issue",
            body: "Body",
            state: "open",
            html_url: "https://example.test/issues/42",
            labels: [{ name: "needs-supervisor" }],
            assignees: [],
          })
        }
        if (url.pathname === "/repos/prokube/example/issues/42/comments") {
          return Response.json([
            { user: { login: "prokube-bot" }, body: "Coding workflow `run-42` claimed this issue." },
            {
              user: { login: "prokube-bot" },
              body: "Coding workflow `run-42` stopped before creating a pull request. Added `needs-supervisor`: failed.",
            },
          ])
        }
        if (url.pathname === "/repos/prokube/example/issues/42/dependencies/blocked_by") return Response.json([])
        return new Response("Not found", { status: 404 })
      },
    })
    servers.push(server)
    const client = new GitHubClient("token", `http://127.0.0.1:${server.port}`)
    expect(await client.releaseIssueClaim("prokube/example", 42, "prokube-bot", "run-42", "retry"))
      .toBe(true)
    expect(mutations).toBe(0)
  })
})
