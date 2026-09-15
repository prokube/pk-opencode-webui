import { describe, expect, test } from "bun:test"
import { mergeConfigState } from "../src/context/config"

describe("config state", () => {
  test("deep-merges partial update responses without dropping effective config", () => {
    const current = {
      model: "provider/old",
      permission: { edit: "ask", bash: { "*": "deny" } },
      tools: { read: true, write: false },
    }
    const patch = { model: "provider/new", permission: { edit: "allow" } }

    expect(mergeConfigState(current, patch)).toEqual({
      model: "provider/new",
      permission: { edit: "allow", bash: { "*": "deny" } },
      tools: { read: true, write: false },
    })
  })

  test("replaces arrays instead of merging their indices", () => {
    expect(mergeConfigState({ instructions: ["old"] }, { instructions: ["new"] })).toEqual({ instructions: ["new"] })
  })

  test("ignores keys that can mutate object prototypes", () => {
    const patch = JSON.parse('{"model":"provider/new","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true}}')
    const result = mergeConfigState({ tools: { read: true } }, patch)

    expect(result).toEqual({ tools: { read: true }, model: "provider/new" })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
