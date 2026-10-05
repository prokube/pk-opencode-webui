import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:18040/notebook/test/ui/",
    headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
  projects: [
    { name: "prefix", testMatch: "multi-server.spec.ts", use: { baseURL: "http://127.0.0.1:18040/notebook/test/ui/" } },
    { name: "root", testMatch: "multi-server.spec.ts", use: { baseURL: "http://127.0.0.1:18044/" } },
    { name: "session-prefix", testMatch: "browser-session.spec.ts", use: { baseURL: "http://127.0.0.1:18045/notebook/test/ui/" } },
    { name: "session-root", testMatch: "browser-session.spec.ts", use: { baseURL: "http://127.0.0.1:18046/" } },
  ],
  webServer: {
    command: "bun run build && bun run e2e/fixture.ts",
    url: "http://127.0.0.1:18040/notebook/test/ui/",
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
