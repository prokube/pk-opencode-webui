import { describe, test, expect } from "bun:test";
import { createSSEParser } from "./sse";

function collect(chunks: string[]): string[] {
  const results: string[] = [];
  const parser = createSSEParser((data) => results.push(data));
  for (const chunk of chunks) {
    parser.push(chunk);
  }
  return results;
}

describe("createSSEParser", () => {
  test("parses a single event", () => {
    expect(collect(["data: hello\n\n"])).toEqual(["hello"]);
  });

  test("normalizes CRLF line endings", () => {
    expect(collect(["data: hello\r\n\r\n"])).toEqual(["hello"]);
  });

  test("normalizes bare CR line endings", () => {
    expect(collect(["data: hello\r\r"])).toEqual(["hello"]);
  });

  test("concatenates multi-line data fields with newline", () => {
    expect(collect(["data: line1\ndata: line2\n\n"])).toEqual(["line1\nline2"]);
  });

  test("handles data: without space after colon", () => {
    expect(collect(["data:nospace\n\n"])).toEqual(["nospace"]);
  });

  test("parses multiple events in one chunk", () => {
    expect(collect(["data: a\n\ndata: b\n\n"])).toEqual(["a", "b"]);
  });

  test("handles events split across chunk boundaries", () => {
    expect(collect(["data: hel", "lo\n\n"])).toEqual(["hello"]);
  });

  test("handles event boundary split across chunks", () => {
    expect(collect(["data: a\n", "\ndata: b\n\n"])).toEqual(["a", "b"]);
  });

  test("ignores empty lines and comment lines", () => {
    expect(collect([": this is a comment\n\ndata: real\n\n"])).toEqual(["real"]);
  });

  test("ignores non-data fields (event, id, retry)", () => {
    expect(collect(["event: message\nid: 1\nretry: 5000\ndata: payload\n\n"])).toEqual(["payload"]);
  });

  test("skips blocks with no data lines", () => {
    expect(collect(["event: ping\n\ndata: actual\n\n"])).toEqual(["actual"]);
  });
});
