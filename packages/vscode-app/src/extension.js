const childProcess = require("child_process")
const fs = require("fs")
const http = require("http")
const net = require("net")
const os = require("os")
const path = require("path")
const vscode = require("vscode")
const { ExtensionHttpProxyBridge } = require("./extension-proxy")
const { VSCodeStorageBridge } = require("./extension-storage")

const output = vscode.window.createOutputChannel("opencode App")
const processes = new Map()
let settingsPanel = undefined
// sessionId -> { panel, title }，复用同一 session 的 panel
const sessionPanels = new Map()

async function openSettingsPanel(provider) {
  if (settingsPanel) {
    settingsPanel.reveal()
    return
  }

  const panel = vscode.window.createWebviewPanel("opencodeSettings", "OpenCode Settings", vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: provider.localResourceRoots(),
  })

  const messageListener = panel.webview.onDidReceiveMessage((message) =>
    provider.handleMessage(message, panel.webview),
  )
  panel.webview.html = provider.localAppHtml(panel.webview, { settings: true })
  panel.onDidDispose(() => {
    messageListener.dispose()
    settingsPanel = undefined
  })

  settingsPanel = panel
}

// 在编辑器区打开（或聚焦）某个 session 的聊天 panel。同一 sessionId 复用已有 panel。
async function openSessionPanel(provider, sessionDir, sessionId, sourceWebview) {
  if (typeof sessionId !== "string" || !sessionId) return
  const existing = sessionPanels.get(sessionId)
  if (existing) {
    existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.One)
    return
  }

  const title = sessionDir ? `${path.basename(sessionDir)} · opencode` : "opencode Session"
  const panel = vscode.window.createWebviewPanel("opencodeSession", title, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: provider.localResourceRoots(),
  })

  const messageListener = panel.webview.onDidReceiveMessage((message) =>
    provider.handleMessage(message, panel.webview),
  )

  panel.webview.html = provider.localAppHtml(panel.webview, { sessionDir, sessionId })

  panel.onDidDispose(() => {
    messageListener.dispose()
    sessionPanels.delete(sessionId)
  })
  sessionPanels.set(sessionId, { panel, title })
  // 通知来源 webview（侧边栏列表）panel 已创建，可提前停止 opening loading。
  if (sourceWebview) {
    void sourceWebview.postMessage({ source: "opencode-vscode-app", command: "sessionPanelOpened", sessionId })
  }
}

// 在编辑器区打开（或聚焦）新建会话的聊天 panel。同一目录的“new”条目复用。
async function openNewSessionPanel(provider, sessionDir, sourceWebview) {
  const newKey = sessionDir ? `${sessionDir}:new` : "new"
  const existing = sessionPanels.get(newKey)
  if (existing) {
    existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.One)
    return
  }

  const title = sessionDir ? `${path.basename(sessionDir)} · opencode` : "opencode Session"
  const panel = vscode.window.createWebviewPanel("opencodeSession", title, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: provider.localResourceRoots(),
  })

  const messageListener = panel.webview.onDidReceiveMessage((message) =>
    provider.handleMessage(message, panel.webview),
  )

  panel.webview.html = provider.localAppHtml(panel.webview, { sessionDir, newSession: true })

  panel.onDidDispose(() => {
    messageListener.dispose()
    sessionPanels.delete(newKey)
  })
  sessionPanels.set(newKey, { panel, title })
  if (sourceWebview) {
    void sourceWebview.postMessage({ source: "opencode-vscode-app", command: "sessionPanelOpened", sessionId: newKey })
  }
}

function activate(context) {
  output.appendLine("[opencode-app] activate from source: " + __dirname)
  vscode.window.showInformationMessage("opencode-app v0.0.1 (dev) loaded from " + __dirname)
  const provider = new OpenCodeAppViewProvider(context)
  context.subscriptions.push(output)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("opencodeVscodeApp.view", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeVscodeApp.restart", async () => {
      stopProcesses()
      await provider.refresh()
    }),
  )
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeVscodeApp.openInBrowser", async () => {
      await vscode.env.openExternal(vscode.Uri.parse(await provider.externalWebUrl()))
    }),
  )
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeVscodeApp.reload", async () => {
      await provider.reload()
    }),
  )
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeVscodeApp.openSettings", async () => {
      await openSettingsPanel(provider)
    }),
  )
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeVscodeApp.openSession", async (dir, id) => {
      await openSessionPanel(provider, dir, id)
    }),
  )
}

function deactivate() {
  stopProcesses()
}

class OpenCodeAppViewProvider {
  constructor(context) {
    this.context = context
    this.view = undefined
    this.runtimePort = undefined
    this.backendPort = undefined
    this.proxy = new ExtensionHttpProxyBridge(output)
    this.storage = new VSCodeStorageBridge(context, (patch, sourceWebview) => this.broadcastStorage(patch, sourceWebview))
  }

  resolveWebviewView(view) {
    this.view = view
    view.webview.options = {
      enableScripts: true,
    }
    view.webview.onDidReceiveMessage((message) => this.handleMessage(message, view.webview))
    return this.refresh()
  }

  // 处理来自任意 webview（侧边栏 view 或 session panel）的消息。
  // webview 参数指明响应应回发到哪个 webview，避免 panel 的代理响应被投递到侧边栏。
  async handleMessage(message, webview) {
    if (!message || typeof message !== "object") return
    if (message.command === "restart") {
      stopProcesses()
      await this.refresh()
    }
    if (message.command === "openInBrowser") {
      await vscode.env.openExternal(vscode.Uri.parse(await this.externalWebUrl()))
    }
    if (message.command === "showLogs") {
      output.show()
    }
    if (message.command === "pickDirectory") {
      await this.pickDirectory(message, webview)
    }
    if (message.command === "storageSet") {
      await this.storage.handleSet(message, webview)
    }
    if (message.command === "storageRemove") {
      await this.storage.handleRemove(message, webview)
    }
    if (message.command === "storageClear") {
      await this.storage.handleClear(webview)
    }
    if (message.command === "storageReplace") {
      await this.storage.handleReplace(message, webview)
    }
    if (message.command === "storageGetAll") {
      this.storage.handleGetAll(webview)
    }
    if (message.command === "fiConfigGet") {
      await this.handleFiConfigGet(message, webview)
    }
    if (message.command === "fiConfigUpdate") {
      await this.handleFiConfigUpdate(message, webview)
    }
    if (message.command === "proxyFetch") {
      await this.proxy.proxyFetch(message, webview)
    }
    if (message.command === "proxyCancel") {
      this.proxy.cancelProxy(message)
    }
    if (message.command === "webSocketProxyOpen") {
      this.proxy.webSocketProxy(message, webview)
    }
    if (message.command === "webSocketProxySend") {
      this.proxy.sendWebSocketProxy(message)
    }
    if (message.command === "webSocketProxyClose") {
      this.proxy.closeWebSocketProxy(message)
    }
    if (message.command === "openSessionPanel") {
      await openSessionPanel(this, message.sessionDir, message.sessionId, webview)
    }
    if (message.command === "openNewSessionPanel") {
      await openNewSessionPanel(this, message.sessionDir, webview)
    }
    if (message.command === "startManualModeBackend") {
      await this.startManualModeBackend()
    }
  }

  async reload() {
    await this.refresh()
  }

  async handleFiConfigGet(message, webview) {
    try {
      await postFiConfigResult(webview, message.requestId, await readFiConfig())
    } catch (error) {
      await postFiConfigResult(webview, message.requestId, undefined, error)
    }
  }

  async handleFiConfigUpdate(message, webview) {
    try {
      const config = isRecord(message.config) ? message.config : {}
      await writeFiConfig(config)
      await postFiConfigResult(webview, message.requestId, config)
    } catch (error) {
      await postFiConfigResult(webview, message.requestId, undefined, error)
    }
  }

  async startManualModeBackend() {
    try {
      const config = vscode.workspace.getConfiguration("opencodeVscodeApp")
      const backendPort = await resolveBackendPort(this.context, config)
      const backendUrl = `http://127.0.0.1:${backendPort}`
      if (await requestOpencodeHealthOk(backendUrl)) {
        await this.refresh()
        return
      }
      launchManualModeBackend(this.context, config, backendPort)
      vscode.window.showInformationMessage("已在 cmd.exe 中启动 opencode 服务端")
    } catch (error) {
      output.appendLine(`[manualMode] failed to launch cmd.exe: ${error.message}`)
      vscode.window.showErrorMessage(`无法启动 cmd.exe: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async refresh() {
    if (!this.view) return
    try {
      const ports = await ensureServices(this.context)
      this.runtimePort = ports.web
      this.backendPort = ports.backend
      output.appendLine(`[storage] backend started on port ${this.backendPort}`)
      
      console.log(`[storage] backend started on port ${this.backendPort}`)
      // 把后端地址写入共享 storage，SDK 通过 StorageBridge 同步后就能读到
      const backendUrl = `http://127.0.0.1:${this.backendPort}`
      await this.storage.set(
        "opencode.settings.dat:defaultServerUrl",
        backendUrl,
      )
      // 同步注入代理 baseUrl：webview 误用 location.origin 拼成的 vscode-webview:// 请求
      // 会在 Extension Host 侧被改写回这个真实后端地址
      this.proxy.baseUrl = backendUrl
      output.appendLine(`[storage] wrote defaultServerUrl = ${backendUrl}`)
      console.log(`[storage] wrote defaultServerUrl = ${backendUrl}`)

      this.view.webview.options = {
        enableScripts: true,
        localResourceRoots: this.localResourceRoots(),
      }
      if (vscode.workspace.getConfiguration("opencodeVscodeApp").get("manualMode", false) && !(await requestOpencodeHealthOk(backendUrl))) {
        this.view.webview.html = this.manualModeHtml(manualModeCommand(this.context, vscode.workspace.getConfiguration("opencodeVscodeApp"), this.backendPort))
        return
      }
      this.view.webview.html = this.localAppHtml(this.view.webview)
    } catch (error) {
      this.view.webview.html = this.errorHtml(error)
    }
  }

  ports() {
    const config = vscode.workspace.getConfiguration("opencodeVscodeApp")
    return {
      backend: normalizePort(config.get("backendPort", 0)),
      web: config.get("webPort", 4444),
    }
  }

  webUrl(options = {}) {
    const url = new URL(`http://localhost:${this.webPort()}`)
    url.pathname = this.appPath(options)
    if (options.cacheBust) url.searchParams.set("t", String(options.cacheBust))
    return url.toString()
  }

  async externalWebUrl(options = {}) {
    return (await vscode.env.asExternalUri(vscode.Uri.parse(this.webUrl(options)))).toString()
  }

  appPath(options = {}) {
    const encode = (dir) => Buffer.from(dir, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    if (options.settings) {
      const dir = normalizeWorkspaceDir(workspaceDirFromVSCode())
      if (dir) return "/" + encode(dir) + "/settings"
      return "/settings"
    }
    // 新建会话的聊天页（编辑器区 panel，无 session id）
    if (options.newSession) {
      const dir = options.sessionDir ?? normalizeWorkspaceDir(workspaceDirFromVSCode())
      if (!dir) return "/"
      return "/" + encode(dir) + "/vscode-session"
    }
    // 单个 session 的聊天页（编辑器区 panel）
    if (options.sessionId) {
      const dir = options.sessionDir ?? normalizeWorkspaceDir(workspaceDirFromVSCode())
      if (!dir) return "/"
      return "/" + encode(dir) + "/vscode-session/" + options.sessionId
    }
    // 侧边栏默认展示当前工作目录的 sessions 列表
    const workspaceDir = normalizeWorkspaceDir(resolveWorkspaceDir(this.context.extensionPath))
    if (!workspaceDir) return "/"
    return "/" + encode(workspaceDir) + "/vscode-sessions-list"
  }

  webDistDir() {
    // 打包模式（远程安装）：扩展目录下的 runtime/web/dist
    // dev 模式（F5）：仓库 packages/app/dist
    const packaged = path.join(this.context.extensionPath, "runtime", "web", "dist")
    if (fs.existsSync(path.join(packaged, "index.html"))) return packaged
    const repoRoot = findRepoRoot(this.context.extensionPath)
    return path.join(repoRoot, "packages", "app", "dist")
  }

  localResourceRoots() {
    const roots = []
    const webDistDir = this.webDistDir()
    if (fs.existsSync(path.join(webDistDir, "index.html"))) roots.push(vscode.Uri.file(webDistDir))
    return roots
  }

  canUseLocalWebview() {
    // dev 和打包模式统一：只要有构建产物 dist/index.html 就用本地 webview（acquireVsCodeApi）。
    return fs.existsSync(path.join(this.webDistDir(), "index.html"))
  }

  webPort() {
    const ports = this.ports()
    if (this.runtimePort) return this.runtimePort
    return packagedBinaryPath(this.context.extensionPath) ? ports.backend : ports.web
  }

  localAppHtml(webview, options = {}) {
    const appPathValue = this.appPath(options)
    output.appendLine("[localAppHtml] webDistDir=" + this.webDistDir() + " appPath=" + appPathValue)
    const nonce = createNonce()
    const webDistDir = this.webDistDir()
    const html = fs.readFileSync(path.join(webDistDir, "index.html"), "utf8")
    output.appendLine("[localAppHtml] appPath=" + JSON.stringify(this.appPath(options)) + " distDir=" + this.webDistDir())
    const routeScript = `<meta http-equiv="Content-Security-Policy" content="${localWebviewCsp(webview, nonce)}">
    <script nonce="${nonce}">
      const opencodePath = ${JSON.stringify(this.appPath(options))}
      history.replaceState(history.state, "", opencodePath + location.search)
    </script>`
    return injectLocalSpriteSymbols(
      rewriteLocalAppHtml(html, webview, webDistDir, nonce).replace(/<head([^>]*)>/i, `<head$1>
    ${routeScript}`),
      webDistDir,
    )
  }

  broadcastStorage(patch, sourceWebview) {
    for (const webview of this.webviews()) {
      if (webview === sourceWebview) continue
      void webview.postMessage({ source: "opencode-vscode-app", command: "storagePatch", patch })
    }
  }

  webviews() {
    return [
      this.view?.webview,
      settingsPanel?.webview,
      ...[...sessionPanels.values()].map((entry) => entry.panel.webview),
    ].filter(Boolean)
  }

  async pickDirectory(message, webview) {
    const target = webview ?? this.view?.webview
    const uris = await vscode.window.showOpenDialog({
      title: typeof message.title === "string" ? message.title : "Open project",
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: !!message.multiple,
      defaultUri: workspaceDirFromVSCode() ? vscode.Uri.file(workspaceDirFromVSCode()) : undefined,
      openLabel: "Open",
    })
    await target?.postMessage({
      source: "opencode-vscode-app",
      command: "directoryPicked",
      requestId: message.requestId,
      result: uris ? uris.map((uri) => normalizeWorkspaceDir(uri.fsPath)) : null,
    })
  }

  errorHtml(error) {
    const nonce = createNonce()
    return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <style>
      body {
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        font-family: var(--vscode-font-family);
        padding: 12px;
      }
      pre {
        white-space: pre-wrap;
        background: var(--vscode-textCodeBlock-background);
        padding: 8px;
      }
      button {
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        border: 0;
        padding: 6px 10px;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <h3>opencode App failed to start</h3>
    <pre>${escapeHtml(error instanceof Error ? error.message : String(error))}</pre>
    <p>Set <code>opencodeVscodeApp.bunPath</code> if Bun is not available from PATH or <code>BUN_EXE</code>.</p>
    <button id="retry">Retry</button>
    <button id="logs">Show Logs</button>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi()
      document.getElementById("retry").addEventListener("click", () => vscode.postMessage({ command: "restart" }))
      document.getElementById("logs").addEventListener("click", () => vscode.postMessage({ command: "showLogs" }))
    </script>
  </body>
</html>`
  }

  manualModeHtml(command) {
    const nonce = createNonce()
    return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <style>
      body {
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        font-family: var(--vscode-font-family);
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        box-sizing: border-box;
      }
      main {
        display: flex;
        flex-direction: column;
        gap: 12px;
        width: 100%;
        max-width: 520px;
        text-align: center;
      }
      .icon {
        align-self: center;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        color: var(--vscode-notificationsWarningIcon-foreground);
        background: var(--vscode-inputValidation-warningBackground);
        font-weight: 600;
      }
      h2 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }
      p {
        margin: 0;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        line-height: 1.5;
      }
      pre {
        margin: 0;
        padding: 12px;
        white-space: pre-wrap;
        word-break: break-all;
        text-align: left;
        background: var(--vscode-textCodeBlock-background);
        border-radius: 4px;
        font-size: 12px;
      }
      button {
        align-self: center;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        border: 0;
        border-radius: 3px;
        padding: 6px 12px;
        cursor: pointer;
      }
      button:hover {
        background: var(--vscode-button-hoverBackground);
      }
      .actions {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="icon">!</div>
      <h2>手动模式</h2>
      <p>opencode 后端尚未启动。请在终端中运行以下命令。</p>
      <pre>${escapeHtml(command)}</pre>
      <div class="actions">
        <button id="retry">Check Again</button>
        <button id="start">使用cmd.exe启动服务端</button>
      </div>
    </main>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi()
      document.getElementById("retry").addEventListener("click", () => vscode.postMessage({ command: "restart" }))
      document.getElementById("start").addEventListener("click", () => vscode.postMessage({ command: "startManualModeBackend" }))
    </script>
  </body>
</html>`
  }
}

// A configured backendPort is authoritative. Use 0 to allocate and persist a random port.
async function resolveBackendPort(context, config) {
  const configured = normalizePort(config.get("backendPort", 0))
  if (configured) {
    output.appendLine(`[opencode] using configured backend port ${configured}`)
    return configured
  }
  const port = await findAvailablePort()
  output.appendLine(`[opencode] backendPort is not configured, using ${port} and saving to settings`)
  await config.update("backendPort", port, true)
  return port
}

async function ensureServices(context) {
  const binary = packagedBinaryPath(context.extensionPath)
  const repoRoot = binary ? undefined : findRepoRoot(context.extensionPath)
  const workspaceDir = resolveWorkspaceDir(repoRoot ?? context.extensionPath)
  const buildDir = path.join(context.globalStorageUri.fsPath, "runtime")
  const config = vscode.workspace.getConfiguration("opencodeVscodeApp")
  // 手动模式：跳过进程启动，webview 通过 postMessage 获取启动命令
  if (config.get("manualMode", false)) {
    const backendPort = await resolveBackendPort(context, config)
    output.appendLine(`[opencode] manual mode — skipping backend start (port ${backendPort})`)
    return { backend: backendPort, web: backendPort }
  }
  const backendPort = await resolveBackendPort(context, config)
  const env = {
    ...process.env,
    BUN_INSTALL_CACHE_DIR: path.join(buildDir, "cache", "bun-install"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(buildDir, "cache", "bun-runtime"),
    OPENCODE_BUILD_DIR: buildDir,
    TEMP: path.join(buildDir, "tmp"),
    TMP: path.join(buildDir, "tmp"),
    TMPDIR: path.join(buildDir, "tmp"),
    VITE_OPENCODE_SERVER_HOST: "localhost",
    VITE_OPENCODE_SERVER_PORT: String(backendPort),
    OPENCODE_SERVER_PASSWORD: "",
    OPENCODE_SERVER_USERNAME: "",
  }
  fs.mkdirSync(env.BUN_INSTALL_CACHE_DIR, { recursive: true })
  fs.mkdirSync(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH, { recursive: true })
  fs.mkdirSync(env.TMP, { recursive: true })

  const serveUrl = `http://127.0.0.1:${backendPort}`

  if (binary) {
    if (!(await requestWithoutAuthOk(serveUrl))) {
      startProcess("opencode", binary, ["serve", "--port", String(backendPort), "--hostname", "127.0.0.1"], {
        cwd: workspaceDir,
        env,
      })
    } else {
      output.appendLine(`[opencode] port ${backendPort} is already listening`)
    }
  } else {
    const bun = resolveBun(config.get("bunPath", ""))
    env.BUN_EXE = bun
    env.PATH = `${path.dirname(bun)}${path.delimiter}${process.env.PATH ?? ""}`
    if (!(await isPortOpen(backendPort))) {
      startProcess(
        "backend",
        bun,
        [
          "run",
          "--conditions=browser",
          path.join(repoRoot, "packages", "opencode", "src", "index.ts"),
          "serve",
          "--port",
          String(backendPort),
        ],
        {
          cwd: workspaceDir,
          env,
        },
      )
    } else {
      output.appendLine(`[backend] port ${backendPort} is already listening`)
    }
  }

  await waitForHttp(serveUrl, "opencode")
  return { backend: backendPort, web: backendPort }
}

function packagedBinaryPath(extensionPath) {
  const binary = process.platform === "win32" ? "opencode.exe" : "opencode"
  const candidate = path.join(extensionPath, "runtime", "bin", binary)
  if (fs.existsSync(candidate)) return candidate
  return ""
}

function localWebviewCsp(webview, nonce) {
  return [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `font-src ${webview.cspSource} data:`,
    `media-src ${webview.cspSource} data: blob:`,
    `manifest-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    "connect-src http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
  ].join("; ")
}

function rewriteLocalAppHtml(html, webview, webDistDir, nonce) {
  return addScriptNonces(
    rewriteLocalResourceAttributes(rewriteLocalStylesheets(html, webview, webDistDir, nonce), webview, webDistDir),
    nonce,
  )
}

function injectLocalSpriteSymbols(html, webDistDir) {
  const sprites = fs
    .readdirSync(path.join(webDistDir, "assets"))
    .filter((name) => /^sprite-.*\.svg$/i.test(name))
    .flatMap((name) => {
      const file = path.join(webDistDir, "assets", name)
      if (!fs.existsSync(file)) return []
      return [fs.readFileSync(file, "utf8").replace(/<\?xml[^>]*>\s*/i, "")]
    })
  if (sprites.length === 0) return html
  return html.replace(/<body([^>]*)>/i, `<body$1>
    <div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${sprites.join("\n")}</div>`)
}

function rewriteLocalStylesheets(html, webview, webDistDir, nonce) {
  return html.replace(/<link\b[^>]*\brel=(["'])stylesheet\1[^>]*>/gi, (tag) => {
    const href = localAttributeValue(tag, "href")
    if (!href) return tag
    const file = localResourceFile(webDistDir, href)
    if (!file || !fs.existsSync(file)) return tag
    const css = rewriteCssResourceUrls(fs.readFileSync(file, "utf8"), webview, webDistDir)
    return `<style nonce="${nonce}">\n${css}\n</style>`
  })
}

function rewriteCssResourceUrls(css, webview, webDistDir) {
  return css.replace(/url\((["']?)([^"')]+)\1\)/gi, (match, quote, value) => {
    const uri = localResourceUri(webview, webDistDir, value)
    if (!uri) return match
    return `url(${quote}${uri}${quote})`
  })
}

function rewriteLocalResourceAttributes(html, webview, webDistDir) {
  return html.replace(/\b(src|href)=(["'])([^"']+)\2/gi, (match, name, quote, value) => {
    const uri = localResourceUri(webview, webDistDir, value)
    if (!uri) return match
    return `${name}=${quote}${uri}${quote}`
  })
}

function addScriptNonces(html, nonce) {
  return html.replace(/<script\b(?![^>]*\bsrc=)(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`)
}

function localAttributeValue(tag, name) {
  const match = new RegExp(`\\b${name}=(["'])([^"']+)\\1`, "i").exec(tag)
  return match?.[2]
}

function localResourceUri(webview, webDistDir, value) {
  const file = localResourceFile(webDistDir, value)
  if (!file) return undefined
  return webview.asWebviewUri(vscode.Uri.file(file)).toString()
}

function localResourceFile(webDistDir, value) {
  if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(value)) return undefined
  const match = /^([^?#]*)([?#].*)?$/.exec(value)
  const resource = match?.[1]
  if (!resource) return undefined
  const relative = resource.replace(/^\/+/, "").replace(/^\.\//, "")
  if (!relative || relative.startsWith("../") || relative.includes("/../")) return undefined
  return path.join(webDistDir, ...relative.split("/"))
}

function startProcess(name, command, args, options) {
  const current = processes.get(name)
  if (current && !current.killed) return
  output.appendLine(`[${name}] ${command} ${args.join(" ")}`)
  const child = childProcess.spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
  })
  processes.set(name, child)
  child.stdout.on("data", (data) => output.append(`[${name}] ${data}`))
  child.stderr.on("data", (data) => output.append(`[${name}] ${data}`))
  child.on("error", (error) => output.appendLine(`[${name}] failed: ${error.message}`))
  child.on("exit", (code, signal) => {
    output.appendLine(`[${name}] exited code=${code ?? ""} signal=${signal ?? ""}`)
    if (processes.get(name) === child) processes.delete(name)
  })
}

function resolveWorkspaceDir(fallback) {
  const workspaceDir = workspaceDirFromVSCode()
  if (!workspaceDir) {
    output.appendLine(`[backend] no VS Code workspace found, using ${fallback}`)
    return fallback
  }
  output.appendLine(`[backend] VS Code workspace: ${workspaceDir}`)
  return workspaceDir
}

function workspaceDirFromVSCode() {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath
}

function normalizeWorkspaceDir(directory) {
  if (!directory) return directory
  return directory.replace(/^[a-z]:/, (drive) => drive.toUpperCase())
}

function normalizePort(value) {
  const port = Number(value)
  if (!Number.isInteger(port)) return 0
  if (port < 1 || port > 65535) return 0
  return port
}

function stopProcesses() {
  for (const child of processes.values()) {
    child.kill()
  }
  processes.clear()
}

function fiConfigFile() {
  return path.join(os.homedir(), ".opencode-fi-plugin-config", "opencode-fi-plugin.jsonc")
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function stripJsonComments(text) {
  let output = ""
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    const next = text[index + 1]
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === "\"") inString = false
      continue
    }
    if (char === "\"") {
      inString = true
      output += char
      continue
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index++
      output += "\n"
      continue
    }
    if (char === "/" && next === "*") {
      index += 2
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index++
      index++
      continue
    }
    output += char
  }
  return output.replace(/,\s*([}\]])/g, "$1")
}

async function readFiConfig() {
  const file = fiConfigFile()
  if (!fs.existsSync(file)) return {}
  const text = await fs.promises.readFile(file, "utf8")
  if (!text.trim()) return {}
  return JSON.parse(stripJsonComments(text))
}

async function writeFiConfig(config) {
  const file = fiConfigFile()
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

async function postFiConfigResult(webview, requestId, config, error) {
  await webview?.postMessage({
    source: "opencode-vscode-app",
    command: "fiConfigResult",
    requestId,
    config: config ?? {},
    error: error ? error instanceof Error ? error.message : String(error) : undefined,
  })
}

function clearViteCache(buildDir) {
  fs.rmSync(path.join(buildDir, "web", "vite-cache"), { recursive: true, force: true })
}

function findRepoRoot(start) {
  let current = start
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "packages", "app", "package.json"))) return current
    current = path.dirname(current)
  }
  throw new Error(`Cannot find repo root from ${start}`)
}

function resolveBun(setting) {
  const candidates = [
    setting,
    process.env.BUN_EXE,
    findOnPath(process.platform === "win32" ? "bun.exe" : "bun"),
    process.platform === "win32" ? "D:\\bun.exe" : "",
  ].filter(Boolean)
  const bun = candidates.find((candidate) => fs.existsSync(candidate))
  if (!bun) {
    throw new Error(`Cannot find Bun. Checked: ${candidates.join(", ") || "no candidates"}`)
  }
  return bun
}

function findOnPath(command) {
  const result = childProcess.spawnSync(process.platform === "win32" ? "where" : "which", [command], {
    encoding: "utf8",
    shell: false,
  })
  if (result.status !== 0) return ""
  return result.stdout.split(/\r?\n/).find(Boolean) ?? ""
}

function manualModeCommand(context, config, backendPort) {
  const binary = packagedBinaryPath(context.extensionPath)
  if (binary) return `"${binary}" serve --port ${backendPort} --hostname 127.0.0.1`
  const repoRoot = findRepoRoot(context.extensionPath)
  const bun = resolveBun(config.get("bunPath", ""))
  return `"${bun}" run --conditions=browser "${path.join(repoRoot, "packages", "opencode", "src", "index.ts")}" serve --port ${backendPort} --hostname 127.0.0.1`
}

function launchManualModeBackend(context, config, backendPort) {
  if (process.platform !== "win32") {
    throw new Error("cmd.exe launch is only supported on Windows")
  }
  const cwd = resolveWorkspaceDir(context.extensionPath)
  const command = `start "" /D "${cwd}" cmd.exe /d /k "${manualModeCommand(context, config, backendPort)}"`
  const child = childProcess.spawn(
    "cmd.exe",
    ["/d", "/c", command],
    {
      cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      windowsVerbatimArguments: true,
    },
  )
  child.unref()
  output.appendLine(`[manualMode] launched detached cmd.exe for backend port ${backendPort}`)
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port })
    socket.setTimeout(300)
    socket.on("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.on("timeout", () => {
      socket.destroy()
      resolve(false)
    })
    socket.on("error", () => resolve(false))
  })
}

async function resolvePackagedPort(preferred) {
  if (!(await isPortOpen(preferred))) return preferred
  if (await requestWithoutAuthOk(`http://127.0.0.1:${preferred}`)) return preferred
  const port = await findAvailablePort()
  output.appendLine(`[opencode] port ${preferred} is occupied or requires authentication, using ${port}`)
  return port
}

async function resolveDevBackendPort(preferred) {
  if (!(await isPortOpen(preferred))) return preferred
  if (await requestWithoutAuthOk(`http://127.0.0.1:${preferred}`)) return preferred
  const port = await findAvailablePort()
  output.appendLine(`[backend] port ${preferred} is occupied or requires authentication, using ${port}`)
  return port
}

async function resolveDevWebPort(preferred) {
  if (!(await isPortOpen(preferred))) return preferred
  const port = await findAvailablePort()
  output.appendLine(`[web] port ${preferred} is already listening for a different backend, using ${port}`)
  return port
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port)
          return
        }
        reject(new Error("Cannot allocate a local port"))
      })
    })
    server.on("error", reject)
  })
}

async function waitForHttp(url, name) {
  const started = Date.now()
  while (Date.now() - started < 30_000) {
    if (await requestOk(url)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${name} server did not become ready within 30 seconds: ${url}`)
}

function requestOk(url) {
  return new Promise((resolve) => {
    const request = http.request(url, { method: "HEAD", timeout: 1_000 }, (response) => {
      response.resume()
      resolve(response.statusCode >= 200 && response.statusCode < 500)
    })
    request.on("timeout", () => {
      request.destroy()
      resolve(false)
    })
    request.on("error", () => resolve(false))
    request.end()
  })
}

function requestWithoutAuthOk(url) {
  return new Promise((resolve) => {
    const request = http.request(url, { method: "HEAD", timeout: 1_000 }, (response) => {
      response.resume()
      resolve(response.statusCode >= 200 && response.statusCode < 400)
    })
    request.on("timeout", () => {
      request.destroy()
      resolve(false)
    })
    request.on("error", () => resolve(false))
    request.end()
  })
}

function requestOpencodeHealthOk(url) {
  return new Promise((resolve) => {
    const request = http.request(new URL("/global/health", url), { method: "GET", timeout: 1_000 }, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => {
        body += chunk
      })
      response.on("end", () => {
        try {
          resolve(response.statusCode >= 200 && response.statusCode < 300 && JSON.parse(body).healthy === true)
        } catch {
          resolve(false)
        }
      })
    })
    request.on("timeout", () => {
      request.destroy()
      resolve(false)
    })
    request.on("error", () => resolve(false))
    request.end()
  })
}

function createNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join("")
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;"
    if (char === "<") return "&lt;"
    if (char === ">") return "&gt;"
    if (char === '"') return "&quot;"
    return "&#039;"
  })
}

module.exports = {
  activate,
  deactivate,
}
