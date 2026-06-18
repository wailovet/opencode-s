import { VSCodeHttpProxy } from "./vscode-http-proxy"

export type FiCurrentState = "analysis" | "default"

export type FiAnalysisImplementationOptions = {
  enabled?: boolean
  readTools?: string[]
  allowNetworkSearch?: boolean
  defaultCommands?: string[]
}

export type FiPluginConfig = {
  workflows?: {
    "analysis-implementation"?: boolean | FiAnalysisImplementationOptions
  }
}

export const FI_ANALYSIS_IMPLEMENTATION_DEFAULT = "/fi-analysis-implementation-default"
export const FI_MODE_KEY = "analysis-implementation"

export function fiAnalysisImplementationEnabled(config: FiPluginConfig) {
  const workflow = config.workflows?.[FI_MODE_KEY]
  if (workflow === false) return false
  if (workflow && typeof workflow === "object" && workflow.enabled === false) return false
  return true
}

export function fiPluginConfigWithEnabled(config: FiPluginConfig, enabled: boolean): FiPluginConfig {
  const workflows = config.workflows && typeof config.workflows === "object" ? config.workflows : {}
  const current = workflows[FI_MODE_KEY]
  return {
    ...config,
    workflows: {
      ...workflows,
      [FI_MODE_KEY]: enabled ? { ...(current && typeof current === "object" ? current : {}), enabled: true } : false,
    },
  }
}

export function getVSCodeFiConfig() {
  return requestFiConfig<FiPluginConfig>({ command: "fiConfigGet" })
}

export function updateVSCodeFiConfig(config: FiPluginConfig) {
  return requestFiConfig<FiPluginConfig>({ command: "fiConfigUpdate", config })
}

function requestFiConfig<T>(message: Record<string, unknown>) {
  return new Promise<T>((resolve, reject) => {
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage)
      reject(new Error("FI 配置请求超时"))
    }, 10_000)

    const onMessage = (event: MessageEvent) => {
      if (!VSCodeHttpProxy.isBridgeMessage(event)) return
      const data = event.data as Record<string, unknown> | undefined
      if (!data || data.source !== "opencode-vscode-app") return
      if (data.command !== "fiConfigResult" || data.requestId !== requestId) return
      window.clearTimeout(timeout)
      window.removeEventListener("message", onMessage)
      if (data.error) {
        reject(new Error(String(data.error)))
        return
      }
      resolve(data.config as T)
    }

    window.addEventListener("message", onMessage)
    VSCodeHttpProxy.postMessage({
      source: "opencode-vscode-app",
      ...message,
      requestId,
    })
  })
}
