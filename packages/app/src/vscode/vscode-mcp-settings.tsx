import type { Config, McpLocalConfig, McpOAuthConfig, McpRemoteConfig, McpStatus } from "@opencode-ai/sdk/v2/client"
import { Dialog as KobalteDialog } from "@kobalte/core/dialog"
import type { Component, JSX } from "solid-js"
import { For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogFooter } from "@opencode-ai/ui/v2/dialog-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { showToast } from "@/utils/toast"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { SettingsListV2 } from "@/components/settings-v2/parts/list"
import { SettingsRowV2 } from "@/components/settings-v2/parts/row"
import "@/components/settings-v2/settings-v2.css"

type McpConfig = NonNullable<Config["mcp"]>
type McpEntry = McpLocalConfig | McpRemoteConfig
type McpTypeOption = { value: McpEntry["type"]; label: string }
type EnvironmentVariable = { key: string; value: string }
type McpForm = {
  name: string
  type: McpEntry["type"]
  command: string[]
  url: string
  environment: EnvironmentVariable[]
  headers: string
  oauth: string
  timeout: string
  enabled: boolean
}

const MCP_TYPE_OPTIONS: McpTypeOption[] = [
  { value: "local", label: "本地命令" },
  { value: "remote", label: "远程 URL" },
]

const STATUS_LABELS: Record<McpStatus["status"], string> = {
  connected: "已连接",
  disabled: "已禁用",
  failed: "连接失败",
  needs_auth: "需要认证",
  needs_client_registration: "需要客户端注册",
}

export const VSCodeMcpSettingsPage: Component = () => {
  const serverSync = useServerSync()
  const serverSdk = useServerSDK()
  const [dialogOpen, setDialogOpen] = createSignal(false)
  const [mode, setMode] = createSignal<"add" | "edit">("add")
  const [form, setForm] = createStore({
    name: "",
    type: "local" as McpEntry["type"],
    command: [""],
    url: "",
    environment: [] as EnvironmentVariable[],
    headers: "",
    oauth: "",
    timeout: "",
    enabled: true,
  })

  const configured = createMemo(() => Object.entries(serverSync.data.config.mcp ?? {}).filter(isConfiguredMcp))
  const [status, { refetch }] = createResource(() =>
    serverSdk.client.mcp.status().then((response) => response.data ?? ({} as Record<string, McpStatus>)),
  )

  const openAdd = () => {
    resetForm()
    setMode("add")
    setDialogOpen(true)
  }

  const openEdit = (name: string, entry: McpEntry) => {
    setForm({
      name,
      type: entry.type,
      command: entry.type === "local" ? nonEmptyList(entry.command) : [""],
      url: entry.type === "remote" ? entry.url : "",
      environment:
        entry.type === "local" && entry.environment
          ? Object.entries(entry.environment).map(([key, value]) => ({ key, value }))
          : [],
      headers: entry.type === "remote" && entry.headers ? JSON.stringify(entry.headers, null, 2) : "",
      oauth: entry.type === "remote" && entry.oauth !== undefined ? JSON.stringify(entry.oauth, null, 2) : "",
      timeout: entry.timeout ? String(entry.timeout) : "",
      enabled: entry.enabled ?? true,
    })
    setMode("edit")
    setDialogOpen(true)
  }

  const updateMcp = async (next: McpConfig) => {
    const before = serverSync.data.config.mcp
    serverSync.set("config", "mcp", next)
    await serverSync.updateConfig({ mcp: next }).catch((err: unknown) => {
      serverSync.set("config", "mcp", before)
      showToast({ title: "MCP 配置更新失败", description: err instanceof Error ? err.message : String(err) })
    })
    await refetch()
  }

  const save = async () => {
    const entry = buildEntry(form)
    if (!entry) return
    await updateMcp({
      ...(serverSync.data.config.mcp ?? {}),
      [entry.name]: entry.config,
    })
    setDialogOpen(false)
    resetForm()
  }

  const saveJson = async (input: string) => {
    const entries = buildEntriesFromJson(input)
    if (!entries) return
    await updateMcp({
      ...(serverSync.data.config.mcp ?? {}),
      ...entries,
    })
    setDialogOpen(false)
    resetForm()
  }

  const setEnabled = async (name: string, entry: McpEntry, enabled: boolean) => {
    await updateMcp({
      ...(serverSync.data.config.mcp ?? {}),
      [name]: { ...entry, enabled },
    })
  }

  const toggleRuntime = async (name: string) => {
    const current = status()?.[name]?.status
    if (!current) return
    await {
      connected: () => serverSdk.client.mcp.disconnect({ name }),
      disabled: () => serverSdk.client.mcp.connect({ name }),
      failed: () => serverSdk.client.mcp.connect({ name }),
      needs_auth: () => serverSdk.client.mcp.auth.authenticate({ name }),
      needs_client_registration: () => serverSdk.client.mcp.connect({ name }),
    }[current]()
      .catch((err: unknown) => {
        showToast({ title: "MCP 状态切换失败", description: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => void refetch())
  }

  const resetForm = () => {
    setForm({
      name: "",
      type: "local",
      command: [""],
      url: "",
      environment: [],
      headers: "",
      oauth: "",
      timeout: "",
      enabled: true,
    })
  }

  return (
    <div class="vscode-mcp-settings">
      <style>{`
        .vscode-mcp-settings {
          width: 100%;
          height: 100%;
          overflow: auto;
          background: var(--v2-background-bg-base);
        }

        .vscode-mcp-settings-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
        }

        .vscode-mcp-row-actions {
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-end;
          gap: 8px;
        }

        .vscode-mcp-status {
          font-size: 11px;
          font-weight: 440;
          color: var(--v2-text-text-muted);
        }

        [data-component="dialog-v2"].vscode-mcp-dialog [data-slot="dialog-container"] {
          width: min(640px, calc(100vw - 32px));
          height: auto;
          max-height: calc(100vh - 64px);
          align-items: stretch;
          border-radius: 8px;
        }

        [data-component="dialog-v2"].vscode-mcp-dialog [data-slot="dialog-content"] {
          width: 100%;
          min-height: 0;
          align-items: stretch;
          overflow: hidden;
        }

        [data-component="dialog-v2"].vscode-mcp-dialog [data-slot="dialog-header"] {
          align-items: center;
          padding: 24px 24px 16px;
          border-bottom: 0.5px solid var(--v2-border-border-base);
        }

        [data-component="dialog-v2"].vscode-mcp-dialog [data-slot="dialog-body"] {
          display: flex;
          min-height: 0;
          flex-direction: column;
          align-items: stretch;
          overflow: hidden;
        }

        [data-component="dialog-v2"].vscode-mcp-dialog [data-slot="dialog-footer"] {
          flex-shrink: 0;
          padding: 16px 24px 20px;
          border-top: 0.5px solid var(--v2-border-border-base);
        }

        .vscode-mcp-dialog-body {
          width: 100%;
          height: min(560px, calc(100vh - 200px));
          min-height: 280px;
          flex: 0 1 auto;
          overflow-x: hidden;
          overflow-y: auto;
          padding: 20px 24px 24px;
          scrollbar-width: thin;
          box-sizing: border-box;
        }

        .vscode-mcp-dialog-form {
          display: flex;
          width: 100%;
          min-width: 0;
          flex-direction: column;
          gap: 16px;
        }

        .vscode-mcp-dialog-mode {
          display: inline-flex;
          align-self: flex-start;
          gap: 4px;
          padding: 3px;
          border-radius: 6px;
          background: var(--v2-background-bg-layer-02);
          box-shadow: inset 0 0 0 0.5px var(--v2-border-border-muted);
        }

        .vscode-mcp-dialog-mode-button {
          height: 26px;
          padding: 0 10px;
          border: 0;
          border-radius: 4px;
          background: transparent;
          color: var(--v2-text-text-muted);
          font-size: 12px;
          font-weight: 530;
          line-height: 1;
          cursor: pointer;
        }

        .vscode-mcp-dialog-mode-button[data-active] {
          background: var(--v2-background-bg-button-neutral);
          color: var(--v2-text-text-base);
          box-shadow: var(--v2-elevation-button-neutral);
        }

        .vscode-mcp-dialog-field {
          display: flex;
          width: 100%;
          min-width: 0;
          flex-direction: column;
          gap: 7px;
          box-sizing: border-box;
        }

        .vscode-mcp-dialog-label {
          font-size: 13px;
          font-weight: 530;
          line-height: 16px;
          color: var(--v2-text-text-base);
        }

        .vscode-mcp-dialog-description {
          font-size: 11px;
          font-weight: 440;
          line-height: 15px;
          color: var(--v2-text-text-muted);
          white-space: normal;
        }

        .vscode-mcp-dialog-body [data-component="text-input-v2"],
        .vscode-mcp-dialog-body [data-component="textarea-v2"],
        .vscode-mcp-dialog-body [data-component="select-v2-root"] {
          width: 100%;
          max-width: 100%;
          box-sizing: border-box;
        }

        .vscode-mcp-dialog-body [data-component="textarea-v2"] textarea {
          min-height: 88px;
          max-width: 100%;
          resize: vertical;
        }

        .vscode-mcp-dialog-body .vscode-mcp-json-textarea {
          min-height: 410px;
          height: 410px;
        }

        .vscode-mcp-dialog-body .vscode-mcp-json-textarea [data-slot="textarea-v2-textarea"] {
          min-height: 410px;
          height: 410px;
          max-height: 410px;
          font-family: var(--font-mono);
          font-size: 12px;
          line-height: 18px;
          resize: none !important;
          overflow: auto;
        }

        .vscode-mcp-dialog-switch-field {
          min-height: 32px;
          justify-content: center;
        }

        .vscode-mcp-dynamic-list {
          display: flex;
          width: 100%;
          min-width: 0;
          flex-direction: column;
          gap: 8px;
          overflow: hidden;
        }

        .vscode-mcp-dynamic-row {
          display: grid;
          width: 100%;
          min-width: 0;
          grid-template-columns: minmax(0, 1fr) 32px;
          align-items: center;
          gap: 8px;
          box-sizing: border-box;
        }

        .vscode-mcp-env-row {
          display: grid;
          width: 100%;
          min-width: 0;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 32px;
          align-items: center;
          gap: 8px;
          box-sizing: border-box;
        }

        .vscode-mcp-dynamic-delete {
          flex: 0 0 auto;
          width: 32px;
          min-width: 32px;
          padding: 0 !important;
        }

        .vscode-mcp-dynamic-add {
          justify-content: center;
          width: 100%;
        }

        @media (max-width: 520px) {
          .vscode-mcp-env-row {
            grid-template-columns: minmax(0, 1fr) auto;
          }

          .vscode-mcp-env-row [data-component="text-input-v2"]:nth-child(2) {
            grid-column: 1 / -2;
          }
        }
      `}</style>
      <div class="settings-v2-tab-header">
        <div class="vscode-mcp-settings-header">
          <h2 class="settings-v2-tab-title">MCP</h2>
          <ButtonV2 variant="ghost-muted" icon="plus" onClick={openAdd}>
            添加
          </ButtonV2>
        </div>
      </div>
      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">已配置服务器</h3>
          <SettingsListV2>
            <Show
              when={configured().length > 0}
              fallback={<div class="settings-v2-provider-empty">暂无 MCP 服务器配置。</div>}
            >
              <For each={configured()}>
                {([name, entry]) => (
                  <SettingsRowV2 title={name} description={descriptionFor(name, entry, status()?.[name])}>
                    <div class="vscode-mcp-row-actions">
                      <Switch checked={entry.enabled ?? true} onChange={(checked) => void setEnabled(name, entry, checked)} />
                      <ButtonV2 variant="neutral" onClick={() => openEdit(name, entry)}>
                        编辑
                      </ButtonV2>
                      <ButtonV2 variant="neutral" onClick={() => void toggleRuntime(name)}>
                        {runtimeActionLabel(status()?.[name]?.status)}
                      </ButtonV2>
                    </div>
                  </SettingsRowV2>
                )}
              </For>
            </Show>
          </SettingsListV2>
        </div>
      </div>
      <McpDialog
        open={dialogOpen()}
        mode={mode()}
        form={form}
        setForm={setForm}
        onOpenChange={setDialogOpen}
        onCancel={() => setDialogOpen(false)}
        onSave={() => void save()}
        onSaveJson={(input) => void saveJson(input)}
      />
    </div>
  )
}

const McpDialog: Component<{
  open: boolean
  mode: "add" | "edit"
  form: {
    name: string
    type: McpEntry["type"]
    command: string[]
    url: string
    environment: EnvironmentVariable[]
    headers: string
    oauth: string
    timeout: string
    enabled: boolean
  }
  setForm: ReturnType<typeof createStore<McpForm>>[1]
  onOpenChange: (open: boolean) => void
  onCancel: () => void
  onSave: () => void
  onSaveJson: (input: string) => void
}> = (props) => {
  const [inputMode, setInputMode] = createSignal<"form" | "json">("form")
  const [jsonInput, setJsonInput] = createSignal("")
  const addCommand = () => props.setForm("command", (items) => [...items, ""])
  const removeCommand = (index: number) =>
    props.setForm("command", (items) => nonEmptyList(items.filter((_, itemIndex) => itemIndex !== index)))
  const addEnvironment = () => props.setForm("environment", (items) => [...items, { key: "", value: "" }])
  const removeEnvironment = (index: number) =>
    props.setForm("environment", (items) => items.filter((_, itemIndex) => itemIndex !== index))

  createEffect(() => {
    if (!props.open) return
    setInputMode("form")
    setJsonInput("")
  })

  const save = () => {
    if (inputMode() === "json") {
      props.onSaveJson(jsonInput())
      return
    }
    props.onSave()
  }

  return (
    <KobalteDialog open={props.open} onOpenChange={props.onOpenChange}>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay />
        <Dialog title={props.mode === "add" ? "添加 MCP 服务器" : "编辑 MCP 服务器"} fit class="vscode-mcp-dialog">
          <div class="vscode-mcp-dialog-body">
            <div class="vscode-mcp-dialog-form">
              <div class="vscode-mcp-dialog-mode" role="tablist" aria-label="MCP 输入方式">
                <button
                  type="button"
                  class="vscode-mcp-dialog-mode-button"
                  data-active={inputMode() === "form" ? "" : undefined}
                  onClick={() => setInputMode("form")}
                >
                  表单
                </button>
                <button
                  type="button"
                  class="vscode-mcp-dialog-mode-button"
                  data-active={inputMode() === "json" ? "" : undefined}
                  onClick={() => setInputMode("json")}
                >
                  JSON
                </button>
              </div>
              <Show
                when={inputMode() === "form"}
                fallback={
                  <Field
                    label="JSON"
                    description='支持 { "mcpServers": ... } 或 opencode { "mcp": ... }，保存时会转换为 config.mcp。'
                  >
                    <TextareaV2
                      class="!w-full vscode-mcp-json-textarea"
                      value={jsonInput()}
                      placeholder={`{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}`}
                      onInput={(event) => setJsonInput(event.currentTarget.value)}
                    />
                  </Field>
                }
              >
                <Field label="名称" description="写入 config.mcp.<name>。同名会覆盖现有配置。">
                  <TextInputV2
                    appearance="large"
                    class="!w-full"
                    value={props.form.name}
                    disabled={props.mode === "edit"}
                    onInput={(event) => props.setForm("name", event.currentTarget.value)}
                  />
                </Field>
                <Field label="类型" description="本地 MCP 运行命令；远程 MCP 连接 URL。">
                  <SelectV2
                    options={MCP_TYPE_OPTIONS}
                    current={MCP_TYPE_OPTIONS.find((option) => option.value === props.form.type)}
                    value={(option) => option.value}
                    label={(option) => option.label}
                    onSelect={(option) => option && props.setForm("type", option.value)}
                  />
                </Field>
                <Show
                  when={props.form.type === "local"}
                  fallback={
                    <>
                      <Field label="URL" description="远程 MCP 服务地址，例如 https://example.com/mcp。">
                        <TextInputV2
                          appearance="large"
                          class="!w-full"
                          value={props.form.url}
                          onInput={(event) => props.setForm("url", event.currentTarget.value)}
                        />
                      </Field>
                      <Field label="Headers" description='JSON 对象，例如 { "Authorization": "Bearer {env:TOKEN}" }。'>
                        <TextareaV2
                          class="!w-full"
                          value={props.form.headers}
                          onInput={(event) => props.setForm("headers", event.currentTarget.value)}
                        />
                      </Field>
                      <Field label="OAuth" description="JSON 对象；填 false 可关闭自动 OAuth 探测。留空则不写入。">
                        <TextareaV2
                          class="!w-full"
                          value={props.form.oauth}
                          onInput={(event) => props.setForm("oauth", event.currentTarget.value)}
                        />
                      </Field>
                    </>
                  }
                >
                  <Field label="命令与参数" description="每行一个命令或参数，例如 npx 与 @playwright/mcp@latest 分成两行。">
                    <div class="vscode-mcp-dynamic-list">
                      <For each={props.form.command}>
                        {(item, index) => (
                          <div class="vscode-mcp-dynamic-row">
                            <TextInputV2
                              appearance="large"
                              class="!w-full"
                              value={item}
                              placeholder={index() === 0 ? "命令，例如 npx" : "参数"}
                              onInput={(event) => props.setForm("command", index(), event.currentTarget.value)}
                            />
                            <ButtonV2
                              size="large"
                              variant="ghost-muted"
                              icon="xmark-small"
                              class="vscode-mcp-dynamic-delete"
                              aria-label="删除参数"
                              onClick={() => removeCommand(index())}
                            />
                          </div>
                        )}
                      </For>
                      <ButtonV2 variant="ghost-muted" icon="plus" class="vscode-mcp-dynamic-add" onClick={addCommand}>
                        添加参数
                      </ButtonV2>
                    </div>
                  </Field>
                  <Field label="环境变量" description='每行一个环境变量，例如 GITHUB_TOKEN = {env:GITHUB_TOKEN}。'>
                    <div class="vscode-mcp-dynamic-list">
                      <For each={props.form.environment}>
                        {(item, index) => (
                          <div class="vscode-mcp-env-row">
                            <TextInputV2
                              appearance="large"
                              class="!w-full"
                              value={item.key}
                              placeholder="名称"
                              onInput={(event) => props.setForm("environment", index(), "key", event.currentTarget.value)}
                            />
                          <TextInputV2
                            appearance="large"
                            class="!w-full"
                              value={item.value}
                              placeholder="值"
                              onInput={(event) => props.setForm("environment", index(), "value", event.currentTarget.value)}
                          />
                          <ButtonV2
                            size="large"
                            variant="ghost-muted"
                            icon="xmark-small"
                            class="vscode-mcp-dynamic-delete"
                              aria-label="删除环境变量"
                              onClick={() => removeEnvironment(index())}
                          />
                        </div>
                      )}
                    </For>
                      <ButtonV2 variant="ghost-muted" icon="plus" class="vscode-mcp-dynamic-add" onClick={addEnvironment}>
                        添加环境变量
                    </ButtonV2>
                  </div>
                </Field>
                </Show>
                <Field label="启动时启用" description="控制 MCP 服务是否在启动时自动启用。">
                  <div class="vscode-mcp-dialog-switch-field">
                    <Switch checked={props.form.enabled} onChange={(checked) => props.setForm("enabled", checked)} />
                  </div>
                </Field>
                <Field label="Timeout" description="请求超时时间，单位毫秒。留空使用默认值。">
                  <TextInputV2
                    type="number"
                    numeric
                    appearance="large"
                    class="!w-full"
                    value={props.form.timeout}
                    onInput={(event) => props.setForm("timeout", event.currentTarget.value)}
                  />
                </Field>
              </Show>
            </div>
          </div>
          <DialogFooter>
            <ButtonV2 variant="neutral" onClick={props.onCancel}>
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

const Field: Component<{ label: string; description: string; children: JSX.Element }> = (props) => {
  return (
    <div class="vscode-mcp-dialog-field">
      <span class="vscode-mcp-dialog-label">{props.label}</span>
      <span class="vscode-mcp-dialog-description">{props.description}</span>
      {props.children}
    </div>
  )
}

function buildEntry(form: {
  name: string
  type: McpEntry["type"]
  command: string[]
  url: string
  environment: EnvironmentVariable[]
  headers: string
  oauth: string
  timeout: string
  enabled: boolean
}) {
  const name = form.name.trim()
  if (!name) {
    showToast({ title: "MCP 名称不能为空" })
    return
  }

  const timeout = form.timeout.trim() ? Number(form.timeout.trim()) : undefined
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0)) {
    showToast({ title: "Timeout 必须是正整数毫秒值" })
    return
  }

  if (form.type === "local") {
    const command = form.command.map((item) => item.trim()).filter(Boolean)
    if (command.length === 0) {
      showToast({ title: "本地 MCP 需要填写命令" })
      return
    }

    const environment = buildStringRecord(form.environment, "环境变量")
    if (!environment.ok) return

    return {
      name,
      config: {
        type: "local",
        command,
        enabled: form.enabled,
        ...(environment.value && { environment: environment.value }),
        ...(timeout && { timeout }),
      } satisfies McpLocalConfig,
    }
  }

  const url = form.url.trim()
  if (!URL.canParse(url)) {
    showToast({ title: "远程 MCP URL 无效" })
    return
  }

  const headers = parseStringRecord(form.headers, "Headers")
  if (!headers.ok) return
  const oauth = parseOAuth(form.oauth)
  if (!oauth.ok) return

  return {
    name,
    config: {
      type: "remote",
      url,
      enabled: form.enabled,
      ...(headers.value && { headers: headers.value }),
      ...(oauth.hasValue && { oauth: oauth.value }),
      ...(timeout && { timeout }),
    } satisfies McpRemoteConfig,
  }
}

function buildEntriesFromJson(input: string) {
  if (!input.trim()) {
    showToast({ title: "MCP JSON 不能为空" })
    return
  }

  const root = parseJson(input, "MCP JSON")
  if (!root.ok) return
  if (!isRecord(root.value)) {
    showToast({ title: "MCP JSON 必须是对象" })
    return
  }

  const entries = {
    ...(isRecord(root.value.mcpServers) ? buildMcpServersEntries(root.value.mcpServers) : undefined),
    ...(isRecord(root.value.mcp) ? buildOpenCodeMcpEntries(root.value.mcp) : undefined),
  }
  if (Object.keys(entries).length === 0) {
    showToast({ title: '未找到 MCP 配置', description: '需要包含 "mcpServers" 或 "mcp" 对象。' })
    return
  }
  return entries
}

function buildMcpServersEntries(servers: Record<string, unknown>) {
  const entries = Object.entries(servers)
    .map(([name, value]) => {
      const entry = buildMcpServersEntry(name, value)
      if (!entry) return
      return [name, entry] as const
    })
    .filter((entry): entry is readonly [string, McpEntry] => !!entry)
  return Object.fromEntries(entries) as McpConfig
}

function buildMcpServersEntry(name: string, value: unknown) {
  if (!isRecord(value)) {
    showToast({ title: `${name} 配置必须是对象` })
    return
  }
  if (typeof value.command !== "string" || !value.command.trim()) {
    showToast({ title: `${name} 需要填写 command 字符串` })
    return
  }
  if (value.args !== undefined && !isStringArray(value.args)) {
    showToast({ title: `${name}.args 必须是字符串数组` })
    return
  }
  const environment = optionalStringRecord(value.env ?? value.environment, `${name}.env`)
  if (!environment.ok) return

  return {
    type: "local",
    command: [value.command.trim(), ...(value.args ?? [])],
    enabled: typeof value.enabled === "boolean" ? value.enabled : value.disabled === true ? false : true,
    ...(environment.value && { environment: environment.value }),
  } satisfies McpLocalConfig
}

function buildOpenCodeMcpEntries(mcp: Record<string, unknown>) {
  const entries = Object.entries(mcp)
    .map(([name, value]) => {
      const entry = buildOpenCodeMcpEntry(name, value)
      if (!entry) return
      return [name, entry] as const
    })
    .filter((entry): entry is readonly [string, McpEntry] => !!entry)
  return Object.fromEntries(entries) as McpConfig
}

function buildOpenCodeMcpEntry(name: string, value: unknown) {
  if (!isRecord(value)) {
    showToast({ title: `${name} 配置必须是对象` })
    return
  }
  const timeout = optionalTimeout(value.timeout, `${name}.timeout`)
  if (!timeout.ok) return
  const enabled = typeof value.enabled === "boolean" ? value.enabled : true

  if (value.type === "local") {
    if (!isStringArray(value.command) || value.command.length === 0) {
      showToast({ title: `${name}.command 必须是非空字符串数组` })
      return
    }
    const environment = optionalStringRecord(value.environment, `${name}.environment`)
    if (!environment.ok) return
    return {
      type: "local",
      command: value.command,
      enabled,
      ...(environment.value && { environment: environment.value }),
      ...(timeout.value && { timeout: timeout.value }),
    } satisfies McpLocalConfig
  }

  if (value.type === "remote") {
    if (typeof value.url !== "string" || !URL.canParse(value.url)) {
      showToast({ title: `${name}.url 必须是有效 URL` })
      return
    }
    const headers = optionalStringRecord(value.headers, `${name}.headers`)
    if (!headers.ok) return
    if (value.oauth !== undefined && value.oauth !== false && !isOAuth(value.oauth)) {
      showToast({ title: `${name}.oauth 必须是对象或 false` })
      return
    }
    return {
      type: "remote",
      url: value.url,
      enabled,
      ...(headers.value && { headers: headers.value }),
      ...(value.oauth !== undefined && { oauth: value.oauth as McpOAuthConfig | false }),
      ...(timeout.value && { timeout: timeout.value }),
    } satisfies McpRemoteConfig
  }

  showToast({ title: `${name}.type 必须是 local 或 remote` })
}

function isConfiguredMcp(entry: [string, McpConfig[string]]): entry is [string, McpEntry] {
  return entry[1].type === "local" || entry[1].type === "remote"
}

function nonEmptyList(items: string[]) {
  if (items.length > 0) return items
  return [""]
}

function descriptionFor(name: string, entry: McpEntry, status: McpStatus | undefined): JSX.Element {
  return (
    <span>
      {entry.type === "local" ? entry.command.join(" ") : entry.url}
      <span class="vscode-mcp-status"> · {STATUS_LABELS[status?.status ?? "disabled"]}</span>
      <Show when={status?.status === "failed" || status?.status === "needs_client_registration"}>
        <span class="vscode-mcp-status"> · {status?.error}</span>
      </Show>
    </span>
  )
}

function parseStringRecord(input: string, label: string) {
  const text = input.trim()
  if (!text) return { ok: true as const, value: undefined }
  const value = parseJson(text, label)
  if (!value.ok) return value
  if (!isStringRecord(value.value)) {
    showToast({ title: `${label} 必须是字符串键值对象` })
    return { ok: false as const }
  }
  return { ok: true as const, value: value.value }
}

function optionalStringRecord(value: unknown, label: string) {
  if (value === undefined) return { ok: true as const, value: undefined }
  if (!isStringRecord(value)) {
    showToast({ title: `${label} 必须是字符串键值对象` })
    return { ok: false as const }
  }
  return { ok: true as const, value }
}

function optionalTimeout(value: unknown, label: string) {
  if (value === undefined) return { ok: true as const, value: undefined }
  if (!Number.isInteger(value) || value <= 0) {
    showToast({ title: `${label} 必须是正整数毫秒值` })
    return { ok: false as const }
  }
  return { ok: true as const, value }
}

function buildStringRecord(items: EnvironmentVariable[], label: string) {
  const entries = items
    .map((item) => ({ key: item.key.trim(), value: item.value }))
    .filter((item) => item.key || item.value)
  const missing = entries.find((item) => !item.key)
  if (missing) {
    showToast({ title: `${label}名称不能为空` })
    return { ok: false as const }
  }
  const duplicate = entries.find((item, index) => entries.findIndex((target) => target.key === item.key) !== index)
  if (duplicate) {
    showToast({ title: `${label}名称重复`, description: duplicate.key })
    return { ok: false as const }
  }
  if (entries.length === 0) return { ok: true as const, value: undefined }
  return { ok: true as const, value: Object.fromEntries(entries.map((item) => [item.key, item.value])) }
}

function parseOAuth(input: string) {
  const text = input.trim()
  if (!text) return { ok: true as const, hasValue: false as const, value: undefined }
  const value = parseJson(text, "OAuth")
  if (!value.ok) return { ok: false as const }
  if (value.value === false) return { ok: true as const, hasValue: true as const, value: false }
  if (!isOAuth(value.value)) {
    showToast({ title: "OAuth 必须是对象或 false" })
    return { ok: false as const }
  }
  return { ok: true as const, hasValue: true as const, value: value.value }
}

function parseJson(input: string, label: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(input) as unknown }
  } catch (err) {
    showToast({ title: `${label} JSON 格式无效`, description: err instanceof Error ? err.message : String(err) })
    return { ok: false }
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.values(value).every((item) => typeof item === "string")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isOAuth(value: unknown): value is McpOAuthConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.entries(record).every(([key, item]) => {
    if (key === "callbackPort") return typeof item === "number"
    return ["clientId", "clientSecret", "scope", "redirectUri"].includes(key) && typeof item === "string"
  })
}

function runtimeActionLabel(status: McpStatus["status"] | undefined) {
  if (status === "connected") return "断开"
  if (status === "needs_auth") return "认证"
  return "连接"
}
