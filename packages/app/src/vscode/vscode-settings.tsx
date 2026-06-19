import { DialogSettings } from "@/components/settings-v2"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { A, useLocation } from "@solidjs/router"
import { Match, Switch, createMemo, onCleanup, onMount } from "solid-js"
import { VSCodeMcpSettingsPage } from "./vscode-mcp-settings"
import { VSCodePermissionsSettingsPage } from "./vscode-permissions-settings"
import "./vscode-settings.css"

export function VSCodeSettingsPage() {
  const location = useLocation()
  const settingsBase = createMemo(() => location.pathname.replace(/\/settings(?:\/.*)?$/, "/settings"))
  const settingsTab = createMemo(() => {
    if (location.pathname.endsWith("/settings/permissions")) return "permissions"
    if (location.pathname.endsWith("/settings/mcp")) return "mcp"
    return "native"
  })

  onMount(() => {
    document.body.classList.add("vscode-settings-open")
  })
  onCleanup(() => {
    document.body.classList.remove("vscode-settings-open")
  })

  return (
    <div class="vscode-settings-wrapper">
      <div class="vscode-settings-tabs">
        <A class="vscode-settings-tab" data-active={settingsTab() === "native"} href={settingsBase()}>
          原生设置
        </A>
        <A class="vscode-settings-tab" data-active={settingsTab() === "permissions"} href={`${settingsBase()}/permissions`}>
          权限
        </A>
        <A class="vscode-settings-tab" data-active={settingsTab() === "mcp"} href={`${settingsBase()}/mcp`}>
          MCP
        </A>
      </div>
      <div class="vscode-settings-content">
        <Switch>
          <Match when={settingsTab() === "permissions"}>
            <VSCodePermissionsSettingsPage />
          </Match>
          <Match when={settingsTab() === "mcp"}>
            <VSCodeMcpSettingsPage />
          </Match>
          <Match when={true}>
            <div class="vscode-settings-native">
              <Kobalte open modal={false} onOpenChange={(open) => { if (!open) window.close() }}>
                <DialogSettings />
              </Kobalte>
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  )
}
