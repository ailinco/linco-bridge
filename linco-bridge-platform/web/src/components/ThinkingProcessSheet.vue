<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { AgentTrace } from '@/bridge/types'
import AgentTraceActionCard from '@/components/AgentTraceActionCard.vue'
import { isEmptyAgentTrace, traceSummaryStatus } from '@/utils/agent-trace-view'
import { updateChatFollowState, type ChatFollowState } from '@/utils/chat-scroll-policy'

const props = defineProps<{
  visible: boolean
  trace?: AgentTrace
  streaming?: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const hasTrace = computed(() => !isEmptyAgentTrace(props.trace))
const summary = computed(() =>
  props.trace ? traceSummaryStatus(props.trace, props.streaming) : '思考过程',
)
const actionStateKey = computed(() =>
  (props.trace?.actions ?? [])
    .map((action) => `${action.id}:${action.status}:${action.detail?.length ?? 0}`)
    .join('|'),
)
const scrollAnchor = ref('')
const following = ref<ChatFollowState>({ following: true })

function followLatestAction() {
  if (!props.visible || !props.streaming || !following.value.following) return
  const lastIndex = (props.trace?.actions.length ?? 0) - 1
  if (lastIndex < 0) return
  const target = `thinking-action-${lastIndex}`
  if (scrollAnchor.value !== target) {
    scrollAnchor.value = target
    return
  }
  scrollAnchor.value = ''
  void nextTick(() => {
    scrollAnchor.value = target
  })
}

function handleScroll(event: { detail: { scrollTop?: number } }) {
  const scrollTop = Number(event.detail.scrollTop)
  if (!Number.isFinite(scrollTop)) return
  following.value = updateChatFollowState(following.value, { scrollTop })
}

function handleScrollToLower() {
  following.value = updateChatFollowState(following.value, { reachedBottom: true })
}

watch(
  () => [props.visible, props.streaming] as const,
  ([visible, streaming]) => {
    following.value = { following: true }
    scrollAnchor.value = ''
    if (visible && streaming) followLatestAction()
  },
  { immediate: true },
)

watch(actionStateKey, followLatestAction)
</script>

<template>
  <view v-if="visible" class="thinking-sheet" @touchmove.stop.prevent>
    <view class="thinking-sheet__mask" @tap="emit('close')" />
    <view class="thinking-sheet__panel">
      <view class="thinking-sheet__handle-wrap">
        <view class="thinking-sheet__handle" />
      </view>

      <view class="thinking-sheet__header">
        <view class="thinking-sheet__header-side" />
        <view class="thinking-sheet__title-wrap">
          <text class="thinking-sheet__title">思考过程</text>
          <text v-if="hasTrace" class="thinking-sheet__subtitle">{{ summary }}</text>
        </view>
        <view class="thinking-sheet__close-btn" @tap="emit('close')">
          <text class="thinking-sheet__close-icon">×</text>
        </view>
      </view>

      <view class="thinking-sheet__divider" />

      <scroll-view
        class="thinking-sheet__body"
        scroll-y
        :show-scrollbar="false"
        :scroll-into-view="scrollAnchor"
        :lower-threshold="80"
        @scroll="handleScroll"
        @scrolltolower="handleScrollToLower"
      >
        <view v-if="hasTrace" class="thinking-sheet__trace">
          <view
            v-for="(action, index) in trace!.actions"
            :id="`thinking-action-${index}`"
            :key="action.id"
          >
            <AgentTraceActionCard :action="action" />
          </view>
        </view>

        <view v-if="!hasTrace" class="thinking-sheet__empty-wrap">
          <text class="thinking-sheet__empty">暂无思考内容</text>
        </view>
      </scroll-view>
    </view>
  </view>
</template>

<style scoped lang="scss">
.thinking-sheet {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.thinking-sheet__mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
}

.thinking-sheet__panel {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  max-height: 78vh;
  min-height: 36vh;
  background: #ffffff;
  border-radius: 24rpx 24rpx 0 0;
  padding-bottom: env(safe-area-inset-bottom);
}

.thinking-sheet__handle-wrap {
  display: flex;
  justify-content: center;
  padding: 20rpx 0 8rpx;
}

.thinking-sheet__handle {
  width: 72rpx;
  height: 8rpx;
  border-radius: 999rpx;
  background: rgba(0, 0, 0, 0.1);
}

.thinking-sheet__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8rpx 24rpx 20rpx;
}

.thinking-sheet__header-side,
.thinking-sheet__close-btn {
  width: 64rpx;
  height: 64rpx;
  flex-shrink: 0;
}

.thinking-sheet__close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
}

.thinking-sheet__close-icon {
  font-size: 44rpx;
  line-height: 1;
  color: rgba(0, 0, 0, 0.45);
}

.thinking-sheet__title-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4rpx;
}

.thinking-sheet__title {
  font-size: 32rpx;
  font-weight: 600;
  line-height: 1.4;
  color: #4d4c48;
}

.thinking-sheet__subtitle {
  font-size: 24rpx;
  line-height: 1.4;
  color: rgba(0, 0, 0, 0.45);
}

.thinking-sheet__divider {
  height: 1px;
  background: #f3f4f6;
}

.thinking-sheet__body {
  flex: 1;
  min-height: 0;
  max-height: calc(78vh - 180rpx);
}

.thinking-sheet__trace {
  box-sizing: border-box;
  width: 100%;
  padding: 28rpx 32rpx 40rpx;
}

.thinking-sheet__empty-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 240rpx;
  padding: 32rpx;
}

.thinking-sheet__empty {
  font-size: 28rpx;
  color: rgba(0, 0, 0, 0.45);
}
</style>
