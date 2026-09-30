import { A, useNavigate, type AnchorProps, type NavigateOptions } from "@solidjs/router"
import { useServer } from "./server"
import { serverHref } from "../utils/servers"

export function useServerNavigate() {
  const navigate = useNavigate()
  const server = useServer()
  return ((to: string | number, options?: Partial<NavigateOptions>) => {
    if (typeof to === "number") return navigate(to)
    return navigate(serverHref(server.id, to), options)
  }) as typeof navigate
}

export function ServerLink(props: AnchorProps) {
  const server = useServer()
  return <A {...props} href={serverHref(server.id, props.href)} />
}
