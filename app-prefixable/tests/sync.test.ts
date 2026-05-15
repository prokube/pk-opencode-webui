import { describe, expect, test } from "bun:test"
import { applyPartDelta, mergeMessageUpdate, mergePartUpdate, mergeSessionMessages } from "../src/context/sync"
import type { MessageWithParts } from "../src/context/sync"
import type { Message, Part } from "../src/sdk/client"
import { nextSSEReconnectDelay } from "../src/utils/sse"

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

const pendingTool = (id: string, messageID: string): Part => ({
  id,
  sessionID: "ses_1",
  messageID,
  type: "tool",
  callID: "call_1",
  tool: "apply_patch",
  state: { status: "pending", input: {}, raw: "{}" },
})

const completedTool = (id: string, messageID: string): Part => ({
  id,
  sessionID: "ses_1",
  messageID,
  type: "tool",
  callID: "call_1",
  tool: "apply_patch",
  state: { status: "completed", input: {}, output: "ok", title: "Patched", metadata: {}, time: { start: 1, end: 2 } },
})

const runningTool = (id: string, messageID: string, start: number): Part => ({
  id,
  sessionID: "ses_1",
  messageID,
  type: "tool",
  callID: "call_1",
  tool: "apply_patch",
  state: { status: "running", input: {}, time: { start } },
})

const message = (info: Message, parts: Part[]): MessageWithParts => ({ info, parts })

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

  test("message.part.updated preserves order when replacing existing parts", () => {
    const first = text("part_1", "msg_1", "hello")
    const second = text("part_2", "msg_1", "world")
    const updated = text("part_1", "msg_1", "hi")

    expect(mergePartUpdate([first, second], updated)).toEqual([updated, second])
  })

  test("message.part.delta appends string fields", () => {
    expect(applyPartDelta(text("part_1", "msg_1", "hel"), "text", "lo")).toMatchObject({
      text: "hello",
    })
  })

  test("message.part.delta ignores non-appendable fields", () => {
    expect(applyPartDelta(text("part_1", "msg_1", "hello"), "id", "_bad")).toMatchObject({
      id: "part_1",
      text: "hello",
    })
  })

  test("session sync replaces stale pending tool parts when part count is unchanged", () => {
    const existing = [message(user("msg_1"), [pendingTool("part_1", "msg_1")])]
    const synced = [message(user("msg_1"), [completedTool("part_1", "msg_1")])]

    expect(mergeSessionMessages(existing, synced)[0].parts[0]).toMatchObject({
      type: "tool",
      state: { status: "completed" },
    })
  })

  test("session sync preserves newer SSE tool updates", () => {
    const existing = [message(user("msg_1"), [runningTool("part_1", "msg_1", 5)])]
    const synced = [message(user("msg_1"), [runningTool("part_1", "msg_1", 1)])]

    expect(mergeSessionMessages(existing, synced)[0].parts[0]).toMatchObject({
      type: "tool",
      state: { status: "running", time: { start: 5 } },
    })
  })

  test("session sync preserves SSE-only messages and parts", () => {
    const existing = [message(user("msg_1"), [text("part_1", "msg_1"), text("part_2", "msg_1")]), message(user("msg_2"), [])]
    const synced = [message(user("msg_1"), [text("part_1", "msg_1")])]

    const merged = mergeSessionMessages(existing, synced)

    expect(merged.map((m) => m.info.id)).toEqual(["msg_1", "msg_2"])
    expect(merged[0].parts.map((p) => p.id)).toEqual(["part_1", "part_2"])
  })

  test("immediate SSE close backs off reconnects", () => {
    expect(nextSSEReconnectDelay(Date.now(), Date.now(), 3000)).toBe(6000)
    expect(nextSSEReconnectDelay(Date.now(), Date.now(), 30_000)).toBe(30_000)
  })

  test("long-lived SSE resets reconnect delay", () => {
    const connectedAt = Date.now() - 11_000

    expect(nextSSEReconnectDelay(connectedAt, Date.now(), 30_000)).toBe(3000)
  })
})
