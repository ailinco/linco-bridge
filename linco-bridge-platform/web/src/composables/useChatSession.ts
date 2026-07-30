import { computed, nextTick, ref } from 'vue'
import { parseAgentTypeFromSessionId } from '@/bridge/sdk/agent-chat'
import { BRIDGE_HISTORY_SYNC_LIMIT } from '@/bridge/constants'
import type { OutboundChatFile } from '@/api/session-api'
import { useBridgeStore, useSessionStore } from '@/stores'
import { takePendingFiles } from '@/composables/pendingAttachmentTransfer'
import { takePendingLaunch } from '@/composables/pendingLaunchTransfer'
import { toApiOutboundFiles } from '@/utils/chat-attachments'
import { prepareOutboundImages } from '@/utils/image-compress'
import { resolveChatHeader, type ChatHeaderView } from '@/utils/chat-header'
import { showToast } from '@/utils/format'
import {
  createCancelToken,
  delay,
  isAbortError,
  scheduleNextFrame,
  type CancelToken,
} from '@/utils/platform-runtime'
export function useChatSession() {
  const sessionStore = useSessionStore()
  const bridgeStore = useBridgeStore()

  const sessionId = ref('')
  const draft = ref('')
  const sending = ref(false)
  const loading = ref(false)
  const header = ref<ChatHeaderView | null>(null)
  const scrollAnchor = ref('')
  const pendingDraft = ref('')
  const activeStreamId = ref('')
  const cancelToken = ref<CancelToken | null>(null)
  const messages = computed(() => sessionStore.getMessages(sessionId.value))

  async function refreshHeader() {
    if (!sessionId.value) return

    const session = sessionStore.getSession(sessionId.value)
    const agentType = session?.agentType ?? parseAgentTypeFromSessionId(sessionId.value)

    if (agentType) {
      await bridgeStore.checkStatus(agentType, session?.connectionId).catch(() => undefined)
    }

    const status = agentType ? bridgeStore.statusByType[agentType] : undefined
    const online = session?.online ?? status?.connected ?? false
    const deviceName = status?.deviceName ?? session?.deviceName
    const boundContextName = status?.boundContextName ?? session?.boundContextName

    header.value = resolveChatHeader(sessionId.value, session, online, deviceName, boundContextName)
  }

  async function loadSession(
    id: string,
    options?: string | { initialDraft?: string; reloadHistory?: boolean },
  ) {
    const normalized =
      typeof options === 'string'
        ? { initialDraft: options, reloadHistory: false }
        : { initialDraft: options?.initialDraft, reloadHistory: options?.reloadHistory ?? false }

    sessionId.value = id
    draft.value = ''
    const launchMessage = takePendingLaunch(id)
    const autoSendText = launchMessage ?? normalized.initialDraft?.trim() ?? ''
    const hasAutoSend = autoSendText.length > 0
    pendingDraft.value = autoSendText
    loading.value = true

    try {
      if (sessionStore.sessions.length === 0) {
        await sessionStore.loadSessions().catch(() => undefined)
      }

      const session = sessionStore.getSession(id)
      const agentType = session?.agentType ?? parseAgentTypeFromSessionId(id)
      if (agentType) {
        await bridgeStore.checkStatus(agentType, session?.connectionId).catch(() => undefined)
      }

      const status = agentType ? bridgeStore.statusByType[agentType] : undefined
      const deviceName = status?.deviceName ?? session?.deviceName
      const boundContextName = status?.boundContextName ?? session?.boundContextName
      header.value = resolveChatHeader(
        id,
        session,
        session?.online ?? status?.connected,
        deviceName,
        boundContextName,
      )

      if (hasAutoSend) {
        sessionStore.setMessages(id, [])
      } else {
        if (normalized.reloadHistory) {
          sessionStore.setMessages(id, [])
        }

        try {
          await sessionStore.loadMessages(id, {
            limit: normalized.reloadHistory ? BRIDGE_HISTORY_SYNC_LIMIT : undefined,
            reload: normalized.reloadHistory,
          })
        } catch (err) {
          sessionStore.setMessages(id, [])
          const message = err instanceof Error ? err.message : '加载消息失败'
          if (message.includes('会话不存在')) {
            showToast(message)
          }
        }
      }
    } finally {
      loading.value = false
    }

    void refreshHeader()
    scrollToBottom()

    const pendingFiles = takePendingFiles(id)
    if (pendingDraft.value || pendingFiles.length > 0) {
      const text = pendingDraft.value
      pendingDraft.value = ''
      await sendMessage(text, pendingFiles)
    }
  }

  function scrollToBottom() {
    scrollAnchor.value = ''
    void nextTick(() => {
      scheduleNextFrame(() => {
        scrollAnchor.value = 'chat-bottom'
      })
      void delay(160).then(() => {
        scrollAnchor.value = ''
        scrollAnchor.value = 'chat-bottom'
      })
    })
  }
  async function sendMessage(contentOverride?: string, files: OutboundChatFile[] = []) {
    const content = (contentOverride ?? draft.value).trim()
    // 发送前再压一次：覆盖 landing stash / 未走 picker 压缩的路径
    const preparedFiles = await prepareOutboundImages(files)
    const apiFiles = toApiOutboundFiles(preparedFiles)
    if ((!content && apiFiles.length === 0) || !sessionId.value || sending.value) return
    if (files.length > 0 && apiFiles.length === 0) {
      showToast('附件读取失败，请重新选择')
      return
    }

    sending.value = true
    activeStreamId.value = ''
    draft.value = ''

    const cancel = createCancelToken()
    cancelToken.value = cancel
    scrollToBottom()

    try {
      await sessionStore.sendMessageStream(sessionId.value, content, {
        cancel,
        onStreamId: (streamId) => {
          activeStreamId.value = streamId
        },
        files: apiFiles,
      })
    } catch (err) {
      if (isAbortError(err) || cancel.aborted) {
        showToast('已停止生成')
      } else {
        const message = err instanceof Error ? err.message : '发送失败'
        showToast(message)
      }
    } finally {
      cancelToken.value = null
      activeStreamId.value = ''
      sending.value = false
      await refreshHeader()
    }
  }

  async function stopGeneration() {
    if (!sending.value || !sessionId.value) return

    cancelToken.value?.abort()

    const streamId = activeStreamId.value
    if (streamId) {
      try {
        await sessionStore.cancelActiveStream(sessionId.value, streamId)
      } catch (err) {
        const message = err instanceof Error ? err.message : '停止生成失败'
        showToast(message)
      }
    }

    sending.value = false
    activeStreamId.value = ''
    cancelToken.value = null
  }

  async function reloadHistory(limit?: number, reload = true) {
    if (!sessionId.value) return
    loading.value = true
    try {
      await sessionStore.loadMessages(sessionId.value, { limit, reload })
      scrollToBottom()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '加载消息失败')
      throw err
    } finally {
      loading.value = false
      await refreshHeader()
    }
  }

  return {
    sessionId,
    draft,
    sending,
    loading,
    header,
    messages,
    scrollAnchor,
    loadSession,
    sendMessage,
    stopGeneration,
    scrollToBottom,
    reloadHistory,
  }
}
