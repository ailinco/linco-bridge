import { onScopeDispose, readonly, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue'

const DEFAULT_STREAM_INTERVAL_MS = 80

export function useThrottledStreamingContent(
  source: MaybeRefOrGetter<string>,
  streaming: MaybeRefOrGetter<boolean | undefined>,
  intervalMs = DEFAULT_STREAM_INTERVAL_MS,
): Readonly<Ref<string>> {
  const rendered = ref(toValue(source))
  let timer: ReturnType<typeof setTimeout> | undefined
  let hasPublishedStreamingValue = Boolean(toValue(streaming) && rendered.value.length > 0)

  const clearTimer = () => {
    if (timer == null) return
    clearTimeout(timer)
    timer = undefined
  }

  watch(
    [() => toValue(source), () => Boolean(toValue(streaming))],
    ([value, isStreaming], [, wasStreaming]) => {
      if (!isStreaming) {
        clearTimer()
        hasPublishedStreamingValue = false
        rendered.value = value
        return
      }

      if (!wasStreaming) {
        clearTimer()
        rendered.value = value
        hasPublishedStreamingValue = value.length > 0
        return
      }

      if (!hasPublishedStreamingValue) {
        rendered.value = value
        hasPublishedStreamingValue = true
        return
      }

      if (timer != null) return
      timer = setTimeout(() => {
        timer = undefined
        rendered.value = toValue(source)
      }, intervalMs)
    },
    { flush: 'sync' },
  )

  onScopeDispose(clearTimer)
  return readonly(rendered)
}
