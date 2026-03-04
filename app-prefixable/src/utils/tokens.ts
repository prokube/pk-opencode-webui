/** Compute context token count: input + cached (read + write) */
export function getContextTokens(tokens: { input?: number; cache?: { read?: number; write?: number } } | undefined) {
  return (tokens?.input || 0) + (tokens?.cache?.read || 0) + (tokens?.cache?.write || 0)
}
