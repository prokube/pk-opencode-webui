export function advanceDraftVersion(versions: Map<string, number>, key: string) {
  const version = (versions.get(key) ?? 0) + 1
  versions.delete(key)
  versions.set(key, version)
  return version
}

export function trimDraftVersions(versions: Map<string, number>, limit: number) {
  const removed: string[] = []
  while (versions.size > limit) {
    const key = versions.keys().next().value
    if (key === undefined) break
    versions.delete(key)
    removed.push(key)
  }
  return removed
}

export function draftVersionIsCurrent(versions: Map<string, number>, key: string, version: number) {
  return (versions.get(key) ?? 0) === version
}
