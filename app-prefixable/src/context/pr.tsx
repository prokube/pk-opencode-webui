/**
 * PR context — polls /api/ext/pr/info and exposes PR state to the UI.
 * Polling is adaptive: faster when a PR exists, slower when there's none.
 */

import { createContext, useContext, createSignal, onCleanup, type ParentProps } from "solid-js"
import { useBasePath } from "./base-path"
import { useSDK } from "./sdk"

export type PrState =
  | "OPEN"
  | "CLOSED"
  | "MERGED"

export type PrInfo = {
  number: number
  title: string
  state: PrState
  url: string
  headRefName: string
  baseRefName: string
  isDraft: boolean
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null
  unresolvedReviewThreadCount: number
}

export type VcsInfo = {
  branch: string | null
  dirty: number
  pr: PrInfo | null
}

type PrContextValue = {
  info: () => VcsInfo | null
  loading: () => boolean
  refresh: () => Promise<void>
}

const PrContext = createContext<PrContextValue>()

// Poll intervals in ms
const POLL_WITH_PR = 2 * 60 * 1000   // 2 min when PR exists
const POLL_NO_PR = 5 * 60 * 1000     // 5 min when no PR

export function PrProvider(props: ParentProps) {
  const { prefix } = useBasePath()
  const { directory } = useSDK()

  const [info, setInfo] = createSignal<VcsInfo | null>(null)
  const [loading, setLoading] = createSignal(false)

  let timer: ReturnType<typeof setTimeout> | null = null

  async function fetch_info() {
    setLoading(true)
    const dirParam = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    try {
      const res = await fetch(prefix(`/api/ext/pr/info${dirParam}`))
      if (res.ok) setInfo(await res.json() as VcsInfo)
    } catch (e) {
      console.error("[PR] fetch error:", e)
    } finally {
      setLoading(false)
    }
    scheduleNext()
  }

  function scheduleNext() {
    if (timer) clearTimeout(timer)
    const delay = info()?.pr ? POLL_WITH_PR : POLL_NO_PR
    timer = setTimeout(fetch_info, delay)
  }

  async function refresh() {
    if (timer) clearTimeout(timer)
    await fetch_info()
  }

  // Initial fetch
  fetch_info()

  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  return (
    <PrContext.Provider value={{ info, loading, refresh }}>
      {props.children}
    </PrContext.Provider>
  )
}

export function usePr() {
  const ctx = useContext(PrContext)
  if (!ctx) throw new Error("usePr must be used within PrProvider")
  return ctx
}
