// Run explicitly with LIVE_NOTEBOOK_URL and LIVE_SANDBOX_URL. Authentication
// stays in an isolated temporary context; no cookies, traces or tokens are saved.
import { chromium, expect } from "@playwright/test"

const notebook = process.env.LIVE_NOTEBOOK_URL
const endpoint = process.env.LIVE_SANDBOX_URL?.replace(/\/$/, "")
if (!notebook || !endpoint) throw new Error("Set LIVE_NOTEBOOK_URL and LIVE_SANDBOX_URL")
if (new URL(notebook).origin !== new URL(endpoint).origin) throw new Error("Expected same-origin deployment")
const attached = process.env.LIVE_CDP
const browser = attached ? await chromium.connectOverCDP(attached) : await chromium.launch({ headless: false, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=19222"] })
const context = await browser.newContext()
if (attached) await context.addCookies(await browser.contexts()[0].cookies([notebook, endpoint]))
const page = await context.newPage()
page.setDefaultTimeout(30_000)
const traffic: string[] = []
const frames: string[] = []
const ptys: string[] = []
page.on("response", async response => {
  if (response.url().split("?")[0] === endpoint + "/pty" && response.request().method() === "POST" && response.ok()) {
    const body = await response.json()
    if (body.id) ptys.push(body.id)
  }
})
page.on("request", req => traffic.push(req.url()))
page.on("websocket", ws => {
  if (!ws.url().startsWith(endpoint.replace(/^http/, "ws"))) return
  ws.on("framereceived", frame => frames.push(String(frame.payload)))
})
try {
  await page.goto(new URL("settings/servers", notebook).href)
  await page.getByRole("button", { name: "Add server", exact: true }).waitFor({ timeout: attached ? 30_000 : 600_000 })
  console.log("PASS notebook UI loaded after real browser login")
  await page.getByRole("button", { name: "Add server", exact: true }).click()
  await page.getByLabel("Server URL", { exact: true }).fill(endpoint)
  await page.getByLabel("Name", { exact: true }).fill("Sandbox Browser-Session")
  await page.getByLabel("Authentication", { exact: true }).selectOption("session")
  const management = page.url()
  await page.getByRole("button", { name: "Save connection", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Manage servers", exact: true })).toBeVisible()
  expect(page.url()).toBe(management)
  const id = Buffer.from(endpoint).toString("base64url")
  await page.getByRole("button", { name: "Back to workspace", exact: true }).click()
  await page.getByRole("button", { name: "Select server", exact: true }).click()
  await page.getByRole("menuitem", { name: /Sandbox Browser-Session/ }).click()
  await expect(page).toHaveURL(url => url.searchParams.get("server") === id)
  await expect(page.getByText("Authentication required", { exact: false })).toHaveCount(0)
  console.log("PASS direct cookie-authenticated connection and bottom-left server selector")
  const result = await page.evaluate(async endpoint => {
    const health = await fetch(endpoint + "/global/health", { redirect: "error" })
    const path = await fetch(endpoint + "/path", { redirect: "error" }).then(r => r.json())
    const response = await fetch(endpoint + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Browser-Session verification" }) })
    if (!response.ok) throw new Error("Session creation failed: " + response.status)
    return { health: health.status, directory: path.directory, session: (await response.json()).id }
  }, endpoint)
  if (result.health !== 200 || !result.directory || !result.session) throw new Error("Invalid live response")
  try {
    const dir = Buffer.from(result.directory).toString("base64url")
    await page.goto(new URL(`${dir}/session/${result.session}?server=${id}`, notebook).href)
    await expect(page.getByRole("heading", { name: "Browser-Session verification", exact: true })).toBeVisible()
    await expect.poll(() => traffic.some(url => url.startsWith(endpoint + "/global/event"))).toBe(true)
    await page.evaluate(async ({ endpoint, session }) => {
      const response = await fetch(endpoint + "/session/" + session, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Browser-Session SSE verified" }) })
      if (!response.ok) throw new Error("Session update failed")
    }, { endpoint, session: result.session })
    await expect(page.getByRole("heading", { name: "Browser-Session SSE verified", exact: true })).toBeVisible()
    console.log("PASS real SSE updates the notebook WebUI")
    await page.getByRole("button", { name: "Toggle Terminal", exact: true }).click()
    await expect.poll(() => frames.join(""), { timeout: 30_000 }).not.toBe("")
    await page.locator(".xterm-helper-textarea").last().focus()
    await page.keyboard.type("printf '%s%s\\n' BROWSER_SESSION_ PTY_OK")
    await page.keyboard.press("Enter")
    await expect.poll(() => frames.join("")).toContain("BROWSER_SESSION_PTY_OK")
    console.log("PASS real terminal websocket with browser session")
    if (traffic.some(url => url.includes("/api/remote/") || url.includes("connect-ticket"))) throw new Error("Unexpected relay or ticket")
    console.log("PASS no remote relay, no connection ticket")
    await page.getByRole("button", { name: "Toggle Terminal", exact: true }).click()
  } finally {
    await page.evaluate(async ({ endpoint, session, ptys }) => {
      for (const id of ptys) await fetch(endpoint + "/pty/" + id, { method: "DELETE" })
      await fetch(endpoint + "/session/" + session, { method: "DELETE" })
    }, { endpoint, session: result.session, ptys })
  }
  console.log("LIVE_BROWSER_SESSION_PASS")
} finally {
  await context.close()
  if (!attached) await browser.close()
}
if (attached) process.exit(0)
