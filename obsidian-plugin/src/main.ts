import path from "node:path"
import {
  App,
  FileSystemAdapter,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian"
import { ProcessRunner, WslPublisher } from "./process"
import type {
  BlogPublisherSettings,
  PublisherPost,
  PublisherResult,
  PushMode,
} from "./types"

const DEFAULT_SETTINGS: BlogPublisherSettings = {
  distro: "Ubuntu",
  repoPath: "/home/jyuny1/github/blog",
  pythonPath: "/home/jyuny1/github/blog/.venv/bin/python",
  nodeBinPath: "/home/jyuny1/.local/share/pi-node/node-v22.23.1-linux-x64/bin",
  branch: "v5",
  runBuild: true,
  pushMode: "confirm",
  timeoutSeconds: 600,
}

class ConfirmationModal extends Modal {
  private resolve: ((confirmed: boolean) => void) | null = null
  private answered = false

  constructor(
    app: App,
    private readonly heading: string,
    private readonly summary: string,
    private readonly confirmLabel: string,
  ) {
    super(app)
  }

  ask(): Promise<boolean> {
    this.open()
    return new Promise((resolve) => {
      this.resolve = resolve
    })
  }

  onOpen(): void {
    this.setTitle(this.heading)
    this.contentEl.createEl("pre", { cls: "ljy-publisher-summary", text: this.summary })
    const actions = this.contentEl.createDiv({ cls: "ljy-publisher-actions" })
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.answer(false))
    const confirm = actions.createEl("button", {
      cls: "mod-cta",
      text: this.confirmLabel,
    })
    confirm.addEventListener("click", () => this.answer(true))
  }

  onClose(): void {
    this.contentEl.empty()
    if (!this.answered) this.resolve?.(false)
  }

  private answer(confirmed: boolean): void {
    this.answered = true
    this.resolve?.(confirmed)
    this.resolve = null
    this.close()
  }
}

class ProgressModal extends Modal {
  private statusEl!: HTMLElement
  private logEl!: HTMLElement
  private actionButton!: HTMLButtonElement
  private finished = false

  constructor(
    app: App,
    private readonly onCancel: () => void,
  ) {
    super(app)
  }

  onOpen(): void {
    this.setTitle("LJY Blog Publisher")
    this.statusEl = this.contentEl.createEl("p", { text: "Starting…" })
    this.logEl = this.contentEl.createEl("pre", { cls: "ljy-publisher-log" })
    const actions = this.contentEl.createDiv({ cls: "ljy-publisher-actions" })
    this.actionButton = actions.createEl("button", { text: "Cancel" })
    this.actionButton.addEventListener("click", () => {
      if (this.finished) this.close()
      else this.onCancel()
    })
  }

  setStatus(status: string): void {
    this.statusEl.setText(status)
  }

  append(stream: "stdout" | "stderr", text: string): void {
    const prefix = stream === "stderr" ? "" : ""
    this.logEl.appendText(prefix + text)
    this.logEl.scrollTop = this.logEl.scrollHeight
  }

  finish(status: string, succeeded: boolean): void {
    this.finished = true
    this.setStatus(status)
    this.actionButton.setText("Close")
    this.actionButton.toggleClass("mod-cta", succeeded)
  }

  onClose(): void {
    if (!this.finished) this.onCancel()
    this.contentEl.empty()
  }
}

export default class LjyBlogPublisherPlugin extends Plugin {
  settings!: BlogPublisherSettings
  private readonly runner = new ProcessRunner()

  async onload(): Promise<void> {
    await this.loadSettings()
    this.addSettingTab(new BlogPublisherSettingTab(this.app, this))

    this.addCommand({
      id: "validate-current-note",
      name: "Validate current note",
      checkCallback: (checking) => this.withCurrentPost(checking, (file) => this.validateCurrent(file)),
    })
    this.addCommand({
      id: "publish-current-note",
      name: "Publish current note",
      checkCallback: (checking) => this.withCurrentPost(checking, (file) => this.publishCurrent(file)),
    })
    this.addCommand({
      id: "sync-all-published-posts",
      name: "Sync all published posts",
      callback: () => void this.syncAll(),
    })
    this.addCommand({
      id: "run-doctor",
      name: "Check publishing setup",
      callback: () => void this.runDoctor(),
    })
  }

  onunload(): void {
    void this.runner.cancel("Plugin unloaded; publishing was cancelled.")
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
    if (this.settings.pushMode !== "confirm" && this.settings.pushMode !== "never") {
      this.settings.pushMode = "confirm"
      await this.saveSettings()
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  async runDoctor(): Promise<void> {
    await this.runExclusive(async (publisher, progress, vaultPath) => {
      progress.setStatus("Checking publishing setup…")
      const result = await publisher.invoke(
        ["doctor", "--vault", vaultPath, "--branch", this.settings.branch],
        (stream, text) => progress.append(stream, text),
        true,
      )
      const checks = Object.entries(result.checks ?? {})
        .map(([name, passed]) => `${passed ? "✓" : "✗"} ${name}`)
      if (result.nodePath) checks.push(`nodePath: ${result.nodePath}`)
      if (result.npmPath) checks.push(`npmPath: ${result.npmPath}`)
      progress.append("stderr", `${checks.join("\n")}\n`)
      progress.finish(result.ok ? "Setup is ready." : "Setup needs attention.", result.ok)
      new Notice(result.ok ? "Blog publishing setup is ready." : "Blog publishing setup needs attention.")
    })
  }

  private withCurrentPost(checking: boolean, callback: (file: TFile) => Promise<void>): boolean {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file
    const available = Boolean(file && file.extension === "md" && file.path.startsWith("posts/"))
    if (!checking && file && available) void callback(file)
    return available
  }

  private async validateCurrent(file: TFile): Promise<void> {
    await this.runExclusive(async (publisher, progress, vaultPath) => {
      progress.setStatus(`Validating ${file.basename}…`)
      const notePath = await this.noteWslPath(publisher, file)
      const result = await publisher.invoke(
        ["validate", notePath, "--vault", vaultPath],
        (stream, text) => progress.append(stream, text),
      )
      progress.finish("Validation passed.", true)
      this.showWarnings(result.posts)
      new Notice(`Validated “${file.basename}”.`)
    })
  }

  private async publishCurrent(file: TFile): Promise<void> {
    try {
      await this.ensureSettings()
      if (this.runner.running) {
        new Notice("Another publishing operation is already running.")
        return
      }

      const publisher = new WslPublisher(this.settings, this.runner)
      const vaultPath = await this.vaultWslPath(publisher)
      const notePath = await this.noteWslPath(publisher, file)
      const plan = await publisher.invoke(["plan", notePath, "--vault", vaultPath])
      const push = await this.shouldPush(plan, `Publish “${file.basename}”?`)
      if (push === null) return

      await this.runExclusive(
        async (activePublisher, progress) => {
          progress.setStatus(`Publishing ${file.basename}…`)
          const args = ["publish", notePath, "--vault", vaultPath]
          if (this.settings.runBuild || push) args.push("--build")
          if (push) args.push("--commit", "--push", "--branch", this.settings.branch)
          const result = await activePublisher.invoke(args, (stream, text) => progress.append(stream, text))
          progress.finish(this.successMessage(result, push), true)
          this.showWarnings(result.posts)
          new Notice(this.successMessage(result, push))
        },
        { publisher, vaultPath },
      )
    } catch (error) {
      this.reportPreparationError(error)
    }
  }

  private async syncAll(): Promise<void> {
    try {
      await this.ensureSettings()
      if (this.runner.running) {
        new Notice("Another publishing operation is already running.")
        return
      }

      const publisher = new WslPublisher(this.settings, this.runner)
      const vaultPath = await this.vaultWslPath(publisher)
      const plan = await publisher.invoke(["plan", "--all", "--vault", vaultPath])
      const push = this.settings.pushMode !== "never"
      const summary = this.planSummary(plan, push)
      const confirmed = await new ConfirmationModal(
        this.app,
        "Sync all published posts?",
        summary,
        push ? "Sync and push" : "Sync",
      ).ask()
      if (!confirmed) return

      await this.runExclusive(
        async (activePublisher, progress) => {
          progress.setStatus("Syncing all published posts…")
          const args = ["publish", "--all", "--vault", vaultPath]
          if (this.settings.runBuild || push) args.push("--build")
          if (push) args.push("--commit", "--push", "--branch", this.settings.branch)
          const result = await activePublisher.invoke(args, (stream, text) => progress.append(stream, text))
          progress.finish(this.successMessage(result, push), true)
          this.showWarnings(result.posts)
          new Notice(this.successMessage(result, push))
        },
        { publisher, vaultPath },
      )
    } catch (error) {
      this.reportPreparationError(error)
    }
  }

  private async shouldPush(result: PublisherResult, heading: string): Promise<boolean | null> {
    if (this.settings.pushMode === "never") return false
    const confirmed = await new ConfirmationModal(
      this.app,
      heading,
      this.planSummary(result, true),
      "Publish and push",
    ).ask()
    return confirmed ? true : null
  }

  private async runExclusive(
    operation: (publisher: WslPublisher, progress: ProgressModal, vaultPath: string) => Promise<void>,
    prepared?: { publisher: WslPublisher; vaultPath: string },
  ): Promise<void> {
    if (this.runner.running) {
      new Notice("Another publishing operation is already running.")
      return
    }

    let progress: ProgressModal | null = null
    try {
      await this.ensureSettings()
      const publisher = prepared?.publisher ?? new WslPublisher(this.settings, this.runner)
      const vaultPath = prepared?.vaultPath ?? (await this.vaultWslPath(publisher))
      progress = new ProgressModal(this.app, () => void this.runner.cancel())
      progress.open()
      await operation(publisher, progress, vaultPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (progress) {
        progress.append("stderr", `\n${message}\n`)
        progress.finish("Publishing failed.", false)
      }
      console.error("LJY Blog Publisher", error)
      new Notice(`Blog publishing failed: ${message.slice(0, 180)}`)
    }
  }

  private async ensureSettings(): Promise<void> {
    const errors: string[] = []
    if (!this.settings.distro.trim()) errors.push("WSL distribution is required.")
    if (!this.settings.repoPath.startsWith("/")) errors.push("Repository path must be an absolute Linux path.")
    if (!this.settings.pythonPath.startsWith("/")) errors.push("Python path must be an absolute Linux path.")
    if (!this.settings.nodeBinPath.startsWith("/")) errors.push("Node bin path must be an absolute Linux path.")
    if (!/^[A-Za-z0-9._/-]+$/.test(this.settings.branch)) errors.push("Branch contains unsupported characters.")
    if (this.settings.timeoutSeconds < 30 || this.settings.timeoutSeconds > 7200) {
      errors.push("Timeout must be between 30 and 7200 seconds.")
    }
    if (errors.length) throw new Error(errors.join(" "))
  }

  private adapter(): FileSystemAdapter {
    const adapter = this.app.vault.adapter
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("This vault is not backed by a desktop filesystem.")
    }
    return adapter
  }

  private async vaultWslPath(publisher: WslPublisher): Promise<string> {
    return publisher.windowsToWslPath(this.adapter().getBasePath())
  }

  private async noteWslPath(publisher: WslPublisher, file: TFile): Promise<string> {
    const windowsPath = path.join(this.adapter().getBasePath(), ...file.path.split("/"))
    return publisher.windowsToWslPath(windowsPath)
  }

  private planSummary(result: PublisherResult, push: boolean): string {
    const posts = result.posts ?? []
    const lines = posts.map((post) => {
      const action = post.disposition === "generate" ? "generate" : "remove"
      return `• ${action}: ${post.permalink} (${post.localAssets} local assets)`
    })
    return [
      ...lines,
      "",
      `Build: ${this.settings.runBuild || push ? "yes" : "no"}`,
      `Push: ${push ? `origin/${this.settings.branch}` : "no"}`,
    ].join("\n")
  }

  private successMessage(result: PublisherResult, pushed: boolean): string {
    const generated = (result.posts ?? []).filter((post) => post.disposition === "generate").length
    const removed = (result.posts ?? []).filter((post) => post.disposition === "remove").length
    const suffix = pushed ? ` and pushed to ${this.settings.branch}` : ""
    return `Generated ${generated}, removed ${removed}${suffix}.`
  }

  private showWarnings(posts: PublisherPost[] | undefined): void {
    const warnings = (posts ?? []).flatMap((post) => post.warnings.map((warning) => `${post.permalink}: ${warning}`))
    if (warnings.length) new Notice(warnings.join("\n"), 10_000)
  }

  private reportPreparationError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    console.error("LJY Blog Publisher preparation failed", error)
    new Notice(`Could not prepare publishing: ${message.slice(0, 180)}`)
  }
}

class BlogPublisherSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: LjyBlogPublisherPlugin,
  ) {
    super(app, plugin)
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()
    containerEl.createEl("h2", { text: "LJY Blog Publisher" })

    this.textSetting("WSL distribution", "For example: Ubuntu", "distro")
    this.textSetting("Repository path", "Absolute Linux path to the blog repo", "repoPath")
    this.textSetting("Python path", "Absolute Linux path to the publisher venv", "pythonPath")
    this.textSetting("Node bin path", "Linux directory containing node and npm", "nodeBinPath")
    this.textSetting("Production branch", "Expected Git/Pages production branch", "branch")

    new Setting(containerEl)
      .setName("Run Astro check and build")
      .setDesc("Build before any commit or push.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.runBuild).onChange(async (value) => {
          this.plugin.settings.runBuild = value
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName("Push mode")
      .setDesc("Confirm is recommended. Credentials stay inside WSL.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("confirm", "Confirm before push")
          .addOption("never", "Never push")
          .setValue(this.plugin.settings.pushMode)
          .onChange(async (value) => {
            this.plugin.settings.pushMode = value as PushMode
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName("Timeout (seconds)")
      .setDesc("Allowed range: 30–7200 seconds.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.timeoutSeconds)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10)
          if (Number.isFinite(parsed)) {
            this.plugin.settings.timeoutSeconds = parsed
            await this.plugin.saveSettings()
          }
        }),
      )

    new Setting(containerEl)
      .setName("Test configuration")
      .setDesc("Run publish.py doctor through the configured WSL environment.")
      .addButton((button) => button.setButtonText("Run doctor").onClick(() => void this.plugin.runDoctor()))
  }

  private textSetting(
    name: string,
    description: string,
    key: "distro" | "repoPath" | "pythonPath" | "nodeBinPath" | "branch",
  ): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) =>
        text.setValue(this.plugin.settings[key]).onChange(async (value) => {
          this.plugin.settings[key] = value.trim()
          await this.plugin.saveSettings()
        }),
      )
  }
}
