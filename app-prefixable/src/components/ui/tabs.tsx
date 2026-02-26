import { Tabs as Kobalte } from "@kobalte/core/tabs"
import { Show, splitProps, type JSX, type ParentProps, type Component } from "solid-js"

type TabsRootProps = Parameters<typeof Kobalte>[0] & {
  variant?: "normal" | "alt" | "pill" | "settings"
}

type TabsListProps = Parameters<typeof Kobalte.List>[0]

type TabsTriggerProps = Parameters<typeof Kobalte.Trigger>[0] & {
  classes?: { button?: string }
  hideCloseButton?: boolean
  closeButton?: JSX.Element
  onMiddleClick?: () => void
}

type TabsContentProps = Parameters<typeof Kobalte.Content>[0]

function TabsRoot(props: ParentProps<TabsRootProps>) {
  const [local, rest] = splitProps(props, ["class", "classList", "variant", "children"])
  return (
    <Kobalte
      {...rest}
      data-component="tabs"
      data-variant={local.variant || "normal"}
      classList={{
        ...(local.classList ?? {}),
        [local.class ?? ""]: !!local.class,
      }}
    >
      {local.children}
    </Kobalte>
  )
}

function TabsList(props: ParentProps<TabsListProps>) {
  const [local, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <Kobalte.List
      {...rest}
      data-slot="tabs-list"
      classList={{
        ...(local.classList ?? {}),
        [local.class ?? ""]: !!local.class,
      }}
    >
      {local.children}
    </Kobalte.List>
  )
}

function TabsTrigger(props: ParentProps<TabsTriggerProps>) {
  const [local, rest] = splitProps(props, [
    "class",
    "classList",
    "classes",
    "children",
    "closeButton",
    "hideCloseButton",
    "onMiddleClick",
  ])
  return (
    <div
      data-slot="tabs-trigger-wrapper"
      classList={{
        ...(local.classList ?? {}),
        [local.class ?? ""]: !!local.class,
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && local.onMiddleClick) {
          e.preventDefault()
          local.onMiddleClick()
        }
      }}
    >
      <Kobalte.Trigger
        {...rest}
        data-slot="tabs-trigger"
        classList={{ [local.classes?.button ?? ""]: !!local.classes?.button }}
      >
        {local.children}
      </Kobalte.Trigger>
      <Show when={local.closeButton}>
        {(closeButton) => (
          <div data-slot="tabs-trigger-close-button" data-hidden={local.hideCloseButton}>
            {closeButton()}
          </div>
        )}
      </Show>
    </div>
  )
}

function TabsContent(props: ParentProps<TabsContentProps>) {
  const [local, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <Kobalte.Content
      {...rest}
      data-slot="tabs-content"
      classList={{
        ...(local.classList ?? {}),
        [local.class ?? ""]: !!local.class,
      }}
    >
      {local.children}
    </Kobalte.Content>
  )
}

const TabsSectionTitle: Component<ParentProps> = (props) => {
  return <div data-slot="tabs-section-title">{props.children}</div>
}

export const Tabs = Object.assign(TabsRoot, {
  List: TabsList,
  Trigger: TabsTrigger,
  Content: TabsContent,
  SectionTitle: TabsSectionTitle,
})
