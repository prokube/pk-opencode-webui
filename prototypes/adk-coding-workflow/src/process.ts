export type ProcessResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export interface ProcessRunner {
  run(command: string[], options?: {
    cwd?: string
    env?: Record<string, string | undefined>
    cleanEnv?: boolean
    timeoutMs?: number
  }): Promise<ProcessResult>
}

export class BunProcessRunner implements ProcessRunner {
  async run(command: string[], options: {
    cwd?: string
    env?: Record<string, string | undefined>
    cleanEnv?: boolean
    timeoutMs?: number
  } = {}): Promise<ProcessResult> {
    const env = Object.fromEntries(
      Object.entries({ ...(options.cleanEnv ? {} : process.env), ...options.env })
        .filter((entry): entry is [string, string] => entry[1] !== undefined),
    )
    const child = Bun.spawn(command, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const timeoutMs = options.timeoutMs ?? 30 * 60_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<number>((_, reject) => {
      timer = setTimeout(() => {
        try {
          if (process.platform === "win32") child.kill("SIGKILL")
          else process.kill(-child.pid, "SIGKILL")
        } catch {
          child.kill("SIGKILL")
        }
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${command.join(" ")}`))
      }, timeoutMs)
    })
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        Promise.race([child.exited, timeout]),
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { exitCode, stdout, stderr }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

export async function requireSuccess(
  runner: ProcessRunner,
  command: string[],
  options?: {
    cwd?: string
    env?: Record<string, string | undefined>
    cleanEnv?: boolean
    timeoutMs?: number
  },
): Promise<ProcessResult> {
  const result = await runner.run(command, options)
  if (result.exitCode !== 0) {
    const truncate = (output: string) => output.length > 2_000
      ? `${output.slice(0, 1_000)}\n... output truncated ...\n${output.slice(-1_000)}`
      : output
    const diagnostics = [
      result.stdout && `stdout:\n${truncate(result.stdout)}`,
      result.stderr && `stderr:\n${truncate(result.stderr)}`,
    ].filter(Boolean).join("\n")
    throw new Error(`Command failed (${result.exitCode}): ${command.join(" ")}\n${diagnostics}`)
  }
  return result
}
