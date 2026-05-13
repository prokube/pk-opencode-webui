export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import {
  type Client,
  type Config,
  type RequestResult,
} from "./gen/client/types.gen.js"
import { OpencodeClient } from "./gen/sdk.gen.js"
export { type Config as OpencodeClientConfig, OpencodeClient }

export type VcsDiffMode = "git" | "branch"

export type VcsFileDiff = {
  file: string
  patch: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

type VcsDiffParameters = {
  directory?: string
  mode?: VcsDiffMode
}

type VcsDiffOptions = Partial<Omit<Parameters<Client["get"]>[0], "url" | "query">>

type VcsDiffClient = {
  diff: <ThrowOnError extends boolean = false>(
    parameters?: VcsDiffParameters,
    options?: VcsDiffOptions & { throwOnError?: ThrowOnError },
  ) => RequestResult<VcsFileDiff[], unknown, ThrowOnError>
}

type OpencodeClientWithVcsDiff = OpencodeClient & {
  vcs: OpencodeClient["vcs"] & VcsDiffClient
}

export function createOpencodeClient(config?: Config & { directory?: string }): OpencodeClientWithVcsDiff {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    const isNonASCII = /[^\x00-\x7F]/.test(config.directory)
    const encodedDirectory = isNonASCII ? encodeURIComponent(config.directory) : config.directory
    config.headers = {
      ...config.headers,
      "x-opencode-directory": encodedDirectory,
    }
  }

  const client = createClient(config)
  const sdk = new OpencodeClient({ client })
  const diff: VcsDiffClient["diff"] = <ThrowOnError extends boolean = false>(
    parameters?: VcsDiffParameters,
    options?: VcsDiffOptions & { throwOnError?: ThrowOnError },
  ) => client.get<VcsFileDiff[], unknown, ThrowOnError>({
    ...options,
    url: "/vcs/diff",
    query: {
      directory: parameters?.directory,
      mode: parameters?.mode,
    },
  })

  Object.assign(sdk.vcs, { diff })
  return sdk as OpencodeClientWithVcsDiff
}
