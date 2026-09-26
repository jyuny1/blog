import { execFile, spawn, type ChildProcess } from "node:child_process"
import type {
  BlogPublisherSettings,
  OutputHandler,
  ProcessResult,
  PublisherResult,
} from "./types"

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const PROTOCOL_VERSION = 1

function minimalEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "SystemRoot",
    "WINDIR",
    "PATH",
    "PATHEXT",
    "COMSPEC",
    "USERPROFILE",
    "TEMP",
    "TMP",
    "WSLENV",
  ]
  return Object.fromEntries(
    allowed
      .map((name) => [name, process.env[name]])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

interface ActiveRun {
  id: number
  child: ChildProcess
  cancellationReason: string | null
  timer: NodeJS.Timeout | null
  closed: Promise<void>
  resolveClosed: () => void
  termination: Promise<void> | null
}

export class ProcessRunner {
  private active: ActiveRun | null = null
  private nextRunId = 0

  get running(): boolean {
    return this.active !== null
  }

  async run(
    executable: string,
    args: string[],
    timeoutMs: number,
    onOutput?: OutputHandler,
  ): Promise<ProcessResult> {
    if (this.active) throw new Error("Another publisher process is already running.")

    return new Promise<ProcessResult>((resolve, reject) => {
      let stdout = ""
      let stderr = ""
      let outputBytes = 0
      let settled = false
      let resolveClosed = (): void => undefined
      const closed = new Promise<void>((closedResolve) => {
        resolveClosed = closedResolve
      })

      let child: ChildProcess
      try {
        child = spawn(executable, args, {
          shell: false,
          windowsHide: true,
          env: minimalEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
        })
      } catch (error) {
        reject(error)
        return
      }

      const state: ActiveRun = {
        id: ++this.nextRunId,
        child,
        cancellationReason: null,
        timer: null,
        closed,
        resolveClosed,
        termination: null,
      }
      state.timer = setTimeout(() => {
        void this.cancel(`Publisher timed out after ${Math.round(timeoutMs / 1000)} seconds.`)
      }, timeoutMs)
      this.active = state

      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        if (state.timer) clearTimeout(state.timer)
        if (this.active?.id === state.id) this.active = null
        state.resolveClosed()
        callback()
      }

      const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
        outputBytes += chunk.byteLength
        if (outputBytes > MAX_OUTPUT_BYTES) {
          void this.cancel("Publisher output exceeded 2 MiB.")
          return
        }
        const text = chunk.toString("utf8")
        if (stream === "stdout") stdout += text
        else stderr += text
        onOutput?.(stream, text)
      }

      child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk))
      child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk))
      child.on("error", (error) => finish(() => reject(error)))
      child.on("close", (code) => {
        finish(() => {
          if (state.cancellationReason) {
            reject(new Error(state.cancellationReason))
            return
          }
          resolve({ exitCode: code ?? -1, stdout, stderr })
        })
      })
    })
  }

  async cancel(reason = "Publishing cancelled."): Promise<void> {
    const state = this.active
    if (!state) return
    state.cancellationReason = state.cancellationReason ?? reason
    if (!state.termination) {
      state.termination = (async () => {
        const pid = state.child.pid
        if (pid) {
          await new Promise<void>((resolve) => {
            execFile(
              "taskkill.exe",
              ["/PID", String(pid), "/T", "/F"],
              { windowsHide: true, env: minimalEnvironment() },
              () => resolve(),
            )
          })
        }
        if (this.active?.id === state.id) state.child.kill("SIGKILL")
        await state.closed
      })()
    }
    await state.termination
  }
}

export class WslPublisher {
  constructor(
    private readonly settings: BlogPublisherSettings,
    private readonly runner: ProcessRunner,
  ) {}

  async windowsToWslPath(windowsPath: string): Promise<string> {
    const result = await this.runner.run(
      "wsl.exe",
      [
        "--distribution",
        this.settings.distro,
        "--exec",
        "wslpath",
        "-a",
        "-u",
        windowsPath,
      ],
      30_000,
    )
    if (result.exitCode !== 0) {
      throw new Error(this.errorText("Could not convert the Windows path", result))
    }
    const converted = result.stdout.trim()
    if (!converted.startsWith("/")) throw new Error("wslpath returned an invalid Linux path.")
    return converted
  }

  async invoke(
    cliArgs: string[],
    onOutput?: OutputHandler,
    acceptNotOk = false,
  ): Promise<PublisherResult> {
    const script = `${this.settings.repoPath.replace(/\/$/, "")}/publish.py`
    const result = await this.runner.run(
      "wsl.exe",
      [
        "--distribution",
        this.settings.distro,
        "--exec",
        "env",
        `BLOG_NODE_BIN=${this.settings.nodeBinPath}`,
        this.settings.pythonPath,
        script,
        ...cliArgs,
        "--json",
      ],
      this.settings.timeoutSeconds * 1000,
      onOutput,
    )

    let payload: PublisherResult
    try {
      payload = JSON.parse(result.stdout.trim()) as PublisherResult
    } catch {
      throw new Error(this.errorText("Publisher returned invalid JSON", result))
    }
    if (payload.schemaVersion !== PROTOCOL_VERSION) {
      throw new Error(`Unsupported publisher protocol version: ${String(payload.schemaVersion)}`)
    }
    if ((result.exitCode !== 0 || !payload.ok) && !acceptNotOk) {
      throw new Error(payload.error?.message ?? this.errorText("Publisher failed", result))
    }
    return payload
  }

  private errorText(prefix: string, result: ProcessResult): string {
    const detail = (result.stderr || result.stdout).trim().slice(-2_000)
    return detail ? `${prefix}: ${detail}` : `${prefix} (exit ${result.exitCode})`
  }
}
