import type { AgentTrace, AgentTraceAction } from '@/bridge/types'

export interface AgentTraceTodo {
  text: string
  status: string
}

export function isEmptyAgentTrace(trace: AgentTrace | undefined | null): boolean {
  if (!trace) return true
  return !trace.task?.status && trace.actions.length === 0
}

export function actionTitle(action: AgentTraceAction): string {
  const label = action.label?.trim()
  if (label) return label
  const toolName = action.tool_name?.trim()
  if (toolName) return toolName
  switch (action.type.trim()) {
    case 'read':
      return '读取文件'
    case 'write':
      return '写入文件'
    case 'shell':
      return '执行命令'
    case 'thinking':
      return '思考'
    case 'plan':
      return '执行计划'
    case 'tool':
      return '调用工具'
    default:
      return '执行步骤'
  }
}

export function actionPreview(action: AgentTraceAction): string {
  const detail = action.detail?.trim() ?? ''
  if (!detail) return ''
  return detail.split('\n')[0]?.trim() ?? ''
}

export function hiddenActionDetail(action: AgentTraceAction, preview: string): string {
  const detail = action.detail?.trim() ?? ''
  if (!detail) return ''
  const rest = detail.split('\n').slice(1).join('\n').trim()
  if (rest) return rest
  return detail === preview ? '' : detail
}

export function planTodosForAction(action: AgentTraceAction): AgentTraceTodo[] {
  if (action.type.trim() !== 'plan') return []
  return todosFromPlanObject(action.detail_object)
}

function todosFromPlanObject(value: unknown): AgentTraceTodo[] {
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  let rawTodos: unknown[] | null = Array.isArray(record.todos) ? record.todos : null
  if (!rawTodos && record.update && typeof record.update === 'object') {
    const updateTodos = (record.update as Record<string, unknown>).todos
    rawTodos = Array.isArray(updateTodos) ? updateTodos : null
  }
  if (!rawTodos) return []
  return rawTodos
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => {
      const text = String(item.content ?? item.text ?? item.title ?? '').trim()
      if (!text) return null
      return {
        text,
        status: String(item.status ?? '').trim(),
      }
    })
    .filter((item): item is AgentTraceTodo => item !== null)
}

export function isActionActive(status: string): boolean {
  const normalized = status.trim().toLowerCase()
  return (
    normalized === 'running' ||
    normalized === 'started' ||
    normalized === 'pending' ||
    normalized === 'pending_approval' ||
    normalized === 'task_running'
  )
}

export function isActionSuccess(status: string): boolean {
  const normalized = status.trim().toLowerCase()
  return normalized === 'success' || normalized === 'completed' || normalized === 'task_success'
}

export function traceSummaryStatus(trace: AgentTrace, streaming = false): string {
  if (streaming && isActionActive(trace.task?.status ?? '')) {
    return '执行中'
  }
  const activeAction = trace.actions.find((action) => isActionActive(action.status))
  if (streaming && activeAction) return actionTitle(activeAction)
  if (
    trace.task?.status === 'task_success' ||
    isActionSuccess(trace.actions.at(-1)?.status ?? '')
  ) {
    return '已完成'
  }
  if (trace.task?.status === 'task_failed') return '执行失败'
  return '思考过程'
}
