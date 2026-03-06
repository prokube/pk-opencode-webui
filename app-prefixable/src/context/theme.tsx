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

const query = window.matchMedia("(prefers-color-scheme: dark)")

function loadPreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === "light" || stored === "dark" || stored === "system") return stored
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
  const [systemDark, setSystemDark] = createSignal(query.matches)

  const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches)
  query.addEventListener("change", handler)
  onCleanup(() => query.removeEventListener("change", handler))

  const setTheme = (v: ThemePreference) => {
    setThemeRaw(v)
    localStorage.setItem(STORAGE_KEY, v)
  }

  const resolved = () => resolve(theme(), systemDark())

  createEffect(() => {
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
