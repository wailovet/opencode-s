import { DialogSettings } from "@/components/settings-v2"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { Route, useLocation, useNavigate, useParams } from "@solidjs/router"
import type { ParentProps } from "solid-js"
import { createEffect, createMemo, onCleanup, onMount, Show } from "solid-js"
import VSCodeSessionPage from "./vscode-session"
import { VSCodeSessionsListPage } from "./vscode-sessions-list"
import { SDKProvider } from "@/context/sdk"
import { decode64 } from "@/utils/base64"
import { TerminalProvider } from "@/context/terminal"
import { FileProvider } from "@/context/file"
import { PromptProvider } from "@/context/prompt"
import { CommentsProvider } from "@/context/comments"
import { LocalProvider } from "@/context/local"
import { DataProvider } from "@opencode-ai/ui/context"
import { useSync } from "@/context/sync"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { isVSCodeAppPath } from "./vscode-route"

console.log("[vscode-patch] module loaded, backendUrl=", (window).__opencodeVSCodeBackendUrl)
const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"
const HTTP_PROXY_TIMEOUT_MS = 120_000
type VSCodeWebviewApi = { postMessage(message: unknown): void }
type VSCodeWindow = typeof window & {
  acquireVsCodeApi?: () => VSCodeWebviewApi
  __opencodeVSCodeApi?: VSCodeWebviewApi
  __opencodeVSCodeAssetBase?: string
  __opencodeVSCodeAssetPathPatched?: boolean
  __opencodeVSCodeBackendUrl?: string
}

normalizeVSCodeLocationDirectory()
installVSCodeBackendUrl()
installVSCodeHttpProxyBridge()
installVSCodeWebSocketProxyBridge()
installVSCodePermissionBootstrapFallback()
installVSCodeAssetPathRewrite()
installVSCodeChromeStyle()
markVSCodeSessionOpen()

function normalizeVSCodeDirectory(directory: string) {
  return directory.replace(/^[a-z]:/, (drive) => drive.toUpperCase())
}

function markVSCodeSessionOpen() {
  if (typeof document === "undefined") return
  if (!vscodeApi()) return
  document.body.classList.add("vscode-session-open")
}

function installVSCodeChromeStyle() {
  if (typeof document === "undefined") return
  if (document.getElementById("opencode-vscode-chrome-style")) return

  const style = document.createElement("style")
  style.id = "opencode-vscode-chrome-style"
  style.textContent = `
    body.vscode-session-open header.shrink-0.relative.flex.flex-row.h-9.bg-v2-background-bg-deep {
      display: none !important;
    }

    body.vscode-session-open aside[aria-label="Development performance diagnostics"],
    body.vscode-session-open [aria-label="Development performance diagnostics"] {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
  `
  document.head.append(style)
}

// 把 extension.js 注入的后端地址写入 localStorage，让 app 的 SDK 用它作为 defaultServerUrl。
// localAppHtml 模式下 location.origin 是 vscode-webview://，不能作为后端地址。
function installVSCodeBackendUrl() {
  if (typeof window === "undefined") return
  const backendUrl = (window as VSCodeWindow).__opencodeVSCodeBackendUrl
  console.log("[installVSCodeBackendUrl] backendUrl=", backendUrl, "location.origin=", window.location.origin)
  if (!backendUrl) return
  try {
    localStorage.setItem(DEFAULT_SERVER_URL_KEY, backendUrl)
    console.log("[installVSCodeBackendUrl] wrote to localStorage:", backendUrl)
  } catch (e) {
    console.log("[installVSCodeBackendUrl] localStorage.setItem failed:", e)
  }
}

function installVSCodeHttpProxyBridge() {
  if (typeof window === "undefined") return
  if (!vscodeApi()) return
  const target = window as typeof window & { __opencodeVSCodeHttpProxyFetchPatched?: boolean }
  if (target.__opencodeVSCodeHttpProxyFetchPatched) return
  target.__opencodeVSCodeHttpProxyFetchPatched = true

  const originalFetch = window.fetch
  window.fetch = async (input, init) => {
    const request = new Request(input, init)
    if (!isVSCodeBackendRequest(request)) return originalFetch.call(window, request)
    if (isVSCodeSseProxyRequest(request)) return vscodeSseProxyFetch(request)
    return vscodeHttpProxyFetch(request)
  }
}

function isVSCodeBackendRequest(input: RequestInfo | URL) {
  if (!vscodeApi()) return false
  const url = requestUrl(input)
  // 静态资源（vscode-webview:// 协议的 /assets/ 路径）不走代理，其余全走。
  // 后端是唯一的 API 来源，所有 API 请求都必须经 httpProxy 转发。
  if (isVSCodeStaticResource(url)) return false
  return true
}

// vscode-webview:// 协议下的静态资源（asWebviewUri 生成的 JS/CSS/图片等），不走代理。
function isVSCodeStaticResource(url: URL) {
  if (url.protocol === "vscode-webview:" || url.protocol === "https:") {
    return url.pathname.startsWith("/assets/") || url.pathname.endsWith(".js") || url.pathname.endsWith(".css") || url.pathname.endsWith(".svg") || url.pathname.endsWith(".png") || url.pathname.endsWith(".woff") || url.pathname.endsWith(".woff2") || url.pathname.endsWith(".ico")
  }
  return false
}

function isVSCodeSseProxyRequest(request: Request) {
  const url = requestUrl(request)
  return request.headers.get("accept")?.includes("text/event-stream") || url.pathname === "/global/event"
}

function isVSCodeBackendHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1"
}

function isVSCodeBackendPath(pathname: string) {
  if (pathname.startsWith("/assets/")) return false
  if (pathname.startsWith("/stable-")) return false
  if (pathname.startsWith("/vscode-resource/")) return false
  return true
}

function installVSCodeAssetPathRewrite() {
  if (typeof window === "undefined") return
  if (!vscodeApi()) return
  const target = window as VSCodeWindow
  if (target.__opencodeVSCodeAssetPathPatched) return
  target.__opencodeVSCodeAssetPathPatched = true

  const setAttribute = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (name, value) {
    return setAttribute.call(this, name, rewriteVSCodeAssetPath(String(value)))
  }

  const setAttributeNS = Element.prototype.setAttributeNS
  Element.prototype.setAttributeNS = function (namespace, name, value) {
    return setAttributeNS.call(this, namespace, name, rewriteVSCodeAssetPath(String(value)))
  }
}

function rewriteVSCodeAssetPath(value: string) {
  const target = window as VSCodeWindow
  if (!target.__opencodeVSCodeAssetBase) return value
  if (!value.startsWith("/assets/")) return value
  const sprite = /^\/assets\/sprite-[^/]+\.svg#(.+)$/.exec(value)
  if (sprite) return `#${sprite[1]}`
  return target.__opencodeVSCodeAssetBase + value.slice("/assets/".length)
}

function requestUrl(input: RequestInfo | URL) {
  if (input instanceof Request) return new URL(input.url)
  return new URL(String(input), window.location.href)
}

function vscodeApi() {
  const target = window as VSCodeWindow
  if (!target.__opencodeVSCodeApi && typeof target.acquireVsCodeApi === "function") {
    target.__opencodeVSCodeApi = target.acquireVsCodeApi()
  }
  return target.__opencodeVSCodeApi
}

export function postVSCodeMessage(message: unknown) {
  const api = vscodeApi()
  if (api) {
    api.postMessage(message)
    return
  }
  window.parent.postMessage(message, "*")
}

// 判断是否运行在 VS Code webview 中。
export function isInVSCodeWebview() {
  return !!vscodeApi() || isVSCodeAppPath()
}

// 打开某个 session 的聊天界面。环境感知：
// - VS Code 环境：postMessage 通知 extension 在编辑器区新开/聚焦 panel。
// - Web 环境：新浏览器窗口打开原生 web 的 session 路由（/<slug>/session/<id>）。
export function openVSCodeSession(directory: string, sessionId: string) {
  if (!sessionId) return
  if (isInVSCodeWebview()) {
    postVSCodeMessage({
      source: "opencode-vscode-app",
      command: "openSessionPanel",
      sessionDir: directory,
      sessionId,
    })
    return
  }
  const slug = base64Encode(directory)
  window.open(`/${slug}/session/${sessionId}`, "_blank")
}

// 新建会话。环境感知：
// - VS Code 环境：postMessage 通知 extension 新开一个加载新会话页的 panel。
// - Web 环境：新浏览器窗口打开原生 web 的新会话路由（/<slug>/session）。
export function openVSCodeNewSession(directory: string) {
  if (isInVSCodeWebview()) {
    postVSCodeMessage({source: "opencode-vscode-app", command: "openNewSessionPanel", sessionDir: directory})
    return
  }
  const slug = base64Encode(directory)
  window.open(`/${slug}/session`, "_blank")
}

function isVSCodeBridgeMessage(event: MessageEvent) {
  if (vscodeApi()) return true
  return event.source === window.parent
}

async function vscodeHttpProxyFetch(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init)
  const requestId = createProxyRequestId()
  const abort = () => {
    postVSCodeMessage({
      source: "opencode-vscode-app",
      command: "httpProxyCancel",
      requestId,
    })
  }
  if (request.signal.aborted) throw abortError()

  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => {
      abort()
      cleanup()
      reject(abortError())
    }
    const timeout = setTimeout(() => {
      abort()
      cleanup()
      reject(new Error("VS Code HTTP proxy timed out"))
    }, HTTP_PROXY_TIMEOUT_MS)
    const cleanup = () => {
      clearTimeout(timeout)
      request.signal.removeEventListener("abort", onAbort)
      window.removeEventListener("message", onMessage)
    }
    const onMessage = (event: MessageEvent) => {
      if (!isVSCodeBridgeMessage(event)) return
      const message = event.data
      if (!message || message.source !== "opencode-vscode-app" || message.requestId !== requestId) return
      if (message.command !== "httpProxyResponse") return
      cleanup()
      if (request.signal.aborted) {
        reject(abortError())
        return
      }
      if (message.error) {
        reject(new Error(String(message.error)))
        return
      }
      resolve(
        new Response(responseBody(message), {
          status: message.status,
          statusText: message.statusText,
          headers: message.headers,
        }),
      )
    }

    request.signal.addEventListener("abort", onAbort, { once: true })
    window.addEventListener("message", onMessage)
    void proxyRequestPayload(request)
      .then((payload) => {
        if (request.signal.aborted) {
          cleanup()
          reject(abortError())
          return
        }
        postVSCodeMessage({
          source: "opencode-vscode-app",
          command: "httpProxyRequest",
          requestId,
          ...payload,
        })
      })
      .catch((error) => {
        cleanup()
        reject(error)
      })
  })
}

async function vscodeSseProxyFetch(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init)
  const requestId = createProxyRequestId()
  if (request.signal.aborted) throw abortError()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        request.signal.removeEventListener("abort", onAbort)
        window.removeEventListener("message", onMessage)
      }
      const cancel = () => {
        postVSCodeMessage({
          source: "opencode-vscode-app",
          command: "sseProxyCancel",
          requestId,
        })
      }
      const onAbort = () => {
        cancel()
        cleanup()
        controller.error(abortError())
      }
      const onMessage = (event: MessageEvent) => {
        if (!isVSCodeBridgeMessage(event)) return
        const message = event.data
        if (!message || message.source !== "opencode-vscode-app" || message.requestId !== requestId) return
        if (message.command === "sseProxyChunk") {
          controller.enqueue(base64ToUint8Array(String(message.body ?? "")))
          return
        }
        if (message.command === "sseProxyClose") {
          cleanup()
          controller.close()
          return
        }
        if (message.command === "sseProxyError") {
          cleanup()
          controller.error(new Error(String(message.error ?? "VS Code SSE proxy failed")))
        }
      }

      request.signal.addEventListener("abort", onAbort, { once: true })
      window.addEventListener("message", onMessage)
      void proxyRequestPayload(request)
        .then((payload) => {
          if (request.signal.aborted) {
            cleanup()
            controller.error(abortError())
            return
          }
          postVSCodeMessage({
            source: "opencode-vscode-app",
            command: "sseProxyOpen",
            requestId,
            ...payload,
          })
        })
        .catch((error) => {
          cleanup()
          controller.error(error)
        })
    },
    cancel() {
      postVSCodeMessage({
        source: "opencode-vscode-app",
        command: "sseProxyCancel",
        requestId,
      })
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

function installVSCodeWebSocketProxyBridge() {
  if (typeof window === "undefined") return
  if (!vscodeApi()) return
  const target = window as typeof window & { __opencodeVSCodeWebSocketProxyPatched?: boolean }
  if (target.__opencodeVSCodeWebSocketProxyPatched) return
  target.__opencodeVSCodeWebSocketProxyPatched = true

  const NativeWebSocket = window.WebSocket
  const websocketFactory = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
    if (isVSCodeWebSocketProxyUrl(url)) return new VSCodeProxyWebSocket(String(url), protocols) as unknown as WebSocket
    return new NativeWebSocket(url, protocols)
  }
  Object.defineProperties(websocketFactory, {
    CONNECTING: { value: NativeWebSocket.CONNECTING },
    OPEN: { value: NativeWebSocket.OPEN },
    CLOSING: { value: NativeWebSocket.CLOSING },
    CLOSED: { value: NativeWebSocket.CLOSED },
  })
  window.WebSocket = websocketFactory as unknown as typeof WebSocket
}

function isVSCodeWebSocketProxyUrl(input: string | URL) {
  const url = new URL(String(input), window.location.href)
  return (
    (url.protocol === "ws:" || url.protocol === "wss:") &&
    isVSCodeBackendHost(url.hostname) &&
    (url.origin !== window.location.origin.replace(/^http:/, "ws:").replace(/^https:/, "wss:") ||
      isVSCodeBackendPath(url.pathname)) &&
    url.pathname.startsWith("/pty/") &&
    url.pathname.endsWith("/connect")
  )
}

class VSCodeProxyWebSocket extends EventTarget {
  static readonly CONNECTING = WebSocket.CONNECTING
  static readonly OPEN = WebSocket.OPEN
  static readonly CLOSING = WebSocket.CLOSING
  static readonly CLOSED = WebSocket.CLOSED
  readonly CONNECTING = WebSocket.CONNECTING
  readonly OPEN = WebSocket.OPEN
  readonly CLOSING = WebSocket.CLOSING
  readonly CLOSED = WebSocket.CLOSED
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
  private readonly requestId = createProxyRequestId()
  private readonly onParentMessage = (event: MessageEvent) => this.receive(event)

  constructor(url: string, protocols?: string | string[]) {
    super()
    this.url = new URL(url, window.location.href).toString()
    window.addEventListener("message", this.onParentMessage)
    postVSCodeMessage({
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
      postVSCodeMessage({
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
    postVSCodeMessage({
      source: "opencode-vscode-app",
      command: "webSocketProxyClose",
      requestId: this.requestId,
      code,
      reason,
    })
  }

  private receive(event: MessageEvent) {
    if (!isVSCodeBridgeMessage(event)) return
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
          data: message.binary ? base64ToUint8Array(String(message.body ?? "")).buffer : String(message.body ?? ""),
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
  if (data instanceof Blob) return { body: uint8ArrayToBase64(new Uint8Array(await data.arrayBuffer())), binary: true }
  if (ArrayBuffer.isView(data)) return { body: uint8ArrayToBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)), binary: true }
  return { body: uint8ArrayToBase64(new Uint8Array(data)), binary: true }
}

async function proxyRequestPayload(request: Request) {
  return {
    url: request.url,
    method: request.method,
    headers: [...request.headers.entries()],
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : uint8ArrayToBase64(new Uint8Array(await request.arrayBuffer())),
  }
}

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError")
}

function responseBody(message: { status: number; body?: string }) {
  if (message.status === 204 || message.status === 205 || message.status === 304) return null
  return base64ToUint8Array(message.body ?? "")
}

function createProxyRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function uint8ArrayToBase64(bytes: Uint8Array) {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64ToUint8Array(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function installVSCodePermissionBootstrapFallback() {
  if (typeof window === "undefined") return
  const target = window as typeof window & { __opencodeVSCodePermissionFetchPatched?: boolean }
  if (target.__opencodeVSCodePermissionFetchPatched) return
  target.__opencodeVSCodePermissionFetchPatched = true

  const originalFetch = window.fetch
  window.fetch = async (input, init) => {
    if (isVSCodePermissionListRequest(input)) return emptyJSONListResponse()
    return originalFetch.call(window, input, init)
  }
}

function emptyJSONListResponse() {
  return new Response("[]", {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function isVSCodePermissionListRequest(input: RequestInfo | URL) {
  if (!vscodeApi()) return false

  const url = (() => {
    if (input instanceof Request) return new URL(input.url)
    return new URL(String(input), window.location.href)
  })()
  return url.pathname === "/permission"
}

function normalizeVSCodeLocationDirectory() {
  if (typeof window === "undefined") return

  const match = /^\/([^/]+)\/vscode-session(?:\/|$)/.exec(window.location.pathname)
  if (!match) return

  const directory = normalizeVSCodeDirectory(decode64(match[1]))
  const slug = base64Encode(directory)
  if (slug === match[1]) return

  window.history.replaceState(
    window.history.state,
    "",
    `/${slug}${window.location.pathname.slice(match[1].length + 1)}${window.location.search}${window.location.hash}`,
  )
}

function VSCodeSessionProviders(props: ParentProps) {
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  let debugObserver: MutationObserver | undefined

  const removeDebugUI = () => {
    const debugBar = document.querySelector('aside[aria-label="Development performance diagnostics"]')
    if (debugBar) debugBar.remove()
    const helpBtn = document.querySelector('button[aria-label="Help"]')
    if (helpBtn) {
      const wrapper = helpBtn.closest('[class*="fixed"]')
      if (wrapper) wrapper.remove()
    }
  }

  onMount(() => {
    markVSCodeSessionOpen()
    debugObserver = new MutationObserver(removeDebugUI)
    debugObserver.observe(document.body, { childList: true, subtree: true })
    removeDebugUI()
  })
  onCleanup(() => {
    debugObserver?.disconnect()
    document.body.classList.remove("vscode-session-open")
  })

  const directory = createMemo(() => {
    return params.dir ? normalizeVSCodeDirectory(decode64(params.dir)) : ""
  })
  const slug = createMemo(() => base64Encode(directory()))

  createEffect(() => {
    const next = slug()
    if (!params.dir || !next || next === params.dir) return
    const path = location.pathname.slice(params.dir.length + 1)
    navigate(`/${next}${path}${location.search}${location.hash}`, { replace: true })
  })

  return (
    <Show when={directory()} keyed>
      {(dir) => (
        <SDKProvider directory={dir}>
          <VSCodeDirectoryDataProvider directory={dir}>
            <TerminalProvider>
              <FileProvider>
                <PromptProvider>
                  <CommentsProvider>
                    <VSCodeSessionPage />
                  </CommentsProvider>
                </PromptProvider>
              </FileProvider>
            </TerminalProvider>
          </VSCodeDirectoryDataProvider>
        </SDKProvider>
      )}
    </Show>
  )
}

function VSCodeDirectoryDataProvider(props: ParentProps & { directory: string }) {
  const sync = useSync()
  const slug = createMemo(() => base64Encode(props.directory))

  return (
    <DataProvider
      data={sync.data}
      directory={props.directory}
      onNavigateToSession={(sessionID: string) =>
        openVSCodeSession(props.directory, sessionID)
      }
      onSessionHref={(sessionID: string) =>
        `/${slug()}/vscode-session/${sessionID}`
      }
    >
      <LocalProvider>
        {props.children}
      </LocalProvider>
    </DataProvider>
  )
}

// sessions 列表页的 provider 栈。列表只需 SDK + Data + Local，不需要聊天专用的
// Terminal/File/Prompt/Comments provider。
function VSCodeSessionsListProviders(props: ParentProps) {
  const params = useParams()
  const directory = createMemo(() =>
    params.dir ? normalizeVSCodeDirectory(decode64(params.dir)) : "",
  )

  return (
    <Show when={directory()} keyed>
      {(dir) => (
        <SDKProvider directory={dir}>
          <VSCodeDirectoryDataProvider directory={dir}>
            <VSCodeSessionsListPage directory={dir} />
          </VSCodeDirectoryDataProvider>
        </SDKProvider>
      )}
    </Show>
  )
}

export function PatchedRouteGate(props: ParentProps) {
  const location = useLocation()
  const component = () => {
    if (location.pathname.includes("/settings")) return VSCodeSettingsPage
  }
  return (
    <Show when={component()} keyed fallback={props.children}>
      {(Component) => <Component />}
    </Show>
  )
}

export function VSCodeSettingsPage() {
  onMount(() => {
    document.body.classList.add("vscode-settings-open")
  })

  return (
    <div class="vscode-settings-wrapper">
      <style>{`
      .vscode-settings-wrapper {
        width: 100vw;
        height: 100dvh;
      }

      .vscode-settings-wrapper [data-component="dialog-v2"],
      body.vscode-settings-open [data-component="dialog-v2"] {
        display: flex;
        align-items: stretch;
        justify-content: stretch;
        width: 100% !important;
        height: 100% !important;
        pointer-events: auto;
      }

      body.vscode-settings-open [data-slot="dialog-container"] {
        width: 100% !important;
        height: 100% !important;
        border-radius: 0 !important;
        box-shadow: none !important;
      }

      body.vscode-settings-open [data-slot="dialog-content"] {
        width: 100% !important;
        height: 100% !important;
        max-height: none !important;
        border-radius: 0 !important;
      }

      body.vscode-settings-open [data-slot="dialog-body"] {
        width: 100% !important;
        height: 100% !important;
        max-height: none !important;
      }
    `}</style>
      <Kobalte open modal onOpenChange={(open) => { if (!open) window.close() }}>
        <DialogSettings />
      </Kobalte>
    </div>
  )
}


export function PatchedRoutes() {
  return (
    <>
      <Route path="/settings" component={VSCodeSettingsPage} />
      <Route path="/:dir/vscode-sessions" component={VSCodeSessionsListProviders} />
      <Route path="/:dir/vscode-session/:id?" component={VSCodeSessionProviders} />
    </>
  )
}
