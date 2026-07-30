import { defineStore } from 'pinia'
import { ref } from 'vue'
import { createAppBridgeSdk } from '@/api'
import {
  cancelStreamMessage,
  fetchMessages,
  fetchSessions,
  streamSessionMessage,
  type CancelToken,
  type OutboundChatFile,
} from '@/api/session-api'
import type { BridgeSdk } from '@/bridge/sdk/types'
import type { AgentBridgeSetup, AgentBridgeType, BridgeStatusResult } from '@/bridge/types'
import type {
  AgentTrace,
  ChatMessage,
  ChatMessageAttachment,
  ChatSessionItem,
} from '@/bridge/types'
import { sanitizeBridgeAssistantContent } from '@/utils/bridge-message-sanitize'
import { mapOutboundFilesToAttachments } from '@/utils/chat-attachments'
import {
  mergeMessageAttachments,
  mergeStreamErrorContent,
  reconcileAssistantMessage,
} from '@/utils/chat-message-reconcile'

const STREAMING_ASSISTANT_ID_PREFIX = 'stream-assistant-'

function isStreamingAssistantPlaceholder(message: ChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.streaming === true &&
    message.id.startsWith(STREAMING_ASSISTANT_ID_PREFIX)
  )
}

export const useBridgeStore = defineStore('bridge', () => {
  const sdk = ref<BridgeSdk>(createAppBridgeSdk())
  const setupByType = ref<Partial<Record<AgentBridgeType, AgentBridgeSetup>>>({})
  const statusByType = ref<Partial<Record<AgentBridgeType, BridgeStatusResult>>>({})

  function setSdk(next: BridgeSdk) {
    sdk.value = next
  }

  async function loadSetup(type: AgentBridgeType, connectionId?: string) {
    const setup = await sdk.value.getSetup(type, connectionId)
    setupByType.value = { ...setupByType.value, [type]: setup }
    return setup
  }

  async function checkStatus(type: AgentBridgeType, connectionId?: string) {
    const status = await sdk.value.checkStatus(type, connectionId)
    statusByType.value = { ...statusByType.value, [type]: status }
    return status
  }

  return {
    sdk,
    setupByType,
    statusByType,
    setSdk,
    loadSetup,
    checkStatus,
  }
})

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<ChatSessionItem[]>([])
  const messagesBySession = ref<Record<string, ChatMessage[]>>({})
  const loadingSessions = ref(false)
  const loadingMessages = ref<Record<string, boolean>>({})

  function getSession(sessionId: string) {
    return sessions.value.find((item) => item.id === sessionId)
  }

  function getMessages(sessionId: string) {
    return messagesBySession.value[sessionId] ?? []
  }

  async function loadSessions() {
    loadingSessions.value = true
    try {
      sessions.value = await fetchSessions()
    } finally {
      loadingSessions.value = false
    }
  }

  function removeSession(sessionId: string) {
    sessions.value = sessions.value.filter((item) => item.id !== sessionId)
    const nextMessages = { ...messagesBySession.value }
    delete nextMessages[sessionId]
    messagesBySession.value = nextMessages
  }

  function removeSessionsByConnection(connectionId: string) {
    const normalized = connectionId.trim()
    if (!normalized) return
    const removingIds = sessions.value
      .filter((item) => item.connectionId === normalized)
      .map((item) => item.id)
    sessions.value = sessions.value.filter((item) => item.connectionId !== normalized)
    const nextMessages = { ...messagesBySession.value }
    for (const sessionId of removingIds) {
      delete nextMessages[sessionId]
    }
    messagesBySession.value = nextMessages
  }

  async function loadMessages(sessionId: string, options?: { limit?: number; reload?: boolean }) {
    loadingMessages.value = {
      ...loadingMessages.value,
      [sessionId]: true,
    }
    try {
      const session = getSession(sessionId)
      const fetched = await fetchMessages(sessionId, options)
      messagesBySession.value = {
        ...messagesBySession.value,
        [sessionId]: fetched.map((message) =>
          message.role === 'assistant'
            ? {
                ...message,
                content: sanitizeBridgeAssistantContent(message.content, {
                  agentType: session?.agentType,
                }),
              }
            : message,
        ),
      }
    } finally {
      loadingMessages.value = {
        ...loadingMessages.value,
        [sessionId]: false,
      }
    }
  }

  function setMessages(sessionId: string, messages: ChatMessage[]) {
    messagesBySession.value = {
      ...messagesBySession.value,
      [sessionId]: messages,
    }
  }

  function upsertMessage(sessionId: string, message: ChatMessage) {
    const current = messagesBySession.value[sessionId] ?? []
    const index = current.findIndex((item) => item.id === message.id)
    const next =
      index >= 0
        ? current.map((item, idx) => (idx === index ? message : item))
        : [...current, message]
    messagesBySession.value = {
      ...messagesBySession.value,
      [sessionId]: next,
    }
  }

  function findStreamingAssistantPlaceholder(sessionId: string) {
    const current = messagesBySession.value[sessionId] ?? []
    return current.find((item) => isStreamingAssistantPlaceholder(item))
  }

  function finalizeStreamingAssistant(
    sessionId: string,
    placeholderId: string,
    message: ChatMessage,
  ) {
    const current = messagesBySession.value[sessionId] ?? []
    const placeholderIndex = current.findIndex((item) => item.id === placeholderId)
    const synchronizedIndex = current.findIndex(
      (item) => item.id === message.id && item.id !== placeholderId,
    )
    const placeholder = placeholderIndex >= 0 ? current[placeholderIndex] : undefined
    const synchronized = synchronizedIndex >= 0 ? current[synchronizedIndex] : undefined
    const sourceIndex =
      placeholderIndex >= 0
        ? placeholderIndex
        : synchronizedIndex >= 0
          ? synchronizedIndex
          : current.length
    const insertionIndex = current
      .slice(0, sourceIndex)
      .filter((item) => item.id !== placeholderId && item.id !== message.id).length
    const next = current.filter((item) => item.id !== placeholderId && item.id !== message.id)
    next.splice(
      Math.min(insertionIndex, next.length),
      0,
      reconcileAssistantMessage({ placeholder, synchronized, final: message }),
    )
    messagesBySession.value = {
      ...messagesBySession.value,
      [sessionId]: next,
    }
  }

  function patchStreamingAssistant(
    sessionId: string,
    assistantId: string,
    patch: {
      content?: string
      attachments?: ChatMessageAttachment[]
      reasoning?: ChatMessage['reasoning'] | null
      reasoningStreaming?: boolean
      agentTrace?: AgentTrace | null
      streaming?: boolean
    },
  ) {
    const current = messagesBySession.value[sessionId] ?? []
    const index = current.findIndex((item) => item.id === assistantId)
    const existing = index >= 0 ? current[index] : undefined
    const nextReasoning =
      patch.reasoning === null
        ? undefined
        : patch.reasoning !== undefined
          ? patch.reasoning
          : existing?.reasoning
    const nextAgentTrace =
      patch.agentTrace === null
        ? undefined
        : patch.agentTrace !== undefined
          ? patch.agentTrace
          : existing?.agentTrace
    const nextMessage: ChatMessage = {
      id: assistantId,
      sessionId,
      role: 'assistant',
      content: patch.content ?? existing?.content ?? '',
      createdAt: existing?.createdAt ?? Date.now(),
      streaming: patch.streaming ?? existing?.streaming ?? true,
      attachments: patch.attachments ?? existing?.attachments,
      reasoning: nextReasoning,
      reasoningStreaming: patch.reasoningStreaming ?? existing?.reasoningStreaming,
      agentTrace: nextAgentTrace,
    }
    const next =
      index >= 0
        ? current.map((item, idx) => (idx === index ? nextMessage : item))
        : [...current, nextMessage]
    messagesBySession.value = {
      ...messagesBySession.value,
      [sessionId]: next,
    }
  }

  async function sendMessageStream(
    sessionId: string,
    content: string,
    options?: {
      cancel?: CancelToken
      onStreamId?: (streamId: string) => void
      files?: OutboundChatFile[]
    },
  ) {
    const assistantPlaceholderId = `stream-assistant-${Date.now()}`
    const optimisticUserId = `optimistic-user-${Date.now()}`
    const trimmed = content.trim()
    const outboundFiles = options?.files ?? []
    const optimisticAttachments = mapOutboundFilesToAttachments(outboundFiles)
    let assistantStarted = false
    let finalPhaseStarted = false
    let streamError = ''
    const reasoningStartedAt = Date.now()

    const finalizeStreamError = (message: string) => {
      const normalized = message.trim() || 'stream error'
      if (!assistantStarted) {
        assistantStarted = true
        patchStreamingAssistant(sessionId, assistantPlaceholderId, { content: '' })
      }
      const current = messagesBySession.value[sessionId] ?? []
      const existing = current.find((item) => item.id === assistantPlaceholderId)
      streamError = normalized
      patchStreamingAssistant(sessionId, assistantPlaceholderId, {
        content: mergeStreamErrorContent(existing?.content ?? '', normalized),
        streaming: false,
        reasoningStreaming: false,
        reasoning: existing?.reasoning
          ? {
              ...existing.reasoning,
              endedAt: existing.reasoning.endedAt ?? Date.now(),
            }
          : undefined,
      })
    }

    if (trimmed || optimisticAttachments.length > 0) {
      upsertMessage(sessionId, {
        id: optimisticUserId,
        sessionId,
        role: 'user',
        content: trimmed || `[${optimisticAttachments.length} 个附件]`,
        attachments: optimisticAttachments.length > 0 ? optimisticAttachments : undefined,
        createdAt: Date.now(),
      })
    }

    const replyPromise = streamSessionMessage(
      sessionId,
      content,
      {
        onStart: ({ streamId }) => {
          if (streamId) options?.onStreamId?.(streamId)
          if (!assistantStarted) {
            assistantStarted = true
            patchStreamingAssistant(sessionId, assistantPlaceholderId, { content: '' })
          }
        },
        onUserMessage: (message) => {
          const current = messagesBySession.value[sessionId] ?? []
          const optimistic = current.find((item) => item.id === optimisticUserId)
          const synchronized = current.find((item) => item.id === message.id)
          // 服务端不回传 data: 预览，保留乐观更新里的本地缩略图
          const mergedMessage: ChatMessage = {
            ...synchronized,
            ...message,
            attachments:
              message.attachments?.map((att, index) => ({
                ...att,
                previewUrl:
                  att.previewUrl || optimistic?.attachments?.[index]?.previewUrl || undefined,
              })) ?? optimistic?.attachments,
          }
          const withoutOptimistic = current.filter(
            (item) => item.id !== optimisticUserId && item.id !== message.id,
          )
          // 阻塞发送可能先 onStart 再 onUser：用户消息必须插在「输出中」占位之前
          const streamingIdx = withoutOptimistic.findIndex(
            (item) => item.id === assistantPlaceholderId,
          )
          const next =
            streamingIdx >= 0
              ? [
                  ...withoutOptimistic.slice(0, streamingIdx),
                  mergedMessage,
                  ...withoutOptimistic.slice(streamingIdx),
                ]
              : [...withoutOptimistic, mergedMessage]
          messagesBySession.value = {
            ...messagesBySession.value,
            [sessionId]: next,
          }
        },
        onReasoning: ({ fullText }) => {
          if (!assistantStarted) {
            assistantStarted = true
            patchStreamingAssistant(sessionId, assistantPlaceholderId, { content: '' })
          }
          patchStreamingAssistant(sessionId, assistantPlaceholderId, {
            reasoning: {
              content: fullText,
              startedAt: reasoningStartedAt,
            },
            reasoningStreaming: true,
          })
        },
        onReasoningEnd: () => {
          const current = messagesBySession.value[sessionId] ?? []
          const existing = current.find((item) => item.id === assistantPlaceholderId)
          if (!existing?.reasoning) return
          patchStreamingAssistant(sessionId, assistantPlaceholderId, {
            reasoning: {
              ...existing.reasoning,
              endedAt: Date.now(),
            },
            reasoningStreaming: false,
          })
        },
        onReasoningClear: () => {
          patchStreamingAssistant(sessionId, assistantPlaceholderId, {
            reasoning: null,
            reasoningStreaming: false,
          })
        },
        onAgentTrace: (trace) => {
          if (!assistantStarted) {
            assistantStarted = true
            patchStreamingAssistant(sessionId, assistantPlaceholderId, { content: '' })
          }
          patchStreamingAssistant(sessionId, assistantPlaceholderId, { agentTrace: trace })
        },
        onChunk: ({ fullText, phase, ephemeral }) => {
          if (streamError) return
          const isEphemeral = ephemeral === true || phase === 'progress'
          if (!assistantStarted) {
            assistantStarted = true
            patchStreamingAssistant(sessionId, assistantPlaceholderId, { content: '' })
          }
          if (isEphemeral && finalPhaseStarted) return
          if (!isEphemeral) finalPhaseStarted = true
          patchStreamingAssistant(sessionId, assistantPlaceholderId, { content: fullText })
        },
        onAttachment: (attachment) => {
          if (!assistantStarted) {
            assistantStarted = true
            patchStreamingAssistant(sessionId, assistantPlaceholderId, {
              content: '',
              attachments: [attachment],
            })
            return
          }
          const current = messagesBySession.value[sessionId] ?? []
          const existing = current.find((item) => item.id === assistantPlaceholderId)
          const attachments = mergeMessageAttachments(existing?.attachments, [attachment])
          patchStreamingAssistant(sessionId, assistantPlaceholderId, { attachments })
        },
        onError: finalizeStreamError,
        onDone: (message) => {
          finalizeStreamingAssistant(sessionId, assistantPlaceholderId, message)
        },
      },
      options?.cancel,
      options?.files ?? [],
    )

    try {
      return await replyPromise
    } catch (error) {
      if (!streamError && !options?.cancel?.aborted) {
        finalizeStreamError(error instanceof Error ? error.message : 'stream error')
      }
      throw error
    } finally {
      await loadSessions().catch(() => undefined)
    }
  }

  async function cancelActiveStream(sessionId: string, streamId: string) {
    const placeholder = findStreamingAssistantPlaceholder(sessionId)
    const message = await cancelStreamMessage(sessionId, streamId)
    if (message) {
      if (placeholder) {
        finalizeStreamingAssistant(sessionId, placeholder.id, message)
      } else {
        upsertMessage(sessionId, { ...message, streaming: false, reasoningStreaming: false })
      }
    } else if (placeholder) {
      const current = messagesBySession.value[sessionId] ?? []
      messagesBySession.value = {
        ...messagesBySession.value,
        [sessionId]: current.filter((item) => item.id !== placeholder.id),
      }
    }
    await loadSessions().catch(() => undefined)
    return message
  }

  function appendDemoExchange(sessionId: string, content: string) {
    const current = messagesBySession.value[sessionId] ?? []
    const now = Date.now()
    messagesBySession.value = {
      ...messagesBySession.value,
      [sessionId]: [
        ...current,
        {
          id: `local-user-${now}`,
          sessionId,
          role: 'user',
          content,
          createdAt: now,
        },
        {
          id: `local-assistant-${now + 1}`,
          sessionId,
          role: 'assistant',
          content: `[Demo] 已收到：${content}`,
          createdAt: now + 1,
        },
      ],
    }
  }

  return {
    sessions,
    messagesBySession,
    loadingSessions,
    loadingMessages,
    getSession,
    getMessages,
    loadSessions,
    removeSession,
    removeSessionsByConnection,
    loadMessages,
    sendMessage: sendMessageStream,
    sendMessageStream,
    cancelActiveStream,
    appendDemoExchange,
    setMessages,
    upsertMessage,
    patchStreamingAssistant,
  }
})
