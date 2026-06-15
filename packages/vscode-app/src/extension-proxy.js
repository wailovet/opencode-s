/**
 * ExtensionHttpProxyBridge —— 在 VS Code Extension Host 进程中处理代理请求。
 *
 * 【职责】
 * 接收来自 Webview 侧（vscode-http-proxy.ts）的 postMessage 请求，
 * 在 Extension Host 进程中执行真实的网络 I/O，并将结果通过 postMessage 返回。
 *
 * 【协议】
 *
 *   Webview → Extension Host:
 *     { command: "proxyFetch",  requestId, url, method, headers, body }
 *     { command: "proxyCancel", requestId }
 *     { command: "webSocketProxyOpen",  requestId, url, protocols }
 *     { command: "webSocketProxySend",  requestId, body, binary }
 *     { command: "webSocketProxyClose", requestId, code, reason }
 *
 *   Extension Host → Webview:
 *     { command: "proxyMeta",   requestId, status, statusText, headers }
 *     { command: "proxyChunk",  requestId, body: "<base64>" }
 *     { command: "proxyClose",  requestId }
 *     { command: "proxyError",  requestId, error }
 *     { command: "webSocketProxyOpen",    requestId }
 *     { command: "webSocketProxyMessage", requestId, body, binary }
 *     { command: "webSocketProxyError",   requestId }
 *     { command: "webSocketProxyClose",   requestId, code, reason, wasClean }
 *
 * 【使用方式】（在 extension.js 中）
 *
 *   const { ExtensionHttpProxyBridge } = require("./extension-proxy")
 *
 *   class OpenCodeAppViewProvider {
 *     constructor(context) {
 *       this.proxy = new ExtensionHttpProxyBridge(output)
 *     }
 *
 *     async handleMessage(message, webview) {
 *       if (message.command === "proxyFetch")
 *         await this.proxy.proxyFetch(message, webview)
 *       if (message.command === "proxyCancel")
 *         this.proxy.cancelProxy(message)
 *       // ...
 *     }
 *   }
 */

// ── 主类 ──

class ExtensionHttpProxyBridge {
  /**
   * @param {{ appendLine: (msg: string) => void }} logger - 日志输出通道
   */
  constructor(logger) {
    this.log = logger

    /** 活跃请求的 AbortController 集合 */
    this.activeControllers = new Map()
    /** 活跃的 WebSocket 连接集合 */
    this.webSocketSockets = new Map()
    /**
     * 后端真实地址（如 http://127.0.0.1:12377）。
     * 由 extension.js 在后端启动后注入；用于把 webview 误用 location.origin 拼成的
     * vscode-webview://<host>/<path> 请求改写回真实后端。
     * 为空字符串表示未配置，此时不做改写。
     */
    this.baseUrl = ""
  }

  // ── 统一 HTTP/SSE 代理 ────────────────────────────

  /**
   * 取消正在进行的请求。
   */
  cancelProxy(message) {
    const controller = this.activeControllers.get(message.requestId)
    if (!controller) return
    controller.abort()
    this.activeControllers.delete(message.requestId)
  }

  /**
   * 【核心】处理所有 HTTP 请求（普通 API + SSE 流式统一路径）。
   *
   * 流程：
   *   1. 安全检查（resolveUrl）—— 拒绝非 localhost 请求
   *   2. 用 Node.js fetch 向真实后端发出请求
   *   3. 先发送 proxyMeta（状态码 + 响应头）
   *   4. 通过 response.body.getReader() 逐块读取响应体
   *   5. 每块转 base64，通过 proxyChunk 推送给 webview
   *   6. 流结束后发送 proxyClose，出错发送 proxyError
   *
   * SSE 和非 SSE 请求走同一条路径，统一流式处理。
   *
   * @param {{ requestId: string, url: string, method?: string, headers?: [string,string][], body?: string }} message
   * @param {{ postMessage: (msg: object) => Thenable<boolean> }} webview
   */
  async proxyFetch(message, webview) {
    const requestId = message.requestId
    if (typeof requestId !== "string") return
    const targetUrl = this.resolveUrl(message.url, "http")
    this.log.appendLine(`[proxyFetch] ${message.method ?? "GET"} ${message.url} -> ${targetUrl}`)
    const controller = new AbortController()
    this.activeControllers.set(requestId, controller)
    try {
      const response = await fetch(targetUrl, {
        method: typeof message.method === "string" ? message.method : "GET",
        headers: this.cleanHeaders(message.headers),
        body: typeof message.body === "string" ? Buffer.from(message.body, "base64") : undefined,
        signal: controller.signal,
      })
      this.log.appendLine(`[proxyFetch] response ${response.status} ${response.statusText} ${targetUrl}`)

      // 先发响应元数据
      await webview.postMessage({
        source: "opencode-vscode-app",
        command: "proxyMeta",
        requestId,
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
      })

      // 流式读取响应体
      if (response.body) {
        const reader = response.body.getReader()
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          await webview.postMessage({
            source: "opencode-vscode-app",
            command: "proxyChunk",
            requestId,
            body: Buffer.from(chunk.value).toString("base64"),
          })
        }
      }

      await webview.postMessage({
        source: "opencode-vscode-app",
        command: "proxyClose",
        requestId,
      })
      this.log.appendLine(`[proxyFetch] close ${targetUrl}`)
    } catch (error) {
      if (controller.signal.aborted) return
      this.log.appendLine(
        `[proxyFetch] error ${targetUrl}: ${error instanceof Error ? error.message : String(error)}`,
      )
      try {
        await webview.postMessage({
          source: "opencode-vscode-app",
          command: "proxyError",
          requestId,
          error: error instanceof Error ? error.message : String(error),
        })
      } catch {}
    } finally {
      this.activeControllers.delete(requestId)
    }
  }

  // ── URL 解析与安全检查 ─────────────────────────────

  /**
   * 把 vscode-webview:// 协议的请求改写为后端真实地址。
   *
   * Webview 运行在 vscode-webview:// 协议下，前端代码误用 location.origin 作为 baseUrl 时，
   * 会拼出 vscode-webview://<host>/<path> 这类请求（扩展没有对应的静态文件）。
   * 这里仅替换 origin，保留 pathname + search + hash，转发到 baseUrl 指向的后端。
   *
   *   vscode-webview://xxx/global/config?a=1
   *     -> http://127.0.0.1:12377/global/config?a=1
   *
   * 非 vscode-webview 协议、或 baseUrl 未配置时原样返回。
   */
  rewriteWebviewUrl(urlString) {
    if (typeof urlString !== "string") return urlString
    if (!this.baseUrl) return urlString
    let url
    try {
      url = new URL(urlString)
    } catch {
      return urlString
    }
    if (url.protocol !== "vscode-webview:") return urlString
    const rewritten = `${this.baseUrl.replace(/\/+$/, "")}${url.pathname}${url.search}${url.hash}`
    this.log.appendLine(`[rewriteWebview] ${urlString} -> ${rewritten}`)
    return rewritten
  }

  /**
   * 解析并验证请求 URL。
   *
   * 流程：
   *   1. 先用 rewriteWebviewUrl 把 vscode-webview:// 改写为后端地址
   *   2. 再做安全检查（仅允许 http/https/ws/wss + localhost/127.0.0.1）
   *
   * 改写后的 URL 已经是 http://127.0.0.1:...，会自然通过校验。
   */
  resolveUrl(urlString, expectedProtocol) {
    const rewritten = this.rewriteWebviewUrl(urlString)
    if (typeof rewritten !== "string") throw new Error("Missing proxy URL")
    const url = new URL(rewritten)

    if (expectedProtocol === "http") {
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Refusing non-HTTP proxy URL")
    } else if (expectedProtocol === "ws") {
      if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Refusing non-WebSocket proxy URL")
    }

    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error("Refusing non-local proxy URL")

    return url
  }

  /**
   * 过滤跳转头（hop-by-hop headers）。
   * 移除：connection, content-length, host, keep-alive, transfer-encoding
   */
  cleanHeaders(headers) {
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

  // ── WebSocket 代理 ──────────────────────────────────

  /**
   * 建立 WebSocket 代理连接。
   *
   * 在 Extension Host 进程中创建真实 WebSocket 连接到后端，
   * 建立双向管道桥接 webview 与后端。
   */
  webSocketProxy(message, webview) {
    const requestId = message.requestId
    if (typeof requestId !== "string") return
    try {
      if (typeof WebSocket !== "function") throw new Error("WebSocket is not available in the VS Code extension host")
      const targetUrl = this.resolveUrl(message.url, "ws")
      this.log.appendLine(`[webSocketProxy] ${message.url} -> ${targetUrl}`)
      const socket = new WebSocket(targetUrl, normalizeWebSocketProtocols(message.protocols))
      socket.binaryType = "arraybuffer"
      this.webSocketSockets.set(requestId, socket)
      socket.addEventListener("open", async () => {
        this.log.appendLine(`[webSocketProxy] open ${targetUrl}`)
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
        this.log.appendLine(`[webSocketProxy] error ${targetUrl}`)
        await webview.postMessage({
          source: "opencode-vscode-app",
          command: "webSocketProxyError",
          requestId,
        })
      })
      socket.addEventListener("close", async (event) => {
        this.webSocketSockets.delete(requestId)
        this.log.appendLine(
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
    const socket = this.webSocketSockets.get(message.requestId)
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (message.binary) {
      socket.send(Buffer.from(String(message.body ?? ""), "base64"))
      return
    }
    socket.send(String(message.body ?? ""))
  }

  closeWebSocketProxy(message) {
    const socket = this.webSocketSockets.get(message.requestId)
    if (!socket) return
    socket.close(
      typeof message.code === "number" ? message.code : undefined,
      typeof message.reason === "string" ? message.reason : undefined,
    )
  }
}

// ── 工具函数 ──

/** 标准化 WebSocket 子协议参数 */
function normalizeWebSocketProtocols(protocols) {
  if (typeof protocols === "string") return protocols
  if (!Array.isArray(protocols)) return undefined
  return protocols.filter((protocol) => typeof protocol === "string")
}

/** 将 WebSocket 消息事件的 data 编码为 postMessage 可传输的 payload */
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

module.exports = { ExtensionHttpProxyBridge, normalizeWebSocketProtocols, webSocketMessagePayload }
