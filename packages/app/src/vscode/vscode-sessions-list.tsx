import { type Session } from "@opencode-ai/sdk/v2/client"
import { DateTime } from "luxon"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { produce } from "solid-js/store"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { sortedRootSessions } from "@/pages/layout/helpers"
import { openVSCodeNewSession, openVSCodeSession } from "@/vscode/vscode-patch"

const SESSION_LIMIT = 100
const LONG_PRESS_MS = 500

// 当前工作目录的 session 列表。外壳与 vscode-session.tsx 保持一致
// （bg-background-stronger rounded-[10px] shadow-[var(--v2-elevation-raised)]），
// 列表行风格贴近 home.tsx 的 HomeSessionRow（v2 token）。
// 点击行为通过 openVSCodeSession 环境感知：VS Code 新开 panel，web 新窗口。
export function VSCodeSessionsListPage(props: { directory: string }) {
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<Error | null>(null)
  const backendUrl = (window as unknown as { __opencodeVSCodeBackendUrl?: string }).__opencodeVSCodeBackendUrl ?? ""
  // 正在打开的 session id —— 点击后进入 opening 态直到 panel 就绪或超时。
  // panel 由 extension 异步创建并加载 app bundle，无法精确感知就绪时刻，
  // 用乐观 loading + 超时兜底，给用户即时反馈。
  const [openingId, setOpeningId] = createSignal<string | null>(null)
  let openingTimer: ReturnType<typeof setTimeout> | undefined
  // 长按后进入删除态的 session id。同一时间只有一行展开删除按钮。
  const [archivingId, setArchivingId] = createSignal<string | null>(null)
  const [store, setStore] = serverSync.child(props.directory, { bootstrap: false })

  const sessions = createMemo(() => sortedRootSessions(store, Date.now()))

  onMount(async () => {
    try {
      await serverSync.project.loadSessions(props.directory, { limit: SESSION_LIMIT })
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setLoading(false)
    }
  })

  // extension 创建 panel 后回执 sessionPanelOpened，据此提前清除 opening 态，
  // 不必等 10s 超时。仅在 webview 环境生效（web 环境用 window.open 无此消息）。
  const onPanelOpened = (event: MessageEvent) => {
    const message = event.data
    if (!message || message.source !== "opencode-vscode-app") return
    if (message.command !== "sessionPanelOpened") return
    if (message.sessionId === openingId()) {
      clearTimeout(openingTimer)
      setOpeningId(null)
    }
  }
  window.addEventListener("message", onPanelOpened)
  onCleanup(() => {
    clearTimeout(openingTimer)
    window.removeEventListener("message", onPanelOpened)
  })

  const relative = (session: Session) => {
    const ms = session.time.updated ?? session.time.created
    return DateTime.fromMillis(ms).toRelative({ locale: language.locale() }) ?? ""
  }

  const openSession = (sessionId: string) => {
    if (openingId() === sessionId) return
    setOpeningId(sessionId)
    openVSCodeSession(props.directory, sessionId)
    // 兜底：panel 加载通常在数百毫秒到数秒，10s 后强制清除避免永久卡在 loading。
    clearTimeout(openingTimer)
    openingTimer = setTimeout(() => setOpeningId(null), 10_000)
  }

  // 新建会话。opening key 与 extension 的 openNewSessionPanel 回执一致（<dir>:new）。
  const newSessionKey = `${props.directory}:new`
  const newSession = () => {
    if (openingId() === newSessionKey) return
    setOpeningId(newSessionKey)
    openVSCodeNewSession(props.directory)
    clearTimeout(openingTimer)
    openingTimer = setTimeout(() => setOpeningId(null), 10_000)
  }

  // 归档（删除）session：调 SDK 标记 archived，然后从本地 store 移除让列表即时更新。
  const archiveSession = async (sessionID: string) => {
    setArchivingId(null)
    setStore(
      "session",
      produce((list: Session[]) => {
        const index = list.findIndex((s) => s.id === sessionID)
        if (index !== -1) list.splice(index, 1)
      }),
    )
    await serverSDK.client.session
      .update({ sessionID, time: { archived: Date.now() } })
      .catch(() => {
        // 归档失败：重新加载列表恢复真实状态。
        void serverSync.project.loadSessions(props.directory, { limit: SESSION_LIMIT })
      })
  }

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      <div class="flex-1 min-h-0 flex flex-col bg-background-stronger overflow-hidden">
        <div class="shrink-0 flex items-center justify-between px-4 py-3 border-b border-v2-border-border-base">
          <div class="flex items-center gap-2 min-w-0">
            <span
              class="size-1.5 rounded-full shrink-0"
              classList={{
                "bg-v2-state-bg-success": !loading() && !error(),
                "bg-v2-state-bg-danger": !!error(),
                "bg-v2-icon-icon-muted": loading(),
              }}
            />
            <Show
              when={error()}
              fallback={
                <span class="text-v2-text-text-muted text-12-regular truncate">
                  {backendUrl || "opencode"}
                </span>
              }
            >
              <span class="text-v2-state-fg-danger text-12-regular truncate">
                {(error()?.message ?? "Connection failed").slice(0, 40)}
              </span>
            </Show>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <Show when={loading()}>
              <Spinner class="size-4 text-v2-icon-icon-muted" />
            </Show>
            <IconButtonV2
              variant="ghost-muted"
              size="small"
              icon={
                openingId() === newSessionKey ? (
                  <Spinner class="size-4 text-v2-icon-icon-muted" />
                ) : (
                  <IconV2 name="plus" />
                )
              }
              aria-label={language.t("command.session.new")}
              disabled={openingId() === newSessionKey}
              onClick={() => newSession()}
            />
          </div>
        </div>
        <ScrollView class="flex-1 min-h-0">
          <Show
            when={!loading() || sessions().length > 0}
            fallback={<SessionsSkeleton />}
          >
            <Show
              when={sessions().length > 0}
              fallback={<SessionsEmpty language={language} />}
            >
              <div class="flex flex-col gap-px p-2">
                <For each={sessions()}>
                  {(session) => (
                    <SessionRow
                      title={session.title || language.t("command.session.new")}
                      relative={relative(session)}
                      opening={openingId() === session.id}
                      archiving={archivingId() === session.id}
                      archiveLabel={language.t("common.archive")}
                      confirmLabel={language.t("common.delete")}
                      cancelLabel={language.t("common.cancel")}
                      onClick={() => openSession(session.id)}
                      onRequestArchive={() => setArchivingId(session.id)}
                      onCancelArchive={() => setArchivingId((cur) => (cur === session.id ? null : cur))}
                      onConfirmArchive={() => archiveSession(session.id)}
                    />
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </ScrollView>
      </div>
    </div>
  )
}

function SessionRow(props: {
  title: string
  relative: string
  opening: boolean
  archiving: boolean
  archiveLabel: string
  confirmLabel: string
  cancelLabel: string
  onClick: () => void
  onRequestArchive: () => void
  onCancelArchive: () => void
  onConfirmArchive: () => void
}) {
  let pressTimer: ReturnType<typeof setTimeout> | undefined
  let longPressed = false

  // 长按 LONG_PRESS_MS 触发归档态；提前松手则视为普通点击。
  const startPress = () => {
    longPressed = false
    pressTimer = setTimeout(() => {
      longPressed = true
      props.onRequestArchive()
    }, LONG_PRESS_MS)
  }
  const endPress = () => {
    clearTimeout(pressTimer)
  }

  return (
    <div
      class="flex min-w-0 w-full shrink-0 items-center rounded-[6px] h-11 gap-2 px-3 py-2 transition-[background-color] duration-[120ms] ease-in-out text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover"
      classList={{
        "bg-v2-state-bg-danger": props.archiving,
        "ring-1 ring-v2-state-border-danger": props.archiving,
      }}
    >
      <button
        type="button"
        disabled={props.opening}
        class="flex min-w-0 flex-1 items-center gap-2 bg-transparent text-left border-0 disabled:opacity-60"
        onClick={() => {
          if (longPressed || props.archiving) return
          props.onClick()
        }}
        onPointerDown={startPress}
        onPointerUp={endPress}
        onPointerLeave={endPress}
      >
        <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-14-regular">
          {props.title}
        </span>
        <Show
          when={props.opening}
          fallback={<span class="shrink-0 text-12-regular text-v2-text-text-faint">{props.relative}</span>}
        >
          <Spinner class="shrink-0 size-4 text-v2-icon-icon-muted" />
        </Show>
      </button>
      <Show when={props.archiving}>
        <button
          type="button"
          class="shrink-0 rounded-[4px] px-2 py-1 text-12-medium bg-v2-state-bg-danger text-v2-state-fg-danger border-0 cursor-pointer"
          onClick={() => props.onConfirmArchive()}
        >
          {props.confirmLabel}
        </button>
        <button
          type="button"
          class="shrink-0 rounded-[4px] px-2 py-1 text-12-medium bg-transparent text-v2-text-text-muted border-0 cursor-pointer"
          onClick={() => props.onCancelArchive()}
        >
          {props.cancelLabel}
        </button>
      </Show>
    </div>
  )
}

function SessionsSkeleton() {
  return (
    <div class="flex flex-col gap-px p-2">
      <For each={[0, 1, 2, 3, 4]}>
        {() => <div class="h-11 rounded-[6px] bg-v2-background-bg-deep opacity-70" />}
      </For>
    </div>
  )
}

function SessionsEmpty(props: { language: ReturnType<typeof useLanguage> }) {
  return (
    <div class="h-full flex flex-col items-center justify-center text-center px-6 py-10 gap-1">
      <span class="text-14-medium text-v2-text-text-base">
        {props.language.t("home.sessions.empty")}
      </span>
      <span class="text-12-regular text-v2-text-text-muted">
        {props.language.t("home.sessions.empty.description")}
      </span>
    </div>
  )
}
