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
            multiSourceEnabled: true,
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
            multiSourceEnabled: true,
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
            multiSourceEnabled: true,
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

  test("does not let invalidated in-flight responses overwrite fresh cache", async () => {
    let releaseFirst: ((value: Response) => void) | undefined
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (!releaseFirst) {
        return await new Promise<Response>((resolve) => {
          releaseFirst = resolve
        })
      }
      return new Response(
        JSON.stringify({
          settings: {
            multiSourceEnabled: true,
            sources: [{ id: "beta", directory: "/workspace/app", enabled: true }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })

    const first = resolveTelegramSourceId("http://127.0.0.1:3000", "/workspace/app")
    invalidateTelegramSourceIdCache("http://127.0.0.1:3000", "/workspace/app")
    const second = await resolveTelegramSourceId("http://127.0.0.1:3000", "/workspace/app")

    releaseFirst?.(
      new Response(
        JSON.stringify({
          settings: {
            multiSourceEnabled: true,
            sources: [{ id: "alpha", directory: "/workspace/app", enabled: true }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )
    await first
    const third = await resolveTelegramSourceId("http://127.0.0.1:3000", "/workspace/app")

    expect(second).toBe("beta")
    expect(third).toBe("beta")
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    fetchSpy.mockRestore()
  })

  test("returns default source when multi-source mode is disabled", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          settings: {
            multiSourceEnabled: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })

    const sourceId = await resolveTelegramSourceId("http://127.0.0.1:3000", "/workspace/app")

    expect(sourceId).toBe("default")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    fetchSpy.mockRestore()
  })

  test("returns default source when multi-source flag is missing", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          settings: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })

    const sourceId = await resolveTelegramSourceId("http://127.0.0.1:3000", "/workspace/app")

    expect(sourceId).toBe("default")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    fetchSpy.mockRestore()
  })
})
