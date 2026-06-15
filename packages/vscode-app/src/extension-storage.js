/**
 * VSCodeStorageBridge —— Extension Host 侧的共享存储处理器。
 *
 * 职责：
 *   管理 VSCode 扩展的 globalState，作为所有 webview 的 localStorage 统一后端。
 *   接收 webview 的读写请求，更新 globalState 并广播到其他 webview。
 *
 * 数据流：
 *   Webview 写操作 → postMessage → 本模块 → globalState.update()
 *     → broadcastStorage() 广播到其他 webview
 *   Webview storageGetAll → 本模块 → globalState.get() → 全量返回
 *
 * 使用方式（在 extension.js 中）：
 *
 *   const { VSCodeStorageBridge } = require("./vscode-storage-bridge")
 *   const bridge = new VSCodeStorageBridge(context, WEBVIEW_STORAGE_KEY)
 *
 *   // 注册消息处理器：
 *   bridge.handleSet(message, webview)
 *   bridge.handleRemove(message, webview)
 *   bridge.handleClear(webview)
 *   bridge.handleReplace(message, webview)
 *   bridge.handleGetAll(webview)
 *
 *   // 获取当前快照：
 *   bridge.snapshot()
 *
 *   // 写入一个值（可用于扩展侧主动写数据，如 defaultServerUrl）：
 *   await bridge.set(key, value)
 */

const WEBVIEW_STORAGE_KEY = "opencode.vscode.storage"

class VSCodeStorageBridge {
  /**
   * @param {import("vscode").ExtensionContext} context
   * @param {(patch: object, sourceWebview?: { postMessage: Function }) => void} broadcastFn
   *   广播函数——将 patch 发送给除 sourceWebview 之外的所有 webview
   */
  constructor(context, broadcastFn) {
    this.context = context
    this.broadcast = broadcastFn
  }

  /** 读取全部键值 */
  snapshot() {
    const raw = this.context.globalState.get(WEBVIEW_STORAGE_KEY)
    return normalizeSnapshot(raw)
  }

  /** 写入单个 key（扩展侧主动设置，如 defaultServerUrl） */
  async set(key, value) {
    if (typeof key !== "string" || typeof value !== "string") return
    const next = { ...this.snapshot(), [key]: value }
    await this.context.globalState.update(WEBVIEW_STORAGE_KEY, next)
    this.broadcast({ type: "set", key, value })
  }

  // ── webview → 扩展 ──

  /** webview 设置一个 key */
  async handleSet(message, sourceWebview) {
    if (typeof message.key !== "string" || typeof message.value !== "string") return
    const next = { ...this.snapshot(), [message.key]: message.value }
    await this.context.globalState.update(WEBVIEW_STORAGE_KEY, next)
    this.broadcast({ type: "set", key: message.key, value: message.value }, sourceWebview)
  }

  /** webview 删除一个 key */
  async handleRemove(message, sourceWebview) {
    if (typeof message.key !== "string") return
    const next = this.snapshot()
    delete next[message.key]
    await this.context.globalState.update(WEBVIEW_STORAGE_KEY, next)
    this.broadcast({ type: "remove", key: message.key }, sourceWebview)
  }

  /** webview 清空 */
  async handleClear(sourceWebview) {
    await this.context.globalState.update(WEBVIEW_STORAGE_KEY, {})
    this.broadcast({ type: "clear" }, sourceWebview)
  }

  /** webview 替换全部 */
  async handleReplace(message, sourceWebview) {
    const next = normalizeSnapshot(message.entries)
    await this.context.globalState.update(WEBVIEW_STORAGE_KEY, next)
    this.broadcast({ type: "replace", entries: next }, sourceWebview)
  }

  /** webview 请求全量数据 */
  handleGetAll(webview) {
    const entries = this.snapshot()
    const hasUrl = !!entries["opencode.settings.dat:defaultServerUrl"]
    console.log(`[storage] handleGetAll: ${Object.keys(entries).length} keys, hasServerUrl=${hasUrl} url=${entries["opencode.settings.dat:defaultServerUrl"] ?? "N/A"}`)
    webview.postMessage({
      source: "opencode-vscode-app",
      command: "storagePatch",
      patch: { type: "replace", entries },
    })
  }
}

function normalizeSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry) => typeof entry[0] === "string" && typeof entry[1] === "string"),
  )
}

module.exports = { VSCodeStorageBridge, WEBVIEW_STORAGE_KEY }
