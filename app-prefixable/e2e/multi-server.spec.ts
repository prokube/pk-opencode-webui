import { test, expect } from "@playwright/test"

test.beforeEach(async ({ request }) => {
  for (const port of [18041, 18042, 18043]) await request.post(`http://127.0.0.1:${port}/test/reset`)
})

test("missing and rejected credentials never fall back to the local server", async ({ page }) => {
  const beta = Buffer.from("http://127.0.0.1:18043").toString("base64url")
  await page.addInitScript(
    ({ id }) =>
      localStorage.setItem(
        "opencode.connections.v1",
        JSON.stringify([{ id, url: "http://127.0.0.1:18043", name: "Beta", auth: "basic", username: "opencode" }]),
      ),
    { id: beta },
  )
  await page.goto(`./L3dvcmtzcGFjZQ/session/ses_shared?server=${beta}`)
  await expect(page.getByRole("status")).toContainText("Authentication required")
  await expect(page.getByRole("heading", { name: "Local session" })).toHaveCount(0)
  await page.getByRole("button", { name: "Edit server connection" }).click()
  await page.getByRole("button", { name: "Edit Beta", exact: true }).click()
  await page.getByLabel("Password", { exact: true }).fill("wrong-password")
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("HTTP 401")
  expect(await page.evaluate(() => sessionStorage.getItem("opencode.connectionCredentials.v1"))).not.toContain(
    "wrong-password",
  )
  await page.getByLabel("Password", { exact: true }).fill("beta-secret")
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.goto(`./settings?server=${beta}#servers`)
  await expect(page.getByRole("heading", { name: "Servers", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: /^Instructions/ })).toBeDisabled()
  await page.getByRole("button", { name: "Remove Beta", exact: true }).click()
  await expect(page.getByText("This server connection is not configured in this browser.")).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem("opencode.connectionCredentials.v1"))).not.toContain(
    "beta-secret",
  )
  await page.getByRole("button", { name: "Manage servers" }).click()
  await page.getByRole("button", { name: /Local server.*Built-in connection/ }).click()
  await expect(page.getByRole("button", { name: "Select server" })).toHaveText("Local server")
})

test("sessions with identical IDs stay attached to their server across tabs and reload", async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = []
  const streams = async (port: number) => (await request.get(`http://127.0.0.1:${port}/test/streams`)).json()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("./")
  await page.getByRole("button", { name: "Select server" }).click()
  await page.getByRole("button", { name: "Add server" }).click()
  await page.getByLabel("Server URL", { exact: true }).fill("http://127.0.0.1:18042")
  await page.getByLabel("Name", { exact: true }).fill("Alpha")
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(page.getByRole("button", { name: "Select server" })).toHaveText("Alpha")
  await expect.poll(() => streams(18041)).toBe(0)
  await expect.poll(() => streams(18042)).toBe(1)
  const alpha = new URL(page.url()).searchParams.get("server")!
  await page.goto(`./L3dvcmtzcGFjZQ/session/ses_shared?server=${alpha}`)
  await expect(page.getByRole("navigation", { name: "Open sessions" })).toContainText("Alpha session")
  await page.getByRole("button", { name: "Select server" }).click()
  await page.getByRole("button", { name: "Add server" }).click()
  await page.getByLabel("Server URL", { exact: true }).fill("http://127.0.0.1:18043")
  await page.getByLabel("Name", { exact: true }).fill("Beta")
  await page.getByLabel("Authentication", { exact: true }).selectOption("basic")
  await page.getByLabel("Password", { exact: true }).fill("beta-secret")
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(page.getByRole("button", { name: "Select server" })).toHaveText("Beta")
  await expect.poll(() => streams(18042)).toBe(1)
  await expect.poll(() => streams(18043)).toBe(1)
  const beta = new URL(page.url()).searchParams.get("server")!
  await page.goto(`./L3dvcmtzcGFjZQ/session/ses_shared?server=${beta}`)
  const tabs = page.getByRole("navigation", { name: "Open sessions" })
  await expect(tabs).toContainText("Beta session")
  const received: string[] = []
  page.on("websocket", (socket) => socket.on("framereceived", (frame) => received.push(String(frame.payload))))
  await page.getByRole("button", { name: "Toggle Terminal", exact: true }).click()
  await expect.poll(() => received.join("")).toContain("Beta terminal")
  await page.getByRole("button", { name: "Toggle Terminal", exact: true }).click()
  await tabs.getByRole("button", { name: /^Alpha.*Alpha session$/ }).click()
  await expect(page.getByRole("button", { name: "Select server" })).toHaveText("Alpha")
  await expect(page.getByRole("heading", { name: "Alpha session", exact: true })).toBeVisible()
  await page.getByPlaceholder("Type a message... (Tab to switch agent, / for commands)").fill("Alpha draft only")
  await expect(tabs.getByRole("button", { name: /^Alpha.*Alpha session$/ })).toHaveAttribute("aria-current", "page")
  await tabs.getByRole("button", { name: /^Beta.*Beta session$/ }).click()
  await expect(page.getByRole("button", { name: "Select server" })).toHaveText("Beta")
  await expect(page.getByRole("heading", { name: "Beta session", exact: true })).toBeVisible()
  await expect(page.getByPlaceholder("Type a message... (Tab to switch agent, / for commands)")).toHaveValue("")
  await page.getByPlaceholder("Type a message... (Tab to switch agent, / for commands)").fill("Beta draft only")
  await tabs.getByRole("button", { name: /^Alpha.*Alpha session$/ }).click()
  await expect(page.getByPlaceholder("Type a message... (Tab to switch agent, / for commands)")).toHaveValue(
    "Alpha draft only",
  )
  await tabs.getByRole("button", { name: /^Beta.*Beta session$/ }).click()
  await expect(page.getByPlaceholder("Type a message... (Tab to switch agent, / for commands)")).toHaveValue(
    "Beta draft only",
  )
  await page.reload()
  await expect(tabs).toContainText("Alpha session")
  await expect(tabs).toContainText("Beta session")
  await request.post("http://127.0.0.1:18042/test/event", {
    data: { type: "session.status", properties: { sessionID: "ses_shared", status: { type: "busy" } } },
  })
  await expect(tabs.getByRole("button", { name: /^Alpha.*Alpha session$/ }).getByLabel("Running")).toBeVisible()
  await expect(tabs.getByRole("button", { name: /^Beta.*Beta session$/ }).getByLabel("Running")).toHaveCount(0)
  await request.post("http://127.0.0.1:18042/test/event", {
    data: { type: "session.idle", properties: { sessionID: "ses_shared" } },
  })
  await expect(tabs.getByRole("button", { name: /^Alpha.*Alpha session$/ }).getByLabel("Running")).toHaveCount(0)
  await page.getByRole("option", { name: /Select session Beta session/ }).hover()
  await page.getByRole("button", { name: "More session options", exact: true }).first().click()
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
  await page.getByRole("textbox", { name: "Session title", exact: true }).fill("Beta renamed")
  await page.getByRole("textbox", { name: "Session title", exact: true }).press("Enter")
  await expect(page.getByRole("heading", { name: "Beta renamed", exact: true })).toBeVisible()
  await expect
    .poll(async () => (await request.get("http://127.0.0.1:18043/test/writes")).json())
    .toContain("Beta renamed")
  expect(await (await request.get("http://127.0.0.1:18042/test/writes")).json()).not.toContain("Beta renamed")
  await page.getByRole("button", { name: "New session", exact: true }).click()
  await page.getByPlaceholder("Type a message... (Tab to switch agent, / for commands)").fill("Beta new draft")
  await tabs.getByRole("button", { name: /^Alpha.*Alpha session$/ }).click()
  await page.getByRole("button", { name: "New session", exact: true }).click()
  await page.getByPlaceholder("Type a message... (Tab to switch agent, / for commands)").fill("Alpha new draft")
  await tabs.getByRole("button", { name: /^Beta.*New session$/ }).click()
  await expect(page.getByPlaceholder("Type a message... (Tab to switch agent, / for commands)")).toHaveValue(
    "Beta new draft",
  )
  await page.getByPlaceholder("Type a message... (Tab to switch agent, / for commands)").press("Enter")
  await expect(page).toHaveURL(new RegExp(`/session/ses_beta_1\\?server=${beta}`))
  await expect(tabs.getByRole("button", { name: /^Beta.*Beta new session$/ })).toBeVisible()
  await expect(tabs.getByRole("button", { name: /^Beta.*New session$/ })).toHaveCount(0)
  await expect.poll(async () => (await request.get("http://127.0.0.1:18043/test/writes")).json()).toContain("prompt")
  expect(await (await request.get("http://127.0.0.1:18042/test/writes")).json()).not.toContain("create")
  await page.screenshot({ path: testInfo.outputPath("multi-server.png"), fullPage: true })
  await tabs.getByRole("button", { name: "Close Alpha session", exact: true }).click()
  await expect.poll(() => streams(18042)).toBe(1)
  await tabs.getByRole("button", { name: "Close New session", exact: true }).click()
  await expect.poll(() => streams(18042)).toBe(0)
  await expect.poll(() => streams(18043)).toBe(1)
  await tabs.getByRole("button", { name: "Close Beta new session", exact: true }).click()
  await tabs.getByRole("button", { name: "Close Beta renamed", exact: true }).click()
  await expect.poll(() => streams(18043)).toBe(1)
  expect(await page.evaluate(() => localStorage.getItem("opencode.connections.v1"))).not.toContain("beta-secret")
  expect(errors).toEqual([])
})
