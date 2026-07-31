<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ArtifactBlockHeader from '@/components/ArtifactBlockHeader.vue'
import { highlightCode, plainCodeHtml } from '@/utils/code-highlight'
import { isMarkdownFenceLanguage } from '@/utils/fence-language'
import { isH5Runtime } from '@/utils/platform-runtime'
import MessageMarkdownBody from '@/components/MessageMarkdownBody.vue'
import { copyToClipboard, showToast } from '@/utils/format'

const props = defineProps<{
  code: string
  language?: string
  variant?: 'user' | 'assistant'
  showStreamingIndicator?: boolean
}>()

const showPreview = ref(false)
const languageLabel = computed(() => (props.language || 'code').toLowerCase())
const isMarkdownBlock = computed(() => isMarkdownFenceLanguage(props.language ?? ''))
const canPreview = computed(
  () => isMarkdownBlock.value && !props.showStreamingIndicator && props.code.trim().length > 0,
)
const highlightedHtml = computed(() => {
  if (!isH5Runtime()) return plainCodeHtml(props.code)
  return highlightCode(props.code, props.language ?? 'plaintext')
})
const highlightedBlockHtml = computed(
  () => `<pre class="hljs"><code>${highlightedHtml.value}</code></pre>`,
)

watch(
  canPreview,
  (value) => {
    if (value) {
      showPreview.value = true
      return
    }
    showPreview.value = false
  },
  { immediate: true },
)

async function handleCopy() {
  try {
    await copyToClipboard(props.code)
    showToast('已复制代码', 'success')
  } catch {
    showToast('复制失败')
  }
}
</script>

<template>
  <view class="chat-code" :class="`chat-code--${variant ?? 'assistant'}`">
    <ArtifactBlockHeader
      :label="languageLabel"
      :can-preview="canPreview"
      :show-preview="showPreview"
      @copy="handleCopy"
      @toggle-preview="showPreview = $event"
    />

    <view v-if="canPreview && showPreview" class="chat-code__preview">
      <MessageMarkdownBody :content="code" :variant="variant" />
    </view>

    <scroll-view v-else scroll-y class="chat-code__scroll" :show-scrollbar="false">
      <!-- #ifdef H5 -->
      <div class="chat-code__body chat-code__body--highlighted" v-html="highlightedBlockHtml" />
      <!-- #endif -->
      <!-- #ifndef H5 -->
      <text class="chat-code__body" selectable>{{ code }}</text>
      <!-- #endif -->
    </scroll-view>

    <view v-if="showStreamingIndicator" class="chat-code__streaming">
      <text class="chat-code__streaming-text">正在输出...</text>
    </view>
  </view>
</template>

<style scoped lang="scss">
.chat-code {
  margin: 12rpx 0;
  overflow: hidden;
  border-radius: 12rpx;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: #ffffff;
}

.chat-code--user {
  background: #fafafa;
}

.chat-code__scroll {
  max-height: 520rpx;
}

.chat-code__preview {
  max-height: 520rpx;
  overflow: auto;
  padding: 16rpx;
  background: #f8f8f8;
}

.chat-code__body {
  display: block;
  padding: 16rpx;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 24rpx;
  line-height: 1.55;
  color: #24292e;
  white-space: pre-wrap;
  word-break: break-word;
  background: #f8f8f8;
}

.chat-code__body--highlighted {
  :deep(.hljs) {
    margin: 0;
    padding: 0;
    background: transparent;
    white-space: pre-wrap;
    word-break: break-word;
  }
}

.chat-code__streaming {
  padding: 0 16rpx 16rpx;
  background: #f8f8f8;
}

.chat-code__streaming-text {
  display: block;
  font-size: 24rpx;
  line-height: 1.5;
  color: rgba(0, 0, 0, 0.45);
  text-align: center;
}
</style>

<style lang="scss">
@import 'highlight.js/styles/github.css';
</style>
