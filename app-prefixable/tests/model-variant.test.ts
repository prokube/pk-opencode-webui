import { describe, expect, test } from "bun:test"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "../src/context/model-variant"

describe("getConfiguredAgentVariant", () => {
  test("returns agent variant only when model matches and variant is enabled", () => {
    expect(
      getConfiguredAgentVariant(
        {
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
          variant: "fast",
        },
        {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          variants: { fast: {} },
        },
      ),
    ).toBe("fast")
  })

  test("returns undefined when configured variant is disabled", () => {
    expect(
      getConfiguredAgentVariant(
        {
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
          variant: "fast",
        },
        {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          variants: { fast: { disabled: true } },
        },
      ),
    ).toBeUndefined()
  })

  test("returns undefined when configured model does not match active model", () => {
    expect(
      getConfiguredAgentVariant(
        {
          model: { providerID: "openai", modelID: "gpt-5" },
          variant: "fast",
        },
        {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          variants: { fast: {} },
        },
      ),
    ).toBeUndefined()
  })
})

describe("resolveModelVariant", () => {
  test("prefers explicit per-session variant when available", () => {
    expect(resolveModelVariant("fast", "smart", ["fast", "smart"]))
      .toBe("fast")
  })

  test("falls back to configured agent variant when selected is missing", () => {
    expect(resolveModelVariant(undefined, "fast", ["fast", "smart"]))
      .toBe("fast")
  })

  test("treats legacy null override as inherit-configured default", () => {
    expect(resolveModelVariant(null, "fast", ["fast", "smart"]))
      .toBe("fast")
  })

  test("returns undefined when no variants are available", () => {
    expect(resolveModelVariant("fast", "fast", []))
      .toBeUndefined()
  })
})

describe("cycleModelVariant", () => {
  test("cycles from configured variant when no explicit session override exists", () => {
    expect(cycleModelVariant(undefined, "fast", ["fast", "smart"]))
      .toBe("smart")
  })

  test("cycles selected variant to default at end of list", () => {
    expect(cycleModelVariant("smart", undefined, ["fast", "smart"]))
      .toBeUndefined()
  })

  test("treats legacy null override as no override when cycling", () => {
    expect(cycleModelVariant(null, "fast", ["fast", "smart"]))
      .toBe("smart")
  })

  test("returns undefined when no variants exist", () => {
    expect(cycleModelVariant(undefined, "fast", []))
      .toBeUndefined()
  })
})
