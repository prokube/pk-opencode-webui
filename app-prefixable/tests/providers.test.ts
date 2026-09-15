import { describe, expect, test } from "bun:test"
import { normalizeProviderData } from "../src/context/providers"
import type { ProviderData } from "../src/context/sync"

describe("provider helpers", () => {
  test("derives model provider ids without changing sync data", () => {
    const data: ProviderData = {
      all: [{
        id: "alpha",
        name: "Alpha",
        env: [],
        models: {
          fast: {
            id: "fast",
            name: "Fast",
            release_date: "2026-01-01",
            attachment: false,
            reasoning: false,
            temperature: true,
            tool_call: true,
            limit: { context: 128_000, output: 8_000 },
            options: {},
          },
        },
      }],
      connected: ["alpha"],
      default: { alpha: "fast" },
    }

    const normalized = normalizeProviderData(data)

    expect(normalized.all[0].models.fast.providerID).toBe("alpha")
    expect(data.all[0].models.fast).not.toHaveProperty("providerID")
    expect(normalized.connected).toBe(data.connected)
  })
})
