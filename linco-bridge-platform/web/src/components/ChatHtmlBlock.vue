<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ArtifactBlockHeader from '@/components/ArtifactBlockHeader.vue'
import { highlightCode, plainCodeHtml } from '@/utils/code-highlight'
import { canPreviewHtml, wrapHtmlPreviewDocument } from '@/utils/html-preview'
import { isH5Runtime } from '@/utils/platform-runtime'
import { copyToClipboard, showToast } from '@/utils/format'

const props = defineProps<{
  html: string
  incomplete?: boolean
  streaming?: boolean
}>()

const showPreview = ref(false)

const canPreview = computed(
  () =>
    isH5Runtime() &&
    !props.streaming &&
    props.incomplete !== true &&
    canPreviewHtml(props.html) &&
    props.html.trim().length > 0,
)

const previewDocument = computed(() => wrapHtmlPreviewDocument(props.html))
const highlightedHtml = computed(() => {
  if (!isH5Runtime()) return plainCodeHtml(props.html)
  return highlightCode(props.html, 'html')
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
    await copyToClipboard(props.html)
    showToast('已复制代码', 'success')
  } catch {
    showToast('复制失败')
  }
}
</script>

<template>
  <view class="chat-html">
    <ArtifactBlockHeader
      label="html"
      :can-preview="canPreview"
      :show-preview="showPreview"
      @copy="handleCopy"
      @toggle-preview="showPreview = $event"
    />

    <!-- #ifdef H5 -->
    <view v-if="canPreview && showPreview" class="chat-html__preview-wrap">
      <iframe
        class="chat-html__iframe"
        title="html-preview"
        sandbox="allow-scripts allow-same-origin"
        :srcdoc="previewDocument"
      />
    </view>
    <scroll-view v-else scroll-y class="chat-html__scroll" :show-scrollbar="false">
      <div class="chat-html__body chat-html__body--highlighted" v-html="highlightedBlockHtml" />
    </scroll-view>
    <!-- #endif -->

    <!-- #ifndef H5 -->
    <scroll-view scroll-y class="chat-html__scroll" :show-scrollbar="false">
      <text class="chat-html__body" selectable>{{ html }}</text>
    </scroll-view>
    <!-- #endif -->

    <view v-if="incomplete || streaming" class="chat-html__streaming">
      <text class="chat-html__streaming-text">正在输出...</text>
    </view>
  </view>
</template>

<style scoped lang="scss">
.chat-html {
  margin: 12rpx 0;
  overflow: hidden;
  border-radius: 12rpx;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: #ffffff;
}

.chat-html__scroll,
.chat-html__preview-wrap {
  max-height: 440rpx;
}

.chat-html__iframe {
  display: block;
  width: 100%;
  height: 440rpx;
  border: 0;
  background: #ffffff;
}

.chat-html__body {
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

.chat-html__body--highlighted :deep(.hljs) {
  margin: 0;
  padding: 0;
  background: transparent;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-html__streaming {
  padding: 0 16rpx 16rpx;
  background: #f8f8f8;
}

.chat-html__streaming-text {
  display: block;
  font-size: 24rpx;
  line-height: 1.5;
  color: rgba(0, 0, 0, 0.45);
  text-align: center;
}
</style>
