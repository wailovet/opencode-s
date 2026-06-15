import { type Session } from "@opencode-ai/sdk/v2/client"
import { DateTime } from "luxon"
import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { produce } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { sortedRootSessions } from "@/pages/layout/helpers"
import { openVSCodeNewSession, openVSCodeSession } from "@/vscode/vscode-patch"

const SESSION_LIMIT = 100
export function VSCodeSessionsListPage(props: { directory: string }) {
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<Error | null>(null)
  const [openingId, setOpeningId] = createSignal<string | null>(null)
  const [activeId, setActiveId] = createSignal<string | null>(null)
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [editingTitle, setEditingTitle] = createSignal("")
  const [savingTitleId, setSavingTitleId] = createSignal<string | null>(null)
  const [deletingId, setDeletingId] = createSignal<string | null>(null)
  const [query, setQuery] = createSignal("")
  const [store, setStore] = serverSync.child(props.directory, { bootstrap: false })
  const newSessionKey = `${props.directory}:new`
  let openingTimer: ReturnType<typeof setTimeout> | undefined

  const sessions = createMemo(() => sortedRootSessions(store, Date.now()))
  const filteredSessions = createMemo(() => {
    const normalized = query().trim().toLowerCase()
    if (!normalized) return sessions()
    return sessions().filter((session) =>
      (session.title || language.t("command.session.new")).toLowerCase().includes(normalized),
    )
  })
  const connectionStatus = createMemo(() => {
    if (error()) return "Connection failed"
    if (loading()) return "Connecting"
    return "Connected"
  })
  const connectionDetail = createMemo(() => {
    if (error()) return (error()?.message ?? "opencode").slice(0, 48)
    return "opencode"
  })

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

  const onPanelOpened = (event: MessageEvent) => {
    const message = event.data
    if (!message || message.source !== "opencode-vscode-app") return
    if (message.command !== "sessionPanelOpened") return
    if (message.sessionId !== openingId()) return
    clearTimeout(openingTimer)
    setOpeningId(null)
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
    setActiveId(sessionId)
    setOpeningId(sessionId)
    openVSCodeSession(props.directory, sessionId)
    clearTimeout(openingTimer)
    openingTimer = setTimeout(() => setOpeningId(null), 10_000)
  }

  const newSession = () => {
    if (openingId() === newSessionKey) return
    setOpeningId(newSessionKey)
    openVSCodeNewSession(props.directory)
    clearTimeout(openingTimer)
    openingTimer = setTimeout(() => setOpeningId(null), 10_000)
  }

  const editSessionTitle = (session: Session) => {
    setEditingId(session.id)
    setEditingTitle(session.title || language.t("command.session.new"))
  }

  const saveSessionTitle = async (sessionID: string) => {
    const title = editingTitle().trim()
    if (!title) return
    setSavingTitleId(sessionID)
    setStore(
      "session",
      produce((list: Session[]) => {
        const session = list.find((item) => item.id === sessionID)
        if (session) session.title = title
      }),
    )
    await serverSDK.client.session
      .update({ sessionID, title })
      .catch(() => void serverSync.project.loadSessions(props.directory, { limit: SESSION_LIMIT }))
      .finally(() => {
        setSavingTitleId(null)
        setEditingId(null)
      })
  }

  const deleteSession = async (sessionID: string, title: string) => {
    if (!window.confirm(language.t("session.delete.confirm", { name: title }))) return
    setDeletingId(sessionID)
    setStore(
      "session",
      produce((list: Session[]) => {
        const index = list.findIndex((s) => s.id === sessionID)
        if (index !== -1) list.splice(index, 1)
      }),
    )
    await serverSDK.client.session
      .delete({ sessionID })
      .catch(() => void serverSync.project.loadSessions(props.directory, { limit: SESSION_LIMIT }))
      .finally(() => setDeletingId(null))
  }

  return (
    <div class="relative size-full overflow-hidden flex flex-col bg-background-stronger text-v2-text-text-base">
      <div class="shrink-0 flex h-12 min-w-0 items-center gap-2 px-5 text-v2-text-text-base">
        <span
          class="size-1.5 rounded-full shrink-0"
          classList={{
            "bg-v2-state-bg-success": !loading() && !error(),
            "bg-v2-state-bg-danger": !!error(),
            "bg-v2-icon-icon-muted": loading(),
          }}
        />
        <span class="shrink-0 text-14-medium">{connectionStatus()}</span>
        <span class="min-w-0 flex-1 truncate text-right text-12-regular text-v2-text-text-muted">
          {connectionDetail()}
        </span>
        <Show when={loading()}>
          <Spinner class="size-3.5 shrink-0 text-v2-icon-icon-muted" />
        </Show>
        <IconActionButton
          label={language.t("command.session.new")}
          disabled={openingId() === newSessionKey}
          onClick={newSession}
        >
          <Show when={openingId() === newSessionKey} fallback={<IconV2 name="plus" size="small" />}>
            <Spinner class="size-3.5 text-v2-icon-icon-muted" />
          </Show>
        </IconActionButton>
      </div>

      <div class="shrink-0 px-2 pb-3">
        <label class="relative block h-9">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-v2-icon-icon-muted">
            <IconV2 name="magnifying-glass" size="small" />
          </span>
          <input
            class="h-9 w-full rounded-[4px] border-0 bg-v2-background-bg-base pl-9 pr-3 text-14-regular text-v2-text-text-base outline-none placeholder:text-v2-text-text-muted focus:ring-1 focus:ring-v2-border-border-focus"
            value={query()}
            placeholder="Search sessions..."
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
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
            <Show
              when={filteredSessions().length > 0}
              fallback={<SessionsEmpty label="No matching sessions" />}
            >
              <div class="flex flex-col gap-px px-2 pb-2">
                <For each={filteredSessions()}>
                  {(session) => (
                    <SessionRow
                      title={session.title || language.t("command.session.new")}
                      relative={relative(session)}
                      active={activeId() === session.id}
                      opening={openingId() === session.id}
                      editing={editingId() === session.id}
                      draftTitle={editingTitle()}
                      saving={savingTitleId() === session.id}
                      deleting={deletingId() === session.id}
                      editLabel={language.t("common.edit")}
                      saveLabel={language.t("common.save")}
                      deleteLabel={language.t("common.delete")}
                      cancelLabel={language.t("common.cancel")}
                      onClick={() => openSession(session.id)}
                      onEdit={() => editSessionTitle(session)}
                      onDraftTitle={setEditingTitle}
                      onCancelEdit={() => setEditingId((cur) => (cur === session.id ? null : cur))}
                      onSaveTitle={() => saveSessionTitle(session.id)}
                      onDelete={() => deleteSession(session.id, session.title || language.t("command.session.new"))}
                    />
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </ScrollView>
    </div>
  )
}

function SessionRow(props: {
  title: string
  relative: string
  active: boolean
  opening: boolean
  editing: boolean
  draftTitle: string
  saving: boolean
  deleting: boolean
  editLabel: string
  saveLabel: string
  deleteLabel: string
  cancelLabel: string
  onClick: () => void
  onEdit: () => void
  onDraftTitle: (value: string) => void
  onCancelEdit: () => void
  onSaveTitle: () => void
  onDelete: () => void
}) {
  return (
    <div
      class="group flex min-w-0 w-full shrink-0 items-center rounded-[4px] h-9 gap-2 px-2 transition-[background-color,color] duration-[120ms] ease-in-out text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover"
      classList={{
        "bg-v2-overlay-simple-overlay-hover": props.active || props.opening,
        "bg-v2-state-bg-danger ring-1 ring-v2-state-border-danger": props.deleting,
      }}
    >
      <Show
        when={props.editing}
        fallback={
          <button
            type="button"
            disabled={props.opening || props.deleting}
            class="flex h-full min-w-0 flex-1 items-center gap-2 bg-transparent text-left border-0 disabled:opacity-70 cursor-pointer focus-visible:outline-none"
            onClick={() => props.onClick()}
          >
            <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-14-regular">
              {props.title}
            </span>
            <Show
              when={props.opening}
              fallback={<span class="shrink-0 text-12-regular text-v2-text-text-faint">{props.relative}</span>}
            >
              <Spinner class="shrink-0 size-3.5 text-v2-icon-icon-muted" />
            </Show>
          </button>
        }
      >
        <input
          class="h-7 min-w-0 flex-1 rounded-[3px] border-0 bg-v2-background-bg-base px-2 text-14-regular text-v2-text-text-base outline-none focus:ring-1 focus:ring-v2-border-border-focus"
          value={props.draftTitle}
          disabled={props.saving}
          autofocus
          onInput={(event) => props.onDraftTitle(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") props.onSaveTitle()
            if (event.key === "Escape") props.onCancelEdit()
          }}
        />
      </Show>

      <div
        class="shrink-0 flex items-center gap-1 transition-opacity duration-[120ms]"
        classList={{
          "opacity-100": props.active || props.editing,
          "opacity-0 group-hover:opacity-100 focus-within:opacity-100": !props.active && !props.editing,
        }}
      >
        <Show
          when={props.editing}
          fallback={
            <>
              <IconActionButton
                label={props.editLabel}
                disabled={props.opening || props.deleting}
                onClick={props.onEdit}
              >
                <IconV2 name="edit" size="small" />
              </IconActionButton>
              <IconActionButton
                label={props.deleteLabel}
                disabled={props.opening || props.deleting}
                onClick={props.onDelete}
              >
                <Show when={props.deleting} fallback={<Icon name="trash" size="small" />}>
                  <Spinner class="size-3.5 text-v2-icon-icon-muted" />
                </Show>
              </IconActionButton>
            </>
          }
        >
          <IconActionButton
            label={props.saveLabel}
            disabled={props.saving || !props.draftTitle.trim()}
            onClick={props.onSaveTitle}
          >
            <Show when={props.saving} fallback={<Icon name="check" size="small" />}>
              <Spinner class="size-3.5 text-v2-icon-icon-muted" />
            </Show>
          </IconActionButton>
          <IconActionButton
            label={props.cancelLabel}
            disabled={props.saving}
            onClick={props.onCancelEdit}
          >
            <Icon name="close-small" size="small" />
          </IconActionButton>
        </Show>
      </div>
    </div>
  )
}

function IconActionButton(props: {
  label: string
  disabled?: boolean
  children: JSX.Element
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      class="grid size-7 place-items-center rounded-[4px] border-0 bg-transparent text-v2-icon-icon-muted transition-[background-color,color] duration-[120ms] hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base disabled:cursor-default disabled:opacity-50"
      onClick={(event) => {
        event.stopPropagation()
        props.onClick()
      }}
    >
      {props.children}
    </button>
  )
}

function SessionsSkeleton() {
  return (
    <div class="flex flex-col gap-px px-2 pb-2">
      <For each={[0, 1, 2, 3, 4]}>
        {() => <div class="h-9 rounded-[4px] bg-v2-background-bg-deep opacity-70" />}
      </For>
    </div>
  )
}

function SessionsEmpty(props: { language?: ReturnType<typeof useLanguage>; label?: string }) {
  return (
    <div class="h-full flex flex-col items-center justify-center text-center px-6 py-10 gap-1">
      <span class="text-14-medium text-v2-text-text-base">
        {props.label ?? props.language?.t("home.sessions.empty")}
      </span>
      <Show when={!props.label}>
        <span class="text-12-regular text-v2-text-text-muted">
          {props.language?.t("home.sessions.empty.description")}
        </span>
      </Show>
    </div>
  )
}
