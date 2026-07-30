import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { useThrottledStreamingContent } from './useThrottledStreamingContent'

describe('useThrottledStreamingContent', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the first chunk immediately and coalesces later streaming updates', async () => {
    vi.useFakeTimers()
    const source = ref('')
    const streaming = ref(true)
    const scope = effectScope()
    const rendered = scope.run(() => useThrottledStreamingContent(source, streaming))!

    source.value = 'first'
    expect(rendered.value).toBe('first')

    source.value = 'second'
    source.value = 'latest'
    expect(rendered.value).toBe('first')

    await vi.advanceTimersByTimeAsync(79)
    expect(rendered.value).toBe('first')
    await vi.advanceTimersByTimeAsync(1)
    expect(rendered.value).toBe('latest')

    scope.stop()
  })

  it('renders final content immediately and cancels a pending timer', () => {
    vi.useFakeTimers()
    const source = ref('draft')
    const streaming = ref(true)
    const scope = effectScope()
    const rendered = scope.run(() => useThrottledStreamingContent(source, streaming))!

    source.value = 'pending update'
    expect(vi.getTimerCount()).toBe(1)
    source.value = 'final answer'
    streaming.value = false

    expect(rendered.value).toBe('final answer')
    expect(vi.getTimerCount()).toBe(0)

    scope.stop()
  })

  it('clears a pending timer when its effect scope is disposed', () => {
    vi.useFakeTimers()
    const source = ref('draft')
    const streaming = ref(true)
    const scope = effectScope()
    scope.run(() => useThrottledStreamingContent(source, streaming))

    source.value = 'pending update'
    expect(vi.getTimerCount()).toBe(1)
    scope.stop()

    expect(vi.getTimerCount()).toBe(0)
  })
})
