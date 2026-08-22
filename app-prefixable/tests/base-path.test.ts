import { describe, expect, test } from "bun:test"
import { matchesBasePath, stripBasePath } from "../../shared/base-path"

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
