import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MessageContent from '@/components/MessageContent.vue'

const stubs = {
  MessageMarkdown: {
    template: '<div data-test="markdown">{{ content }}</div>',
    props: ['content', 'variant', 'streaming'],
  },
  ChatCodeBlock: true,
  ChatHtmlBlock: true,
}

describe('MessageContent streaming rendering', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces rapid streaming text and renders final text immediately', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MessageContent, {
      props: { content: '', streaming: true, variant: 'assistant' },
      global: { stubs },
    })

    await wrapper.setProps({ content: 'first' })
    expect(wrapper.find('[data-test="markdown"]').text()).toBe('first')

    await wrapper.setProps({ content: 'second' })
    await wrapper.setProps({ content: 'latest' })
    expect(wrapper.find('[data-test="markdown"]').text()).toBe('first')

    await vi.advanceTimersByTimeAsync(80)
    expect(wrapper.find('[data-test="markdown"]').text()).toBe('latest')

    await wrapper.setProps({ content: 'final answer', streaming: false })
    expect(wrapper.find('[data-test="markdown"]').text()).toBe('final answer')
  })
})
