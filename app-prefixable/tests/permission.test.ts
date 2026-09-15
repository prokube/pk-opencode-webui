import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "../src/sdk/client"
import { resetFailedPermissionResponse } from "../src/context/permission"

const permission = {
  id: "permission-1",
  sessionID: "session-1",
  permission: "edit",
  patterns: ["src/file.ts"],
  metadata: {},
  always: [],
} satisfies PermissionRequest

describe("permission helpers", () => {
  test("resets response tracking and restores a dismissed permission after failure", () => {
    const responded = new Set([permission.id])
    const autoAttempted = new Set([permission.id])
    const restored: PermissionRequest[] = []

    resetFailedPermissionResponse(permission, responded, autoAttempted, () => false, (item) => restored.push(item))

    expect(responded.has(permission.id)).toBe(false)
    expect(autoAttempted.has(permission.id)).toBe(false)
    expect(restored).toEqual([permission])
  })

  test("does not overwrite a permission restored by a newer event", () => {
    const responded = new Set([permission.id])
    const autoAttempted = new Set([permission.id])
    const restored: PermissionRequest[] = []

    resetFailedPermissionResponse(permission, responded, autoAttempted, () => true, (item) => restored.push(item))

    expect(responded.has(permission.id)).toBe(false)
    expect(autoAttempted.has(permission.id)).toBe(false)
    expect(restored).toEqual([])
  })
})
