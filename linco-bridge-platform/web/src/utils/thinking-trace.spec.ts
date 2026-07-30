import { describe, expect, it } from 'vitest'
import type { AgentTrace, ChatMessageReasoning } from '@/bridge/types'
import { resolveDisplayAgentTrace } from './thinking-trace'

const reasoning: ChatMessageReasoning = {
  content: 'Inspect the repository before editing.',
  startedAt: 10,
  endedAt: 20,
}

describe('thinking-trace', () => {
  it('projects legacy reasoning into one completed thinking action', () => {
    expect(resolveDisplayAgentTrace(undefined, reasoning, false)).toEqual({
      task: {
        status: 'task_success',
        started_at: 10,
        completed_at: 20,
        total_duration: 10,
      },
      actions: [
        {
          id: 'legacy-reasoning',
          type: 'thinking',
          status: 'completed',
          label: 'Thinking',
          detail: reasoning.content,
          detail_kind: 'markdown',
          started_at: 10,
          completed_at: 20,
          duration: 10,
        },
      ],
    })
  })

  it('keeps a trace that already contains thinking unchanged', () => {
    const trace: AgentTrace = {
      actions: [
        {
          id: 'thinking-1',
          type: 'thinking',
          status: 'running',
          label: 'Thinking',
        },
      ],
    }

    expect(resolveDisplayAgentTrace(trace, reasoning, true)).toBe(trace)
  })

  it('appends legacy reasoning when the trace contains only tool actions', () => {
    const trace: AgentTrace = {
      task: { status: 'task_running', started_at: 5 },
      actions: [{ id: 'tool-1', type: 'tool', status: 'done', label: 'Read file' }],
    }

    const result = resolveDisplayAgentTrace(trace, { ...reasoning, endedAt: undefined }, true)

    expect(result?.task).toBe(trace.task)
    expect(result?.actions.map((item) => item.id)).toEqual(['tool-1', 'legacy-reasoning'])
    expect(result?.actions[1]?.status).toBe('running')
  })
})
