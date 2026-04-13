interface SessionCreateResponse {
  data?: ({ id: string } & Record<string, unknown>) | undefined;
}

interface SessionCreateClient {
  session: {
    create: (input: object) => Promise<SessionCreateResponse>;
  };
}

interface RootSessionTrace {
  source: string;
  state: "start" | "join" | "success" | "error";
  route: string;
  at: number;
  sessionID?: string;
  error?: string;
}

export interface RootSessionResult {
  data: SessionCreateResponse["data"];
  isLeader: boolean;
}

declare global {
  interface Window {
    __opencodeRootSessionTrace?: RootSessionTrace[];
  }
}

const inFlight = new Map<string, Promise<SessionCreateResponse["data"]>>();

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
  opts: { source: string; scope?: string },
): Promise<RootSessionResult> {
  const key = opts.scope ?? "default";
  const existing = inFlight.get(key);
  if (existing) {
    trace({
      source: opts.source,
      state: "join",
      route: routePath(),
      at: Date.now(),
    });
    return existing.then((data) => ({ data, isLeader: false }));
  }

  trace({
    source: opts.source,
    state: "start",
    route: routePath(),
    at: Date.now(),
  });

  const req = client.session
    .create({})
    .then((res) => {
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
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, req);
  return req.then((data) => ({ data, isLeader: true }));
}
