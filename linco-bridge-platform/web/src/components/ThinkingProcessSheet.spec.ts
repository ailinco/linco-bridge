import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ThinkingProcessSheet from '@/components/ThinkingProcessSheet.vue'
import type { AgentTrace } from '@/bridge/types'

function trace(status = 'running', count = 1): AgentTrace {
  return {
    task: { status: status === 'running' ? 'task_running' : 'task_success' },
    actions: Array.from({ length: count }, (_, index) => ({
      id: `action-${index}`,
      type: 'tool',
      status,
      label: `Action ${index}`,
    })),
  }
}

const stubs = {
  'scroll-view': {
    template: '<div data-test="scroll-view"><slot /></div>',
  },
  AgentTraceActionCard: {
    template: '<div>{{ action.id }}</div>',
    props: ['action'],
  },
}

describe('ThinkingProcessSheet follow behavior', () => {
  it('opens a completed trace at the beginning', async () => {
    const wrapper = mount(ThinkingProcessSheet, {
      props: { visible: true, trace: trace('completed', 2), streaming: false },
      global: { stubs },
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-test="scroll-view"]').attributes('scroll-into-view')).toBe('')
  })

  it('follows the latest action while a trace is streaming', async () => {
    const wrapper = mount(ThinkingProcessSheet, {
      props: { visible: true, trace: trace('running', 1), streaming: true },
      global: { stubs },
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-test="scroll-view"]').attributes('scroll-into-view')).toBe(
      'thinking-action-0',
    )

    await wrapper.setProps({ trace: trace('running', 2) })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-test="scroll-view"]').attributes('scroll-into-view')).toBe(
      'thinking-action-1',
    )
  })

  it('pauses following after an upward scroll and resumes at the bottom', async () => {
    const wrapper = mount(ThinkingProcessSheet, {
      props: { visible: true, trace: trace('running', 1), streaming: true },
      global: { stubs },
    })
    const scrollView = wrapper.find('[data-test="scroll-view"]')
    await wrapper.vm.$nextTick()
    for (const scrollTop of [500, 490, 480, 470]) {
      scrollView.element.dispatchEvent(new CustomEvent('scroll', { detail: { scrollTop } }))
    }
    await wrapper.vm.$nextTick()
    await wrapper.setProps({ trace: trace('running', 2) })
    await wrapper.vm.$nextTick()

    expect(scrollView.attributes('scroll-into-view')).toBe('thinking-action-0')

    scrollView.element.dispatchEvent(new CustomEvent('scrolltolower'))
    await wrapper.setProps({ trace: trace('running', 3) })
    await wrapper.vm.$nextTick()
    expect(scrollView.attributes('scroll-into-view')).toBe('thinking-action-2')
  })
})
