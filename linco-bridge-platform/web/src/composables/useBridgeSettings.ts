import { ref } from 'vue'

import type {
  AgentBridgeType,
  BridgeSessionSettings,
  BridgeSettingsOptions,
  BridgeSettingsPickerResult,
} from '@/bridge/types'
import { useBridgeStore } from '@/stores'
import { showBridgeSettingsPicker } from '@/utils/bridge-settings-picker'
import { buildBridgeSettingsToolbarLabel } from '@/utils/bridge-settings'

export function useBridgeSettings() {
  const bridgeStore = useBridgeStore()
  const pendingSettings = ref<BridgeSessionSettings | null>(null)
  const cachedOptions = ref<BridgeSettingsOptions | null>(null)

  const settingsLabel = ref('默认')

  function syncSettingsLabel(options?: BridgeSettingsOptions | null) {
    settingsLabel.value = buildBridgeSettingsToolbarLabel(pendingSettings.value, options)
  }

  async function preloadOptions(
    agentType: AgentBridgeType,
    connectionId?: string,
    sessionId?: string,
  ) {
    try {
      cachedOptions.value = await bridgeStore.sdk.loadSettingsOptions(
        agentType,
        connectionId,
        sessionId,
      )
      syncSettingsLabel(cachedOptions.value)
    } catch {
      // landing toolbar can still show 默认 before connector is ready
    }
  }

  function applySessionSettings(settings: BridgeSessionSettings | null | undefined) {
    pendingSettings.value = settings?.reasoningEffort || settings?.modelId ? { ...settings } : null
    syncSettingsLabel(cachedOptions.value)
  }

  async function pickSettings(input: {
    agentType: AgentBridgeType
    connectionId?: string
    sessionId?: string
    persist?: boolean
  }): Promise<BridgeSettingsPickerResult | null> {
    let options = cachedOptions.value
    options = await bridgeStore.sdk.loadSettingsOptions(
      input.agentType,
      input.connectionId,
      input.sessionId,
    )
    cachedOptions.value = options

    const picked = await showBridgeSettingsPicker({
      agentType: input.agentType,
      connectionId: input.connectionId,
      sessionId: input.sessionId,
      initialSettings: pendingSettings.value,
      options,
    })
    if (!picked) return null

    const next: BridgeSessionSettings = {
      reasoningEffort: picked.reasoningEffort ?? pendingSettings.value?.reasoningEffort,
      modelId: picked.modelId ?? pendingSettings.value?.modelId,
      modelName: picked.modelName ?? pendingSettings.value?.modelName,
      updatedAt: Date.now(),
    }
    pendingSettings.value = next.reasoningEffort?.trim() || next.modelId?.trim() ? next : null
    syncSettingsLabel(options)

    if (input.persist && input.sessionId) {
      const saved = await bridgeStore.sdk.updateBridgeSettings(input.agentType, {
        connectionId: input.connectionId,
        sessionId: input.sessionId,
        reasoningEffort: picked.reasoningEffort,
        modelId: picked.modelId,
        modelName: picked.modelName,
      })
      pendingSettings.value = saved
      syncSettingsLabel(options)
      return saved
    }

    return picked
  }

  function resetPendingSettings() {
    pendingSettings.value = null
    settingsLabel.value = '默认'
  }

  return {
    pendingSettings,
    cachedOptions,
    settingsLabel,
    preloadOptions,
    applySessionSettings,
    pickSettings,
    resetPendingSettings,
    syncSettingsLabel,
  }
}
