import "solid-js"

declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: ReturnType<typeof import("@thisbeyond/solid-dnd").createSortable> | true
    }
  }
}
