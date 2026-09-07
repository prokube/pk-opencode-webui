import { describe, expect, test } from "bun:test"
import { parseProjectConfig, removeProjectDefault, removeProjectPermissionPattern } from "../src/utils/project-config"

describe("project config rewrites", () => {
  test("removes one permission pattern without dropping sibling rules", () => {
    const result = removeProjectPermissionPattern({
      permission: {
        edit: "allow",
        bash: { "*": "ask", "git *": "allow", "rm *": "deny" },
      },
    }, "bash", "rm *")

    expect(result).toEqual({
      changed: true,
      config: {
        permission: {
          edit: "allow",
          bash: { "*": "ask", "git *": "allow" },
        },
      },
    })
  })

  test("reports an inherited or missing permission pattern without changing config", () => {
    const config = { permission: { bash: { "*": "ask" as const } } }
    expect(removeProjectPermissionPattern(config, "bash", "rm *")).toEqual({ config, changed: false })
    expect(removeProjectPermissionPattern({ permission: "ask" }, "bash", "rm *")).toEqual({
      config: { permission: "ask" },
      changed: false,
    })
  })

  test("represents inherited model and agent defaults by omitting their keys", () => {
    const model = removeProjectDefault({ model: "anthropic/sonnet", default_agent: "build", username: "dev" }, "model")
    const agent = removeProjectDefault(model.config, "default_agent")

    expect(agent).toEqual({ config: { username: "dev" }, changed: true })
    expect(JSON.stringify(agent.config)).toBe('{"username":"dev"}')
  })

  test("parses only project config objects", () => {
    expect(parseProjectConfig('{"model":"anthropic/sonnet"}')).toEqual({ model: "anthropic/sonnet" })
    expect(parseProjectConfig("null")).toBeNull()
    expect(parseProjectConfig("[]")).toBeNull()
    expect(parseProjectConfig("invalid")).toBeNull()
  })
})
