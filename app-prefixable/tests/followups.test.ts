import { describe, expect, test } from "bun:test"
import { canDispatchFollowup, parseFollowups, parseLegacyFollowupMap } from "../src/utils/followups"

const model = { providerID: "provider", modelID: "model" }

describe("follow-ups", () => {
  test("migrates legacy text entries with stable send metadata", () => {
    const items = parseFollowups(JSON.stringify([{ id: "one", text: "continue" }]), { agent: "build", model })
    expect(items).toHaveLength(1)
    expect(items[0].messageID.startsWith("msg_")).toBe(true)
    expect(items[0].model).toEqual(model)
  })

  test("extracts one session from the released legacy queue map", () => {
    const migrated = parseLegacyFollowupMap(JSON.stringify({ ses_1: [{ id: "one", text: "continue" }], ses_2: [{ id: "two", text: "keep" }] }), "ses_1", { agent: "build", model })
    expect(migrated.items.map((item) => item.text)).toEqual(["continue"])
    expect(JSON.parse(migrated.remaining!)).toHaveProperty("ses_2")
  })

  test("dispatches only an eligible non-failed head item", () => {
    const item = parseFollowups(JSON.stringify([{ id: "one", text: "continue" }]), { agent: "build", model })[0]
    const ready = { ready: true, working: false, processing: false, loading: false, blocked: false, historyLoading: false, loadError: false, child: false, composerEmpty: true, dispatching: false, paused: false, reverting: false, providerConnected: true, item }
    expect(canDispatchFollowup(ready)).toBe(true)
    expect(canDispatchFollowup({ ...ready, working: true })).toBe(false)
    expect(canDispatchFollowup({ ...ready, item: { ...item, failed: true } })).toBe(false)
    expect(canDispatchFollowup({ ...ready, providerConnected: false })).toBe(false)
  })
})
