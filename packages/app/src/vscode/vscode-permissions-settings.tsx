import type { Component } from "solid-js"
import { For, createMemo } from "solid-js"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { showToast } from "@/utils/toast"
import { useServerSync } from "@/context/server-sync"
import type { PermissionActionConfig, PermissionConfig, PermissionRuleConfig } from "@opencode-ai/sdk/v2/client"
import { SettingsListV2 } from "@/components/settings-v2/parts/list"
import { SettingsRowV2 } from "@/components/settings-v2/parts/row"
import "@/components/settings-v2/settings-v2.css"

type PermissionOption = {
  value: PermissionActionConfig | "custom"
  label: string
}

const ACTION_OPTIONS: PermissionOption[] = [
  { value: "ask", label: "询问" },
  { value: "allow", label: "允许" },
  { value: "deny", label: "拒绝" },
]

const CUSTOM_OPTION: PermissionOption = { value: "custom", label: "自定义" }

const TOOL_ROWS = [
  { key: "read", title: "读取文件", description: "控制 read 工具读取文件内容。" },
  { key: "edit", title: "编辑文件", description: "控制 edit 工具修改文件内容。" },
  { key: "glob", title: "Glob 搜索", description: "控制 glob 工具按文件名模式搜索。" },
  { key: "grep", title: "文本搜索", description: "控制 grep 工具在文件内容中搜索。" },
  { key: "list", title: "列出目录", description: "控制 list 工具读取目录内容。" },
  { key: "bash", title: "Shell 命令", description: "控制 bash 工具执行命令。" },
  { key: "task", title: "子任务", description: "控制 task 工具启动子任务。" },
  { key: "todowrite", title: "TODO 写入", description: "控制 todowrite 工具更新任务列表。" },
  { key: "question", title: "提问", description: "控制 question 工具向用户确认问题。" },
  { key: "webfetch", title: "网页读取", description: "控制 webfetch 工具读取网页内容。" },
  { key: "websearch", title: "网页搜索", description: "控制 websearch 工具搜索网络内容。" },
  { key: "lsp", title: "LSP", description: "控制 lsp 工具读取语言服务信息。" },
  { key: "external_directory", title: "外部目录", description: "控制对工作区外目录的访问。" },
  { key: "skill", title: "Skill", description: "控制 skill 工具加载和运行技能。" },
  { key: "doom_loop", title: "循环保护", description: "控制 doom_loop 保护动作。" },
] as const

type ToolKey = (typeof TOOL_ROWS)[number]["key"]

export const VSCodePermissionsSettingsPage: Component = () => {
  const serverSync = useServerSync()
  const permission = createMemo(() => serverSync.data.config.permission)

  const updatePermission = async (next: PermissionConfig) => {
    const before = permission()
    serverSync.set("config", "permission", next)
    await serverSync.updateConfig({ permission: next }).catch((err: unknown) => {
      serverSync.set("config", "permission", before)
      showToast({ title: "权限配置更新失败", description: err instanceof Error ? err.message : String(err) })
    })
  }

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
      `}</style>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">权限</h2>
      </div>
      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">默认权限</h3>
          <SettingsListV2>
            <SettingsRowV2 title="所有工具" description="设置所有工具调用的默认策略；选择后会替换当前按工具细分的配置。">
              <PermissionSelect
                value={globalAction(permission())}
                onChange={(value) => {
                  if (value === "custom") return
                  void updatePermission(value)
                }}
              />
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">工具调用</h3>
          <SettingsListV2>
            <For each={TOOL_ROWS}>
              {(item) => (
                <SettingsRowV2 title={item.title} description={item.description}>
                  <PermissionSelect
                    value={toolAction(permission(), item.key)}
                    onChange={(value) => {
                      if (value === "custom") return
                      void updatePermission(permissionWithTool(permission(), item.key, value))
                    }}
                  />
                </SettingsRowV2>
              )}
            </For>
          </SettingsListV2>
        </div>
      </div>
    </div>
  )
}

const PermissionSelect: Component<{
  value: PermissionOption["value"]
  onChange: (value: PermissionOption["value"]) => void
}> = (props) => {
  const options = createMemo(() => (props.value === "custom" ? [...ACTION_OPTIONS, CUSTOM_OPTION] : ACTION_OPTIONS))
  const current = createMemo(() => optionFor(props.value))
  return (
    <SelectV2
      appearance="inline"
      options={options()}
      current={current()}
      value={(option) => option.value}
      label={(option) => option.label}
      onSelect={(option) => {
        if (!option) return
        props.onChange(option.value)
      }}
    />
  )
}

// 后端把字符串 action normalize 成 { "*": action } 存入配置，所以要同时识别字符串形式
// （"deny"）和通配符对象形式（{ "*": "deny" }），否则会被判成 "custom"。
function globalAction(permission: PermissionConfig | undefined) {
  const action = actionFromRule(permission as PermissionRuleConfig | undefined)
  if (action) return action
  if (isPermissionObject(permission)) {
    const wildcard = actionFromRule(permission["*"] as PermissionRuleConfig | undefined)
    if (wildcard) return wildcard
  }
  return "custom"
}

function toolAction(permission: PermissionConfig | undefined, key: ToolKey) {
  const action = actionFromRule(permission as PermissionRuleConfig | undefined)
  if (action) return action
  if (!isPermissionObject(permission)) return "ask"
  // 具体工具规则优先；缺失时回退到 "*" 通配符，符合 opencode 权限优先级。
  const rule = permission[key]
  const toolActionValue = actionFromRule(rule as PermissionRuleConfig | undefined)
  if (toolActionValue) return toolActionValue
  if (rule) return "custom"
  return actionFromRule(permission["*"] as PermissionRuleConfig | undefined) ?? "ask"
}

function permissionWithTool(permission: PermissionConfig | undefined, key: ToolKey, action: PermissionActionConfig) {
  if (!isPermissionObject(permission)) return { [key]: action }
  return { ...permission, [key]: action }
}

function actionFromRule(rule: PermissionRuleConfig | undefined) {
  if (rule === "ask" || rule === "allow" || rule === "deny") return rule
}

function isPermissionObject(
  permission: PermissionConfig | undefined,
): permission is Exclude<PermissionConfig, PermissionActionConfig> {
  return !!permission && typeof permission === "object" && !Array.isArray(permission)
}

function optionFor(value: PermissionOption["value"]) {
  return ACTION_OPTIONS.find((option) => option.value === value) ?? CUSTOM_OPTION
}
