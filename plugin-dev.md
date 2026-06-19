# opencode 插件开发指南

## 概述

插件系统采用钩子（Hook）架构。插件注册钩子函数，opencode 服务器在特定执行点调用这些函数。插件 SDK 为 `@opencode-ai/plugin`。

### 架构

```
packages/plugin/        - 插件 SDK (@opencode-ai/plugin)
  src/index.ts          - Hooks 类型、PluginInput、Plugin 类型
  src/tool.ts           - ToolDefinition 辅助函数（基于 zod）
  src/shell.ts          - BunShell 类型
  src/tui.ts            - TUI 插件类型
  src/example.ts        - 示例插件
```

存在**两套**触发系统：

| 系统 | 包 | 范围 | 钩子 |
|--------|---------|-------|-------|
| **Core** (`PluginV2`) | `@opencode-ai/core` | 内部，仅内置插件 | `catalog.transform`、`account.switched`、`aisdk.sdk`、`aisdk.language` |
| **Server** | `@opencode-ai/plugin` | 外部 npm 插件 | 下文所有钩子 |

外部插件开发者只需关注 **Server** 系统。

---

## 插件结构

### 插件模块（推荐）

```ts
// my-plugin/src/index.ts
import type { PluginModule } from "@opencode-ai/plugin"

const plugin: PluginModule = {
  id: "my-plugin",
  server: async (ctx) => {
    return {
      // 在此注册钩子
    }
  },
}

export default plugin
```

对于文件/URL 路径插件，`id` 字段必填；对于 npm 包，默认使用 `package.json#name`。

### 插件函数（更简洁）

```ts
import type { Plugin } from "@opencode-ai/plugin"

const plugin: Plugin = async (ctx) => {
  return {
    // 在此注册钩子
  }
}

export default plugin
```

### 插件输入 (`PluginInput`)

`ctx` 参数包含：

```ts
{
  client:       OpencodeClient       // opencode API 的 HTTP 客户端
  project:      Project              // 当前项目信息
  directory:    string               // 项目目录
  worktree:     string               // Worktree 根目录
  experimental_workspace: {          // 工作区适配器 API（见下文）
    register(type, adapter): void
  }
  serverUrl:    URL                  // 服务器 URL
  $:            BunShell             // Bun shell 辅助（仅在 Bun 环境下可用）
}
```

---

## 可用钩子

### `dispose`

插件卸载时调用。

```ts
dispose?: () => Promise<void>
```

---

### `event`

接收 opencode 内部事件。

```ts
event?: (input: { event: Event }) => Promise<void>
```

---

### `config`

传入当前 opencode 配置，允许插件读取和响应配置变化。

```ts
config?: (input: Config) => Promise<void>
```

**触发位置**：`packages/opencode/src/plugin/index.ts:239`

---

### `tool`

注册自定义工具。使用 `@opencode-ai/plugin` 提供的 `tool()` 辅助函数定义。

```ts
tool?: {
  [key: string]: ToolDefinition
}
```

示例：
```ts
import { tool } from "@opencode-ai/plugin"

tool: {
  mytool: tool({
    description: "一个自定义工具",
    args: {
      query: tool.schema.string().describe("搜索关键词"),
    },
    async execute(args, ctx) {
      // ctx: { sessionID, messageID, agent, directory, worktree, abort, metadata, ask }
      return `结果：${args.query}`
    },
  }),
}
```

**工具上下文** (`ToolContext`)：
- `sessionID`：当前会话 ID
- `messageID`：当前消息 ID
- `agent`：代理名称
- `directory`：项目目录（优先使用，而非 `process.cwd()`）
- `worktree`：Worktree 根目录
- `abort`：用于取消的 `AbortSignal`
- `metadata(input)`：设置工具结果元数据
- `ask(input)`：请求用户授权

---

### `auth`

注册鉴权提供者（OAuth 或 API Key）。

```ts
auth?: AuthHook

type AuthHook = {
  provider: string                           // 提供者 ID（与 provider.id 匹配）
  loader?: (auth, provider) => Promise<Record<string, any>>
  methods: Array<
    | { type: "oauth"; label: string; prompts?: [...]; authorize: (inputs?) => Promise<AuthOAuthResult> }
    | { type: "api"; label: string; prompts?: [...]; authorize: (inputs?) => Promise<...> }
  >
}
```

**内置鉴权插件**（位于 `packages/opencode/src/plugin/`）：
| 文件 | 提供者 |
|------|----------|
| `openai/codex.ts` | OpenAI Codex |
| `github-copilot/copilot.ts` | GitHub Copilot |
| `cloudflare.ts` | Cloudflare AI Gateway、Cloudflare Workers AI |
| `azure.ts` | Azure |
| `digitalocean.ts` | DigitalOcean |
| `xai.ts` | xAI |

---

### `provider`

添加或修改提供者模型。

```ts
provider?: ProviderHook

type ProviderHook = {
  id: string    // 提供者 ID
  models?: (provider: ProviderV2, ctx: ProviderHookContext) => Promise<Record<string, ModelV2>>
}
```

---

### `chat.message`

收到新用户消息时调用。允许修改消息内容和片段。

```ts
"chat.message"?: (
  input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string }; messageID?: string; variant?: string },
  output: { message: UserMessage; parts: Part[] },
) => Promise<void>
```

---

### `chat.params`

修改发送给 LLM 的请求参数（temperature、topP、topK 等）。

```ts
"chat.params"?: (
  input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
  output: {
    temperature: number
    topP: number
    topK: number
    maxOutputTokens: number | undefined
    options: Record<string, any>
  },
) => Promise<void>
```

**触发位置**：`packages/opencode/src/session/llm/request.ts:114`

---

### `chat.headers`

修改 LLM 请求的 HTTP 头。

```ts
"chat.headers"?: (
  input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
  output: { headers: Record<string, string> },
) => Promise<void>
```

**触发位置**：`packages/opencode/src/session/llm/request.ts:134`

---

### `permission.ask`

覆盖权限决策。

```ts
"permission.ask"?: (
  input: Permission,
  output: { status: "ask" | "deny" | "allow" },
) => Promise<void>
```

---

### `command.execute.before`

命令执行前调用。允许注入额外的消息片段。

```ts
"command.execute.before"?: (
  input: { command: string; sessionID: string; arguments: string },
  output: { parts: Part[] },
) => Promise<void>
```

**触发位置**：`packages/opencode/src/session/prompt.ts:291`

---

### `tool.execute.before`

工具执行前调用。允许覆盖工具参数。

```ts
"tool.execute.before"?: (
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any },
) => Promise<void>
```

**触发位置**：`packages/opencode/src/session/tools.ts:87`

---

### `shell.env`

修改 shell 命令执行时的环境变量。

```ts
"shell.env"?: (
  input: { cwd: string; sessionID?: string; callID?: string },
  output: { env: Record<string, string> },
) => Promise<void>
```

**触发位置**：
- `packages/opencode/src/pty-preparation.ts:16` — PTY shell 初始化
- `packages/opencode/src/session/prompt.ts:555` — 会话提示（多参数）
- `packages/opencode/src/tool/shell.ts:423` — shell 工具执行

---

### `tool.execute.after`

工具执行后调用。允许修改工具结果元数据。

```ts
"tool.execute.after"?: (
  input: { tool: string; sessionID: string; callID: string; args: any },
  output: {
    title: string
    output: string
    metadata: any
  },
) => Promise<void>
```

**触发位置**：
- `packages/opencode/src/session/tools.ts:102` — 成功执行
- `packages/opencode/src/session/tools.ts:128` — 带有输出
- `packages/opencode/src/session/tools.ts:146`

---

### `experimental.chat.messages.transform`

在发送给 LLM 之前转换完整消息列表。

```ts
"experimental.chat.messages.transform"?: (
  input: {},
  output: {
    messages: Array<{ info: Message; parts: Part[] }>
  },
) => Promise<void>
```

**触发位置**：
- `packages/opencode/src/session/prompt.ts:1325`
- `packages/opencode/src/session/compaction.ts:360`

---

### `experimental.chat.system.transform`

在发送给 LLM 之前修改系统提示词。

```ts
"experimental.chat.system.transform"?: (
  input: { sessionID?: string; model: Model },
  output: { system: string[] },
) => Promise<void>
```

**触发位置**：
- `packages/opencode/src/agent/agent.ts:376`
- `packages/opencode/src/session/llm/request.ts:69`

---

### `experimental.provider.small_model`

为指定提供者解析"小模型"（用于轻量级任务）。

```ts
"experimental.provider.small_model"?: (
  input: { provider: ProviderV2 },
  output: { model?: ModelV2 },
) => Promise<void>
```

**触发位置**：`packages/opencode/src/provider/provider.ts:1828`

---

### `experimental.session.compacting`

会话压缩开始前调用。允许自定义压缩提示词。

```ts
"experimental.session.compacting"?: (
  input: { sessionID: string },
  output: { context: string[]; prompt?: string },
) => Promise<void>
```

- `context`：追加到默认提示词后的额外上下文字符串
- `prompt`：如果设置，将完全替换默认的压缩提示词

**触发位置**：`packages/opencode/src/session/compaction.ts:353`

---

### `experimental.compaction.autocontinue`

压缩成功后、添加合成自动继续消息前调用。

```ts
"experimental.compaction.autocontinue"?: (
  input: {
    sessionID: string
    agent: string
    model: Model
    provider: ProviderContext
    message: UserMessage
    overflow: boolean
  },
  output: { enabled: boolean },
) => Promise<void>
```

- `enabled`：默认为 `true`。设为 `false` 跳过自动继续。

**触发位置**：`packages/opencode/src/session/compaction.ts:476`

---

### `experimental.text.complete`

文本补全时调用，用于消息片段内的流式文本补全钩子。

```ts
"experimental.text.complete"?: (
  input: { sessionID: string; messageID: string; partID: string },
  output: { text: string },
) => Promise<void>
```

**触发位置**：`packages/opencode/src/session/processor.ts:810`

---

### `tool.definition`

在发送给 LLM 之前修改工具定义（描述和参数）。

```ts
"tool.definition"?: (
  input: { toolID: string },
  output: { description: string; parameters: any },
) => Promise<void>
```

**触发位置**：`packages/opencode/src/tool/registry.ts:289`

---

## 工作区适配器

插件可以通过 `experimental_workspace.register()` 注册自定义工作区适配器。

```ts
import type { Plugin } from "@opencode-ai/plugin"

const plugin: Plugin = async ({ experimental_workspace }) => {
  experimental_workspace.register("my-type", {
    name: "My Workspace",
    description: "为 My Service 创建工作区",
    configure(config) {
      return { ...config, directory: "/path/to/workspace" }
    },
    async create(config, env, from?) { /* 创建工作区 */ },
    async remove(config) { /* 清理 */ },
    target(config) { return { type: "local", directory: config.directory! } },
  })

  return {}
}
```

---

## 内置插件（供参考）

内置插件按以下顺序在 `packages/core/src/plugin/boot.ts` 中注册：

| 插件 | ID | 源文件 |
|--------|----|------------|
| EnvPlugin | `env` | `packages/core/src/plugin/env.ts` |
| AccountPlugin | `account` | `packages/core/src/plugin/account.ts` |
| AgentPlugin | `agent` | `packages/core/src/plugin/agent.ts` |
| CommandPlugin | `command` | `packages/core/src/plugin/command.ts` |
| SkillPlugin | `skill` | `packages/core/src/plugin/skill.ts` |
| ProviderPlugins (32 个) | `*` | `packages/core/src/plugin/provider.ts` |
| ModelsDevPlugin | `models-dev` | `packages/core/src/plugin/models-dev.ts` |
| ConfigProviderPlugin | - | `packages/core/src/config/plugin/provider.ts` |
| ConfigAgentPlugin | - | `packages/core/src/config/plugin/agent.ts` |
| ConfigCommandPlugin | - | `packages/core/src/config/plugin/command.ts` |
| ConfigSkillPlugin | - | `packages/core/src/config/plugin/skill.ts` |
| ConfigReferencePlugin | - | `packages/core/src/config/plugin/reference.ts` |

---

## 插件加载器

- `packages/opencode/src/plugin/loader.ts` — 加载外部 npm 插件
- `packages/opencode/src/plugin/install.ts` — 插件安装
- `packages/opencode/src/plugin/meta.ts` — 插件元数据追踪
- `packages/opencode/src/plugin/shared.ts` — 插件 spec 解析

### 插件 Spec 格式

在 `opencode.json` 中配置：
```json
{
  "plugin": [
    "opencode-my-plugin",                    // npm 包
    ["opencode-my-plugin", { option: true }], // 带选项
    "file:///path/to/plugin",                // 本地路径
    "./relative/plugin"                      // 相对路径
  ]
}
```

### 插件包结构

```
my-plugin/
  package.json         # name、version、engines: { opencode: ">=x" }、exports
  src/
    index.ts           # 默认导出：PluginModule 或 Plugin 函数
```

对于 npm 包，`package.json#exports` 支持以下字段：
```json
{
  "exports": {
    "./server": "./dist/server.js",
    "./tui": "./dist/tui.js"
  }
}
```

---

## 内部 Core 钩子（不用于外部插件）

以下钩子仅供内置插件内部使用：

| 钩子 | 输入 | 输出 | 定义位置 |
|------|-------|--------|------------|
| `catalog.transform` | `Catalog.Editor` | `{}` | `packages/core/src/plugin.ts:24` |
| `account.switched` | `{ serviceID, from?, to? }` | `{}` | `packages/core/src/plugin.ts:28` |
| `aisdk.language` | `{ model, sdk, options }` | `{ language? }` | `packages/core/src/plugin.ts:36` |
| `aisdk.sdk` | `{ model, package, options }` | `{ sdk? }` | `packages/core/src/plugin.ts:46` |
