import { describe, expect, test } from "bun:test"
import { applyPartDelta, mergeMessageUpdate, mergePartUpdate, mergeSessionMessages, reduceSyncLiveEvent, removeSyncSession, updateProviderConnected, upsertSyncSession } from "../src/context/sync"
import type { MessageWithParts, SyncLiveState } from "../src/context/sync"
import type { Message, Part, PermissionRequest, QuestionRequest, Session } from "../src/sdk/client"
import { createEventBuffer } from "../src/utils/event-buffer"
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

const session = (id: string, archived?: number): Session => ({
  id,
  slug: id,
  projectID: "project",
  directory: "/workspace",
  title: id,
  version: "1",
  time: { created: 1, updated: 1, archived },
})

describe("sync event helpers", () => {
  test("upserts active sessions in id order", () => {
    const updated = { ...session("ses_2"), title: "updated" }
    const state = upsertSyncSession({ session: [session("ses_2")], archivedSession: [] }, updated)

    expect(state.session).toEqual([updated])
    expect(upsertSyncSession(state, session("ses_1")).session.map((item) => item.id)).toEqual(["ses_1", "ses_2"])
  })

  test("moves sessions between active and archived lists", () => {
    const active = session("ses_1")
    const archived = session("ses_1", 2)
    const moved = upsertSyncSession({ session: [active], archivedSession: [] }, archived)

    expect(moved.session).toEqual([])
    expect(moved.archivedSession).toEqual([archived])
    expect(upsertSyncSession(moved, active)).toEqual({ session: [active], archivedSession: [] })
  })

  test("removes sessions from active and archived lists", () => {
    const state = { session: [session("ses_1")], archivedSession: [session("ses_2", 2)] }

    expect(removeSyncSession(state, "ses_1")).toEqual({ session: [], archivedSession: state.archivedSession })
    expect(removeSyncSession(state, "ses_2")).toEqual({ session: state.session, archivedSession: [] })
  })

  test("updates provider connection state without duplicating ids", () => {
    const data = { all: [], connected: ["alpha"], default: {} }

    expect(updateProviderConnected(data, "alpha", true)).toBe(data)
    expect(updateProviderConnected(data, "beta", true).connected).toEqual(["alpha", "beta"])
    expect(updateProviderConnected(data, "alpha", false).connected).toEqual([])
  })

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

  test("session sync advances stale text parts from snapshots", () => {
    const existing = [message(user("msg_1"), [text("part_1", "msg_1", "hel")])]
    const synced = [message(user("msg_1"), [text("part_1", "msg_1", "hello")])]

    expect(mergeSessionMessages(existing, synced)[0].parts[0]).toMatchObject({
      type: "text",
      text: "hello",
    })
  })

  test("session sync preserves longer SSE text parts", () => {
    const existing = [message(user("msg_1"), [text("part_1", "msg_1", "hello")])]
    const synced = [message(user("msg_1"), [text("part_1", "msg_1", "hel")])]

    expect(mergeSessionMessages(existing, synced)[0].parts[0]).toMatchObject({
      type: "text",
      text: "hello",
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

  test("reduces status, question, and permission events into canonical live state", () => {
    const question: QuestionRequest = {
      id: "que_1",
      sessionID: "ses_1",
      questions: [],
    }
    const permission: PermissionRequest = {
      id: "per_1",
      sessionID: "ses_1",
      permission: "edit",
      patterns: [],
      metadata: {},
      always: [],
    }
    const initial: SyncLiveState = { status: {}, pendingQuestions: {}, pendingPermissions: {} }
    const busy = reduceSyncLiveEvent(initial, {
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "busy" } },
    })
    const asked = reduceSyncLiveEvent(busy, { type: "question.asked", properties: question })
    const pending = reduceSyncLiveEvent(asked, { type: "permission.asked", properties: permission })

    expect(pending.status.ses_1).toEqual({ type: "busy" })
    expect(pending.pendingQuestions.ses_1).toEqual(question)
    expect(pending.pendingPermissions.per_1).toEqual(permission)

    const idle = reduceSyncLiveEvent(pending, {
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    })
    const replied = reduceSyncLiveEvent(idle, {
      type: "question.replied",
      properties: { sessionID: "ses_1", requestID: "que_1" },
    })
    const cleared = reduceSyncLiveEvent(replied, {
      type: "permission.replied",
      properties: { sessionID: "ses_1", requestID: "per_1" },
    })

    expect(cleared.status.ses_1).toEqual({ type: "idle" })
    expect(cleared.pendingQuestions.ses_1).toBeUndefined()
    expect(cleared.pendingPermissions.per_1).toBeUndefined()
  })

  test("does not let a stale question reply clear a newer request", () => {
    const question: QuestionRequest = {
      id: "que_new",
      sessionID: "ses_1",
      questions: [],
    }
    const state: SyncLiveState = {
      status: {},
      pendingQuestions: { ses_1: question },
      pendingPermissions: {},
    }

    const next = reduceSyncLiveEvent(state, {
      type: "question.rejected",
      properties: { sessionID: "ses_1", requestID: "que_old" },
    })

    expect(next).toBe(state)
    expect(next.pendingQuestions.ses_1).toEqual(question)
  })
})

describe("sync event buffer", () => {
  test("releases buffered events in arrival order after completion", async () => {
    const seen: number[] = []
    const events = createEventBuffer<number>((event) => seen.push(event))

    await events.during(async () => {
      events.push(1)
      events.push(2)
      expect(seen).toEqual([])
    })

    expect(seen).toEqual([1, 2])
  })

  test("keeps only the newest events when the limit is reached", async () => {
    const seen: number[] = []
    const events = createEventBuffer<number>((event) => seen.push(event), 3)

    await events.during(async () => {
      events.push(1)
      events.push(2)
      events.push(3)
      events.push(4)
      events.push(5)
    })

    expect(seen).toEqual([3, 4, 5])
  })

  test("releases buffered events when the coordinated task fails", async () => {
    const seen: string[] = []
    const events = createEventBuffer<string>((event) => seen.push(event))

    await expect(events.during(async () => {
      events.push("live")
      throw new Error("snapshot failed")
    })).rejects.toThrow("snapshot failed")

    expect(seen).toEqual(["live"])
    events.push("after")
    expect(seen).toEqual(["live", "after"])
  })

  test("applies live events after a stale snapshot", async () => {
    const initial: SyncLiveState = { status: {}, pendingQuestions: {}, pendingPermissions: {} }
    let state = initial
    const events = createEventBuffer<{ type: string; properties?: unknown }>((event) => {
      state = reduceSyncLiveEvent(state, event)
    })

    await events.during(async () => {
      events.push({
        type: "session.status",
        properties: { sessionID: "ses_1", status: { type: "busy" } },
      })
      state = { ...state, status: { ses_1: { type: "idle" } } }
    })

    expect(state.status.ses_1).toEqual({ type: "busy" })
  })
})
