/**
 * Sound notification utilities.
 *
 * Sounds are generated programmatically via the Web Audio API so no external
 * audio files are needed. Each sound option exposes a `play` function that
 * synthesises a short tone on demand.
 */

import { dispatchStorageEvent } from "./storage"

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

export const SOUND_STORAGE_KEY = "opencode.soundSettings"

export interface SoundSettings {
  enabled: boolean
  /** ID of the selected sound from SOUND_OPTIONS */
  sound: string
}

const DEFAULTS: SoundSettings = { enabled: false, sound: "chime" }

export function readSoundSettings(): SoundSettings {
  if (typeof window === "undefined") return { ...DEFAULTS }
  try {
    const raw = window.localStorage.getItem(SOUND_STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return { ...DEFAULTS }
    const settings = parsed as Partial<SoundSettings>
    return {
      enabled: typeof settings.enabled === "boolean" ? settings.enabled : DEFAULTS.enabled,
      sound: typeof settings.sound === "string" ? settings.sound : DEFAULTS.sound,
    }
  } catch {
    try { window.localStorage.removeItem(SOUND_STORAGE_KEY) } catch { /* ignore */ }
    return { ...DEFAULTS }
  }
}

export function writeSoundSettings(settings: SoundSettings) {
  if (typeof window === "undefined") return
  const value = JSON.stringify(settings)
  try {
    window.localStorage.setItem(SOUND_STORAGE_KEY, value)
  } catch {
    return
  }
  dispatchStorageEvent(SOUND_STORAGE_KEY, value)
}

// ---------------------------------------------------------------------------
// Web Audio API tone generators
// ---------------------------------------------------------------------------

function getAudioContext(): AudioContext | undefined {
  if (typeof window === "undefined") return undefined
  // Reuse a single context across calls — browser limits the number of contexts
  const win = window as unknown as { __ocAudioCtx?: AudioContext }
  if (!win.__ocAudioCtx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return undefined
    win.__ocAudioCtx = new Ctor()
  }
  return win.__ocAudioCtx
}

/** Play a sequence of tones described by [frequency, startSec, durationSec] tuples. */
function playTones(tones: [number, number, number][], gain = 0.25) {
  const ctx = getAudioContext()
  if (!ctx) return
  // Resume context if suspended (autoplay policy)
  if (ctx.state === "suspended") void ctx.resume().catch(() => {})

  const master = ctx.createGain()
  master.gain.value = gain
  master.connect(ctx.destination)

  let remaining = tones.length

  for (const [freq, start, dur] of tones) {
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = "sine"
    osc.frequency.value = freq
    env.gain.setValueAtTime(1, ctx.currentTime + start)
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur)
    osc.connect(env)
    env.connect(master)
    osc.start(ctx.currentTime + start)
    osc.stop(ctx.currentTime + start + dur + 0.05)
    osc.onended = () => {
      osc.disconnect()
      env.disconnect()
      remaining--
      if (remaining === 0) master.disconnect()
    }
  }
}

// ---------------------------------------------------------------------------
// Sound definitions
// ---------------------------------------------------------------------------

export interface SoundOption {
  id: string
  label: string
  play: () => void
}

export const SOUND_OPTIONS: SoundOption[] = [
  {
    id: "chime",
    label: "Chime",
    play: () => playTones([[587.33, 0, 0.15], [880, 0.12, 0.25]], 0.2),
  },
  {
    id: "ping",
    label: "Ping",
    play: () => playTones([[1200, 0, 0.1]], 0.3),
  },
  {
    id: "duo",
    label: "Duo",
    play: () => playTones([[523.25, 0, 0.12], [659.25, 0.1, 0.12]], 0.2),
  },
  {
    id: "alert",
    label: "Alert",
    play: () => playTones([[440, 0, 0.08], [440, 0.12, 0.08], [440, 0.24, 0.08]], 0.25),
  },
  {
    id: "gentle",
    label: "Gentle",
    play: () => playTones([[392, 0, 0.2], [523.25, 0.15, 0.3]], 0.15),
  },
]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Play the sound with the given option ID. No-op if the ID is unknown. */
export function playSound(id: string) {
  const option = SOUND_OPTIONS.find((o) => o.id === id)
  if (option) option.play()
}
