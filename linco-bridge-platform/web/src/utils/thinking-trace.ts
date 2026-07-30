import type { AgentTrace, AgentTraceAction, ChatMessageReasoning } from '@/bridge/types'

function containsThinking(actions: AgentTraceAction[]): boolean {
  return actions.some(
    (action) => action.type === 'thinking' || containsThinking(action.children ?? []),
  )
}

export function resolveDisplayAgentTrace(
  trace: AgentTrace | undefined,
  reasoning: ChatMessageReasoning | undefined,
  streaming: boolean,
): AgentTrace | undefined {
  if (!reasoning?.content.trim() || (trace && containsThinking(trace.actions))) return trace

  const completedAt = reasoning.endedAt
  const duration = completedAt == null ? undefined : Math.max(0, completedAt - reasoning.startedAt)
  const thinkingAction: AgentTraceAction = {
    id: 'legacy-reasoning',
    type: 'thinking',
    status: streaming && completedAt == null ? 'running' : 'completed',
    label: 'Thinking',
    detail: reasoning.content,
    detail_kind: 'markdown',
    started_at: reasoning.startedAt,
    completed_at: completedAt,
    duration,
  }

  if (trace) {
    return {
      ...trace,
      actions: [...trace.actions, thinkingAction],
    }
  }

  return {
    task: {
      status: streaming && completedAt == null ? 'task_running' : 'task_success',
      started_at: reasoning.startedAt,
      completed_at: completedAt,
      total_duration: duration,
    },
    actions: [thinkingAction],
  }
}
