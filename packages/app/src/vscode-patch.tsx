import "../../vscode-app/src/vscode-patch.css"
import { DialogSettings } from "@/components/settings-v2"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { Route, useLocation } from "@solidjs/router"
import type { Component, ParentProps } from "solid-js"
import { Show } from "solid-js"

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
  return (
    <div class="vscode-settings-wrapper">
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
