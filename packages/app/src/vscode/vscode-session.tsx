import type { UserMessage } from "@opencode-ai/sdk/v2"
import {
  Show,
  Switch,
  Match,
  createMemo,
  createEffect,
  createComputed,
  on,
  untrack,
  createResource,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useSearchParams } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"
import { VSCodePromptInput } from "@/vscode/vscode-prompt-input"
import { createSessionComposerState } from "@/pages/session/composer/session-composer-state"
import { SessionPermissionDock } from "@/pages/session/composer/session-permission-dock"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { MessageTimeline } from "@/pages/session/message-timeline"
import { useSessionLayout } from "@/pages/session/session-layout"
import { useServer } from "@/context/server"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { createResizeObserver } from "@solid-primitives/resize-observer"

// 来源: session.tsx:74-77 — 常量
const emptyUserMessages: UserMessage[] = []

// 来源: session.tsx:186 — 主 Page 组件 (VSCode版)
export default function VSCodeSessionPage() {
  // 来源: session.tsx:196-203 — hooks
  const layout = useLayout()
  const sync = useSync()
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const prompt = usePrompt()
  const server = useServer()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()
  const location = useLocation()
  const { params, sessionKey } = useSessionLayout()
  const composer = createSessionComposerState({ closeMs: 0 })

  // 来源: session.tsx:207-215 — 从URL参数读取初始prompt
  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      if (params.id) return
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  // 来源: session.tsx:217-229 — UI状态
  const [ui, setUi] = createStore({
    pendingMessage: undefined as string | undefined,
    scrollGesture: 0,
    scroll: { overflow: false, bottom: true, jump: false },
  })

  // 来源: session.tsx:310-331 — session info 和 messages
  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))
  const messagesReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    return sync.data.message[id] !== undefined
  })
  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    emptyUserMessages,
  )
  const visibleUserMessages = createMemo(() => {
    const revert = revertMessageID()
    if (!revert) return userMessages()
    return userMessages().filter((m) => m.id < revert)
  }, emptyUserMessages)

  // 来源: session.tsx:393-404 — store
  const [store, setStore] = createStore({
    messageId: undefined as string | undefined,
    mobileTab: "session" as "session" | "changes",
    deferRender: false,
  })

  // 来源: session.tsx:416-428 — defer render
  createComputed((prev) => {
    const key = sessionKey()
    if (key !== prev) {
      setStore("deferRender", true)
      requestAnimationFrame(() => {
        setTimeout(() => setStore("deferRender", false), 0)
      })
    }
    return key
  }, sessionKey())

  // 来源: session.tsx:430-584 — 变量定义
  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let revealMessage = (_id: string) => {}
  let scrollMark = 0
  let messageMark = 0

  const scrollGestureWindowMs = 250

  // 来源: session.tsx:620-633 — 滚动手势检测
  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return
    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return
    setUi("scrollGesture", Date.now())
  }
  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  // 来源: session.tsx:635-670 — session sync
  const [sessionSync] = createResource(
    () => [sdk.directory, params.id] as const,
    ([directory, id]) => {
      if (!id) return
      return sync.session.sync(id)
    },
  )

  // 来源: session.tsx:705-720 — 新消息置顶
  createEffect(
    on(
      () => visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  // 来源: session.tsx:722-733 — session切换重置状态
  createEffect(
    on(
      sessionKey,
      () => {
        setStore("messageId", undefined)
        setUi("pendingMessage", undefined)
      },
      { defer: true },
    ),
  )

  // 来源: session.tsx:1201-1218 — auto scroll
  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "dynamic",
  })

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined

  const updateScrollState = (el: HTMLDivElement) => {
    const overflow = el.scrollHeight > el.clientHeight
    const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
    setUi("scroll", { overflow, bottom, jump: false })
  }

  const scheduleScrollState = (el: HTMLDivElement | undefined) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return
    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined
      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return
      updateScrollState(target)
    })
  }

  const resumeScroll = () => {
    setStore("messageId", undefined)
    autoScroll.forceScrollToBottom()
    clearMessageHash()
    const el = scroller
    if (el) scheduleScrollState(el)
  }

  // 来源: session.tsx:1248-1260 — 用户滚动回底重置
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
  }

  const markUserScroll = () => {
    scrollMark += 1
  }

  createResizeObserver(
    () => content,
    () => {
      const el = scroller
      if (el) scheduleScrollState(el)
    },
  )

  // 来源: session.tsx:1630-1645 — hash scroll (简化)
  const { clearMessageHash } = useSessionHashScroll({
    sessionKey,
    sessionID: () => params.id,
    messagesReady,
    visibleUserMessages,
    historyMore: () => false,
    historyLoading: () => false,
    loadMore: () => Promise.resolve(),
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setActiveMessage: (message) => {
      messageMark = scrollMark
      setStore("messageId", message?.id)
    },
    autoScroll,
    scroller: () => scroller,
    anchor: (id: string) => `message-${id}`,
    revealMessage: (id) => revealMessage(id),
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })

  // 来源: session.tsx:1647-1652 — 无session时聚焦输入框
  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id) requestAnimationFrame(() => inputRef?.focus())
      },
    ),
  )

  // 来源: upstream → SessionComposerRegion → PromptInput
  // VSCode版 — 复用上游 PromptInput 的 VSCode 适配版本

  // 来源: session.tsx:1719-1868 — JSX return
  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      {sessionSync() ?? ""}
      <div class="flex-1 min-h-0 flex flex-col">
        {/* 来源: session.tsx:1770-1860 — 主内容区 */}
        <div class="flex-1 min-h-0 flex flex-col bg-background-stronger rounded-[10px] overflow-hidden shadow-[var(--v2-elevation-raised)]">
          <div class="flex-1 min-h-0 overflow-hidden">
            <Switch>
              {/* 来源: session.tsx:1786-1820 — message timeline */}
              <Match when={params.id}>
                <MessageTimeline
                  scroll={ui.scroll}
                  onResumeScroll={resumeScroll}
                  setScrollRef={setScrollRef}
                  onScheduleScrollState={scheduleScrollState}
                  onAutoScrollHandleScroll={autoScroll.handleScroll}
                  onMarkScrollGesture={markScrollGesture}
                  hasScrollGesture={hasScrollGesture}
                  onUserScroll={markUserScroll}
                  onHistoryScroll={() => {}}
                  onAutoScrollInteraction={autoScroll.handleInteraction}
                  shouldAnchorBottom={() =>
                    !location.hash && !store.messageId && !ui.pendingMessage && !autoScroll.userScrolled()
                  }
                  centered={false}
                  setContentRef={(el) => {
                    content = el
                    autoScroll.contentRef(el)
                    const root = scroller
                    if (root) scheduleScrollState(root)
                  }}
                  historyShift={false}
                  userMessages={visibleUserMessages()}
                  anchor={(id: string) => `message-${id}`}
                  setRevealMessage={(fn) => { revealMessage = fn }}
                />
              </Match>
              {/* 来源: session.tsx:1822 — 空状态 */}
              <Match when={true}>
                <div class="h-full flex flex-col items-center justify-center text-center text-text-weak">
                  <div class="text-14-regular max-w-56">
                    {language.t("session.review.noChanges")}
                  </div>
                </div>
              </Match>
            </Switch>
          </div>
          {/* VSCode版 — 使用 VSCodePromptInput */}
          <div class="shrink-0 px-3 pb-3 flex flex-col gap-2" data-component="session-prompt-dock">
            <Show when={composer.questionRequest()} keyed>
              {(request) => (
                <div>
                  <SessionQuestionDock request={request} onSubmit={resumeScroll} />
                </div>
              )}
            </Show>
            <Show when={composer.permissionRequest()} keyed>
              {(request) => (
                <div>
                  <SessionPermissionDock
                    request={request}
                    responding={composer.permissionResponding()}
                    onDecide={(response) => {
                      resumeScroll()
                      composer.decide(response)
                    }}
                  />
                </div>
              )}
            </Show>
            <VSCodePromptInput onSubmit={() => resumeScroll()} />
          </div>
        </div>
      </div>
      {/* 来源: session.tsx:1866 — 终端面板 (VSCode侧边栏不需要) */}
    </div>
  )
}
