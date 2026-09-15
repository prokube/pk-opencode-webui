import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "../src/sdk/client";
import { createRootSession } from "../src/utils/root-session";

function deferred<T>() {
  const state = {} as {
    promise: Promise<T>;
    resolve: (value: T) => void;
  };
  state.promise = new Promise((resolve) => {
    state.resolve = resolve;
  });
  return state;
}

describe("createRootSession", () => {
  test("keeps concurrent creation intents independent", async () => {
    const requests: ReturnType<typeof deferred<{ data: { id: string } }>>[] = [];
    const client = {
      session: {
        create: () => {
          const request = deferred<{ data: { id: string } }>();
          requests.push(request);
          return request.promise;
        },
      },
    } as unknown as OpencodeClient;

    const first = createRootSession(client, {
      source: "test.first",
    });
    const joined = createRootSession(client, {
      source: "test.joined",
    });
    const other = createRootSession(client, {
      source: "test.other",
    });

    expect(requests).toHaveLength(3);
    requests[0].resolve({ data: { id: "ses_a" } });
    requests[1].resolve({ data: { id: "ses_joined" } });
    requests[2].resolve({ data: { id: "ses_b" } });

    expect(await first).toEqual({ data: { id: "ses_a" }, isLeader: true });
    expect(await joined).toEqual({ data: { id: "ses_joined" }, isLeader: true });
    expect(await other).toEqual({ data: { id: "ses_b" }, isLeader: true });
  });
});
