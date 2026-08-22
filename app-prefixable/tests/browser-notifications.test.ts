import { describe, expect, test } from "bun:test"
import {
  DEFAULT_BROWSER_NOTIFICATION_SETTINGS,
  parseBrowserNotificationSettings,
  shouldShowBrowserNotification,
} from "../src/utils/browser-notifications"

describe("browser notification settings", () => {
  test("uses defaults for absent or malformed storage", () => {
    expect(parseBrowserNotificationSettings(null)).toEqual(DEFAULT_BROWSER_NOTIFICATION_SETTINGS)
    expect(parseBrowserNotificationSettings("not-json")).toEqual(DEFAULT_BROWSER_NOTIFICATION_SETTINGS)
  })

  test("preserves valid preferences and fills missing fields", () => {
    expect(parseBrowserNotificationSettings('{"agent":false,"permissions":false}')).toEqual({
      agent: false,
      permissions: false,
      errors: false,
    })
  })
})

describe("browser notification visibility", () => {
  test("requires permission and an unfocused or hidden document", () => {
    expect(shouldShowBrowserNotification("granted", "hidden", false)).toBe(true)
    expect(shouldShowBrowserNotification("granted", "visible", false)).toBe(true)
    expect(shouldShowBrowserNotification("granted", "visible", true)).toBe(false)
    expect(shouldShowBrowserNotification("default", "hidden", false)).toBe(false)
    expect(shouldShowBrowserNotification("denied", "hidden", false)).toBe(false)
  })
})
