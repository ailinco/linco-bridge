<script setup lang="ts">
import { onLoad, onShow } from '@dcloudio/uni-app'
import { computed, ref, watch } from 'vue'
import AgentLandingAppBar from '@/components/AgentLandingAppBar.vue'
import AppOverlayHost from '@/components/AppOverlayHost.vue'
import ChatBubble from '@/components/ChatBubble.vue'
import ChatInputArea from '@/components/ChatInputArea.vue'
import { parseAgentTypeFromQuery, resolveSessionAgentType } from '@/bridge/sdk/agent-chat'
import type { AgentBridgeType } from '@/bridge/types'
import { useChatSession } from '@/composables/useChatSession'
import { useProjectPicker } from '@/composables/useProjectPicker'
import { useAttachmentPicker } from '@/composables/useAttachmentPicker'
import { useVoiceInput } from '@/composables/useVoiceInput'
import { useSessionStore } from '@/stores'
import { showToast } from '@/utils/format'
import { isBoundWorkspacePick } from '@/utils/pick-workspace'
import { openBoundBridgeChat, reloadBoundChatSession } from '@/utils/open-bound-chat'
import { resolveBridgeProjectLabel } from '@/utils/bridge-project-label'
import {
  supportsBridgeSettingsSelector,
  supportsBridgeSlashCommands,
  supportsBridgeWorkspaceSelector,
} from '@/bridge/constants'
import { cloneOutboundFiles } from '@/utils/chat-attachments'
import { useBridgeSettings } from '@/composables/useBridgeSettings'
import { useSlashCommands } from '@/composables/useSlashCommands'
import {
  buildChatLayoutKey,
  updateChatFollowState,
  type ChatFollowState,
} from '@/utils/chat-scroll-policy'

const chat = useChatSession()
const { pickWorkspace } = useProjectPicker()
const queryAgentType = ref<AgentBridgeType | null>(null)
const refreshing = ref(false)
const routeSessionId = ref('')
const routeReloadHistory = ref(false)
const followLatest = ref<ChatFollowState>({ following: true })
const {
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
} = chat

const sessionStore = useSessionStore()
const agentType = computed<AgentBridgeType | null>(() =>
  resolveSessionAgentType({
    sessionId: chat.sessionId.value,
    sessionAgentType: sessionStore.getSession(chat.sessionId.value)?.agentType ?? null,
    queryAgentType: queryAgentType.value,
  }),
)
const connectionId = computed(() => sessionStore.getSession(chat.sessionId.value)?.connectionId)

const bridgeProjectLabel = computed(() =>
  resolveBridgeProjectLabel(sessionStore.getSession(chat.sessionId.value)),
)

const showBridgeSettings = computed(
  () => agentType.value != null && supportsBridgeSettingsSelector(agentType.value),
)

const { pickFiles, pendingFiles, clearFiles, removeFile } = useAttachmentPicker()
const bridgeSettings = useBridgeSettings()
const { commands: slashCommandList, preload: preloadSlashCommands } = useSlashCommands()
const { startVoice } = useVoiceInput((text) => {
  draft.value = draft.value ? `${draft.value} ${text}` : text
})

watch(
  () => chat.sessionId.value,
  (sessionId) => {
    if (!sessionId) return
    followLatest.value = { following: true }
    const session = sessionStore.getSession(sessionId)
    bridgeSettings.applySessionSettings(session?.bridgeSettings ?? null)
    if (showBridgeSettings.value) {
      void bridgeSettings.preloadOptions(agentType.value!, session?.connectionId, sessionId)
    }
    if (agentType.value && supportsBridgeSlashCommands(agentType.value)) {
      void preloadSlashCommands({
        agentType: agentType.value,
        connectionId: session?.connectionId,
        sessionId,
      })
    }
  },
  { immediate: true },
)

onLoad((query) => {
  const id = String(query?.sessionId ?? '')
  routeSessionId.value = id
  routeReloadHistory.value =
    query?.reloadHistory === '1' || query?.reloadHistory === 'true' || query?.reloadHistory === true
  const initialDraft = query?.draft ? decodeURIComponent(String(query.draft)) : undefined
  queryAgentType.value = parseAgentTypeFromQuery(String(query?.agentType ?? ''))
  if (id) {
    void loadSession(id, { initialDraft, reloadHistory: routeReloadHistory.value })
  }
})

function readRouteQuery(): { sessionId: string; reloadHistory: boolean } {
  const pages = getCurrentPages()
  const current = pages[pages.length - 1] as
    { options?: Record<string, string | boolean> } | undefined
  const query = current?.options ?? {}
  const sessionId = String(query.sessionId ?? '')
  const reloadHistory =
    query.reloadHistory === '1' || query.reloadHistory === 'true' || query.reloadHistory === true
  return { sessionId, reloadHistory }
}

onShow(() => {
  const { sessionId, reloadHistory } = readRouteQuery()
  if (!sessionId || sessionId === routeSessionId.value) return
  routeSessionId.value = sessionId
  routeReloadHistory.value = reloadHistory
  void loadSession(sessionId, { reloadHistory })
})

watch(
  () => buildChatLayoutKey(messages.value),
  () => {
    followLatestOutput()
  },
)

function followLatestOutput() {
  if (followLatest.value.following) scrollToBottom()
}

function handleMessageScroll(event: { detail: { scrollTop?: number } }) {
  const scrollTop = Number(event.detail.scrollTop)
  if (!Number.isFinite(scrollTop)) return
  followLatest.value = updateChatFollowState(followLatest.value, { scrollTop })
}

function handleMessageScrollToLower() {
  followLatest.value = updateChatFollowState(followLatest.value, { reachedBottom: true })
}

async function handleWorkspace() {
  if (!agentType.value) {
    showToast('当前会话不支持切换工作区')
    return
  }
  try {
    const picked = await pickWorkspace(agentType.value, undefined, chat.sessionId.value)
    if (!picked) return
    if (isBoundWorkspacePick(picked)) {
      if (picked.sessionId !== chat.sessionId.value) {
        await openBoundBridgeChat(picked)
        return
      }
      await reloadBoundChatSession(picked.sessionId!, reloadHistory)
      showToast(`已切换至 ${picked.title ?? picked.name}`)
      return
    }
    if (picked.sessionId && picked.sessionId !== chat.sessionId.value) {
      await openBoundBridgeChat(picked)
      return
    }
    await sessionStore.loadSessions().catch(() => undefined)
    await chat.loadSession(chat.sessionId.value, {
      reloadHistory: Boolean(picked.agentSessionId?.trim()),
    })
    showToast(`已选择 ${picked.name}`)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '切换工作区失败')
  }
}

async function handleAdd() {
  await pickFiles()
}

function handleSend() {
  followLatest.value = { following: true }
  scrollToBottom()
  // 对齐 Flutter：先快照附件并立刻清空输入区，再异步发送（勿等整轮回复结束）
  const files = cloneOutboundFiles(pendingFiles.value)
  clearFiles()
  void sendMessage(undefined, files)
}

function handleVoice() {
  startVoice()
}

async function handleRefresh() {
  refreshing.value = true
  try {
    // 下拉刷新只重新拉取已持久化的消息，不做 destructive 的 bridge history-reload
    await reloadHistory(undefined, false)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '刷新失败')
  } finally {
    refreshing.value = false
  }
}

function handleStop() {
  void stopGeneration()
}

async function handlePickSettings() {
  if (!agentType.value || !showBridgeSettings.value) return
  try {
    await bridgeSettings.pickSettings({
      agentType: agentType.value,
      connectionId: connectionId.value,
      sessionId: chat.sessionId.value,
      persist: true,
    })
    await sessionStore.loadSessions().catch(() => undefined)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '更新设置失败')
  }
}
</script>

<template>
  <view class="page-container chat-page">
    <AgentLandingAppBar
      v-if="header"
      :title="header.title"
      :subtitle="header.subtitle"
      :avatar="header.avatar"
      :show-workspace="agentType ? supportsBridgeWorkspaceSelector(agentType) : false"
      :show-more="false"
      @workspace="handleWorkspace"
    />

    <scroll-view
      class="chat-page__messages"
      scroll-y
      refresher-enabled
      :refresher-triggered="refreshing"
      :scroll-with-animation="true"
      :scroll-into-view="scrollAnchor"
      :lower-threshold="120"
      @refresherrefresh="handleRefresh"
      @scroll="handleMessageScroll"
      @scrolltolower="handleMessageScrollToLower"
    >
      <view v-if="loading && messages.length === 0 && !sending" class="chat-page__state">
        <text class="chat-page__state-text">加载中…</text>
      </view>

      <view v-else-if="messages.length === 0 && !sending" class="chat-page__state">
        <text class="chat-page__state-text">发送消息开始对话</text>
      </view>

      <view v-else class="chat-page__list">
        <ChatBubble
          v-for="item in messages"
          :key="item.id"
          :message="item"
          @layout-change="followLatestOutput"
        />
      </view>

      <view id="chat-bottom" class="chat-page__bottom-spacer" />
    </scroll-view>

    <ChatInputArea
      v-model="draft"
      :disabled="loading && !sending"
      :sending="sending"
      :is-send-disabled="loading && !sending"
      :pending-files="pendingFiles"
      :bridge-project-name="bridgeProjectLabel"
      :use-bridge-compact-toolbar="showBridgeSettings"
      :bridge-settings-label="bridgeSettings.settingsLabel.value"
      :slash-commands="slashCommandList"
      @send="handleSend"
      @stop="handleStop"
      @add="handleAdd"
      @voice="handleVoice"
      @remove-file="removeFile"
      @pick-settings="handlePickSettings"
    />
    <!-- #ifndef H5 -->
    <AppOverlayHost />
    <!-- #endif -->
  </view>
</template>

<style scoped lang="scss">
.chat-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #ffffff;
}

.chat-page__messages {
  flex: 1;
  min-height: 0;
  background: #ffffff;
}

.chat-page__list {
  padding: 24rpx 32rpx 16rpx;
}

.chat-page__state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 480rpx;
}

.chat-page__state-text {
  font-size: 28rpx;
  color: rgba(0, 0, 0, 0.45);
}

.chat-page__bottom-spacer {
  height: 48rpx;
}
</style>
