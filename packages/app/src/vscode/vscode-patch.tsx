import { DialogSettings } from "@/components/settings-v2"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { Route, useLocation } from "@solidjs/router"
import type { Component, ParentProps } from "solid-js"
import { onMount, Show } from "solid-js"

const routes = new Map<string, Component>()

export function registerRoute(path: string, component: Component) {
  routes.set(path, component)
}

export function getPatchedRoute(path: string): Component | undefined {
  return routes.get(path)
}

export function PatchedRouteGate(props: ParentProps) {
  const location = useLocation()
  const component = () => getPatchedRoute(location.pathname)
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

registerRoute("/settings", VSCodeSettingsPage)

export function PatchedRoutes() {
  return <Route path="/settings" component={VSCodeSettingsPage} />
}