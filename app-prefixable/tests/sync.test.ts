import { describe, expect, test } from "bun:test"
import { applyPartDelta, mergeMessageUpdate, mergePartUpdate } from "../src/context/sync"
import type { Message, Part } from "../src/sdk/client"

const user = (id: string, sessionID = "ses_1"): Message => ({
  id,
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "prov", modelID: "model" },
})

const text = (id: string, messageID: string, value = ""): Part => ({
  id,
  sessionID: "ses_1",
  messageID,
  type: "text",
  text: value,
})

describe("sync event helpers", () => {
  test("message.updated inserts messages that are not loaded yet", () => {
    const messages = mergeMessageUpdate(undefined, user("msg_1"))

    expect(messages).toHaveLength(1)
    expect(messages[0].info.id).toBe("msg_1")
    expect(messages[0].parts).toEqual([])
  })

  test("message.updated attaches parts received before message info", () => {
    const part = text("part_1", "msg_1", "hello")
    const messages = mergeMessageUpdate(undefined, user("msg_1"), [part])

    expect(messages[0].parts).toEqual([part])
  })

  test("message.part.updated upserts parts by id", () => {
    const first = text("part_1", "msg_1", "hel")
    const updated = text("part_1", "msg_1", "hello")

    expect(mergePartUpdate([first], updated)).toEqual([updated])
  })

  test("message.part.delta appends string fields", () => {
    expect(applyPartDelta(text("part_1", "msg_1", "hel"), "text", "lo")).toMatchObject({
      text: "hello",
    })
  })
})
