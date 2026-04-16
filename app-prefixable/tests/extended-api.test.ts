import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { invalidateTelegramSourceIdCache, resolveTelegramSourceId } from "../src/utils/extended-api"

describe("resolveTelegramSourceId", () => {
  beforeEach(() => {
    invalidateTelegramSourceIdCache()
  })

  afterEach(() => {
    invalidateTelegramSourceIdCache()
  })

  test("reuses cached source mapping within TTL", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          settings: {
            sources: [{ id: "alpha", directory: "/workspace/app", enabled: true }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })

    const first = await resolveTelegramSourceId("http://127.0.0.1:3000", "/workspace/app")
    const second = await resolveTelegramSourceId("http://127.0.0.1:3000", "/workspace/app")

    expect(first).toBe("alpha")
    expect(second).toBe("alpha")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    fetchSpy.mockRestore()
  })

  test("cache invalidation forces a refetch", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          settings: {
            sources: [{ id: "alpha", directory: "/workspace/app", enabled: true }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })

    await resolveTelegramSourceId("http://127.0.0.1:3000", "/workspace/app")
    invalidateTelegramSourceIdCache("http://127.0.0.1:3000", "/workspace/app")
    await resolveTelegramSourceId("http://127.0.0.1:3000", "/workspace/app")

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    fetchSpy.mockRestore()
  })

  test("expired cache entries are refreshed", async () => {
    const nowSpy = spyOn(Date, "now")
    nowSpy.mockReturnValueOnce(1_000)
    nowSpy.mockReturnValue(35_001)

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          settings: {
            sources: [{ id: "alpha", directory: "/workspace/app", enabled: true }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })

    await resolveTelegramSourceId("http://127.0.0.1:3000", "/workspace/app")
    await resolveTelegramSourceId("http://127.0.0.1:3000", "/workspace/app")

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    fetchSpy.mockRestore()
    nowSpy.mockRestore()
  })
})
