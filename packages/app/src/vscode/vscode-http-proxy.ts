/**
 * VSCodeHttpProxy —— VSCode Webview HTTP/WebSocket 代理桥接
 *
 * Webview 运行在 vscode-webview:// 协议下，无法直接发起 HTTP/WebSocket 请求。
 * 本类拦截所有网络请求，通过 postMessage 转发给 Extension Host 代发。
 *
 * 【使用方式】
 *
 *   import { VSCodeHttpProxy } from "./vscode-http-proxy"
 *
 *   VSCodeHttpProxy.install()        // 拦截 window.fetch + window.WebSocket
 *
 *   // 工具方法：
 *   VSCodeHttpProxy.api()            // 获取 acquireVsCodeApi 实例
 *   VSCodeHttpProxy.postMessage({})  // 向 Extension Host 发消息
 *   VSCodeHttpProxy.isInWebview()    // 是否在 VSCode Webview 中
 */

// ── 类型 ──

type VSCodeWebviewApi = { postMessage(message: unknown): void }

// ── 常量 ──

const PROXY_TIMEOUT_MS = 120_000

// ── 类定义 ──

export class VSCodeHttpProxy {
  // ── 安装桥接 ────────────────────────────────────

  /**
   * 安装全部代理桥接（HTTP + WebSocket）。
   * 调用一次即可，内部有防重复标记。
   *
   *   VSCodeHttpProxy.install()
   *   // 之后所有 fetch() 和 new WebSocket("ws://localhost...") 自动走代理
   */
  static install() {
    if (typeof window === "undefined") return
    const hasApi = !!this.api()
    console.log(`[proxyHTTP] install: vscodeApi=${hasApi} localStorage defaultServerUrl=${window.localStorage.getItem("opencode.settings.dat:defaultServerUrl")}`)
    if (!hasApi) {
      console.log("[proxyHTTP] skipped: vscodeApi() not available")
      return
    }
    console.log("[proxyHTTP] installing proxy bridge")
    this.installHttpProxy()
    this.installWebSocketProxy()
    console.log("[proxyHTTP] proxy bridge installed")
  }

  private static installHttpProxy() {
    const target = window as typeof window & { __opencodeVSCodeFetchPatched?: boolean }
    if (target.__opencodeVSCodeFetchPatched) return
    target.__opencodeVSCodeFetchPatched = true

    const originalFetch = window.fetch
    window.fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = this.requestUrl(input)
      console.log(`[proxyHTTP] fetch ${request.method} ${request.url} protocol=${url.protocol} pathname=${url.pathname}`)
      // https://（asWebviewUri）协议的资源由 VSCode 内核提供，直接放行
      if (url.protocol === "https:") {
        console.log(`[proxyHTTP] bypass ${request.method} ${request.url} (${url.protocol} protocol)`)
        return originalFetch.call(window, request)
      }
      // vscode-webview:// 协议：前端误用 location.origin 拼出的请求（扩展无对应静态文件），
      // 转发给 Extension Host，由其在 resolveUrl 中改写回真实后端地址
      if (url.protocol === "vscode-webview:") {
        console.log(`[proxyHTTP] intercept(vscode-webview) ${request.method} ${request.url}`)
        return this.proxyFetch(request)
      }
      console.log(`[proxyHTTP] intercept ${request.method} ${request.url}`)
      return this.proxyFetch(request)
    }
  }

  private static installWebSocketProxy() {
    const target = window as typeof window & { __opencodeVSCodeWebSocketPatched?: boolean }
    if (target.__opencodeVSCodeWebSocketPatched) return
    target.__opencodeVSCodeWebSocketPatched = true

    const NativeWebSocket = window.WebSocket
    const factory = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
      if (VSCodeHttpProxy.isWebSocketProxyUrl(url)) {
        return new VSCodeProxyWebSocket(String(url), protocols) as unknown as WebSocket
      }
      return new NativeWebSocket(url, protocols)
    }
    Object.defineProperties(factory, {
      CONNECTING: { value: NativeWebSocket.CONNECTING },
      OPEN: { value: NativeWebSocket.OPEN },
      CLOSING: { value: NativeWebSocket.CLOSING },
      CLOSED: { value: NativeWebSocket.CLOSED },
    })
    window.WebSocket = factory as unknown as typeof WebSocket
  }

  // ── VSCode API 工具 ──────────────────────────────

  /** 获取 acquireVsCodeApi 实例。不在 Webview 中时返回 undefined。 */
  static api() {
    const target = window as typeof window & {
      acquireVsCodeApi?: () => VSCodeWebviewApi
      __opencodeVSCodeApi?: VSCodeWebviewApi
    }
    if (!target.__opencodeVSCodeApi && typeof target.acquireVsCodeApi === "function") {
      target.__opencodeVSCodeApi = target.acquireVsCodeApi()
    }
    return target.__opencodeVSCodeApi
  }

  /**
   * 向 Extension Host 发送消息。
   * 优先走 VSCode API，不可用时 fallback 到 window.parent。
   */
  static postMessage(message: unknown) {
    const api = this.api()
    if (api) {
      api.postMessage(message)
      return
    }
    window.parent.postMessage(message, "*")
  }

  /** 判断 message 事件是否来自可信的 Extension Host。 */
  static isBridgeMessage(event: MessageEvent) {
    if (this.api()) return true
    return event.source === window.parent
  }

  /** 检测是否运行在 VSCode Webview 环境中。 */
  static isInWebview() {
    return !!this.api()
  }

  // ── 内部实现 ────────────────────────────────────

  private static requestUrl(input: RequestInfo | URL) {
    if (input instanceof Request) return new URL(input.url)
    return new URL(String(input), window.location.href)
  }

  private static createRequestId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }

  static uint8ArrayToBase64(bytes: Uint8Array) {
    let binary = ""
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
  }

  static base64ToUint8Array(value: string) {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  private static abortError() {
    return new DOMException("The operation was aborted.", "AbortError")
  }

  private static isWebSocketProxyUrl(input: string | URL) {
    const url = new URL(String(input), window.location.href)
    return (url.protocol === "ws:" || url.protocol === "wss:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  }

  /**
   * 【核心】统一的代理请求实现。
   *
   * 所有 HTTP 请求（包括 SSE）走同一条路径，流式处理。
   * Extension Host 先返回 proxyMeta（状态码/头），再流式返回 proxyChunk（数据块）。
   */
  private static async proxyFetch(input: RequestInfo | URL, init?: RequestInit) {
    const request = new Request(input, init)
    const requestId = this.createRequestId()
    const startedAt = Date.now()
    const ms = () => `${Date.now() - startedAt}ms`
    console.log(`[proxyHTTP] proxyFetch ${requestId} enter ${request.method} ${request.url}`)

    if (request.signal.aborted) throw this.abortError()

    const payload = await this.proxyRequestPayload(request)
    console.log(`[proxyHTTP] send ${requestId} ${request.method} ${payload.url} payloadReady=${ms()}`)
    this.postMessage({
      source: "opencode-vscode-app",
      command: "proxyFetch",
      requestId,
      ...payload,
    })

    return new Promise<Response>((resolve, reject) => {
      let controller: ReadableStreamController<Uint8Array> | null = null
      let streamStarted = false
      let settled = false
      let pendingChunks: Array<{ body: string }> = []
      let totalBytes = 0
      let chunkCount = 0
      let metaAt = 0

      const cleanup = () => {
        window.removeEventListener("message", onMessage)
        request.signal.removeEventListener("abort", onAbort)
        clearTimeout(timeoutId)
      }

      const onAbort = () => {
        if (settled) return
        settled = true
        this.postMessage({
          source: "opencode-vscode-app",
          command: "proxyCancel",
          requestId,
        })
        cleanup()
        if (controller) controller.error(this.abortError())
        else reject(this.abortError())
      }

      const timeoutId = setTimeout(() => {
        if (settled) return
        settled = true
        console.log(`[proxyHTTP] timeout ${requestId} ${request.url} at=${ms()}`)
        this.postMessage({
          source: "opencode-vscode-app",
          command: "proxyCancel",
          requestId,
        })
        cleanup()
        reject(new Error("VS Code HTTP proxy timed out"))
      }, PROXY_TIMEOUT_MS)

      const onMessage = (event: MessageEvent) => {
        if (settled) return
        if (!VSCodeHttpProxy.isBridgeMessage(event)) return
        const msg = event.data
        if (!msg || msg.source !== "opencode-vscode-app" || msg.requestId !== requestId) return

        if (msg.command === "proxyMeta" && !streamStarted) {
          streamStarted = true
          metaAt = Date.now() - startedAt
          console.log(`[proxyHTTP] meta ${requestId} ${msg.status} ${msg.statusText} ttfb=${metaAt}ms`)
          const stream = new ReadableStream<Uint8Array>({
            start(c) { controller = c },
            cancel() {
              VSCodeHttpProxy.postMessage({
                source: "opencode-vscode-app",
                command: "proxyCancel",
                requestId,
              })
            },
          })
          resolve(new Response(stream, {
            status: msg.status,
            statusText: msg.statusText,
            headers: msg.headers,
          }))
          for (const chunk of pendingChunks) {
            const bytes = VSCodeHttpProxy.base64ToUint8Array(String(chunk.body ?? ""))
            totalBytes += bytes.byteLength
            chunkCount += 1
            controller!.enqueue(bytes)
          }
          pendingChunks = []
          return
        }

        if (msg.command === "proxyChunk") {
          if (controller) {
            const bytes = VSCodeHttpProxy.base64ToUint8Array(String(msg.body ?? ""))
            totalBytes += bytes.byteLength
            chunkCount += 1
            controller.enqueue(bytes)
          } else {
            pendingChunks.push({ body: msg.body })
          }
          return
        }

        if (msg.command === "proxyClose") {
          settled = true
          cleanup()
          console.log(
            `[proxyHTTP] close ${requestId} total=${ms()} ttfb=${metaAt}ms body=${totalBytes}B chunks=${chunkCount}`,
          )
          if (controller) controller.close()
          return
        }

        if (msg.command === "proxyError") {
          settled = true
          cleanup()
          const errMsg = String(msg.error ?? "VS Code proxy failed")
          console.log(`[proxyHTTP] error ${requestId} ${errMsg} at=${ms()}`)
          const proxyErr = new Error(errMsg)
          if (controller) controller.error(proxyErr)
          else reject(proxyErr)
        }
      }

      request.signal.addEventListener("abort", onAbort, { once: true })
      window.addEventListener("message", onMessage)
    })
  }

  private static async proxyRequestPayload(request: Request) {
    return {
      url: request.url,
      method: request.method,
      // 网页来源引用地址：Extension Host 默认拿不到 webview 的 location，
      // 这里把当前页面的 origin 传过去（去掉 path），用于后端同源改写判断
      origin: (() => {
        try {
          return new URL(window.location.href).origin
        } catch {
          return window.location.origin
        }
      })(),
      headers: [...request.headers.entries()],
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : this.uint8ArrayToBase64(new Uint8Array(await request.arrayBuffer())),
    }
  }
}

// ── VSCodeProxyWebSocket（WebSocket 代理实现）─────

/**
 * 不创建真实 WebSocket 的代理实现。
 * 通过 EventTarget + postMessage 模拟标准 WebSocket 接口，
 * 底层与 Extension Host 中的真实 WebSocket 双向桥接。
 */
class VSCodeProxyWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readonly url: string
  readonly protocol = ""
  readonly extensions = ""
  bufferedAmount = 0
  binaryType: BinaryType = "blob"
  readyState = WebSocket.CONNECTING
  onopen: ((this: WebSocket, event: Event) => unknown) | null = null
  onmessage: ((this: WebSocket, event: MessageEvent) => unknown) | null = null
  onerror: ((this: WebSocket, event: Event) => unknown) | null = null
  onclose: ((this: WebSocket, event: CloseEvent) => unknown) | null = null
  private readonly requestId = VSCodeHttpProxy.createRequestId!()
  private readonly onParentMessage = (event: MessageEvent) => this.receive(event)

  constructor(url: string, protocols?: string | string[]) {
    super()
    this.url = new URL(url, window.location.href).toString()
    window.addEventListener("message", this.onParentMessage)
    VSCodeHttpProxy.postMessage({
      source: "opencode-vscode-app",
      command: "webSocketProxyOpen",
      requestId: this.requestId,
      url: this.url,
      protocols,
    })
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== WebSocket.OPEN) throw new DOMException("WebSocket is not open", "InvalidStateError")
    void webSocketPayload(data).then((payload) => {
      VSCodeHttpProxy.postMessage({
        source: "opencode-vscode-app",
        command: "webSocketProxySend",
        requestId: this.requestId,
        ...payload,
      })
    })
  }

  close(code?: number, reason?: string) {
    if (this.readyState === WebSocket.CLOSING || this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSING
    VSCodeHttpProxy.postMessage({
      source: "opencode-vscode-app",
      command: "webSocketProxyClose",
      requestId: this.requestId,
      code,
      reason,
    })
  }

  private receive(event: MessageEvent) {
    if (!VSCodeHttpProxy.isBridgeMessage(event)) return
    const message = event.data
    if (!message || message.source !== "opencode-vscode-app" || message.requestId !== this.requestId) return
    if (message.command === "webSocketProxyOpen") {
      this.readyState = WebSocket.OPEN
      this.emit(new Event("open"))
      return
    }
    if (message.command === "webSocketProxyMessage") {
      this.emit(
        new MessageEvent("message", {
          data: message.binary ? VSCodeHttpProxy.base64ToUint8Array(String(message.body ?? "")).buffer : String(message.body ?? ""),
        }),
      )
      return
    }
    if (message.command === "webSocketProxyError") {
      this.emit(new Event("error"))
      return
    }
    if (message.command === "webSocketProxyClose") {
      this.readyState = WebSocket.CLOSED
      window.removeEventListener("message", this.onParentMessage)
      this.emit(
        new CloseEvent("close", {
          code: Number(message.code ?? 1000),
          reason: String(message.reason ?? ""),
          wasClean: !!message.wasClean,
        }),
      )
    }
  }

  private emit(event: Event) {
    this.dispatchEvent(event)
    if (event.type === "open") this.onopen?.call(this as unknown as WebSocket, event)
    if (event.type === "message") this.onmessage?.call(this as unknown as WebSocket, event as MessageEvent)
    if (event.type === "error") this.onerror?.call(this as unknown as WebSocket, event)
    if (event.type === "close") this.onclose?.call(this as unknown as WebSocket, event as CloseEvent)
  }
}

async function webSocketPayload(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
  if (typeof data === "string") return { body: data, binary: false }
  if (data instanceof Blob) return { body: VSCodeHttpProxy.uint8ArrayToBase64(new Uint8Array(await data.arrayBuffer())), binary: true }
  if (ArrayBuffer.isView(data)) return { body: VSCodeHttpProxy.uint8ArrayToBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)), binary: true }
  return { body: VSCodeHttpProxy.uint8ArrayToBase64(new Uint8Array(data)), binary: true }
}
