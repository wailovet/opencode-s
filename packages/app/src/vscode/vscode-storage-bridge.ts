import { VSCodeHttpProxy } from "./vscode-http-proxy"

/**
 * VSCodeStorageBridge —— 接管 localStorage，与 Extension Host 共享存储。
 *
 * 【设计】
 *   - install() 是异步的：先发 storageGetAll，等 EH 返回数据填充 store，
 *     再替换 Storage.prototype。后续 `getItem` 直接从 store 同步返回。
 *   - 没有竞态：store 在 prototype 替换前就已经有数据了。
 *   - 使用方式（vscode-patch.tsx 顶部）：
 *
 *     import { VSCodeStorageBridge } from "./vscode-storage-bridge"
 *     await VSCodeStorageBridge.install()
 *     // 从这行开始，localStorage.getItem 能读到 EH globalState 的数据
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

  /**
   * 安装 Storage 桥接。
   *
   * 异步：向 EH 请求全量数据，等回复后填充 store，再替换 prototype。
   * resolve 后所有 localStorage 读写都走 store，同步返回。
   */
  static async install() {
    if (typeof window === "undefined") return
    if (!VSCodeHttpProxy.api()) return
    if (this.installed) return
    this.installed = true

    this.store = {}
    console.log("[storageBridge] init: requesting data from EH")

    // 监听 storagePatch 回复
    window.addEventListener("message", this.onMessage)

    // 发请求，等数据回来
    VSCodeHttpProxy.postMessage({ source: "opencode-vscode-app", command: "storageGetAll" })
    await new Promise<void>((resolve) => {
      this._resolveReady = resolve
    })

    // 数据已就绪，替换 prototype
    this.hookPrototype()
    console.log(`[storageBridge] installed: ${Object.keys(this.store).length} keys from EH`)
  }

  private static _resolveReady: (() => void) | null = null
  private static _readyCalled = false

  // ── 内部 ──

  /** 替换 Storage.prototype 方法，全部走 store */
  private static hookPrototype() {
    Storage.prototype.getItem = function (key: string): string | null {
      const val = Object.prototype.hasOwnProperty.call(VSCodeStorageBridge.store, key)
        ? VSCodeStorageBridge.store[key]
        : null
      console.log(`[storageBridge] getItem("${key}") → ${val === null ? "null" : `"${val}"`}`)
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

  /** 处理 EH 发来的 storagePatch 消息 */
  private static onMessage = (event: MessageEvent) => {
    if (!VSCodeHttpProxy.isBridgeMessage(event)) return
    const message = event.data
    if (!message || message.source !== "opencode-vscode-app" || message.command !== "storagePatch") return
    const patch = message.patch as StoragePatch | undefined
    if (!patch) return

    if (patch.type === "replace" && patch.entries && typeof patch.entries === "object") {
      for (const [key, value] of Object.entries(patch.entries)) {
        if (typeof value === "string") VSCodeStorageBridge.store[key] = value
      }
      // 首次 replace 表示初始数据就绪，resolve install()
      if (!VSCodeStorageBridge._readyCalled) {
        VSCodeStorageBridge._readyCalled = true
        VSCodeStorageBridge._resolveReady?.()
      }
      VSCodeStorageBridge.emitStorageEvent(null, null, null)
      return
    }

    if (patch.type === "set" && typeof patch.key === "string" && typeof patch.value === "string") {
      VSCodeStorageBridge.store[patch.key] = patch.value
      VSCodeStorageBridge.emitStorageEvent(patch.key, null, patch.value)
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
