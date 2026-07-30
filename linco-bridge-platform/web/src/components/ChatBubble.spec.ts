import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatBubble from '@/components/ChatBubble.vue'
import type { ChatMessage } from '@/bridge/types'

function assistantMessage(partial: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm-assistant',
    sessionId: 'session-1',
    role: 'assistant',
    content: '',
    createdAt: 1,
    ...partial,
  }
}

const stubs = {
  AgentThinkingEntry: {
    template: '<div data-test="thinking-entry">thinking-entry</div>',
    props: ['startedAt', 'endedAt', 'streaming'],
  },
  MessageContent: {
    template: '<div data-test="message-content">{{ content }}</div>',
    props: ['content', 'variant', 'sessionId', 'streaming'],
  },
  MessageAttachmentList: true,
  ThinkingProcessSheet: {
    name: 'ThinkingProcessSheet',
    template:
      '<div data-test="thinking-sheet">{{ trace?.actions?.map((item) => item.id).join(",") }}</div>',
    props: ['trace', 'visible', 'streaming'],
  },
  ChatStreamingIndicator: {
    template: '<div data-test="streaming-indicator">{{ label }}</div>',
    props: ['label'],
  },
}

describe('ChatBubble assistant streaming layout', () => {
  it('shows thinking entry when agent trace exists without legacy reasoning', () => {
    const wrapper = mount(ChatBubble, {
      props: {
        message: assistantMessage({
          agentTrace: {
            task: { status: 'task_running', started_at: 1 },
            actions: [
              {
                id: 'tool-1',
                type: 'tool',
                status: 'running',
                label: '读取文件',
              },
            ],
          },
          streaming: true,
        }),
      },
      global: { stubs },
    })

    expect(wrapper.find('[data-test="thinking-entry"]').exists()).toBe(true)
  })

  it('shows 正在思考 for empty streaming placeholder', () => {
    const wrapper = mount(ChatBubble, {
      props: {
        message: assistantMessage({ streaming: true }),
      },
      global: { stubs },
    })

    expect(wrapper.find('[data-test="thinking-entry"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="message-content"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="streaming-indicator"]').text()).toBe('正在思考')
  })

  it('renders thinking entry before body and 继续生成中 at tail', () => {
    const wrapper = mount(ChatBubble, {
      props: {
        message: assistantMessage({
          streaming: true,
          content: 'partial reply',
          reasoning: {
            content: 'step 1',
            startedAt: 1,
            endedAt: 2,
          },
          reasoningStreaming: false,
        }),
      },
      global: { stubs },
    })

    const assistantWrap = wrapper.find('.message-row__assistant-wrap')
    const childTestIds = assistantWrap
      .findAll('[data-test]')
      .map((node) => node.attributes('data-test'))

    expect(childTestIds).toEqual(['thinking-entry', 'message-content', 'streaming-indicator'])
    expect(wrapper.find('[data-test="streaming-indicator"]').text()).toBe('继续生成中')
  })

  it('shows 正在思考 at tail when reasoning exists but body is empty', () => {
    const wrapper = mount(ChatBubble, {
      props: {
        message: assistantMessage({
          streaming: true,
          reasoning: {
            content: 'still thinking',
            startedAt: 1,
          },
          reasoningStreaming: true,
        }),
      },
      global: { stubs },
    })

    expect(wrapper.find('[data-test="thinking-entry"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="message-content"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="streaming-indicator"]').text()).toBe('正在思考')
  })

  it('hides tail indicator when stream finished', () => {
    const wrapper = mount(ChatBubble, {
      props: {
        message: assistantMessage({
          streaming: false,
          content: 'final reply',
          reasoning: {
            content: 'done thinking',
            startedAt: 1,
            endedAt: 2,
          },
        }),
      },
      global: { stubs },
    })

    expect(wrapper.find('[data-test="streaming-indicator"]').exists()).toBe(false)
  })

  it('projects legacy reasoning into the trace passed to the thinking sheet', () => {
    const wrapper = mount(ChatBubble, {
      props: {
        message: assistantMessage({
          reasoning: {
            content: 'legacy reasoning',
            startedAt: 1,
            endedAt: 2,
          },
        }),
      },
      global: { stubs },
    })

    const sheet = wrapper.findComponent({ name: 'ThinkingProcessSheet' })
    expect(sheet.props('trace').actions.map((item: { id: string }) => item.id)).toEqual([
      'legacy-reasoning',
    ])
    expect(sheet.attributes('content')).toBeUndefined()
  })

  it('treats completed reasoning as finished while the answer body is still streaming', () => {
    const wrapper = mount(ChatBubble, {
      props: {
        message: assistantMessage({
          content: 'partial answer',
          streaming: true,
          reasoning: {
            content: 'completed reasoning',
            startedAt: 1,
            endedAt: 2,
          },
          reasoningStreaming: false,
        }),
      },
      global: { stubs },
    })

    expect(wrapper.findComponent({ name: 'ThinkingProcessSheet' }).props('streaming')).toBe(false)
  })

  it('treats a retained running trace as finished after the message stream ends', () => {
    const wrapper = mount(ChatBubble, {
      props: {
        message: assistantMessage({
          content: 'final answer',
          streaming: false,
          agentTrace: {
            task: { status: 'task_running' },
            actions: [{ id: 'tool-1', type: 'tool', status: 'running', label: 'Read file' }],
          },
        }),
      },
      global: { stubs },
    })

    expect(wrapper.findComponent({ name: 'ThinkingProcessSheet' }).props('streaming')).toBe(false)
  })
})
