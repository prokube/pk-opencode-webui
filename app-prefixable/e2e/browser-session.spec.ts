import { test, expect } from "@playwright/test"

test("provider credentials use the selected browser-session endpoint without leaking its cookie to a relayed server", async ({ page, context, request, baseURL }) => {
  const origin = new URL(baseURL!).origin
  const endpoint = `${origin}/browser-server`
  const id = Buffer.from(endpoint).toString("base64url")
  const beta = Buffer.from("http://127.0.0.1:18043").toString("base64url")
  for (const port of [18041, 18042, 18043]) await request.post(`http://127.0.0.1:${port}/test/reset`)
  await request.post(`${origin}/test/session/reset`)
  await context.addCookies([{ name: "browser-session", value: "valid", url: origin, httpOnly: true, sameSite: "Strict" }])
  await page.addInitScript(({ endpoint, id, beta }) => {
    localStorage.setItem("opencode.connections.v1", JSON.stringify([
      { id, url: endpoint, name: "Cookie server", auth: "session" },
      { id: beta, url: "http://127.0.0.1:18043", name: "Beta", auth: "basic", username: "opencode" },
    ]))
    sessionStorage.setItem("opencode.connectionCredentials.v1", JSON.stringify({ [beta]: "beta-secret" }))
  }, { endpoint, id, beta })
  await page.goto(`./settings?server=${id}`)
  await page.getByRole("button", { name: "Reconfigure Alpha Provider", exact: true }).click()
  await page.getByPlaceholder("Enter your API key...").fill("fixture-key")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByText("Connected to mock!", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Select server", exact: true }).click()
  await page.getByRole("menuitem", { name: /Beta/ }).click()
  await page.getByTitle("Settings", { exact: true }).click()
  await page.getByRole("button", { name: "Reconfigure Beta Provider", exact: true }).click()
  await page.getByPlaceholder("Enter your API key...").fill("fixture-beta-key")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByText("Connected to mock!", { exact: true })).toBeVisible()
  const alphaRequests = await (await request.get("http://127.0.0.1:18042/test/requests")).json()
  const betaRequests = await (await request.get("http://127.0.0.1:18043/test/requests")).json()
  expect(alphaRequests.some((r: { path: string; cookie: boolean }) => r.path === "/auth/mock" && r.cookie)).toBe(true)
  expect(betaRequests.some((r: { path: string }) => r.path === "/auth/mock")).toBe(true)
  expect(betaRequests.every((r: { cookie: boolean }) => !r.cookie)).toBe(true)
  expect(await (await request.get("http://127.0.0.1:18041/test/writes")).json()).toEqual([])
})

test("Browser-Session directly connects HTTP, SSE and PTY without a key or relay ticket", async ({ page, context, request, baseURL }) => {
  const origin = new URL(baseURL!).origin
  await request.post("http://127.0.0.1:18042/test/reset")
  await request.post(`${origin}/test/session/reset`)
  await context.addCookies([{ name: "browser-session", value: "valid", url: origin, httpOnly: true, sameSite: "Strict" }])
  const requests: string[] = []
  const sockets: string[] = []
  const frames: string[] = []
  page.on("request", req => requests.push(req.url()))
  page.on("websocket", ws => {
    sockets.push(ws.url())
    ws.on("framereceived", frame => frames.push(String(frame.payload)))
  })
  await page.goto("./settings/servers")
  await page.getByRole("button", { name: "Add server" }).click()
  await page.getByLabel("Server URL", { exact: true }).fill(`${origin}/browser-server`)
  await page.getByLabel("Name", { exact: true }).fill("Cookie server")
  await page.getByLabel("Authentication", { exact: true }).selectOption("session")
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0)
  await expect(page.getByLabel("Bearer token", { exact: true })).toHaveCount(0)
  const management = page.url()
  await page.getByRole("button", { name: "Save connection", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Manage servers", exact: true })).toBeVisible()
  expect(page.url()).toBe(management)
  const id = Buffer.from(`${origin}/browser-server`).toString("base64url")
   await page.getByRole("button", { name: "Back to workspace", exact: true }).click()
   await page.getByRole("button", { name: "Select server", exact: true }).click()
   await page.getByRole("menuitem", { name: /Cookie server/ }).click()
   await page.goto(`./L3dvcmtzcGFjZQ/session/ses_shared?server=${id}`)
  await expect(page).toHaveURL(url => url.searchParams.get("server") === id)
  await expect(page.getByRole("heading", { name: "Alpha session", exact: true })).toBeVisible()
  await expect.poll(() => requests.some(url => url.includes("/browser-server/global/event"))).toBe(true)
   const creating = page.waitForResponse(response => response.url().includes("/browser-server/pty") && response.request().method() === "POST")
   await page.getByRole("button", { name: "Toggle Terminal", exact: true }).click()
   const created = await creating
   expect(created.ok(), `PTY creation HTTP ${created.status()}: ${await created.text()}`).toBe(true)
  await expect.poll(() => frames.join("")).toContain("Browser session terminal")
  expect(sockets.some(url => url.includes("/browser-server/pty/pty_test/connect"))).toBe(true)
  expect(requests.some(url => url.includes("/api/remote/") || url.includes("connect-ticket"))).toBe(false)
  expect(sockets.some(url => url.includes("ticket="))).toBe(false)
  expect(await page.evaluate(() => sessionStorage.getItem("opencode.connectionCredentials.v1"))).toBe("{}")
  await page.reload()
  await expect(page.getByRole("heading", { name: "Alpha session", exact: true })).toBeVisible()
  await request.post(`${origin}/test/session/expire`)
  await page.reload()
  await expect(page.getByRole("alert")).toContainText("Browser-Session expired or access denied")
  await expect(page.getByRole("heading", { name: "Alpha session", exact: true })).toHaveCount(0)
})

test("Browser-Session rejects another origin before any request is sent", async ({ page }) => {
  const requests: string[] = []
  page.on("request", req => requests.push(req.url()))
  await page.goto("./settings/servers")
  await page.getByRole("button", { name: "Add server" }).click()
  await page.getByLabel("Server URL", { exact: true }).fill("https://unrelated.invalid/opencode")
  await page.getByLabel("Authentication", { exact: true }).selectOption("session")
  await page.getByRole("button", { name: "Save connection", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("same origin")
  expect(requests.some(url => url.includes("unrelated.invalid"))).toBe(false)
})

test("Browser-Session requires a valid cookie before saving", async ({ page, baseURL }) => {
  await page.goto("./settings/servers")
  await page.getByRole("button", { name: "Add server" }).click()
  await page.getByLabel("Server URL", { exact: true }).fill(`${new URL(baseURL!).origin}/browser-server`)
  await page.getByLabel("Authentication", { exact: true }).selectOption("session")
  await page.getByRole("button", { name: "Save connection", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("requires an active browser login")
  expect(await page.evaluate(() => localStorage.getItem("opencode.connections.v1"))).toBe("[]")
})
