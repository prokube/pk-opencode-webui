import { describe, expect, test } from "bun:test"
import {
  DEFAULT_BROWSER_NOTIFICATION_SETTINGS,
  initialBrowserNotificationSettings,
  legacyBrowserEnabled,
  parseLegacyNotificationMap,
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

  test("does not broaden legacy per-session opt-ins", () => {
    const legacy = parseLegacyNotificationMap('{"/workspace::ses_one":true,"ses_two":false}')
    expect(legacy).toEqual({ "/workspace::ses_one": true })
    expect(initialBrowserNotificationSettings(null, legacy)).toEqual({ agent: false, permissions: false, errors: false })
    expect(initialBrowserNotificationSettings(null, {}, false)).toEqual({ agent: false, permissions: false, errors: false })
    expect(initialBrowserNotificationSettings(null, {}, true, true)).toEqual({ agent: false, permissions: false, errors: false })
    expect(legacyBrowserEnabled('"invalid"')).toBe(false)
    expect(legacyBrowserEnabled('{"browser":"false"}')).toBe(false)
    expect(legacyBrowserEnabled('{"browser":true}')).toBe(true)
    expect(initialBrowserNotificationSettings(null, {})).toEqual(DEFAULT_BROWSER_NOTIFICATION_SETTINGS)
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
