export type SessionLoadResult = "found" | "not-found" | "error";

interface SessionGetResult<T> {
  data?: T;
  response?: { status: number };
}

export function sessionLoadResult(result: {
  data?: unknown;
  response?: { status: number };
}): SessionLoadResult {
  if (result.data) return "found";
  if (result.response?.status === 404) return "not-found";
  return "error";
}

export async function requestSession<T>(
  get: (
    params: { sessionID: string },
    options: { throwOnError: false },
  ) => Promise<SessionGetResult<T>>,
  sessionID: string,
) {
  try {
    const response = await get({ sessionID }, { throwOnError: false });
    return { result: sessionLoadResult(response), response } as const;
  } catch (error) {
    return { result: "error" as const, error };
  }
}

export function sessionNeighbor(ids: string[], id: string) {
  const index = ids.indexOf(id);
  if (index === -1) return;
  return ids[index + 1] ?? ids[index - 1];
}

export function sessionDraftKey(serverId: string, dir: string, id?: string) {
  return `${serverId}:${dir}:${id ?? "__new__"}`;
}

export function sessionRouteKey(serverId: string, directory: string, id?: string) {
  return `${serverId}\0${directory}\0${id ?? "__new__"}`;
}

export function archivedLastSession(stored: string | null, session: { id: string; time?: { archived?: number } }) {
  return stored === session.id && !!session.time?.archived;
}
