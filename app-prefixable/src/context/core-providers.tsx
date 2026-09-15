import type { ParentProps } from "solid-js"
import { ConfigProvider } from "./config"
import { MCPProvider } from "./mcp"
import { ProviderProvider } from "./providers"
import { SDKProvider } from "./sdk"
import { SyncProvider } from "./sync"
import { SavedPromptsProvider } from "./saved-prompts"
import { BrowserNotificationEvents } from "./browser-notification-events"

export function CoreProviders(props: ParentProps & { directory?: string }) {
  return (
    <SDKProvider directory={props.directory}>
      <SyncProvider>
        <ConfigProvider>
          <ProviderProvider>
            <MCPProvider>
              <SavedPromptsProvider>
                <BrowserNotificationEvents />
                {props.children}
              </SavedPromptsProvider>
            </MCPProvider>
          </ProviderProvider>
        </ConfigProvider>
      </SyncProvider>
    </SDKProvider>
  )
}
