import { describe, expect, test } from "bun:test"
import { matchesBasePath, normalizeRequestPath, prefixStrippedAllowed, stripBasePath } from "../../shared/base-path"

describe("matchesBasePath", () => {
  test("accepts only the complete configured prefix", () => {
    expect(matchesBasePath("/notebook/user/app", "/notebook/user/app/")).toBe(true)
    expect(matchesBasePath("/notebook/user/app/api/ext/list-dirs", "/notebook/user/app")).toBe(true)
    expect(matchesBasePath("/notebook/user/application", "/notebook/user/app")).toBe(false)
  })

  test("rejects an unprefixed extended API path when a prefix is configured", () => {
    expect(matchesBasePath("/api/ext/mkdir", "/notebook/user/app")).toBe(false)
  })

  test("keeps root deployments unrestricted", () => {
    expect(matchesBasePath("/api/ext/mkdir", "/")).toBe(true)
    expect(matchesBasePath("/session", "")).toBe(true)
  })
})

describe("stripBasePath", () => {
  test("strips an exact prefix and paths below it", () => {
    expect(stripBasePath("/foo", "/foo")).toBe("/")
    expect(stripBasePath("/foo/session", "/foo")).toBe("/session")
  })

  test("does not strip a partial path segment", () => {
    expect(stripBasePath("/foobar/session", "/foo")).toBe("/foobar/session")
  })

  test("leaves paths unchanged for the root prefix", () => {
    expect(stripBasePath("/session", "/")).toBe("/session")
  })
})

describe("normalizeRequestPath", () => {
  test("normalizes a preserved prefix on a complete path segment", () => {
    expect(normalizeRequestPath("/apps/opencode", "/apps/opencode/")).toBe("/")
    expect(normalizeRequestPath("/apps/opencode/session", "/apps/opencode/")).toBe("/session")
    expect(normalizeRequestPath("/apps/opencode-other/session", "/apps/opencode/")).toBeNull()
  })

  test("accepts an already-stripped path only when explicitly enabled", () => {
    expect(normalizeRequestPath("/session", "/apps/opencode/")).toBeNull()
    expect(normalizeRequestPath("/session", "/apps/opencode/", true)).toBe("/session")
    expect(normalizeRequestPath("/", "/apps/opencode/", true)).toBe("/")
  })

  test("handles preserved and stripped paths in stripped-prefix mode", () => {
    expect(normalizeRequestPath("/apps/opencode", "/apps/opencode/", true)).toBe("/")
    expect(normalizeRequestPath("/apps/opencode/session", "/apps/opencode/", true)).toBe("/session")
    expect(normalizeRequestPath("/apps/opencode-other/session", "/apps/opencode/", true)).toBe("/apps/opencode-other/session")
    expect(normalizeRequestPath("apps/opencode/session", "/apps/opencode/", true)).toBeNull()
  })

  test("keeps root deployments unchanged", () => {
    expect(normalizeRequestPath("/session", "/")).toBe("/session")
  })
})

describe("prefixStrippedAllowed", () => {
  test("defaults Kubeflow notebook prefixes to stripped mode", () => {
    expect(prefixStrippedAllowed(undefined, "/notebook/team/workspace/")).toBe(true)
    expect(prefixStrippedAllowed(undefined, "")).toBe(false)
    expect(prefixStrippedAllowed(undefined)).toBe(false)
  })

  test("honors an explicit override", () => {
    expect(prefixStrippedAllowed("false", "/notebook/team/workspace/")).toBe(false)
    expect(prefixStrippedAllowed("true")).toBe(true)
  })
})
