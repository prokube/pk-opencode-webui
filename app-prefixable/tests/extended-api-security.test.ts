import { afterAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleExtendedEndpoint, isSameOriginRequest } from "../../shared/extended-api"

const originalConfigDir = process.env.OPENCODE_CONFIG_DIR
const originalWorkspaceRoot = process.env.OPENCODE_WORKSPACE_ROOT
const configDirs: string[] = []

afterAll(async () => {
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  if (originalConfigDir !== undefined) process.env.OPENCODE_CONFIG_DIR = originalConfigDir
  if (originalWorkspaceRoot === undefined) delete process.env.OPENCODE_WORKSPACE_ROOT
  if (originalWorkspaceRoot !== undefined) process.env.OPENCODE_WORKSPACE_ROOT = originalWorkspaceRoot
  await Promise.all(configDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

function compareRequest(directory: string, body?: { directory: string; expected: string; content: string }) {
  const url = new URL("https://ui.example/api/ext/project-config")
  if (!body) url.searchParams.set("directory", directory)
  const req = new Request(url, body ? {
    method: "PUT",
    headers: { Origin: url.origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } : undefined)
  return handleExtendedEndpoint("/api/ext/project-config", req.method, url, req)
}

describe("extended API security", () => {
  test("rejects cross-origin mutations", async () => {
    const url = new URL("https://ui.example/notebook/user/app/api/ext/mkdir")
    const req = new Request(url, {
      method: "POST",
      headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
      body: JSON.stringify({ path: "." }),
    })
    const response = await handleExtendedEndpoint("/api/ext/mkdir", req.method, url, req)

    expect(response?.status).toBe(403)
    expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(response?.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin")
  })

  test("allows same-origin mutations and requests without Origin", async () => {
    for (const origin of ["https://ui.example", undefined]) {
      const url = new URL("https://ui.example/notebook/user/app/api/ext/mkdir")
      const headers = new Headers({ "Content-Type": "application/json" })
      if (origin) headers.set("Origin", origin)
      const req = new Request(url, { method: "POST", headers, body: "{}" })
      const response = await handleExtendedEndpoint("/api/ext/mkdir", req.method, url, req)

      expect(response?.status).toBe(400)
      expect(response?.headers.get("Referrer-Policy")).toBe("no-referrer")
    }
  })

  test("uses forwarded origin behind TLS termination", () => {
    const req = new Request("http://ui.example/notebook/user/app/api/ext/mkdir", {
      headers: {
        Origin: "https://public.example",
        "X-Forwarded-Host": "public.example",
        "X-Forwarded-Proto": "https",
      },
    })
    expect(isSameOriginRequest(req)).toBe(true)
  })

  test("rejects cross-site fetch metadata even without Origin", () => {
    const req = new Request("https://ui.example/api/ext/mkdir", {
      headers: { "Sec-Fetch-Site": "cross-site" },
    })
    expect(isSameOriginRequest(req)).toBe(false)
  })

  test("deletes MCP config entries idempotently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-mcp-delete-"))
    configDirs.push(dir)
    process.env.OPENCODE_CONFIG_DIR = dir
    const configPath = join(dir, "opencode.json")
    await Bun.write(configPath, JSON.stringify({ mcp: { docs: { type: "remote", url: "https://example.com" } } }))
    const url = new URL("https://ui.example/api/ext/mcp/docs")
    const req = () => new Request(url, { method: "DELETE", headers: { Origin: url.origin } })

    const removed = await handleExtendedEndpoint("/api/ext/mcp/docs", "DELETE", url, req())
    const repeated = await handleExtendedEndpoint("/api/ext/mcp/docs", "DELETE", url, req())

    expect(removed?.status).toBe(200)
    expect(await removed?.json()).toEqual({ success: true, removed: true })
    expect(repeated?.status).toBe(200)
    expect(await repeated?.json()).toEqual({ success: true, removed: false })
    expect(await Bun.file(configPath).json()).toEqual({ mcp: {} })
  })

  test("reads exact content and atomically replaces only the expected version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-compare-write-"))
    configDirs.push(dir)
    process.env.OPENCODE_WORKSPACE_ROOT = dir
    const path = join(dir, "config.json")
    const original = "{\n  \"model\": \"old\"\n}\n"
    await Bun.write(path, original)
    await chmod(path, 0o600)

    const read = await compareRequest(dir)
    expect(read?.status).toBe(200)
    expect(await read?.json()).toEqual({ content: original })

    const responses = await Promise.all([
      compareRequest(dir, { directory: dir, expected: original, content: "{\"model\":\"one\"}" }),
      compareRequest(dir, { directory: dir, expected: original, content: "{\"model\":\"two\"}" }),
    ])
    expect(responses.map((response) => response?.status).sort()).toEqual([200, 409])
    expect(["{\"model\":\"one\"}", "{\"model\":\"two\"}"]).toContain(await Bun.file(path).text())
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([])
  })

  test("rejects compare writes outside the workspace and through symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-compare-root-"))
    const outside = await mkdtemp(join(tmpdir(), "opencode-compare-outside-"))
    configDirs.push(dir, outside)
    process.env.OPENCODE_WORKSPACE_ROOT = dir
    const outsidePath = join(outside, "config.json")
    await Bun.write(outsidePath, "{}")

    const escaped = await compareRequest(outside, { directory: outside, expected: "{}", content: "{\"model\":\"bad\"}" })
    expect(escaped?.status).toBe(403)
    expect(await Bun.file(outsidePath).text()).toBe("{}")

    const target = join(dir, "target.json")
    const link = join(dir, "config.json")
    await Bun.write(target, "{}")
    await symlink(target, link)
    const linkedRead = await compareRequest(dir)
    const linkedWrite = await compareRequest(dir, { directory: dir, expected: "{}", content: "{\"model\":\"bad\"}" })
    expect(linkedRead?.status).toBe(403)
    expect(linkedWrite?.status).toBe(403)
    expect(await Bun.file(target).text()).toBe("{}")
  })
})
