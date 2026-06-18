import type { Accessor, Component } from "solid-js"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { SettingsListV2 } from "@/components/settings-v2/parts/list"
import { SettingsRowV2 } from "@/components/settings-v2/parts/row"

export const VSCodeFiSettings: Component<{
  enabled: Accessor<boolean>
  disabled: Accessor<boolean>
  onEnabledChange: (enabled: boolean) => void
}> = (props) => {
  return (
    <Dialog title="FI 配置" description="配置 opencode-fi-plugin 工作流。">
      <div class="w-[360px] p-4">
        <SettingsListV2>
          <SettingsRowV2 title="分析-实施" description="启用 FI 分析与实施工作流。">
            <Switch checked={props.enabled()} disabled={props.disabled()} onChange={props.onEnabledChange} hideLabel>
              分析-实施
            </Switch>
          </SettingsRowV2>
        </SettingsListV2>
      </div>
    </Dialog>
  )
}
