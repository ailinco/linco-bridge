import type { AgentBridgeType } from '@/bridge/types'
import { pickBridgeWorkspace, type PickWorkspaceResult } from '@/utils/pick-workspace'

export function useProjectPicker() {
  async function pickWorkspace(
    agentType: AgentBridgeType,
    connectionId?: string,
    platformSessionId?: string,
  ): Promise<PickWorkspaceResult | null> {
    return pickBridgeWorkspace(agentType, connectionId, platformSessionId)
  }

  return { pickWorkspace }
}
