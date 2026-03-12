// Relative time formatting: "just now", "3m ago", "1h ago", "2d ago"
// Accepts an optional `now` to allow a shared timer signal across components.
// Clamps negative deltas to 0 so slightly-ahead server timestamps show "just now".
export function formatRelativeTime(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// Absolute time in 24h format: "14:34:12"
export function formatAbsoluteTime(ms: number): string {
  const d = new Date(ms)
  const h = String(d.getHours()).padStart(2, "0")
  const m = String(d.getMinutes()).padStart(2, "0")
  const s = String(d.getSeconds()).padStart(2, "0")
  return `${h}:${m}:${s}`
}

// Duration formatting: "0.3s", "4.2s", "1m 12s"
// Rounds first, then carries overflow so values near 60s never produce "60.0s".
export function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000
  if (totalSeconds < 60) {
    const rounded = Math.round(totalSeconds * 10) / 10
    if (rounded >= 60) return "1m 0s"
    return `${rounded.toFixed(1)}s`
  }
  const total = Math.round(totalSeconds)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}m ${seconds}s`
}
