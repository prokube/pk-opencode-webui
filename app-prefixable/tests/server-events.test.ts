import { describe, expect, test } from "bun:test"
import type { ServerEvent } from "../src/context/server-events"
import { coalesceServerEvent, parseServerEvent } from "../src/context/server-events"

function delta(directory: string, value: string): ServerEvent {
  return {
    directory,
    payload: {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "message-1",
        partID: "part-1",
        field: "text",
        delta: value,
      },
    },
  }
}

describe("server events", () => {
  test("parses global event envelopes", () => {
    expect(parseServerEvent(JSON.stringify(delta("/one", "hello")))).toEqual(delta("/one", "hello"))
    expect(parseServerEvent(JSON.stringify({
      project: "project-1",
      workspace: "workspace-1",
      payload: { id: "event-1", type: "server.connected", properties: {} },
    }))).toEqual({
      directory: "global",
      payload: { id: "event-1", type: "server.connected", properties: {} },
    })
    expect(parseServerEvent(JSON.stringify({ directory: "/one" }))).toBeUndefined()
  })

  test("keeps legacy status events and drops sync bridge duplicates", () => {
    expect(parseServerEvent(JSON.stringify({
      directory: "/one",
      payload: {
        id: "event-1",
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "busy" } },
      },
    }))).toEqual({
      directory: "/one",
      payload: {
        id: "event-1",
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "busy" } },
      },
    })
    expect(parseServerEvent(JSON.stringify({
      directory: "/one",
      payload: { type: "sync", syncEvent: { type: "session.updated.1" } },
    }))).toBeUndefined()
  })

  test("coalesces adjacent deltas only within one directory", () => {
    expect(coalesceServerEvent(delta("/one", "hello"), delta("/one", " world"))).toEqual(delta("/one", "hello world"))
    expect(coalesceServerEvent(delta("/one", "hello"), delta("/two", " world"))).toBeUndefined()
  })
})
