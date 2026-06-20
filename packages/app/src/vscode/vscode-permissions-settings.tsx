import type { Component } from "solid-js"
import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js"
import { Dialog as KobalteDialog } from "@kobalte/core/dialog"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogFooter } from "@opencode-ai/ui/v2/dialog-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { showToast } from "@/utils/toast"
import { useServerSync } from "@/context/server-sync"
import type {
  PermissionActionConfig,
  PermissionConfig,
  PermissionRuleConfig,
} from "@opencode-ai/sdk/v2/client"
import { SettingsListV2 } from "@/components/settings-v2/parts/list"
import { SettingsRowV2 } from "@/components/settings-v2/parts/row"
import { VSCodeHttpProxy } from "./vscode-http-proxy"
import "@/components/settings-v2/settings-v2.css"

type ActionValue = PermissionActionConfig | "custom" | "default"
type PermissionOption = { value: ActionValue; label: string }
type ViewMode = "file" | "live"

const ACTION_OPTIONS: PermissionOption[] = [
  { value: "ask", label: "询问" },
  { value: "allow", label: "允许" },
  { value: "deny", label: "拒绝" },
]

const DEFAULT_OPTION: PermissionOption = { value: "default", label: "跟随默认" }
const CUSTOM_OPTION: PermissionOption = { value: "custom", label: "自定义" }

// 选项常量（固定引用，避免 value 变化时 options 数组重建导致 Kobalte selection 状态丢失）。
const GLOBAL_SELECT_OPTIONS: PermissionOption[] = [...ACTION_OPTIONS, CUSTOM_OPTION]
const TOOL_SELECT_OPTIONS: PermissionOption[] = [DEFAULT_OPTION, ...ACTION_OPTIONS, CUSTOM_OPTION]

const TOOL_ROWS = [
  { key: "read", title: "读取文件", description: "控制 read 工具读取文件内容。", supportsRules: true },
  { key: "edit", title: "编辑文件", description: "控制 edit 工具修改文件内容。", supportsRules: true },
  { key: "glob", title: "Glob 搜索", description: "控制 glob 工具按文件名模式搜索。", supportsRules: true },
  { key: "grep", title: "文本搜索", description: "控制 grep 工具在文件内容中搜索。", supportsRules: true },
  { key: "list", title: "列出目录", description: "控制 list 工具读取目录内容。", supportsRules: true },
  { key: "bash", title: "Shell 命令", description: "控制 bash 工具执行命令。", supportsRules: true },
  { key: "task", title: "子任务", description: "控制 task 工具启动子任务。", supportsRules: true },
  { key: "todowrite", title: "TODO 写入", description: "控制 todowrite 工具更新任务列表。", supportsRules: false },
  { key: "question", title: "提问", description: "控制 question 工具向用户确认问题。", supportsRules: false },
  { key: "webfetch", title: "网页读取", description: "控制 webfetch 工具读取网页内容。", supportsRules: false },
  { key: "websearch", title: "网页搜索", description: "控制 websearch 工具搜索网络内容。", supportsRules: false },
  { key: "lsp", title: "LSP", description: "控制 lsp 工具读取语言服务信息。", supportsRules: true },
  { key: "external_directory", title: "外部目录", description: "控制对工作区外目录的访问。", supportsRules: true },
  { key: "skill", title: "Skill", description: "控制 skill 工具加载和运行技能。", supportsRules: true },
  { key: "doom_loop", title: "循环保护", description: "控制 doom_loop 保护动作。", supportsRules: false },
] as const

type ToolKey = (typeof TOOL_ROWS)[number]["key"]

export const VSCodePermissionsSettingsPage: Component = () => {
  const serverSync = useServerSync()
  // 文件模式数据源：直接读写 opencode.jsonc 的 permission 字段，不经过后端 config.update（深合并会破坏）。
  const [permissionFile, setPermissionFile] = createSignal<PermissionConfig | undefined>(undefined)
  // 运行时模式数据源：opencode 后端实际加载的 permission（只读，用于对比）。
  const permissionLive = createMemo(() => serverSync.data.config.permission)
  const [mode, setMode] = createSignal<ViewMode>("file")
  const [rulesEditKey, setRulesEditKey] = createSignal<ToolKey | undefined>()

  // 进入页面时从配置文件拉取 permission（文件是唯一可编辑数据源）。
  onMount(() => {
    void refreshPermissionFile()
  })

  const refreshPermissionFile = async () => {
    try {
      setPermissionFile(await requestPermissionGet())
    } catch (err: unknown) {
      showToast({ title: "读取权限配置失败", description: err instanceof Error ? err.message : String(err) })
    }
  }

  const currentPermission = createMemo(() => (mode() === "file" ? permissionFile() : permissionLive()))

  // 编辑：构造新 permission 对象，发给扩展进程整体替换文件，回传值更新本地 state。
  const writePermission = async (next: PermissionConfig) => {
    const before = permissionFile()
    setPermissionFile(next)
    try {
      const after = await requestPermissionUpdate(next)
      setPermissionFile(after)
    } catch (err: unknown) {
      setPermissionFile(before)
      showToast({ title: "权限配置更新失败", description: err instanceof Error ? err.message : String(err) })
    }
  }

  const setGlobalAction = (action: PermissionActionConfig) => writePermission({ "*": action })

  const setToolAction = (key: ToolKey, value: ActionValue) => {
    const current = permissionObject(permissionFile())
    if (value === "default") {
      if (!(key in current)) return
      const next = { ...current }
      delete next[key]
      return writePermission(next)
    }
    if (value !== "ask" && value !== "allow" && value !== "deny") return
    return writePermission({ ...current, [key]: value })
  }

  const setToolRules = (key: ToolKey, rules: Record<string, PermissionActionConfig>) =>
    writePermission({ ...permissionObject(permissionFile()), [key]: rules })

  const readOnly = () => mode() === "live"

  return (
    <div class="vscode-permissions-settings">
      <style>{`
        .vscode-permissions-settings {
          width: 100%;
          height: 100%;
          overflow: auto;
          background: var(--v2-background-bg-base);
        }

        .vscode-permissions-settings [data-component="select-v2-root"] {
          width: fit-content;
          max-width: 100%;
        }

        .vscode-permissions-mode-bar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 24px;
          flex-wrap: wrap;
        }

        .vscode-permissions-mode-hint {
          font-size: 11px;
          color: var(--v2-text-text-muted);
        }

        .vscode-permissions-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .vscode-permissions-tool-row {
          display: flex;
          flex-direction: column;
        }

        .vscode-permissions-rules-panel {
          margin: 4px 0 16px;
          padding: 8px 0 8px 16px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .vscode-permissions-rules-panel-row {
          display: flex;
          align-items: center;
          gap: 12px;
          font-size: 12px;
        }

        .vscode-permissions-rules-panel-pattern {
          flex: 1;
          min-width: 0;
          font-family: var(--v2-font-mono, ui-monospace, monospace);
          color: var(--v2-text-text-base);
          word-break: break-all;
        }

        .vscode-permissions-rules-panel-action {
          flex-shrink: 0;
          color: var(--v2-text-text-muted);
        }

        [data-component="dialog-v2"].vscode-permissions-rules-dialog [data-slot="dialog-container"] {
          width: min(640px, calc(100vw - 32px));
          height: auto;
          max-height: calc(100vh - 64px);
          border-radius: 8px;
        }

        [data-component="dialog-v2"].vscode-permissions-rules-dialog [data-slot="dialog-content"] {
          overflow: hidden;
        }

        .vscode-permissions-rules-body {
          flex: 0 1 auto;
          width: 100%;
          min-height: 0;
          max-height: min(420px, calc(100vh - 240px));
          overflow-y: auto;
          padding: 20px 24px;
          box-sizing: border-box;
        }

        .vscode-permissions-rules-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .vscode-permissions-rule-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 140px 32px;
          align-items: center;
          gap: 8px;
        }

        .vscode-permissions-rule-row [data-component="text-input-v2"],
        .vscode-permissions-rule-row [data-component="select-v2-root"] {
          width: 100%;
          max-width: 100%;
        }

        .vscode-permissions-rule-add {
          justify-content: center;
          width: 100%;
          margin-top: 4px;
        }

        .vscode-permissions-rule-delete {
          width: 32px;
          min-width: 32px;
          padding: 0 !important;
        }

        .vscode-permissions-rules-field {
          display: flex;
          flex-direction: column;
          gap: 7px;
          margin-bottom: 16px;
        }

        .vscode-permissions-rules-label {
          font-size: 13px;
          font-weight: 530;
          color: var(--v2-text-text-base);
        }

        .vscode-permissions-rules-description {
          font-size: 11px;
          font-weight: 440;
          color: var(--v2-text-text-muted);
        }

        @media (max-width: 520px) {
          .vscode-permissions-rule-row {
            grid-template-columns: minmax(0, 1fr) 32px;
          }
          .vscode-permissions-rule-row [data-component="select-v2-root"] {
            grid-column: 1 / -2;
          }
        }
      `}</style>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">权限</h2>
      </div>
      <div class="vscode-permissions-mode-bar">
        <ButtonV2 variant={mode() === "file" ? "contrast" : "ghost-muted"} onClick={() => setMode("file")}>
          编辑配置文件
        </ButtonV2>
        <ButtonV2 variant={mode() === "live" ? "contrast" : "ghost-muted"} onClick={() => setMode("live")}>
          查看运行时状态
        </ButtonV2>
        <span class="vscode-permissions-mode-hint">
          {readOnly()
            ? "运行时状态为只读，反映 opencode 当前实际加载的权限；修改请切换到「编辑配置文件」（改动需重启后端才生效）。"
            : "直接编辑 opencode.jsonc 的 permission 字段；改动需重启后端才会被 opencode 重新加载。"}
        </span>
      </div>
      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">默认权限</h3>
          <SettingsListV2>
            <SettingsRowV2 title="所有工具" description="设置所有工具调用的默认策略（写入通配符 *）；单工具未单独配置时回落到此值。">
              <SelectV2
                appearance="inline"
                options={GLOBAL_SELECT_OPTIONS}
                current={GLOBAL_SELECT_OPTIONS.find((o) => o.value === globalAction(currentPermission())) ?? CUSTOM_OPTION}
                value={(option) => option.value}
                label={(option) => option.label}
                disabled={readOnly()}
                onSelect={(option) => {
                  if (!option || readOnly()) return
                  if (option.value !== "ask" && option.value !== "allow" && option.value !== "deny") return
                  void setGlobalAction(option.value)
                }}
              />
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">工具调用</h3>
          <SettingsListV2>
            <For each={TOOL_ROWS}>
              {(item) => {
                const currentRules = createMemo(() => toolRules(currentPermission(), item.key))
                const isCustom = () => toolAction(currentPermission(), item.key) === "custom"
                return (
                  <div class="vscode-permissions-tool-row">
                    <SettingsRowV2 title={item.title} description={item.description}>
                      <div class="vscode-permissions-actions">
                        <SelectV2
                          appearance="inline"
                          options={TOOL_SELECT_OPTIONS}
                          current={TOOL_SELECT_OPTIONS.find((o) => o.value === toolAction(currentPermission(), item.key)) ?? CUSTOM_OPTION}
                          value={(option) => option.value}
                          label={(option) => option.label}
                          disabled={readOnly()}
                          onSelect={(option) => {
                            if (!option || readOnly()) return
                            void setToolAction(item.key, option.value)
                          }}
                        />
                        <Show when={item.supportsRules && !readOnly()}>
                          <ButtonV2 variant="ghost-muted" onClick={() => setRulesEditKey(item.key)}>
                            规则
                          </ButtonV2>
                        </Show>
                      </div>
                    </SettingsRowV2>
                    <Show when={isCustom() && currentRules()}>
                      <div class="vscode-permissions-rules-panel">
                        <For each={Object.entries(currentRules()!)}>
                          {([pattern, action]) => (
                            <div class="vscode-permissions-rules-panel-row">
                              <code class="vscode-permissions-rules-panel-pattern">{pattern}</code>
                              <span class="vscode-permissions-rules-panel-action">{actionLabel(action)}</span>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </SettingsListV2>
        </div>
      </div>
      <RulesDialog
        toolKey={rulesEditKey()}
        rules={rulesEditKey() ? toolRules(currentPermission(), rulesEditKey()!) : undefined}
        onClose={() => setRulesEditKey(undefined)}
        onSave={(rules) => {
          const key = rulesEditKey()
          if (key) void setToolRules(key, rules)
          setRulesEditKey(undefined)
        }}
      />
    </div>
  )
}

const RulesDialog: Component<{
  toolKey: ToolKey | undefined
  rules: Record<string, PermissionActionConfig> | undefined
  onClose: () => void
  onSave: (rules: Record<string, PermissionActionConfig>) => void
}> = (props) => {
  type RuleRow = { pattern: string; action: PermissionActionConfig }
  const [rows, setRows] = createStore<{ items: RuleRow[] }>({ items: [] })

  createEffect(() => {
    if (!props.toolKey) return
    const entries = Object.entries(props.rules ?? {})
    setRows(
      "items",
      entries.length > 0
        ? entries.map(([pattern, action]) => ({ pattern, action }))
        : [{ pattern: "*", action: "ask" }],
    )
  })

  const addRow = () => setRows("items", (items) => [...items, { pattern: "", action: "ask" }])
  const removeRow = (index: number) => setRows("items", (items) => items.filter((_, i) => i !== index))

  const save = () => {
    const collected = rows.items
      .map((row) => ({ pattern: row.pattern.trim(), action: row.action }))
      .filter((row) => row.pattern)
    if (collected.length === 0) {
      showToast({ title: "至少需要一条规则" })
      return
    }
    props.onSave(Object.fromEntries(collected.map((row) => [row.pattern, row.action])))
  }

  const tool = createMemo(() => TOOL_ROWS.find((item) => item.key === props.toolKey))

  return (
    <KobalteDialog open={!!props.toolKey} onOpenChange={(open) => !open && props.onClose()}>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay />
        <Dialog title={tool() ? `${tool()!.title} 规则` : "规则"} fit class="vscode-permissions-rules-dialog">
          <div class="vscode-permissions-rules-body">
            <div class="vscode-permissions-rules-field">
              <span class="vscode-permissions-rules-label">通配符规则</span>
              <span class="vscode-permissions-rules-description">
                每行一个 pattern（通配符，如 `*`、`git *`、`**/node_modules/**`）和对应动作。最后匹配的规则优先；保存为对象形式写入该工具配置。
              </span>
            </div>
            <div class="vscode-permissions-rules-list">
              <For each={rows.items}>
                {(row, index) => (
                  <div class="vscode-permissions-rule-row">
                    <TextInputV2
                      appearance="large"
                      class="!w-full"
                      value={row.pattern}
                      placeholder="pattern，例如 * 或 git *"
                      onInput={(event) => setRows("items", index(), "pattern", event.currentTarget.value)}
                    />
                    <SelectV2
                      appearance="inline"
                      options={ACTION_OPTIONS}
                      current={ACTION_OPTIONS.find((option) => option.value === row.action)}
                      value={(option) => option.value}
                      label={(option) => option.label}
                      onSelect={(option) => option && setRows("items", index(), "action", option.value)}
                    />
                    <ButtonV2
                      size="large"
                      variant="ghost-muted"
                      icon="xmark-small"
                      class="vscode-permissions-rule-delete"
                      aria-label="删除规则"
                      onClick={() => removeRow(index())}
                    />
                  </div>
                )}
              </For>
              <ButtonV2 variant="ghost-muted" icon="plus" class="vscode-permissions-rule-add" onClick={addRow}>
                添加规则
              </ButtonV2>
            </div>
          </div>
          <DialogFooter>
            <ButtonV2 variant="ghost-muted" onClick={props.onClose}>
              取消
            </ButtonV2>
            <ButtonV2 variant="contrast" onClick={save}>
              保存
            </ButtonV2>
          </DialogFooter>
        </Dialog>
      </KobalteDialog.Portal>
    </KobalteDialog>
  )
}

// ── 配置读取：opencode 把字符串 action normalize 成 { "*": action }，需同时识别两种形式。──

function globalAction(permission: PermissionConfig | undefined): ActionValue {
  const action = actionFromRule(permission as PermissionRuleConfig | undefined)
  if (action) return action
  if (isPermissionObject(permission)) {
    const wildcard = actionFromRule(permission["*"] as PermissionRuleConfig | undefined)
    if (wildcard) return wildcard
  }
  return "custom"
}

function toolAction(permission: PermissionConfig | undefined, key: ToolKey): ActionValue {
  const obj = permissionObject(permission)
  if (!(key in obj)) return "default"
  const rule = obj[key] as PermissionRuleConfig | undefined
  const direct = actionFromRule(rule)
  if (direct) return direct
  if (isPermissionObject(rule)) {
    const wildcard = actionFromRule(rule["*"] as PermissionRuleConfig | undefined)
    if (wildcard !== undefined) return wildcard
  }
  return "custom"
}

function toolRules(
  permission: PermissionConfig | undefined,
  key: ToolKey,
): Record<string, PermissionActionConfig> | undefined {
  const obj = permissionObject(permission)
  const rule = obj[key] as PermissionRuleConfig | undefined
  if (!isPermissionObject(rule)) return undefined
  const result: Record<string, PermissionActionConfig> = {}
  for (const [pattern, action] of Object.entries(rule)) {
    if (action === "ask" || action === "allow" || action === "deny") result[pattern] = action
  }
  return result
}

function permissionObject(permission: PermissionConfig | undefined): Record<string, PermissionRuleConfig> {
  if (!isPermissionObject(permission)) return {}
  return permission as Record<string, PermissionRuleConfig>
}

function actionFromRule(rule: PermissionRuleConfig | undefined): PermissionActionConfig | undefined {
  if (rule === "ask" || rule === "allow" || rule === "deny") return rule
}

// 面板里 action 的中文标签（与 select 选项一致）。
function actionLabel(action: PermissionActionConfig): string {
  if (action === "ask") return "询问"
  if (action === "allow") return "允许"
  return "拒绝"
}

function isPermissionObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

// 请求扩展进程读 opencode.jsonc 的 permission 字段。
function requestPermissionGet(): Promise<PermissionConfig | undefined> {
  return requestPermission("permissionGet", {})
}

// 请求扩展进程整体替换 permission 字段，返回写盘后的 permission。
function requestPermissionUpdate(permission: PermissionConfig): Promise<PermissionConfig | undefined> {
  return requestPermission("permissionUpdate", { permission })
}

function requestPermission(
  command: "permissionGet" | "permissionUpdate",
  payload: Record<string, unknown>,
): Promise<PermissionConfig | undefined> {
  return new Promise((resolve, reject) => {
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage)
      reject(new Error("权限配置请求超时"))
    }, 15_000)

    const onMessage = (event: MessageEvent) => {
      if (!VSCodeHttpProxy.isBridgeMessage(event)) return
      const data = event.data as Record<string, unknown> | undefined
      if (!data || data.source !== "opencode-vscode-app") return
      if (data.command !== "permissionResult" || data.requestId !== requestId) return
      window.clearTimeout(timeout)
      window.removeEventListener("message", onMessage)
      if (data.error) {
        reject(new Error(String(data.error)))
        return
      }
      resolve(data.permission as PermissionConfig | undefined)
    }

    window.addEventListener("message", onMessage)
    VSCodeHttpProxy.postMessage({ source: "opencode-vscode-app", command, requestId, ...payload })
  })
}
