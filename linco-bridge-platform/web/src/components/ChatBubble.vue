<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ChatMessage } from '@/bridge/types'
import AgentThinkingEntry from '@/components/AgentThinkingEntry.vue'
import ChatStreamingIndicator from '@/components/ChatStreamingIndicator.vue'
import MessageAttachmentList from '@/components/MessageAttachmentList.vue'
import MessageContent from '@/components/MessageContent.vue'
import ThinkingProcessSheet from '@/components/ThinkingProcessSheet.vue'
import { resolveStreamingTailIndicator } from '@/utils/chat-streaming-indicator'
import { isEmptyAgentTrace } from '@/utils/agent-trace-view'
import { isMiniProgramRuntime } from '@/utils/platform-runtime'
import { isDisplayAgentTraceActive, resolveDisplayAgentTrace } from '@/utils/thinking-trace'

const props = defineProps<{
  message: ChatMessage
}>()

const emit = defineEmits<{
  layoutChange: []
}>()

const sheetVisible = ref(false)

const displayTrace = computed(() =>
  resolveDisplayAgentTrace(
    props.message.agentTrace,
    props.message.reasoning,
    props.message.reasoningStreaming === true,
  ),
)
const hasAgentTrace = computed(() => !isEmptyAgentTrace(displayTrace.value))
const hasProcessEntry = computed(() => hasAgentTrace.value)
const processStartedAt = computed(
  () =>
    props.message.reasoning?.startedAt ??
    props.message.agentTrace?.task?.started_at ??
    props.message.createdAt,
)
const processEndedAt = computed(
  () => props.message.reasoning?.endedAt ?? props.message.agentTrace?.task?.completed_at,
)
const processStreaming = computed(
  () =>
    props.message.reasoningStreaming === true ||
    (props.message.streaming === true && isDisplayAgentTraceActive(displayTrace.value)),
)

const tailIndicator = computed(() =>
  resolveStreamingTailIndicator({
    streaming: props.message.streaming,
    content: props.message.content,
    hasReasoningEntry: hasProcessEntry.value,
    hasAgentTrace: hasAgentTrace.value,
    useBlockingOutputLabel: isMiniProgramRuntime(),
  }),
)
</script>

<template>
  <view :id="message.id" class="message-row" :class="`message-row--${message.role}`">
    <view v-if="message.role === 'user'" class="message-row__user-wrap">
      <view class="message-row__user-bubble">
        <MessageAttachmentList
          v-if="message.attachments?.length"
          :attachments="message.attachments"
          variant="user"
          @preview-load="emit('layoutChange')"
        />
        <MessageContent
          v-if="message.content"
          :content="message.content"
          variant="user"
          :session-id="message.sessionId"
          :streaming="message.streaming"
        />
      </view>
    </view>

    <view v-else class="message-row__assistant-wrap">
      <AgentThinkingEntry
        v-if="hasProcessEntry"
        :started-at="processStartedAt"
        :ended-at="processEndedAt"
        :streaming="processStreaming"
        @tap="sheetVisible = true"
      />

      <MessageAttachmentList
        v-if="message.attachments?.length"
        :attachments="message.attachments"
        variant="assistant"
        @preview-load="emit('layoutChange')"
      />

      <view v-if="message.content" class="message-row__assistant-body">
        <MessageContent
          :content="message.content"
          variant="assistant"
          :session-id="message.sessionId"
          :streaming="message.streaming"
        />
      </view>

      <ChatStreamingIndicator
        v-if="tailIndicator.show && tailIndicator.label"
        class="message-row__streaming-tail"
        :label="tailIndicator.label"
      />
    </view>

    <ThinkingProcessSheet
      :visible="sheetVisible"
      :trace="displayTrace"
      :streaming="processStreaming"
      @close="sheetVisible = false"
    />
  </view>
</template>

<style scoped lang="scss">
.message-row {
  margin-bottom: 28rpx;
}

.message-row__user-wrap {
  display: flex;
  justify-content: flex-end;
}

.message-row__user-bubble {
  max-width: 76%;
  padding: 24rpx 32rpx;
  border-radius: 24rpx;
  background: #f2f4f5;
}

.message-row__assistant-wrap {
  width: 100%;
  padding-right: 8rpx;
}

.message-row__assistant-body {
  width: 100%;
  margin-top: 8rpx;
}

.message-row__streaming-tail {
  margin-top: 8rpx;
}
</style>
