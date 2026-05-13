import { describe, expect, test } from "bun:test"
import { browserOAuthUnsupported, extractProviderAuthCode, isLocalBrowserHost, providerOAuthMethodUnsupported } from "../src/utils/provider-auth"

describe("provider auth helpers", () => {
  test("extracts GitHub-style device codes", () => {
    expect(extractProviderAuthCode("Enter code: ABCD-EFGH")).toBe("ABCD-EFGH")
  })

  test("extracts OpenAI-style 9 character codes", () => {
    expect(extractProviderAuthCode("Enter this code when prompted: A1B2C3D4E")).toBe("A1B2C3D4E")
  })

  test("ignores authorization URLs while extracting codes", () => {
    expect(extractProviderAuthCode("Open https://example.com/device and enter code: 123456789")).toBe("123456789")
  })

  test("detects local browser hosts", () => {
    expect(isLocalBrowserHost("localhost")).toBe(true)
    expect(isLocalBrowserHost("127.0.0.1")).toBe(true)
    expect(isLocalBrowserHost("0.0.0.0")).toBe(true)
    expect(isLocalBrowserHost("notebook.example.com")).toBe(false)
  })

  test("blocks remote browser OAuth that redirects to loopback", () => {
    const authUrl = "https://auth.openai.com/oauth?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback"
    expect(browserOAuthUnsupported({ authUrl, method: "auto", browserHostname: "notebook.example.com" })).toBe(true)
  })

  test("allows local browser OAuth with loopback redirects", () => {
    const authUrl = "https://auth.openai.com/oauth?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback"
    expect(browserOAuthUnsupported({ authUrl, method: "auto", browserHostname: "localhost" })).toBe(false)
  })

  test("allows code methods even on remote hosts", () => {
    const authUrl = "https://auth.openai.com/device"
    expect(browserOAuthUnsupported({ authUrl, method: "code", browserHostname: "notebook.example.com" })).toBe(false)
  })

  test("marks OpenAI browser methods unsupported on remote hosts", () => {
    expect(providerOAuthMethodUnsupported({ providerID: "openai", label: "Browser login", browserHostname: "notebook.example.com" })).toBe(true)
  })

  test("keeps OpenAI headless methods available on remote hosts", () => {
    expect(providerOAuthMethodUnsupported({ providerID: "openai", label: "Headless login", browserHostname: "notebook.example.com" })).toBe(false)
  })
})
