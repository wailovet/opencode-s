const childProcess = require("child_process")
const fs = require("fs")
const http = require("http")
const net = require("net")
const path = require("path")
const vscode = require("vscode")

const output = vscode.window.createOutputChannel("opencode App")
const processes = new Map()
const WEBVIEW_STORAGE_KEY = "opencode.vscode.storage"
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
    this.httpProxyControllers = new Map()
    this.sseProxyControllers = new Map()
    this.webSocketProxySockets = new Map()
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
      await this.storageSet(message, webview)
    }
    if (message.command === "storageRemove") {
      await this.storageRemove(message, webview)
    }
    if (message.command === "storageClear") {
      await this.storageClear(webview)
    }
    if (message.command === "storageReplace") {
      await this.storageReplace(message, webview)
    }
    if (message.command === "httpProxyRequest") {
      await this.httpProxy(message, webview)
    }
    if (message.command === "httpProxyCancel") {
      this.cancelHttpProxy(message)
    }
    if (message.command === "sseProxyOpen") {
      await this.sseProxy(message, webview)
    }
    if (message.command === "sseProxyCancel") {
      this.cancelSseProxy(message)
    }
    if (message.command === "webSocketProxyOpen") {
      this.webSocketProxy(message, webview)
    }
    if (message.command === "webSocketProxySend") {
      this.sendWebSocketProxy(message)
    }
    if (message.command === "webSocketProxyClose") {
      this.closeWebSocketProxy(message)
    }
    if (message.command === "openSessionPanel") {
      await openSessionPanel(this, message.sessionDir, message.sessionId, webview)
    }
    if (message.command === "openNewSessionPanel") {
      await openNewSessionPanel(this, message.sessionDir, webview)
    }
  }

  async reload() {
    if (!this.view) return
    this.view.webview.html = this.localAppHtml(this.view.webview)
  }

  async refresh() {
    if (!this.view) return
    try {
      const ports = await ensureServices(this.context)
      this.runtimePort = ports.web
      this.backendPort = ports.backend
      this.view.webview.options = {
        enableScripts: true,
        localResourceRoots: this.localResourceRoots(),
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
    if (options.settings) return "/settings"
    const encode = (dir) => Buffer.from(dir, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
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
    return "/" + encode(workspaceDir) + "/vscode-sessions"
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

  backendUrl() {
    const port = this.backendPort || this.ports().backend
    if (!port) throw new Error("opencode backend port is not initialized")
    return `http://127.0.0.1:${port}`
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
    const assetBase = webview.asWebviewUri(vscode.Uri.file(path.join(webDistDir, "assets"))).toString() + "/"
    output.appendLine("[localAppHtml] appPath=" + JSON.stringify(this.appPath(options)) + " distDir=" + this.webDistDir())
    const routeScript = `<meta http-equiv="Content-Security-Policy" content="${localWebviewCsp(webview, nonce)}">
    <script nonce="${nonce}">window.__opencodeVSCodeAssetBase = ${JSON.stringify(assetBase)}; window.__opencodeVSCodeAppPath = ${JSON.stringify(this.appPath(options))}; window.__opencodeVSCodeBackendUrl = ${JSON.stringify(this.backendUrl())}; window.__opencodeVSCodeStorageSnapshot = ${JSON.stringify(this.storageSnapshot())}; (function(){try{var s=window.__opencodeVSCodeStorageSnapshot||{};if(Object.keys(s).length){localStorage.clear();Object.keys(s).forEach(function(k){localStorage.setItem(k,String(s[k]))})}}catch(e){}})(); history.replaceState(history.state, "", ${JSON.stringify(this.appPath(options))})</script>`
    return injectLocalSpriteSymbols(
      rewriteLocalAppHtml(html, webview, webDistDir, nonce).replace(/<head([^>]*)>/i, `<head$1>
    ${routeScript}`),
      webDistDir,
    )
  }

  storageSnapshot() {
    return normalizeStorageSnapshot(this.context.globalState.get(WEBVIEW_STORAGE_KEY))
  }

  async storageSet(message, sourceWebview) {
    if (typeof message.key !== "string" || typeof message.value !== "string") return
    const next = { ...this.storageSnapshot(), [message.key]: message.value }
    await this.context.globalState.update(WEBVIEW_STORAGE_KEY, next)
    this.broadcastStorage({ type: "set", key: message.key, value: message.value }, sourceWebview)
  }

  async storageRemove(message, sourceWebview) {
    if (typeof message.key !== "string") return
    const next = { ...this.storageSnapshot() }
    delete next[message.key]
    await this.context.globalState.update(WEBVIEW_STORAGE_KEY, next)
    this.broadcastStorage({ type: "remove", key: message.key }, sourceWebview)
  }

  async storageClear(sourceWebview) {
    await this.context.globalState.update(WEBVIEW_STORAGE_KEY, {})
    this.broadcastStorage({ type: "clear" }, sourceWebview)
  }

  async storageReplace(message, sourceWebview) {
    const next = normalizeStorageSnapshot(message.entries)
    await this.context.globalState.update(WEBVIEW_STORAGE_KEY, next)
    this.broadcastStorage({ type: "replace", entries: next }, sourceWebview)
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

  cancelHttpProxy(message) {
    const controller = this.httpProxyControllers.get(message.requestId)
    if (!controller) return
    controller.abort()
    this.httpProxyControllers.delete(message.requestId)
  }

  async httpProxy(message, webview) {
    const requestId = message.requestId
    if (typeof requestId !== "string") return
    const targetUrl = this.httpProxyUrl(message)
    output.appendLine(`[httpProxy] ${message.method ?? "GET"} ${message.url} -> ${targetUrl}`)
    const controller = new AbortController()
    this.httpProxyControllers.set(requestId, controller)
    try {
      const response = await fetch(targetUrl, {
        method: typeof message.method === "string" ? message.method : "GET",
        headers: this.httpProxyHeaders(message.headers),
        body: typeof message.body === "string" ? Buffer.from(message.body, "base64") : undefined,
        signal: controller.signal,
      })
      output.appendLine(`[httpProxy] response ${response.status} ${response.statusText} ${targetUrl}`)
      const body = Buffer.from(await response.arrayBuffer()).toString("base64")
      await webview.postMessage({
        source: "opencode-vscode-app",
        command: "httpProxyResponse",
        requestId,
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
        body,
      })
    } catch (error) {
      if (controller.signal.aborted) return
      output.appendLine(
        `[httpProxy] error ${targetUrl}: ${error instanceof Error ? error.message : String(error)}`,
      )
      await webview.postMessage({
        source: "opencode-vscode-app",
        command: "httpProxyResponse",
        requestId,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.httpProxyControllers.delete(requestId)
    }
  }

  httpProxyUrl(message) {
    if (typeof message.url !== "string") throw new Error("Missing proxy URL")
    const url = new URL(message.url)
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Refusing non-HTTP proxy URL")
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error("Refusing non-local proxy URL")
    if (this.backendPort) {
      url.protocol = "http:"
      url.hostname = "127.0.0.1"
      url.port = String(this.backendPort)
    }
    return url
  }

  httpProxyHeaders(headers) {
    if (!Array.isArray(headers)) return undefined
    return Object.fromEntries(
      headers.filter((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2) return false
        if (typeof entry[0] !== "string" || typeof entry[1] !== "string") return false
        return !["connection", "content-length", "host", "keep-alive", "transfer-encoding"].includes(
          entry[0].toLowerCase(),
        )
      }),
    )
  }

  cancelSseProxy(message) {
    const controller = this.sseProxyControllers.get(message.requestId)
    if (!controller) return
    controller.abort()
    this.sseProxyControllers.delete(message.requestId)
  }

  async sseProxy(message, webview) {
    const requestId = message.requestId
    if (typeof requestId !== "string") return
    const targetUrl = this.httpProxyUrl(message)
    output.appendLine(`[sseProxy] ${message.method ?? "GET"} ${message.url} -> ${targetUrl}`)
    const controller = new AbortController()
    this.sseProxyControllers.set(requestId, controller)
    try {
      const response = await fetch(targetUrl, {
        method: typeof message.method === "string" ? message.method : "GET",
        headers: this.httpProxyHeaders(message.headers),
        body: typeof message.body === "string" ? Buffer.from(message.body, "base64") : undefined,
        signal: controller.signal,
      })
      output.appendLine(`[sseProxy] response ${response.status} ${response.statusText} ${targetUrl}`)
      if (!response.ok || !response.body) {
        throw new Error(`SSE proxy failed with ${response.status} ${response.statusText}`)
      }
      const reader = response.body.getReader()
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        await webview.postMessage({
          source: "opencode-vscode-app",
          command: "sseProxyChunk",
          requestId,
          body: Buffer.from(chunk.value).toString("base64"),
        })
      }
      await webview.postMessage({
        source: "opencode-vscode-app",
        command: "sseProxyClose",
        requestId,
      })
      output.appendLine(`[sseProxy] close ${targetUrl}`)
    } catch (error) {
      if (controller.signal.aborted) return
      output.appendLine(
        `[sseProxy] error ${targetUrl}: ${error instanceof Error ? error.message : String(error)}`,
      )
      await webview.postMessage({
        source: "opencode-vscode-app",
        command: "sseProxyError",
        requestId,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.sseProxyControllers.delete(requestId)
    }
  }

  webSocketProxy(message, webview) {
    const requestId = message.requestId
    if (typeof requestId !== "string") return
    try {
      if (typeof WebSocket !== "function") throw new Error("WebSocket is not available in the VS Code extension host")
      const targetUrl = this.webSocketProxyUrl(message)
      output.appendLine(`[webSocketProxy] ${message.url} -> ${targetUrl}`)
      const socket = new WebSocket(targetUrl, normalizeWebSocketProtocols(message.protocols))
      socket.binaryType = "arraybuffer"
      this.webSocketProxySockets.set(requestId, socket)
      socket.addEventListener("open", async () => {
        output.appendLine(`[webSocketProxy] open ${targetUrl}`)
        await webview.postMessage({
          source: "opencode-vscode-app",
          command: "webSocketProxyOpen",
          requestId,
        })
      })
      socket.addEventListener("message", async (event) => {
        const payload = await webSocketMessagePayload(event.data)
        await webview.postMessage({
          source: "opencode-vscode-app",
          command: "webSocketProxyMessage",
          requestId,
          ...payload,
        })
      })
      socket.addEventListener("error", async () => {
        output.appendLine(`[webSocketProxy] error ${targetUrl}`)
        await webview.postMessage({
          source: "opencode-vscode-app",
          command: "webSocketProxyError",
          requestId,
        })
      })
      socket.addEventListener("close", async (event) => {
        this.webSocketProxySockets.delete(requestId)
        output.appendLine(
          `[webSocketProxy] close ${targetUrl} code=${event.code} reason=${event.reason} clean=${event.wasClean}`,
        )
        await webview.postMessage({
          source: "opencode-vscode-app",
          command: "webSocketProxyClose",
          requestId,
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        })
      })
    } catch (error) {
      webview.postMessage({
        source: "opencode-vscode-app",
        command: "webSocketProxyClose",
        requestId,
        code: 1011,
        reason: error instanceof Error ? error.message : String(error),
        wasClean: false,
      })
    }
  }

  sendWebSocketProxy(message) {
    const socket = this.webSocketProxySockets.get(message.requestId)
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (message.binary) {
      socket.send(Buffer.from(String(message.body ?? ""), "base64"))
      return
    }
    socket.send(String(message.body ?? ""))
  }

  closeWebSocketProxy(message) {
    const socket = this.webSocketProxySockets.get(message.requestId)
    if (!socket) return
    socket.close(typeof message.code === "number" ? message.code : undefined, typeof message.reason === "string" ? message.reason : undefined)
  }

  webSocketProxyUrl(message) {
    if (typeof message.url !== "string") throw new Error("Missing proxy URL")
    const url = new URL(message.url)
    if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Refusing non-WebSocket proxy URL")
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error("Refusing non-local proxy URL")
    if (!url.pathname.startsWith("/pty/") || !url.pathname.endsWith("/connect")) {
      throw new Error("Refusing unsupported WebSocket proxy URL")
    }
    if (this.backendPort) {
      url.protocol = "ws:"
      url.hostname = "127.0.0.1"
      url.port = String(this.backendPort)
    }
    return url
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

function normalizeStorageSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry) => typeof entry[0] === "string" && typeof entry[1] === "string"),
  )
}

function stopProcesses() {
  for (const child of processes.values()) {
    child.kill()
  }
  processes.clear()
}

function normalizeWebSocketProtocols(protocols) {
  if (typeof protocols === "string") return protocols
  if (!Array.isArray(protocols)) return undefined
  return protocols.filter((protocol) => typeof protocol === "string")
}

async function webSocketMessagePayload(data) {
  if (typeof data === "string") return { body: data, binary: false }
  if (data instanceof ArrayBuffer) return { body: Buffer.from(data).toString("base64"), binary: true }
  if (ArrayBuffer.isView(data)) {
    return { body: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64"), binary: true }
  }
  if (data && typeof data.arrayBuffer === "function") {
    return { body: Buffer.from(await data.arrayBuffer()).toString("base64"), binary: true }
  }
  return { body: Buffer.from(data ?? "").toString("base64"), binary: true }
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
