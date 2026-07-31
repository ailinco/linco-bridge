<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { BridgeProjectItem, BridgeWorkspaceSession } from '@/bridge/types'
import { useBridgeStore } from '@/stores'
import {
  bridgeWorkspacePickerState,
  resolveBridgeWorkspacePicker,
} from '@/utils/bridge-workspace-picker'
import { showToast } from '@/utils/format'
import { CHAT_ICON } from '@/constants/chat-icons'

const VISIBLE_SESSION_COUNT = 3

const bridgeStore = useBridgeStore()

const loadingProjects = ref(false)
const refreshingProjects = ref(false)
const error = ref<string | null>(null)
const projects = ref<BridgeProjectItem[]>([])
const expandedPaths = ref<string[]>([])
const showAllByProject = ref<Record<string, boolean>>({})
const sessionsByProject = ref<Record<string, BridgeWorkspaceSession[]>>({})
const loadingSessionPaths = ref<string[]>([])
const refreshingSessionPaths = ref<string[]>([])
const selectingKey = ref<string | null>(null)

const chatsExpanded = ref(false)
const chats = ref<BridgeWorkspaceSession[] | null>(null)
const loadingChats = ref(false)
const refreshingChats = ref(false)
const showAllChats = ref(false)

const options = computed(() => bridgeWorkspacePickerState.options)
const agentType = computed(() => options.value?.agentType ?? 'codex')
const connectionId = computed(() => options.value?.connectionId ?? '')
const platformSessionId = computed(() => options.value?.platformSessionId)
const supportsChats = computed(() => options.value?.supportsChats ?? agentType.value === 'codex')

watch(
  () => bridgeWorkspacePickerState.visible,
  (visible) => {
    if (visible) {
      void loadProjects()
    } else {
      resetState()
    }
  },
)

function resetState() {
  loadingProjects.value = false
  refreshingProjects.value = false
  error.value = null
  projects.value = []
  expandedPaths.value = []
  showAllByProject.value = {}
  sessionsByProject.value = {}
  loadingSessionPaths.value = []
  refreshingSessionPaths.value = []
  selectingKey.value = null
  chatsExpanded.value = false
  chats.value = null
  loadingChats.value = false
  refreshingChats.value = false
  showAllChats.value = false
}

async function loadProjects(refresh = false) {
  if (!connectionId.value) return
  if (refresh) {
    refreshingProjects.value = true
  } else {
    loadingProjects.value = true
  }
  error.value = null
  try {
    projects.value = await bridgeStore.sdk.listProjects(agentType.value, connectionId.value)
  } catch (err) {
    error.value = err instanceof Error ? err.message : '无法同步项目列表'
  } finally {
    loadingProjects.value = false
    refreshingProjects.value = false
  }
}

function isExpanded(path: string) {
  return expandedPaths.value.includes(path)
}

function toggleExpanded(path: string) {
  if (isExpanded(path)) {
    expandedPaths.value = expandedPaths.value.filter((item) => item !== path)
    return
  }
  expandedPaths.value = [...expandedPaths.value, path]
  void ensureSessions(path)
}

async function ensureSessions(projectPath: string, refresh = false) {
  const project = projects.value.find((item) => item.path === projectPath)
  if (!project || !connectionId.value) return

  if (refresh) {
    if (!refreshingSessionPaths.value.includes(projectPath)) {
      refreshingSessionPaths.value = [...refreshingSessionPaths.value, projectPath]
    }
  } else if (
    !sessionsByProject.value[projectPath] &&
    !loadingSessionPaths.value.includes(projectPath)
  ) {
    loadingSessionPaths.value = [...loadingSessionPaths.value, projectPath]
  } else if (sessionsByProject.value[projectPath] && !refresh) {
    return
  }

  try {
    const sessions = await bridgeStore.sdk.listProjectSessions(
      agentType.value,
      project.path,
      connectionId.value,
      10,
    )
    sessionsByProject.value = { ...sessionsByProject.value, [projectPath]: sessions }
  } catch (err) {
    showToast(err instanceof Error ? err.message : '无法同步该项目会话')
  } finally {
    loadingSessionPaths.value = loadingSessionPaths.value.filter((item) => item !== projectPath)
    refreshingSessionPaths.value = refreshingSessionPaths.value.filter(
      (item) => item !== projectPath,
    )
  }
}

async function toggleChats() {
  if (!supportsChats.value) return
  if (chatsExpanded.value) {
    chatsExpanded.value = false
    return
  }
  chatsExpanded.value = true
  await ensureChats()
}

async function ensureChats(refresh = false) {
  if (!connectionId.value) return
  if (refresh) {
    refreshingChats.value = true
  } else if (chats.value === null) {
    loadingChats.value = true
  } else if (!refresh) {
    refreshingChats.value = true
  }

  try {
    chats.value = await bridgeStore.sdk.listChats(agentType.value, connectionId.value, 10)
  } catch (err) {
    showToast(err instanceof Error ? err.message : '无法同步对话')
  } finally {
    loadingChats.value = false
    refreshingChats.value = false
  }
}

async function runSelecting<T>(key: string, task: () => Promise<T | null>) {
  if (selectingKey.value) return null
  selectingKey.value = key
  try {
    return await task()
  } finally {
    selectingKey.value = null
  }
}

async function applySelection(input: {
  project: BridgeProjectItem
  session?: BridgeWorkspaceSession
}) {
  if (!connectionId.value) return null
  const projectPath = input.project.path.trim()
  const projectName = input.project.name.trim() || projectPath

  return bridgeStore.sdk.applyWorkspaceSelection(agentType.value, {
    connectionId: connectionId.value,
    platformSessionId: platformSessionId.value,
    projectPath,
    projectName,
    agentSessionId: input.session?.id,
    sessionTitle: input.session?.title,
  })
}

async function handleSelectSession(project: BridgeProjectItem, session: BridgeWorkspaceSession) {
  const key = `session:${project.path}:${session.id}`
  await runSelecting(key, async () => {
    try {
      const result = await applySelection({ project, session })
      if (!result) return null
      resolveBridgeWorkspacePicker(result)
      return result
    } catch (err) {
      showToast(err instanceof Error ? err.message : '绑定会话失败')
      return null
    }
  })
}

async function handleCreateProjectSession(project: BridgeProjectItem) {
  const key = `project:${project.path}`
  await runSelecting(key, async () => {
    try {
      const result = await applySelection({
        project,
      })
      if (!result) return null
      resolveBridgeWorkspacePicker(result)
      return result
    } catch (err) {
      showToast(err instanceof Error ? err.message : '切换项目失败')
      return null
    }
  })
}

async function handleSelectChat(session: BridgeWorkspaceSession) {
  const key = `chat:${session.id}`
  await runSelecting(key, async () => {
    try {
      const result = await bridgeStore.sdk.applyWorkspaceSelection(agentType.value, {
        connectionId: connectionId.value,
        platformSessionId: platformSessionId.value,
        projectPath: '',
        projectName: '对话',
        agentSessionId: session.id,
        sessionTitle: session.title,
      })
      resolveBridgeWorkspacePicker(result)
      return result
    } catch (err) {
      showToast(err instanceof Error ? err.message : '绑定对话失败')
      return null
    }
  })
}

function visibleSessions(path: string) {
  const sessions = sessionsByProject.value[path] ?? []
  return showAllByProject.value[path] ? sessions : sessions.slice(0, VISIBLE_SESSION_COUNT)
}

function toggleShowAllSessions(path: string) {
  showAllByProject.value = {
    ...showAllByProject.value,
    [path]: !showAllByProject.value[path],
  }
}

const visibleChats = computed(() => {
  const list = chats.value ?? []
  return showAllChats.value ? list : list.slice(0, VISIBLE_SESSION_COUNT)
})

function handleDismiss() {
  resolveBridgeWorkspacePicker(null)
}
</script>

<template>
  <view
    v-if="bridgeWorkspacePickerState.visible"
    class="workspace-sheet"
    @tap="handleDismiss"
    @touchmove.stop.prevent
  >
    <view class="workspace-sheet__backdrop" />

    <view class="workspace-sheet__panel" @tap.stop>
      <view class="workspace-sheet__handle-wrap">
        <view class="workspace-sheet__handle" />
      </view>
      <text class="workspace-sheet__title">选择项目 / 会话</text>
      <view class="workspace-sheet__divider" />

      <view class="workspace-sheet__sync">
        <text class="workspace-sheet__sync-label">
          {{ loadingProjects || refreshingProjects ? '正在同步' : '已同步到刚刚' }}
        </text>
        <text
          class="workspace-sheet__sync-action"
          :class="{ 'workspace-sheet__sync-action--disabled': loadingProjects }"
          @tap="loadProjects(true)"
        >
          同步最新
        </text>
      </view>
      <view class="workspace-sheet__divider" />

      <scroll-view scroll-y class="workspace-sheet__body" :show-scrollbar="false">
        <view v-if="loadingProjects" class="workspace-sheet__center">
          <text class="workspace-sheet__hint">正在同步项目…</text>
        </view>
        <view v-else-if="error" class="workspace-sheet__center">
          <text class="workspace-sheet__error">{{ error }}</text>
        </view>
        <view v-else-if="projects.length === 0" class="workspace-sheet__center">
          <text class="workspace-sheet__hint">暂无已同步项目</text>
        </view>

        <view v-else class="workspace-sheet__list">
          <view
            v-for="project in projects"
            :key="project.path"
            class="workspace-sheet__project-block"
          >
            <view class="workspace-sheet__project-row" @tap="toggleExpanded(project.path)">
              <image class="workspace-sheet__folder" :src="CHAT_ICON.folder" mode="aspectFit" />
              <text class="workspace-sheet__project-name">{{ project.name }}</text>
              <view
                v-if="refreshingSessionPaths.includes(project.path)"
                class="workspace-sheet__spinner workspace-sheet__spinner--sm"
              />
              <view
                class="workspace-sheet__icon-btn"
                @tap.stop="handleCreateProjectSession(project)"
              >
                <text
                  v-if="selectingKey === `project:${project.path}`"
                  class="workspace-sheet__spinner-text"
                  >…</text
                >
                <text v-else class="workspace-sheet__plus">+</text>
              </view>
              <text class="workspace-sheet__chevron">{{
                isExpanded(project.path) ? '▾' : '▸'
              }}</text>
            </view>

            <view v-if="isExpanded(project.path)" class="workspace-sheet__sessions">
              <view
                v-if="
                  loadingSessionPaths.includes(project.path) &&
                  !sessionsByProject[project.path]?.length
                "
                class="workspace-sheet__session-placeholder"
              >
                暂无会话
              </view>
              <view
                v-else-if="!sessionsByProject[project.path]?.length"
                class="workspace-sheet__session-placeholder"
              >
                暂无会话
              </view>
              <template v-else>
                <view
                  v-for="session in visibleSessions(project.path)"
                  :key="session.id"
                  class="workspace-sheet__session-row"
                  @tap="handleSelectSession(project, session)"
                >
                  <text class="workspace-sheet__session-title">{{ session.title }}</text>
                  <text v-if="session.timeText" class="workspace-sheet__session-time">{{
                    session.timeText
                  }}</text>
                  <view
                    v-if="selectingKey === `session:${project.path}:${session.id}`"
                    class="workspace-sheet__spinner workspace-sheet__spinner--xs"
                  />
                </view>
                <view
                  v-if="(sessionsByProject[project.path]?.length ?? 0) > VISIBLE_SESSION_COUNT"
                  class="workspace-sheet__more"
                  @tap="toggleShowAllSessions(project.path)"
                >
                  <text>{{ showAllByProject[project.path] ? '收起' : '展开显示更多' }}</text>
                  <text v-if="!showAllByProject[project.path]" class="workspace-sheet__chevron"
                    >▸</text
                  >
                </view>
              </template>
            </view>
          </view>

          <template v-if="supportsChats">
            <view class="workspace-sheet__divider workspace-sheet__divider--section" />
            <view class="workspace-sheet__project-row" @tap="toggleChats">
              <image class="workspace-sheet__folder" :src="CHAT_ICON.folder" mode="aspectFit" />
              <text class="workspace-sheet__project-name">对话</text>
              <view
                v-if="refreshingChats"
                class="workspace-sheet__spinner workspace-sheet__spinner--sm"
              />
              <text class="workspace-sheet__chevron">{{ chatsExpanded ? '▾' : '▸' }}</text>
            </view>
            <view v-if="chatsExpanded" class="workspace-sheet__sessions">
              <view
                v-if="loadingChats && !chats?.length"
                class="workspace-sheet__session-placeholder"
              >
                暂无会话
              </view>
              <view v-else-if="!chats?.length" class="workspace-sheet__session-placeholder"
                >暂无会话</view
              >
              <template v-else>
                <view
                  v-for="session in visibleChats"
                  :key="session.id"
                  class="workspace-sheet__session-row"
                  @tap="handleSelectChat(session)"
                >
                  <text class="workspace-sheet__session-title">{{ session.title }}</text>
                  <view
                    v-if="selectingKey === `chat:${session.id}`"
                    class="workspace-sheet__spinner workspace-sheet__spinner--xs"
                  />
                </view>
                <view
                  v-if="(chats?.length ?? 0) > VISIBLE_SESSION_COUNT"
                  class="workspace-sheet__more"
                  @tap="showAllChats = !showAllChats"
                >
                  <text>{{ showAllChats ? '收起' : '展开显示更多' }}</text>
                </view>
              </template>
            </view>
          </template>
        </view>
      </scroll-view>
    </view>
  </view>
</template>

<style scoped lang="scss">
.workspace-sheet {
  position: fixed;
  inset: 0;
  z-index: 99998;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.workspace-sheet__backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
}

.workspace-sheet__panel {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  max-height: 85vh;
  background: #ffffff;
  border-radius: 24rpx 24rpx 0 0;
  padding-bottom: env(safe-area-inset-bottom);
}

.workspace-sheet__handle-wrap {
  display: flex;
  justify-content: center;
  padding: 20rpx 0 8rpx;
}

.workspace-sheet__handle {
  width: 72rpx;
  height: 8rpx;
  border-radius: 999rpx;
  background: rgba(0, 0, 0, 0.1);
}

.workspace-sheet__title {
  display: block;
  text-align: center;
  font-size: 32rpx;
  font-weight: 500;
  color: #4d4c48;
  padding: 8rpx 32rpx 24rpx;
}

.workspace-sheet__divider {
  height: 1px;
  background: #f3f4f6;
}

.workspace-sheet__divider--section {
  margin-top: 8rpx;
}

.workspace-sheet__sync {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24rpx 46rpx;
}

.workspace-sheet__sync-label {
  font-size: 24rpx;
  color: #6a7282;
}

.workspace-sheet__sync-action {
  font-size: 26rpx;
  font-weight: 500;
  color: rgba(0, 0, 0, 0.87);
}

.workspace-sheet__sync-action--disabled {
  opacity: 0.5;
}

.workspace-sheet__body {
  flex: 1;
  min-height: 240rpx;
  max-height: 60vh;
}

.workspace-sheet__list {
  padding: 16rpx 14rpx 32rpx;
}

.workspace-sheet__center {
  padding: 80rpx 32rpx;
  text-align: center;
}

.workspace-sheet__hint {
  font-size: 28rpx;
  color: #8c8c8c;
}

.workspace-sheet__error {
  font-size: 28rpx;
  color: #ff4d4f;
}

.workspace-sheet__project-row {
  display: flex;
  align-items: center;
  padding: 22rpx 30rpx;
  gap: 20rpx;
}

.workspace-sheet__folder {
  width: 40rpx;
  height: 40rpx;
  flex-shrink: 0;
}

.workspace-sheet__project-name {
  flex: 1;
  min-width: 0;
  font-size: 30rpx;
  font-weight: 500;
  color: rgba(0, 0, 0, 0.87);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-sheet__icon-btn {
  width: 56rpx;
  height: 56rpx;
  display: flex;
  align-items: center;
  justify-content: center;
}

.workspace-sheet__plus {
  font-size: 36rpx;
  color: rgba(0, 0, 0, 0.65);
  line-height: 1;
}

.workspace-sheet__chevron {
  font-size: 24rpx;
  color: rgba(0, 0, 0, 0.45);
  width: 40rpx;
  text-align: center;
}

.workspace-sheet__sessions {
  position: relative;
  margin-left: 58rpx;
  padding-left: 28rpx;
  border-left: 2rpx solid #f3f4f6;
}

.workspace-sheet__session-row {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 22rpx 30rpx 22rpx 0;
}

.workspace-sheet__session-title {
  flex: 1;
  min-width: 0;
  font-size: 28rpx;
  color: rgba(0, 0, 0, 0.56);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-sheet__session-time {
  font-size: 23rpx;
  color: #99a1af;
  flex-shrink: 0;
}

.workspace-sheet__session-placeholder {
  padding: 22rpx 0;
  font-size: 26rpx;
  color: #6a7282;
}

.workspace-sheet__more {
  display: flex;
  align-items: center;
  gap: 8rpx;
  padding: 22rpx 0;
  font-size: 26rpx;
  font-weight: 500;
  color: rgba(0, 0, 0, 0.87);
}

.workspace-sheet__spinner {
  width: 26rpx;
  height: 26rpx;
  border: 3rpx solid rgba(0, 0, 0, 0.12);
  border-top-color: #00754a;
  border-radius: 50%;
  animation: workspace-spin 0.8s linear infinite;
  flex-shrink: 0;
}

.workspace-sheet__spinner--sm {
  width: 22rpx;
  height: 22rpx;
}

.workspace-sheet__spinner--xs {
  width: 18rpx;
  height: 18rpx;
}

.workspace-sheet__spinner-text {
  font-size: 28rpx;
  color: #00754a;
}

@keyframes workspace-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
