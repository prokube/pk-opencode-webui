import { describe, expect, test } from "bun:test"

import {
  discoverTickets,
  parseCandidateList,
  parseDiscoveryRequest,
  parseSelectedTicket,
  revalidateSelection,
  selectFirstCandidate,
  type TicketDiscoveryProvider,
} from "../src/discovery"
import type { DiscoveryProject, TicketCandidate } from "../src/domain"

const candidate = (overrides: Partial<TicketCandidate> = {}): TicketCandidate => ({
  provider: "github",
  project: "prokube/pkui",
  number: 42,
  title: "Implement selection",
  author: "owner",
  priority: "medium",
  url: "https://github.com/prokube/pkui/issues/42",
  suggestedBaseBranch: "main",
  ...overrides,
})

class FakeProvider implements TicketDiscoveryProvider {
  readonly provider = "github"
  revalidated?: { candidate: TicketCandidate; baseBranch: string }

  async discover(project: DiscoveryProject) {
    return {
      candidates: [{
        candidate: candidate({ project: project.project, suggestedBaseBranch: project.suggestedBaseBranch }),
        authoredByAuthenticatedUser: false,
        createdAt: "2026-02-01T00:00:00Z",
      }],
      truncated: false,
    }
  }

  async revalidate(value: TicketCandidate, baseBranch: string): Promise<void> {
    this.revalidated = { candidate: value, baseBranch }
  }
}

describe("ticket discovery contract", () => {
  test("parses normalized projects and returns only bounded public candidate fields", async () => {
    const provider = new FakeProvider()
    const request = parseDiscoveryRequest(JSON.stringify({ projects: [
      { provider: "github", project: "prokube/pkui", suggestedBaseBranch: "main" },
    ] }))
    const result = await discoverTickets(request, [provider])
    expect(result).toEqual({ candidates: [candidate()], truncated: false })
    expect(Object.keys(result.candidates[0]!).sort()).toEqual([
      "author", "number", "priority", "project", "provider", "suggestedBaseBranch", "title", "url",
    ])
  })

  test("prioritizes authenticated authors, priority, and age across projects", async () => {
    const provider: TicketDiscoveryProvider = {
      provider: "github",
      async discover(project) {
        const own = project.project.endsWith("owned")
        return {
          candidates: [{
            candidate: candidate({ project: project.project, number: own ? 2 : 1, priority: own ? "low" : "critical" }),
            authoredByAuthenticatedUser: own,
            createdAt: own ? "2026-03-01T00:00:00Z" : "2026-01-01T00:00:00Z",
          }],
          truncated: false,
        }
      },
      async revalidate() {},
    }
    const projects = [
      { provider: "github", project: "prokube/other", suggestedBaseBranch: "main" },
      { provider: "github", project: "prokube/owned", suggestedBaseBranch: "main" },
    ]
    const result = await discoverTickets({ projects, labelPolicy: {
      includeLabels: ["ready"],
      excludeLabels: ["in-progress"],
    } }, [provider], projects)
    expect(result.candidates.map((item) => item.project)).toEqual(["prokube/owned", "prokube/other"])
  })

  test("rejects discovery outside the explicit reviewed project allowlist", async () => {
    expect(() => parseDiscoveryRequest(JSON.stringify({ projects: [
      { provider: "github", project: "unrelated/private", suggestedBaseBranch: "main" },
    ] }))).toThrow("not allowlisted")
    await expect(discoverTickets({ projects: [
      { provider: "github", project: "unrelated/private", suggestedBaseBranch: "main" },
    ], labelPolicy: {
      includeLabels: ["ready"],
      excludeLabels: ["in-progress"],
    } }, [new FakeProvider()])).rejects.toThrow("not allowlisted")
    expect(() => parseCandidateList(JSON.stringify({
      candidates: [candidate({
        project: "unrelated/private",
        url: "https://github.com/unrelated/private/issues/42",
      })],
      truncated: false,
    }))).toThrow("not allowlisted")
  })

  test("rejects a candidate URL that does not identify the published issue", () => {
    expect(() => parseCandidateList(JSON.stringify({
      candidates: [candidate({ url: "https://github.com/prokube/pkui/issues/41" })],
      truncated: false,
    }))).toThrow("Invalid GitHub candidate URL")
  })

  test("rejects a selection outside the published list and revalidates an included selection", async () => {
    const provider = new FakeProvider()
    const list = parseCandidateList(JSON.stringify({ candidates: [candidate()], truncated: false }))
    await expect(revalidateSelection({
      candidateList: list,
      selectedTicket: parseSelectedTicket('{"provider":"github","project":"prokube/pkui","number":7}'),
      baseBranch: "main",
      providers: [provider],
    })).rejects.toThrow("not in the published candidate list")

    const selected = await revalidateSelection({
      candidateList: list,
      selectedTicket: parseSelectedTicket('{"provider":"github","project":"prokube/pkui","number":42}'),
      baseBranch: "feature/target",
      providers: [provider],
    })
    expect(selected).toEqual({ provider: "github", project: "prokube/pkui", number: 42, baseBranch: "feature/target" })
    expect(provider.revalidated?.baseBranch).toBe("feature/target")
  })

  test("rejects oversized candidate input", () => {
    expect(() => parseCandidateList(JSON.stringify({
      candidates: Array.from({ length: 51 }, (_, number) => candidate({ number: number + 1 })),
      truncated: true,
    }))).toThrow("oversized")
  })

  test("parses bounded label policies and defaults to the reviewed safety labels", () => {
    const base = { projects: [
      { provider: "github", project: "prokube/pkui", suggestedBaseBranch: "main" },
    ] }
    expect(parseDiscoveryRequest(JSON.stringify(base)).labelPolicy).toEqual({
      includeLabels: ["ready"],
      excludeLabels: ["in-progress", "needs-discussion", "needs-supervisor"],
    })
    expect(parseDiscoveryRequest(JSON.stringify({
      ...base,
      includeLabels: ["ready", "automated"],
      excludeLabels: [],
    })).labelPolicy).toEqual({
      includeLabels: ["ready", "automated"],
      excludeLabels: [],
    })
    expect(() => parseDiscoveryRequest(JSON.stringify({
      ...base,
      includeLabels: ["ready"],
      excludeLabels: ["READY"],
    }))).toThrow("must not overlap")
  })

  test("automatically selects only the first ranked candidate", () => {
    expect(selectFirstCandidate({ candidates: [candidate(), candidate({ number: 43 })], truncated: false }))
      .toEqual({
        selectedTicket: { provider: "github", project: "prokube/pkui", number: 42 },
        baseBranch: "main",
      })
    expect(() => selectFirstCandidate({ candidates: [], truncated: false })).toThrow("No eligible")
  })
})
