import { describe, expect, test } from "bun:test"
import { applyPartDelta, coalesceSyncEvent, createLatestSuccessfulRequest, createSessionRequestTracker, mergeMessageUpdate, mergePartUpdate, mergeSessionMessages, reduceSyncLiveEvent, removeMessageByID, removePartByID, removeSyncSession, removeSyncSessionData, syncEventSize, updateProviderConnected, upsertSyncSession } from "../src/context/sync"
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

  test("session deletion clears all session-owned state", () => {
    const permission = {
      id: "per_1",
      sessionID: "ses_1",
      permission: "edit",
      patterns: [],
      metadata: {},
      always: [],
    } satisfies PermissionRequest
    const state = {
      session: [session("ses_1")],
      archivedSession: [],
      message: { ses_1: [message(user("msg_1"), [text("part_1", "msg_1")])] },
      part: { msg_1: [text("part_1", "msg_1")] },
      status: { ses_1: { type: "busy" } as const },
      pendingQuestions: { ses_1: { id: "que_1", sessionID: "ses_1", questions: [] } },
      pendingPermissions: { per_1: permission },
    }

    expect(removeSyncSessionData(state, "ses_1")).toEqual({
      session: [],
      archivedSession: [],
      message: {},
      part: {},
      status: {},
      pendingQuestions: {},
      pendingPermissions: {},
    })
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

  test("message.removed removes the message and its independently stored parts", () => {
    const messages = [message(user("msg_1"), [text("part_1", "msg_1")]), message(user("msg_2"), [])]
    const parts = { msg_1: messages[0].parts, msg_2: [] as Part[] }

    const next = removeMessageByID(messages, "msg_1")
    delete parts.msg_1

    expect(next.map((item) => item.info.id)).toEqual(["msg_2"])
    expect(parts).toEqual({ msg_2: [] })
  })

  test("message.part.removed removes the part from message and part stores", () => {
    const first = text("part_1", "msg_1")
    const second = text("part_2", "msg_1")

    expect(removePartByID([first, second], "part_1")).toEqual([second])
    expect({ ...message(user("msg_1"), [first, second]), parts: removePartByID([first, second], "part_1") }.parts)
      .toEqual([second])
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

  test("session sync tombstones prevent REST from restoring SSE removals", () => {
    const tracker = createSessionRequestTracker()
    const request = tracker.begin("ses_1")
    tracker.removeMessage("ses_1", "msg_removed")
    tracker.removePart("ses_1", "msg_1", "part_removed")

    const filtered = tracker.filter(request, [
      message(user("msg_1"), [text("part_1", "msg_1"), text("part_removed", "msg_1")]),
      message(user("msg_removed"), [text("part_2", "msg_removed")]),
    ])

    expect(filtered.map((item) => item.info.id)).toEqual(["msg_1"])
    expect(filtered[0].parts.map((part) => part.id)).toEqual(["part_1"])
    tracker.end(request)

    const next = tracker.begin("ses_1")
    expect(tracker.filter(next, [message(user("msg_removed"), [])])).toHaveLength(0)
    tracker.end(next)
  })

  test("event-only part removals persist until a newer part update", () => {
    const tracker = createSessionRequestTracker()
    tracker.removePart("ses_1", "msg_1", "part_removed")

    const first = tracker.begin("ses_1")
    expect(tracker.filter(first, [message(user("msg_1"), [text("part_removed", "msg_1")])])[0].parts).toEqual([])
    tracker.end(first)

    tracker.updatePart("ses_1", "msg_1", "part_removed")
    const second = tracker.begin("ses_1")
    expect(tracker.filter(second, [message(user("msg_1"), [text("part_removed", "msg_1")])])[0].parts)
      .toHaveLength(1)
    tracker.end(second)
  })

  test("collapsed tombstones survive snapshots without resurrection", () => {
    const tracker = createSessionRequestTracker(1)
    tracker.removeMessage("ses_1", "msg_1")
    expect(tracker.removeMessage("ses_1", "msg_2")).toBe(true)
    expect(tracker.removeMessage("ses_1", "msg_3")).toBe(false)
    expect(tracker.needsSnapshot("ses_1")).toBe(true)

    const request = tracker.begin("ses_1")
    const stale = [message(user("msg_1"), []), message(user("msg_2"), []), message(user("msg_3"), [])]
    expect(tracker.snapshot(request, [], stale)).toEqual([])
    tracker.appliedSnapshot("ses_1")
    tracker.end(request)

    const next = tracker.begin("ses_1")
    expect(tracker.filter(next, stale)).toEqual([])
    expect(tracker.needsSnapshot("ses_1")).toBe(false)
  })

  test("authoritative snapshot preserves in-flight SSE updates and applies atomically after success", async () => {
    const tracker = createSessionRequestTracker()
    const cached = [message(user("msg_old"), [text("part_old", "msg_old", "history")])]
    const failed = tracker.begin("ses_1")
    const state = [...cached]

    await expect(Promise.reject(new Error("snapshot failed"))).rejects.toThrow("snapshot failed")
    tracker.end(failed)
    expect(state).toEqual(cached)

    const request = tracker.begin("ses_1")
    const live = message(user("msg_live"), [text("part_live", "msg_live", "live")])
    state.push(live)
    tracker.updateMessage("ses_1", "msg_live")
    const snapshot = await Promise.resolve([message(user("msg_server"), [])])
    const next = tracker.snapshot(request, state, snapshot)
    state.splice(0, state.length, ...next)
    tracker.appliedSnapshot("ses_1")
    tracker.end(request)

    expect(state.map((item) => item.info.id)).toEqual(["msg_live", "msg_server"])
    expect(state.find((item) => item.info.id === "msg_live")?.parts[0]).toMatchObject({ text: "live" })
  })

  test("authoritative snapshot preserves a part first seen while the request is active", () => {
    const tracker = createSessionRequestTracker()
    const request = tracker.begin("ses_1")
    const live = text("part_live", "msg_1", "live")
    const cached = [message(user("msg_1"), [live])]
    tracker.updatePart("ses_1", "msg_1", live.id)

    const snapshot = tracker.snapshot(request, cached, [message(user("msg_1"), [])])

    expect(snapshot[0].parts).toEqual([live])
    tracker.end(request)
  })

  test("in-flight deltas are preserved without lifting a removal tombstone", () => {
    const tracker = createSessionRequestTracker()
    tracker.removePart("ses_1", "msg_1", "part_1")
    const request = tracker.begin("ses_1")
    tracker.touchPart("ses_1", "msg_1", "part_1")

    const filtered = tracker.snapshot(
      request,
      [message(user("msg_1"), [text("part_1", "msg_1", "live")])],
      [message(user("msg_1"), [text("part_1", "msg_1", "stale")])],
    )

    expect(filtered[0].parts).toEqual([])
    tracker.end(request)
  })

  test("failed newer provider refresh does not suppress an older successful request", async () => {
    const requests = createLatestSuccessfulRequest()
    const older = requests.begin()
    const newer = requests.begin()
    let provider = "bootstrap"

    await Promise.reject(new Error("new refresh failed")).catch(() => undefined)
    expect(requests.apply(older, () => { provider = "older success" })).toBe(true)
    const newest = requests.begin()
    expect(requests.apply(newest, () => { provider = "newer success" })).toBe(true)
    expect(requests.apply(newer, () => { provider = "failed request" })).toBe(false)
    expect(requests.apply(older, () => { provider = "stale" })).toBe(false)
    expect(provider).toBe("newer success")
  })

  test("session.updated and a newer sync invalidate late REST responses", () => {
    const tracker = createSessionRequestTracker()
    const stale = tracker.begin("ses_1")
    tracker.invalidate("ses_1")
    expect(tracker.valid(stale)).toBe(false)

    const older = tracker.begin("ses_1")
    const newer = tracker.begin("ses_1")
    expect(tracker.valid(older)).toBe(false)
    expect(tracker.valid(newer)).toBe(true)
  })

  test("late REST data cannot overwrite state from a newer SSE generation", async () => {
    const tracker = createSessionRequestTracker()
    const request = tracker.begin("ses_1")
    const rest = Promise.resolve(session("ses_1")).then((value) => tracker.valid(request) ? value : undefined)

    tracker.invalidate("ses_1")
    const current = { ...session("ses_1"), title: "from SSE" }

    expect(await rest).toBeUndefined()
    expect(current.title).toBe("from SSE")
  })

  test("session deletion prevents late REST from restoring the session", () => {
    const tracker = createSessionRequestTracker()
    const request = tracker.begin("ses_1")
    tracker.invalidate("ses_1")

    expect(tracker.valid(request)).toBe(false)
  })

  test("preserves removals that arrive during an unknown authoritative snapshot", () => {
    const tracker = createSessionRequestTracker(1)
    tracker.requireSnapshot("ses_1")
    const request = tracker.begin("ses_1")
    tracker.removePart("ses_1", "msg_1", "part_1")
    tracker.removeMessage("ses_1", "msg_2")

    const snapshot = tracker.snapshot(request, [], [
      message(user("msg_1"), [text("part_1", "msg_1", "stale"), text("part_2", "msg_1", "current")]),
      message(user("msg_2"), [text("part_3", "msg_2", "stale")]),
    ])

    expect(snapshot).toEqual([message(user("msg_1"), [text("part_2", "msg_1", "current")])])
  })

  test("allows newer updates to recreate removals during a snapshot", () => {
    const tracker = createSessionRequestTracker()
    const request = tracker.begin("ses_1")
    tracker.removeMessage("ses_1", "msg_1")
    tracker.removePart("ses_1", "msg_2", "part_2")
    tracker.updateMessage("ses_1", "msg_1")
    tracker.updatePart("ses_1", "msg_2", "part_2")

    const snapshot = tracker.snapshot(request, [
      message(user("msg_1"), [text("part_1", "msg_1", "live")]),
      message(user("msg_2"), [text("part_2", "msg_2", "live")]),
    ], [
      message(user("msg_1"), [text("part_1", "msg_1", "stale")]),
      message(user("msg_2"), [text("part_2", "msg_2", "stale")]),
    ])

    expect(snapshot[0].parts[0]).toEqual(text("part_1", "msg_1", "live"))
    expect(snapshot[1].parts[0]).toEqual(text("part_2", "msg_2", "live"))
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
    expect(pending.pendingQuestions.ses_1).toEqual([question])
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
      pendingQuestions: { ses_1: [question] },
      pendingPermissions: {},
    }

    const next = reduceSyncLiveEvent(state, {
      type: "question.rejected",
      properties: { sessionID: "ses_1", requestID: "que_old" },
    })

    expect(next).toBe(state)
    expect(next.pendingQuestions.ses_1).toEqual([question])
  })

  test("retains multiple pending questions and removes only the replied request", () => {
    const first = { id: "que_1", sessionID: "ses_1", questions: [] } satisfies QuestionRequest
    const second = { id: "que_2", sessionID: "ses_1", questions: [] } satisfies QuestionRequest
    const initial: SyncLiveState = { status: {}, pendingQuestions: {}, pendingPermissions: {} }
    const asked = reduceSyncLiveEvent(
      reduceSyncLiveEvent(initial, { type: "question.asked", properties: first }),
      { type: "question.asked", properties: second },
    )
    const replied = reduceSyncLiveEvent(asked, {
      type: "question.replied",
      properties: { sessionID: "ses_1", requestID: first.id },
    })

    expect(asked.pendingQuestions.ses_1).toEqual([first, second])
    expect(replied.pendingQuestions.ses_1).toEqual([second])
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

  test("marks overflow without silently dropping queued events", async () => {
    const seen: number[] = []
    const dropped: number[] = []
    const released: boolean[] = []
    const events = createEventBuffer<number>((event) => seen.push(event), {
      limit: 3,
      overflow: (event) => dropped.push(event),
      released: (overflowed) => released.push(overflowed),
    })

    await events.during(async () => {
      events.push(1)
      events.push(2)
      events.push(3)
      events.push(4)
      events.push(5)
    })

    expect(seen).toEqual([1, 2, 3])
    expect(dropped).toEqual([4, 5])
    expect(released).toEqual([true])
  })

  test("reports affected sessions for targeted resync after release", async () => {
    const affected = new Set<string>()
    const resynced: string[][] = []
    const events = createEventBuffer<{ sessionID: string; value: number }>(() => undefined, {
      limit: 1,
      overflow: (event) => affected.add(event.sessionID),
      released: (overflowed) => {
        if (overflowed) resynced.push([...affected])
      },
    })

    await events.during(async () => {
      events.push({ sessionID: "ses_1", value: 1 })
      events.push({ sessionID: "ses_2", value: 2 })
      expect(resynced).toEqual([])
    })

    expect(resynced).toEqual([["ses_2"]])
  })

  test("coalesces only consecutive deltas with the same identity and field", async () => {
    const seen: Array<{ type: string; properties: { delta: string; partID: string } }> = []
    const delta = (partID: string, value: string) => ({
      type: "message.part.delta" as const,
      properties: { sessionID: "ses_1", messageID: "msg_1", partID, field: "text", delta: value },
    })
    const events = createEventBuffer((event: ReturnType<typeof delta>) => seen.push(event), {
      limit: 2,
      coalesce: coalesceSyncEvent,
    })

    await events.during(async () => {
      events.push(delta("part_1", "hel"))
      events.push(delta("part_1", "lo"))
      events.push(delta("part_2", "!"))
    })

    expect(seen.map((event) => [event.properties.partID, event.properties.delta])).toEqual([
      ["part_1", "hello"],
      ["part_2", "!"],
    ])
  })

  test("bounds coalesced deltas by bytes and reports overflow", async () => {
    const seen: string[] = []
    const dropped: string[] = []
    const delta = (value: string) => ({
      type: "message.part.delta" as const,
      properties: { sessionID: "ses_1", messageID: "msg_1", partID: "part_1", field: "text", delta: value },
    })
    const events = createEventBuffer((event: ReturnType<typeof delta>) => seen.push(event.properties.delta), {
      byteLimit: 5,
      size: (event) => new TextEncoder().encode(event.properties.delta).byteLength,
      coalesce: coalesceSyncEvent,
      overflow: (event) => dropped.push(event.properties.delta),
    })

    await events.during(async () => {
      events.push(delta("hello"))
      events.push(delta("!"))
    })

    expect(seen).toEqual(["hello"])
    expect(dropped).toEqual(["!"])
  })

  test("accounts for payload bytes in non-delta events", () => {
    const event = {
      type: "message.part.updated" as const,
      properties: { part: { ...text("part_1", "msg_1"), text: "x".repeat(1024) } },
    }
    expect(syncEventSize(event)).toBeGreaterThan(1024)
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

  test("drops buffered events after disposal", async () => {
    const seen: string[] = []
    const release = Promise.withResolvers<void>()
    const events = createEventBuffer<string>((event) => seen.push(event))
    const task = events.during(async () => {
      events.push("stale")
      await release.promise
    })

    events.dispose()
    release.resolve()
    await task
    events.push("after")

    expect(seen).toEqual([])
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
