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
import { VSCodeHttpProxy } from "./vscode-http-proxy"

VSCodeHttpProxy.install()
normalizeVSCodeLocationDirectory()
installVSCodeStorageBridge()
installVSCodeChromeStyle()
markVSCodeSessionOpen()

function normalizeVSCodeDirectory(directory: string) {
  return directory.replace(/^[a-z]:/, (drive) => drive.toUpperCase())
}

function markVSCodeSessionOpen() {
  if (typeof document === "undefined") return
  if (!VSCodeHttpProxy.api()) return
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

function installVSCodeStorageBridge() {
  if (typeof window === "undefined") return
  if (!VSCodeHttpProxy.api()) return
  if ((window as any).__opencodeVSCodeStoragePatched) return
  ;(window as any).__opencodeVSCodeStoragePatched = true

  const storage = window.localStorage
  const native = {
    getItem: Storage.prototype.getItem,
    setItem: Storage.prototype.setItem,
    removeItem: Storage.prototype.removeItem,
    clear: Storage.prototype.clear,
    key: Storage.prototype.key,
    length: Object.getOwnPropertyDescriptor(Storage.prototype, "length")?.get,
  }
  // store 初始为空，通过 storageGetAll 从 Extension Host 拉取真实数据
  const store: Record<string, string> = {}
  VSCodeHttpProxy.postMessage({ source: "opencode-vscode-app", command: "storageGetAll" })

  const keys = () => Object.keys(store)
  const syncNativeSet = (key: string, value: string) => {
    try {
      native.setItem.call(storage, key, value)
    } catch {}
  }
  const syncNativeRemove = (key: string) => {
    try {
      native.removeItem.call(storage, key)
    } catch {}
  }
  const syncNativeClear = () => {
    try {
      native.clear.call(storage)
    } catch {}
  }
  const emitStorage = (key: string | null, oldValue: string | null, newValue: string | null) => {
    try {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key,
          oldValue,
          newValue,
          storageArea: storage,
          url: window.location.href,
        }),
      )
    } catch {
      window.dispatchEvent(new Event("storage"))
    }
  }

  Storage.prototype.getItem = function (key) {
    if (this !== storage) return native.getItem.call(this, key)
    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null
  }
  Storage.prototype.setItem = function (key, value) {
    if (this !== storage) return native.setItem.call(this, key, value)
    const next = String(value)
    const previous = Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null
    store[key] = next
    syncNativeSet(key, next)
    VSCodeHttpProxy.postMessage({ source: "opencode-vscode-app", command: "storageSet", key, value: next })
    emitStorage(key, previous, next)
  }
  Storage.prototype.removeItem = function (key) {
    if (this !== storage) return native.removeItem.call(this, key)
    const previous = Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null
    delete store[key]
    syncNativeRemove(key)
    VSCodeHttpProxy.postMessage({ source: "opencode-vscode-app", command: "storageRemove", key })
    emitStorage(key, previous, null)
  }
  Storage.prototype.clear = function () {
    if (this !== storage) return native.clear.call(this)
    const hadValues = keys().length > 0
    for (const key of keys()) delete store[key]
    syncNativeClear()
    VSCodeHttpProxy.postMessage({ source: "opencode-vscode-app", command: "storageClear" })
    if (hadValues) emitStorage(null, null, null)
  }
  Storage.prototype.key = function (index) {
    if (this !== storage) return native.key.call(this, index)
    return keys()[index] ?? null
  }
  try {
    Object.defineProperty(Storage.prototype, "length", {
      configurable: true,
      get() {
        if (this !== storage) return native.length?.call(this) ?? 0
        return keys().length
      },
    })
  } catch {}

  window.addEventListener("message", (event) => {
    if (!VSCodeHttpProxy.isBridgeMessage(event)) return
    const message = event.data
    if (!message || message.source !== "opencode-vscode-app" || message.command !== "storagePatch") return
    const patch = message.patch
    if (!patch || typeof patch !== "object") return
    if (patch.type === "set" && typeof patch.key === "string" && typeof patch.value === "string") {
      const previous = Object.prototype.hasOwnProperty.call(store, patch.key) ? store[patch.key] : null
      store[patch.key] = patch.value
      syncNativeSet(patch.key, patch.value)
      emitStorage(patch.key, previous, patch.value)
      return
    }
    if (patch.type === "remove" && typeof patch.key === "string") {
      const previous = Object.prototype.hasOwnProperty.call(store, patch.key) ? store[patch.key] : null
      delete store[patch.key]
      syncNativeRemove(patch.key)
      emitStorage(patch.key, previous, null)
      return
    }
    if (patch.type === "clear") {
      for (const key of keys()) delete store[key]
      syncNativeClear()
      emitStorage(null, null, null)
      return
    }
    if (patch.type === "replace" && patch.entries && typeof patch.entries === "object") {
      for (const key of keys()) delete store[key]
      for (const [key, value] of Object.entries(patch.entries)) {
        if (typeof value === "string") store[key] = value
      }
      syncNativeClear()
      for (const [key, value] of Object.entries(store)) syncNativeSet(key, value)
      emitStorage(null, null, null)
    }
  })
}

export function openVSCodeSession(directory: string, sessionId: string) {
  if (!sessionId) return
  if (VSCodeHttpProxy.isInWebview()) {
    VSCodeHttpProxy.postMessage({
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
  if (VSCodeHttpProxy.isInWebview()) {
    VSCodeHttpProxy.postMessage({source: "opencode-vscode-app", command: "openNewSessionPanel", sessionDir: directory})
    return
  }
  const slug = base64Encode(directory)
  window.open(`/${slug}/session`, "_blank")
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
