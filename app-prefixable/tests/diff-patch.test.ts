import { describe, expect, test } from "bun:test"
import { createTwoFilesPatch, parsePatch } from "diff"

describe("review diff patches", () => {
  test("generates patches that parse into renderable hunk lines", () => {
    const before = ["export const title = \"old\"", "const removed = true", "console.log(title)", ""].join("\n")
    const after = ["export const title = \"new\"", "console.log(title)", "console.log(\"added\")", ""].join("\n")
    const patch = createTwoFilesPatch("src/example.ts", "src/example.ts", before, after)
    const parsed = parsePatch(patch)

    expect(parsed).toHaveLength(1)
    expect(parsed[0].oldFileName).toBe("src/example.ts")
    expect(parsed[0].newFileName).toBe("src/example.ts")
    expect(parsed[0].hunks).toHaveLength(1)
    expect(parsed[0].hunks[0].lines).toContain('-export const title = "old"')
    expect(parsed[0].hunks[0].lines).toContain('+export const title = "new"')
    expect(parsed[0].hunks[0].lines).toContain("-const removed = true")
    expect(parsed[0].hunks[0].lines).toContain('+console.log("added")')
    expect(parsed[0].hunks[0].lines).toContain(" console.log(title)")
  })
})
