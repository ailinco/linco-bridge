import type { AgentTraceAction, ChatMessage } from '@/bridge/types'

const UPWARD_SCROLL_THRESHOLD = 24

export function updateChatFollowState(
  following: boolean,
  input: { previousTop?: number; scrollTop?: number; reachedBottom?: boolean },
): boolean {
  if (input.reachedBottom) return true
  if (input.previousTop == null || input.scrollTop == null) return following
  if (input.previousTop - input.scrollTop > UPWARD_SCROLL_THRESHOLD) return false
  return following
}

function traceActionKey(action: AgentTraceAction): string {
  const children = (action.children ?? []).map(traceActionKey).join(',')
  return `${action.id}:${action.status}:${action.detail?.length ?? 0}:${action.duration ?? ''}[${children}]`
}

export function buildChatLayoutKey(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1]
  if (!last) return 'empty'

  const attachments = (last.attachments ?? [])
    .map((item) => `${item.name}:${item.mimeType ?? ''}:${item.previewUrl?.length ?? 0}`)
    .join('|')
  const trace = (last.agentTrace?.actions ?? []).map(traceActionKey).join('|')

  return [
    messages.length,
    last.id,
    last.content.length,
    last.reasoning?.content.length ?? 0,
    attachments,
    last.streaming ? 1 : 0,
    last.reasoningStreaming ? 1 : 0,
    trace,
  ].join(':')
}
