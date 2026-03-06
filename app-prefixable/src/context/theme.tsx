import {
  createContext,
  createEffect,
  createSignal,
  useContext,
  onCleanup,
  type ParentProps,
} from "solid-js"

type ThemePreference = "light" | "dark" | "system"

const STORAGE_KEY = "opencode.theme"

function loadPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === "light" || stored === "dark" || stored === "system") return stored
  } catch {
    // localStorage may be unavailable (e.g. privacy mode)
  }
  return "system"
}

function resolve(pref: ThemePreference, systemDark: boolean) {
  if (pref === "system") return systemDark ? "dark" : "light"
  return pref
}

interface ThemeContextValue {
  theme: () => ThemePreference
  setTheme: (v: ThemePreference) => void
  resolved: () => "light" | "dark"
}

const ThemeContext = createContext<ThemeContextValue>()

export function ThemeProvider(props: ParentProps) {
  const [theme, setThemeRaw] = createSignal<ThemePreference>(loadPreference())

  const query = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : undefined

  const [systemDark, setSystemDark] = createSignal(query?.matches ?? false)

  if (query) {
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    if ("addEventListener" in query) {
      query.addEventListener("change", handler)
      onCleanup(() => query.removeEventListener("change", handler))
    } else if ("addListener" in query) {
      query.addListener(handler)
      onCleanup(() => query.removeListener(handler))
    }
  }

  const setTheme = (v: ThemePreference) => {
    setThemeRaw(v)
    try {
      localStorage.setItem(STORAGE_KEY, v)
    } catch {
      // Ignore persistence errors (e.g. storage disabled or quota exceeded)
    }
  }

  const resolved = () => resolve(theme(), systemDark())

  createEffect(() => {
    if (typeof document === "undefined") return
    const dark = resolved() === "dark"
    document.documentElement.classList.toggle("dark", dark)
  })

  const value: ThemeContextValue = { theme, setTheme, resolved }

  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider")
  return ctx
}
