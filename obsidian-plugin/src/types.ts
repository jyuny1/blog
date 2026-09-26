export type PushMode = "confirm" | "never"

export interface BlogPublisherSettings {
  distro: string
  repoPath: string
  pythonPath: string
  nodeBinPath: string
  branch: string
  runBuild: boolean
  pushMode: PushMode
  timeoutSeconds: number
}

export interface PublisherPost {
  source: string
  output: string
  permalink: string
  published: boolean
  disposition: "generate" | "remove"
  references: number
  localAssets: number
  warnings: string[]
}

export interface PublisherError {
  code: string
  message: string
}

export interface PublisherResult {
  schemaVersion: number
  ok: boolean
  action?: string
  posts?: PublisherPost[]
  assets?: { uploaded: number; existing: number }
  build?: string
  commit?: string | null
  push?: string
  checks?: Record<string, boolean>
  nodePath?: string | null
  npmPath?: string | null
  error?: PublisherError
}

export interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type OutputHandler = (stream: "stdout" | "stderr", text: string) => void
