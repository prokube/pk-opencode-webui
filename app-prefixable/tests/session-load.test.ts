import { describe, expect, test } from "bun:test";
import {
  archivedLastSession,
  requestSession,
  sessionDraftKey,
  sessionLoadResult,
  sessionNeighbor,
  sessionRouteKey,
} from "../src/utils/session-load";

describe("session load helpers", () => {
  test("classifies successful, missing, and transient responses", () => {
    expect(sessionLoadResult({ data: { id: "ses_1" }, response: { status: 200 } })).toBe("found");
    expect(sessionLoadResult({ response: { status: 404 } })).toBe("not-found");
    expect(sessionLoadResult({ response: { status: 503 } })).toBe("error");
    expect(sessionLoadResult({})).toBe("error");
  });

  test("uses a non-throwing request and only treats an HTTP 404 response as missing", async () => {
    const options: unknown[] = [];
    const missing = await requestSession(async (_params, requestOptions) => {
      options.push(requestOptions);
      if (requestOptions.throwOnError) throw new Error("HTTP 404");
      return { response: new Response(null, { status: 404 }) };
    }, "ses_missing");
    const unavailable = await requestSession(async () => ({
      response: new Response(null, { status: 503 }),
    }), "ses_unavailable");
    const network = await requestSession(async () => {
      throw new TypeError("fetch failed");
    }, "ses_network");

    expect(options).toEqual([{ throwOnError: false }]);
    expect(missing.result).toBe("not-found");
    expect(unavailable.result).toBe("error");
    expect(network.result).toBe("error");
    expect("error" in network && network.error).toBeInstanceOf(TypeError);
  });

  test("does not select a neighbor when the session is absent", () => {
    expect(sessionNeighbor(["ses_1", "ses_2"], "missing")).toBeUndefined();
    expect(sessionNeighbor(["ses_1", "ses_2", "ses_3"], "ses_2")).toBe("ses_3");
    expect(sessionNeighbor(["ses_1", "ses_2"], "ses_2")).toBe("ses_1");
  });

  test("scopes drafts by server, directory, and session", () => {
    expect(sessionDraftKey("server-a", "dir", "ses_1")).not.toBe(
      sessionDraftKey("server-b", "dir", "ses_1"),
    );
    expect(sessionDraftKey("server-a", "dir")).toBe("server-a:dir:__new__");
  });

  test("does not run a stale submit continuation after same-directory navigation", async () => {
    const started = sessionRouteKey("local", "/workspace", "ses_1");
    let route = started;
    let processing = false;
    const prompt = Promise.resolve().then(() => {
      if (route !== started) return;
      processing = true;
    });

    route = sessionRouteKey("local", "/workspace", "ses_2");
    await prompt;
    expect(processing).toBe(false);
  });

  test("invalidates a pending create after navigation within the same directory", () => {
    const started = sessionRouteKey("local", "/workspace");
    expect(started).not.toBe(sessionRouteKey("local", "/workspace", "ses_2"));
  });

  test("recognizes an archived stored last session", () => {
    expect(archivedLastSession("ses_1", { id: "ses_1", time: { archived: 1 } })).toBe(true);
    expect(archivedLastSession("ses_2", { id: "ses_1", time: { archived: 1 } })).toBe(false);
    expect(archivedLastSession("ses_1", { id: "ses_1", time: {} })).toBe(false);
  });
});
