<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import ChatCodeBlock from '@/components/ChatCodeBlock.vue'
import ChatHtmlBlock from '@/components/ChatHtmlBlock.vue'
import MessageMarkdown from '@/components/MessageMarkdown.vue'
import { runSessionBridgeCommand } from '@/api/session-api'
import { hasRichMessageContent, parseMessageSegments } from '@/utils/message-content'
import {
  buildBridgeFileGetCandidates,
  isOpenableFileLinkTarget,
  openChatAttachment,
  quoteGetPath,
  shouldRetryBridgeFileGet,
} from '@/utils/attachment-open'
import { showToast } from '@/utils/format'
import { useThrottledStreamingContent } from '@/composables/useThrottledStreamingContent'



const props = defineProps<{

  content: string

  variant?: 'user' | 'assistant'

  sessionId?: string

  streaming?: boolean

}>()



const loadingTarget = ref('')

const renderedContent = useThrottledStreamingContent(
  toRef(props, 'content'),
  toRef(props, 'streaming'),
)

const segments = computed(() =>
  parseMessageSegments(renderedContent.value, { streaming: props.streaming }),
)

const useRich = computed(() => hasRichMessageContent(renderedContent.value, props.streaming))



async function handleLinkTap(target: string) {

  const trimmed = target.trim()

  if (!trimmed || props.streaming) return



  if (/^https?:\/\//i.test(trimmed)) {

    // #ifdef H5

    window.open(trimmed, '_blank', 'noopener,noreferrer')

    // #endif

    // #ifndef H5

    uni.setClipboardData({

      data: trimmed,

      success: () => showToast('链接已复制', 'success'),

    })

    // #endif

    return

  }



  if (!isOpenableFileLinkTarget(trimmed)) {
    showToast('暂不支持打开该链接')
    return
  }

  const filePaths = buildBridgeFileGetCandidates(trimmed)
  if (filePaths.length === 0) {
    showToast('暂不支持打开该链接')
    return
  }

  if (!props.sessionId) {
    showToast('当前会话不可用')
    return
  }

  loadingTarget.value = trimmed
  try {
    let lastError = '获取文件失败'
    for (let index = 0; index < filePaths.length; index += 1) {
      const filePath = filePaths[index]!
      const result = await runSessionBridgeCommand(
        props.sessionId,
        `/get ${quoteGetPath(filePath)}`,
      )

      if (result.file) {
        await openChatAttachment(result.file)
        return
      }

      lastError = result.text || lastError
      const hasMoreCandidates = index < filePaths.length - 1
      if (!hasMoreCandidates || !shouldRetryBridgeFileGet(lastError)) {
        break
      }
    }

    showToast(lastError)
  } catch (err) {
    showToast(err instanceof Error ? err.message : '获取文件失败')
  } finally {
    loadingTarget.value = ''
  }

}

</script>



<template>

  <MessageMarkdown

    v-if="!useRich"

    :content="renderedContent"

    :variant="variant"

    :streaming="streaming"

    @link-tap="handleLinkTap"

  />

  <view v-else class="message-content">

    <template v-for="(segment, index) in segments" :key="`${segment.type}-${index}`">

      <ChatHtmlBlock
        v-if="segment.type === 'html'"
        :html="segment.content"
        :incomplete="segment.incomplete === true"
        :streaming="streaming === true"
      />

      <ChatCodeBlock

        v-else-if="segment.type === 'code'"

        :code="segment.content"

        :language="segment.language"

        :variant="variant"

        :show-streaming-indicator="streaming === true && segment.incomplete === true"

      />

      <view

        v-else-if="segment.type === 'link'"

        class="message-content__link"

        :class="{

          'message-content__link--loading': loadingTarget === segment.target,

          'message-content__link--disabled': streaming,

        }"

        @tap="handleLinkTap(segment.target)"

      >

        <text class="message-content__link-text">{{ segment.label }}</text>

      </view>

      <MessageMarkdown

        v-else

        :content="segment.content"

        :variant="variant"

        :streaming="streaming"

        @link-tap="handleLinkTap"

      />

    </template>

  </view>

</template>



<style scoped lang="scss">

.message-content__link {

  display: inline-flex;

  margin: 4rpx 0;

  padding: 6rpx 12rpx;

  border-radius: 8rpx;

  background: rgba(0, 117, 74, 0.12);

}



.message-content__link--loading {

  opacity: 0.6;

}



.message-content__link--disabled {

  opacity: 0.75;

}



.message-content__link-text {

  font-size: 26rpx;

  color: #00754a;

  text-decoration: underline;

}

</style>


