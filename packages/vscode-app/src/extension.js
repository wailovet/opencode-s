const childProcess = require("child_process")
const fs = require("fs")
const http = require("http")
const net = require("net")
const path = require("path")
const vscode = require("vscode")

const output = vscode.window.createOutputChannel("opencode App")
const processes = new Map()
let settingsPanel = undefined

function openSettingsPanel(provider) {
  if (settingsPanel) {
    settingsPanel.reveal()
    return
  }

  const panel = vscode.window.createWebviewPanel(
    "opencodeSettings",
    "OpenCode Settings",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  )

  const url = provider.webUrl()
  const origin = new URL(url).origin
  panel.webview.html = `
<!doctype html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>html,body,iframe{width:100%;height:100%;margin:0;padding:0;overflow:hidden;background:var(--vscode-editor-background)}iframe{width:100%;height:100%;border:0}</style>
</head><body>
<iframe src="${origin}/settings"></iframe>
</body></html>
`

  panel.onDidDispose(() => {
    settingsPanel = undefined
  })

  settingsPanel = panel
}

function activate(context) {
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
      await vscode.env.openExternal(vscode.Uri.parse(provider.webUrl()))
    }),
  )
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeVscodeApp.reload", () => {
      provider.reload()
    }),
  )
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeVscodeApp.openSettings", () => {
      openSettingsPanel(provider)
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
  }

  resolveWebviewView(view) {
    this.view = view
    view.webview.options = {
      enableScripts: true,
    }
    view.webview.onDidReceiveMessage(async (message) => {
      if (message.command === "restart") {
        stopProcesses()
        await this.refresh()
      }
      if (message.command === "openInBrowser") {
        await vscode.env.openExternal(vscode.Uri.parse(this.webUrl()))
      }
      if (message.command === "showLogs") {
        output.show()
      }
      if (message.command === "pickDirectory") {
        await this.pickDirectory(message)
      }
    })
    return this.refresh()
  }

  reload() {
    if (!this.view) return
    this.view.webview.html = this.html()
  }

  async refresh() {
    if (!this.view) return
    try {
      await ensureServices(this.context)
      this.view.webview.html = this.html()
    } catch (error) {
      this.view.webview.html = this.errorHtml(error)
    }
  }

  ports() {
    const config = vscode.workspace.getConfiguration("opencodeVscodeApp")
    return {
      backend: config.get("backendPort", 4096),
      web: config.get("webPort", 4444),
    }
  }

  webUrl(options = {}) {
    const url = new URL(`http://localhost:${this.ports().web}`)
    const workspaceDir = workspaceDirFromVSCode()
    if (workspaceDir) {
      const encoded = Buffer.from(workspaceDir, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
      url.pathname = "/" + encoded + "/session"
      url.searchParams.set("opencode_workspace", workspaceDir)
    }
    if (options.bridge) url.searchParams.set("opencode_vscode", "1")
    if (options.cacheBust) url.searchParams.set("t", String(options.cacheBust))
    return url.toString()
  }

  async pickDirectory(message) {
    const uris = await vscode.window.showOpenDialog({
      title: typeof message.title === "string" ? message.title : "Open project",
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: !!message.multiple,
      defaultUri: workspaceDirFromVSCode() ? vscode.Uri.file(workspaceDirFromVSCode()) : undefined,
      openLabel: "Open",
    })
    await this.view?.webview.postMessage({
      source: "opencode-vscode-app",
      command: "directoryPicked",
      requestId: message.requestId,
      result: uris ? uris.map((uri) => uri.fsPath) : null,
    })
  }

  html() {
    const nonce = createNonce()
    const appUrl = this.webUrl({ bridge: true })
    return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; frame-src http://localhost:${this.ports().web} http://127.0.0.1:${this.ports().web}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"
    >
    <style>
      html, body, iframe {
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 0;
        overflow: hidden;
        background: var(--vscode-editor-background);
      }
      iframe {
        width: 100%;
        height: 100%;
        border: 0;
      }
    </style>
  </head>
  <body>
    <iframe id="app" src="${appUrl}"></iframe>
    <script nonce="${nonce}">
      window.addEventListener("message", (event) => {
        const message = event.data
        if (!message || message.source !== "opencode-vscode-app") return
        if (message.command === "directoryPicked") {
          document.getElementById("app").contentWindow?.postMessage(message, "${new URL(appUrl).origin}")
        }
      })
    </script>
  </body>
</html>`
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

async function ensureServices(context) {
  const repoRoot = findRepoRoot(context.extensionPath)
  const workspaceDir = resolveWorkspaceDir(repoRoot)
  const buildDir = path.join(repoRoot, "build")
  const config = vscode.workspace.getConfiguration("opencodeVscodeApp")
  const backendPort = config.get("backendPort", 4096)
  const webPort = config.get("webPort", 4444)
  const bun = resolveBun(config.get("bunPath", ""))
  const env = {
    ...process.env,
    BUN_EXE: bun,
    BUN_INSTALL_CACHE_DIR: path.join(buildDir, "cache", "bun-install"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(buildDir, "cache", "bun-runtime"),
    OPENCODE_BUILD_DIR: buildDir,
    TEMP: path.join(buildDir, "tmp"),
    TMP: path.join(buildDir, "tmp"),
    TMPDIR: path.join(buildDir, "tmp"),
    VITE_OPENCODE_SERVER_HOST: "localhost",
    VITE_OPENCODE_SERVER_PORT: String(backendPort),
    PATH: `${path.dirname(bun)}${path.delimiter}${process.env.PATH ?? ""}`,
  }
  fs.mkdirSync(env.BUN_INSTALL_CACHE_DIR, { recursive: true })
  fs.mkdirSync(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH, { recursive: true })
  fs.mkdirSync(env.TMP, { recursive: true })

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

  if (!(await isPortOpen(webPort))) {
    clearViteCache(buildDir)
    startProcess("web", bun, ["run", "dev", "--", "--port", String(webPort), "--host", "127.0.0.1", "--force"], {
      cwd: path.join(repoRoot, "packages", "app"),
      env,
    })
  } else {
    output.appendLine(`[web] port ${webPort} is already listening`)
  }

  await waitForHttp(`http://127.0.0.1:${webPort}`, "web")
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

function stopProcesses() {
  for (const child of processes.values()) {
    child.kill()
  }
  processes.clear()
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
