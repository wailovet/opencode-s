import { DialogSettings } from "@/components/settings-v2"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { Route, useLocation, useNavigate, useParams } from "@solidjs/router"
import type { ParentProps } from "solid-js"
import { createMemo, onCleanup, onMount, Show } from "solid-js"
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

function VSCodeSessionProviders(props: ParentProps) {
  const params = useParams()
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
    return params.dir ? decode64(params.dir) : ""
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
