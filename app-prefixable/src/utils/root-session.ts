import type { OpencodeClient, SessionCreateResponse } from "../sdk/client";

type SessionCreateClient = Pick<OpencodeClient, "session">;

interface RootSessionTrace {
  source: string;
  state: "start" | "success" | "error";
  route: string;
  at: number;
  sessionID?: string;
  error?: string;
}

export interface RootSessionResult {
  data: SessionCreateResponse | undefined;
  isLeader: boolean;
}

export interface RootSessionScope {
  serverId: string;
  directory: string;
}

declare global {
  interface Window {
    __opencodeRootSessionTrace?: RootSessionTrace[];
  }
}

function routePath() {
  if (typeof window === "undefined") return "server";
  return window.location.pathname;
}

function trace(entry: RootSessionTrace) {
  if (typeof window === "undefined") return;
  const logs = window.__opencodeRootSessionTrace ?? [];
  logs.push(entry);
  window.__opencodeRootSessionTrace = logs.slice(-80);
  if (entry.state === "error") {
    console.warn("[SessionCreate]", entry);
  }
}

export function createRootSession(
  client: SessionCreateClient,
  opts: { source: string; scope: RootSessionScope },
): Promise<RootSessionResult> {
  trace({
    source: opts.source,
    state: "start",
    route: routePath(),
    at: Date.now(),
  });

  return client.session
    .create({})
    .then((res) => {
      if ("error" in res && res.error) throw res.error;
      trace({
        source: opts.source,
        state: "success",
        route: routePath(),
        at: Date.now(),
        sessionID: res.data?.id,
      });
      return res.data;
    })
    .catch((err: unknown) => {
      trace({
        source: opts.source,
        state: "error",
        route: routePath(),
        at: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    })
    .then((data) => ({ data, isLeader: true }));
}
