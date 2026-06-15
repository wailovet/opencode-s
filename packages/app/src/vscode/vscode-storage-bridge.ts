import { VSCodeHttpProxy } from "./vscode-http-proxy"

/**
 * VSCodeStorageBridge —— 接管 localStorage，与 Extension Host 共享存储。
 *
 * 职责：
 *   1. 完全替换 Storage.prototype，所有 localStorage 读写走本桥接
 *   2. 数据同步到 Extension Host 的 globalState（跨 webview 共享 + 持久化）
 *   3. 来自其他 webview 的变更通过 postMessage 广播过来
 *
 * 初始化顺序：
 *   routeScript（写值到原生 localStorage）→ install()（读原生 localStorage）
 *   → 发 storageGetAll → 等回复合并 → 后续读写全走 store
 *
 * 使用方式：
 *   import { VSCodeStorageBridge } from "./vscode-storage-bridge"
 *   VSCodeStorageBridge.install()
 *   // 之后 localStorage.getItem/setItem 等全部走桥接
 */

// ── 类型 ──

type StoragePatch =
  | { type: "set"; key: string; value: string }
  | { type: "remove"; key: string }
  | { type: "clear" }
  | { type: "replace"; entries: Record<string, string> }

// ── 类定义 ──

export class VSCodeStorageBridge {
  private static store: Record<string, string> = {}
  private static installed = false

  // ── 安装 ──

  /**
   * 安装 Storage 桥接。
   * 必须在 SDK 启动前调用（已在 vscode-patch.tsx 顶部调用）。
   */
  static install() {
    if (typeof window === "undefined") return
    if (!VSCodeHttpProxy.api()) return
    if (this.installed) return
    this.installed = true

    this.store = {}
    console.log("[storageBridge] init")

    // 请求 Extension Host 的完整数据
    VSCodeHttpProxy.postMessage({ source: "opencode-vscode-app", command: "storageGetAll" })

    // 替换 Storage.prototype
    this.hookPrototype()

    // 监听 Extension Host 发来的更新
    window.addEventListener("message", this.onMessage)
    console.log("[storageBridge] installed")
  }

  // ── 内部 ──

  /** 替换 Storage.prototype 方法，全部走 store，不碰原生 localStorage */
  private static hookPrototype() {
    Storage.prototype.getItem = function (key: string): string | null {
      const val = Object.prototype.hasOwnProperty.call(VSCodeStorageBridge.store, key)
        ? VSCodeStorageBridge.store[key]
        : null
      console.log(`[storageBridge] -- getItem("${key}") → ${val === null ? "null" : `"${val}"`}`)
      return val
    }

    Storage.prototype.setItem = function (key: string, value: string): void {
      const next = String(value)
      const prev = Object.prototype.hasOwnProperty.call(VSCodeStorageBridge.store, key)
        ? VSCodeStorageBridge.store[key]
        : null
      console.log(`[storageBridge] setItem("${key}", "${next}") prev=${prev === null ? "null" : `"${prev}"`}`)
      VSCodeStorageBridge.store[key] = next
      VSCodeHttpProxy.postMessage({
        source: "opencode-vscode-app",
        command: "storageSet",
        key,
        value: next,
      })
      VSCodeStorageBridge.emitStorageEvent(key, prev, next)
    }

    Storage.prototype.removeItem = function (key: string): void {
      const prev = Object.prototype.hasOwnProperty.call(VSCodeStorageBridge.store, key)
        ? VSCodeStorageBridge.store[key]
        : null
      console.log(`[storageBridge] removeItem("${key}") prev=${prev === null ? "null" : `"${prev}"`}`)
      delete VSCodeStorageBridge.store[key]
      VSCodeHttpProxy.postMessage({
        source: "opencode-vscode-app",
        command: "storageRemove",
        key,
      })
      VSCodeStorageBridge.emitStorageEvent(key, prev, null)
    }

    Storage.prototype.clear = function (): void {
      const count = Object.keys(VSCodeStorageBridge.store).length
      console.log(`[storageBridge] clear (${count} keys)`)
      VSCodeStorageBridge.store = {}
      VSCodeHttpProxy.postMessage({
        source: "opencode-vscode-app",
        command: "storageClear",
      })
      if (count > 0) VSCodeStorageBridge.emitStorageEvent(null, null, null)
    }

    Storage.prototype.key = function (index: number): string | null {
      const k = Object.keys(VSCodeStorageBridge.store)[index] ?? null
      console.log(`[storageBridge] key(${index}) → ${k === null ? "null" : `"${k}"`}`)
      return k
    }

    try {
      Object.defineProperty(Storage.prototype, "length", {
        configurable: true,
        get() {
          const len = Object.keys(VSCodeStorageBridge.store).length
          return len
        },
      })
    } catch {}
  }

  /** 处理 Extension Host 发来的 storagePatch 消息 */
  private static onMessage = (event: MessageEvent) => {
    if (!VSCodeHttpProxy.isBridgeMessage(event)) return
    const message = event.data
    if (!message || message.source !== "opencode-vscode-app" || message.command !== "storagePatch") return
    const patch = message.patch as StoragePatch | undefined
    if (!patch) return

    if (patch.type === "set" && typeof patch.key === "string" && typeof patch.value === "string") {
      const prev = Object.prototype.hasOwnProperty.call(VSCodeStorageBridge.store, patch.key)
        ? VSCodeStorageBridge.store[patch.key]
        : null
      VSCodeStorageBridge.store[patch.key] = patch.value
      VSCodeStorageBridge.emitStorageEvent(patch.key, prev, patch.value)
      return
    }

    if (patch.type === "remove" && typeof patch.key === "string") {
      delete VSCodeStorageBridge.store[patch.key]
      VSCodeStorageBridge.emitStorageEvent(patch.key, null, null)
      return
    }

    if (patch.type === "clear") {
      VSCodeStorageBridge.store = {}
      VSCodeStorageBridge.emitStorageEvent(null, null, null)
      return
    }

    if (patch.type === "replace" && patch.entries && typeof patch.entries === "object") {
      console.log(`[storageBridge] merge ${Object.keys(patch.entries).length} keys from EH`)
      for (const [key, value] of Object.entries(patch.entries)) {
        if (typeof value === "string") {
          VSCodeStorageBridge.store[key] = value
        }
      }
      VSCodeStorageBridge.emitStorageEvent(null, null, null)
    }
  }

  // ── 辅助 ──

  private static emitStorageEvent(
    key: string | null,
    oldValue: string | null,
    newValue: string | null,
  ) {
    try {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key,
          oldValue,
          newValue,
          storageArea: undefined,
          url: window.location.href,
        }),
      )
    } catch {
      window.dispatchEvent(new Event("storage"))
    }
  }
}
