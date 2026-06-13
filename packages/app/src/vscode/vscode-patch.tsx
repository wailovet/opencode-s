import { DialogSettings } from "@/components/settings-v2"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { Route, useLocation, useNavigate, useParams } from "@solidjs/router"
import type { ParentProps } from "solid-js"
import { createEffect, createMemo, onCleanup, onMount, Show } from "solid-js"
import VSCodeSessionPage from "./vscode-session"
import { SDKProvider } from "@/context/sdk"
import { decode64 } from "@/utils/base64"
import { TerminalProvider } from "@/context/terminal"
import { FileProvider } from "@/context/file"
import { PromptProvider } from "@/context/prompt"
import { CommentsProvider } from "@/context/comments"
import { LocalProvider } from "@/context/local"
import { DataProvider } from "@opencode-ai/ui/context"
import { useSync } from "@/context/sync"
import { base64Encode } from "@opencode-ai/core/util/encode"

normalizeVSCodeLocationDirectory()
installVSCodePermissionBootstrapFallback()

function normalizeVSCodeDirectory(directory: string) {
  return directory.replace(/^[a-z]:/, (drive) => drive.toUpperCase())
}

function installVSCodePermissionBootstrapFallback() {
  if (typeof window === "undefined") return
  const target = window as typeof window & { __opencodeVSCodePermissionFetchPatched?: boolean }
  if (target.__opencodeVSCodePermissionFetchPatched) return
  target.__opencodeVSCodePermissionFetchPatched = true

  const originalFetch = window.fetch
  window.fetch = async (input, init) => {
    if (isVSCodePermissionListRequest(input)) return emptyJSONListResponse()
    return originalFetch.call(window, input, init)
  }
}

function emptyJSONListResponse() {
  return new Response("[]", {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function isVSCodePermissionListRequest(input: RequestInfo | URL) {
  if (!/^\/[^/]+\/vscode-session(?:\/|$)/.test(window.location.pathname)) return false

  const url = (() => {
    if (input instanceof Request) return new URL(input.url)
    return new URL(String(input), window.location.href)
  })()
  return url.pathname === "/permission"
}

function normalizeVSCodeLocationDirectory() {
  if (typeof window === "undefined") return

  const match = /^\/([^/]+)\/vscode-session(?:\/|$)/.exec(window.location.pathname)
  if (!match) return

  const directory = normalizeVSCodeDirectory(decode64(match[1]))
  const slug = base64Encode(directory)
  if (slug === match[1]) return

  window.history.replaceState(
    window.history.state,
    "",
    `/${slug}${window.location.pathname.slice(match[1].length + 1)}${window.location.search}${window.location.hash}`,
  )
}

function VSCodeSessionProviders(props: ParentProps) {
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  let debugObserver: MutationObserver | undefined

  const removeDebugUI = () => {
    const debugBar = document.querySelector('aside[aria-label="Development performance diagnostics"]')
    if (debugBar) debugBar.remove()
    const helpBtn = document.querySelector('button[aria-label="Help"]')
    if (helpBtn) {
      const wrapper = helpBtn.closest('[class*="fixed"]')
      if (wrapper) wrapper.remove()
    }
  }

  onMount(() => {
    debugObserver = new MutationObserver(removeDebugUI)
    debugObserver.observe(document.body, { childList: true, subtree: true })
    removeDebugUI()
  })
  onCleanup(() => debugObserver?.disconnect())

  const directory = createMemo(() => {
    return params.dir ? normalizeVSCodeDirectory(decode64(params.dir)) : ""
  })
  const slug = createMemo(() => base64Encode(directory()))

  createEffect(() => {
    const next = slug()
    if (!params.dir || !next || next === params.dir) return
    const path = location.pathname.slice(params.dir.length + 1)
    navigate(`/${next}${path}${location.search}${location.hash}`, { replace: true })
  })

  return (
    <Show when={directory()} keyed>
      {(dir) => (
        <SDKProvider directory={dir}>
          <VSCodeDirectoryDataProvider directory={dir}>
            <TerminalProvider>
              <FileProvider>
                <PromptProvider>
                  <CommentsProvider>
                    <VSCodeSessionPage />
                  </CommentsProvider>
                </PromptProvider>
              </FileProvider>
            </TerminalProvider>
          </VSCodeDirectoryDataProvider>
        </SDKProvider>
      )}
    </Show>
  )
}

function VSCodeDirectoryDataProvider(props: ParentProps & { directory: string }) {
  const sync = useSync()
  const navigate = useNavigate()
  const slug = createMemo(() => base64Encode(props.directory))

  return (
    <DataProvider
      data={sync.data}
      directory={props.directory}
      onNavigateToSession={(sessionID: string) =>
        navigate(`/${slug()}/vscode-session/${sessionID}`)
      }
      onSessionHref={(sessionID: string) =>
        `/${slug()}/vscode-session/${sessionID}`
      }
    >
      <LocalProvider>
        {props.children}
      </LocalProvider>
    </DataProvider>
  )
}

export function PatchedRouteGate(props: ParentProps) {
  const location = useLocation()
  const component = () => {
    if (location.pathname.includes("/settings")) return VSCodeSettingsPage
  }
  return (
    <Show when={component()} keyed fallback={props.children}>
      {(Component) => <Component />}
    </Show>
  )
}

export function VSCodeSettingsPage() {
  onMount(() => {
    document.body.classList.add("vscode-settings-open")
  })

  return (
    <div class="vscode-settings-wrapper">
      <style>{`
      .vscode-settings-wrapper {
        width: 100vw;
        height: 100dvh;
      }

      .vscode-settings-wrapper [data-component="dialog-v2"],
      body.vscode-settings-open [data-component="dialog-v2"] {
        display: flex;
        align-items: stretch;
        justify-content: stretch;
        width: 100% !important;
        height: 100% !important;
        pointer-events: auto;
      }

      body.vscode-settings-open [data-slot="dialog-container"] {
        width: 100% !important;
        height: 100% !important;
        border-radius: 0 !important;
        box-shadow: none !important;
      }

      body.vscode-settings-open [data-slot="dialog-content"] {
        width: 100% !important;
        height: 100% !important;
        max-height: none !important;
        border-radius: 0 !important;
      }

      body.vscode-settings-open [data-slot="dialog-body"] {
        width: 100% !important;
        height: 100% !important;
        max-height: none !important;
      }
    `}</style>
      <Kobalte open modal onOpenChange={(open) => { if (!open) window.close() }}>
        <DialogSettings />
      </Kobalte>
    </div>
  )
}


export function PatchedRoutes() {
  return (
    <>
      <Route path="/settings" component={VSCodeSettingsPage} />
      <Route path="/:dir/vscode-session/:id?" component={VSCodeSessionProviders} />
    </>
  )
}
