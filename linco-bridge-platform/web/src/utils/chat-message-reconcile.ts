import type { ChatMessage, ChatMessageAttachment } from '@/bridge/types'

function attachmentIdentity(attachment: ChatMessageAttachment): string {
  return `${attachment.name}\0${attachment.mimeType ?? ''}\0${attachment.previewUrl ?? ''}`
}

export function mergeMessageAttachments(
  ...groups: Array<ChatMessageAttachment[] | undefined>
): ChatMessageAttachment[] | undefined {
  const seen = new Set<string>()
  const merged: ChatMessageAttachment[] = []

  for (const group of groups) {
    for (const attachment of group ?? []) {
      const identity = attachmentIdentity(attachment)
      if (seen.has(identity)) continue
      seen.add(identity)
      merged.push(attachment)
    }
  }

  return merged.length > 0 ? merged : undefined
}

export function reconcileAssistantMessage(input: {
  placeholder?: ChatMessage
  synchronized?: ChatMessage
  final: ChatMessage
}): ChatMessage {
  const streamedReasoning = input.placeholder?.reasoning
  const reasoning = input.final.reasoning ?? input.synchronized?.reasoning ?? streamedReasoning
  const completedReasoning =
    reasoning && reasoning === streamedReasoning && reasoning.endedAt == null
      ? { ...reasoning, endedAt: input.final.createdAt }
      : reasoning

  return {
    ...input.placeholder,
    ...input.synchronized,
    ...input.final,
    streaming: false,
    reasoningStreaming: false,
    reasoning: completedReasoning,
    agentTrace:
      input.final.agentTrace ?? input.synchronized?.agentTrace ?? input.placeholder?.agentTrace,
    attachments: mergeMessageAttachments(
      input.final.attachments,
      input.synchronized?.attachments,
      input.placeholder?.attachments,
    ),
  }
}

export function mergeStreamErrorContent(content: string, error: string): string {
  const normalizedContent = content.trimEnd()
  const normalizedError = error.trim() || 'stream error'
  if (!normalizedContent) return normalizedError
  if (normalizedContent.endsWith(normalizedError)) return normalizedContent
  return `${normalizedContent}\n\n${normalizedError}`
}
