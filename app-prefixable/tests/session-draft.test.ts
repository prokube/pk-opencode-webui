import { describe, expect, test } from "bun:test"
import { advanceDraftVersion, draftVersionIsCurrent, trimDraftVersions } from "../src/utils/session-draft"

describe("session draft revisions", () => {
  test("prevents a failed submission from replacing a newer same-session draft", () => {
    const versions = new Map<string, number>()
    const submitted = advanceDraftVersion(versions, "session-one")

    advanceDraftVersion(versions, "session-one")

    expect(draftVersionIsCurrent(versions, "session-one", submitted)).toBe(false)
  })

  test("allows a failed submission to restore after unrelated navigation or submission", () => {
    const versions = new Map<string, number>()
    const submitted = advanceDraftVersion(versions, "session-one")

    advanceDraftVersion(versions, "session-two")

    expect(draftVersionIsCurrent(versions, "session-one", submitted)).toBe(true)
  })

  test("bounds revision metadata and retains recently touched drafts", () => {
    const versions = new Map<string, number>()
    advanceDraftVersion(versions, "session-one")
    advanceDraftVersion(versions, "session-two")
    advanceDraftVersion(versions, "session-one")
    advanceDraftVersion(versions, "session-three")

    expect(trimDraftVersions(versions, 2)).toEqual(["session-two"])
    expect([...versions.keys()]).toEqual(["session-one", "session-three"])
  })
})
