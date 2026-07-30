import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/bridge/types'
import {
  mergeMessageAttachments,
  mergeStreamErrorContent,
  reconcileAssistantMessage,
} from './chat-message-reconcile'

const placeholder: ChatMessage = {
  id: 'stream-assistant-1',
  sessionId: 'session-1',
  role: 'assistant',
  content: 'draft',
  createdAt: 10,
  streaming: true,
  reasoningStreaming: true,
  reasoning: {
    content: 'checking',
    startedAt: 8,
  },
  agentTrace: {
    actions: [{ id: 'tool-1', type: 'tool', status: 'running', label: 'Read file' }],
  },
  attachments: [{ name: 'report.txt', mimeType: 'text/plain', previewUrl: 'local://report' }],
}

describe('chat-message-reconcile', () => {
  it('keeps streamed metadata while final fields remain authoritative', () => {
    const synchronized: ChatMessage = {
      id: 'assistant-final',
      sessionId: 'session-1',
      role: 'assistant',
      content: 'synchronized draft',
      createdAt: 20,
      attachments: [{ name: 'server.pdf', mimeType: 'application/pdf' }],
    }
    const final: ChatMessage = {
      id: 'assistant-final',
      sessionId: 'session-1',
      role: 'assistant',
      content: 'final answer',
      createdAt: 30,
    }

    expect(reconcileAssistantMessage({ placeholder, synchronized, final })).toEqual({
      ...final,
      streaming: false,
      reasoningStreaming: false,
      reasoning: {
        content: 'checking',
        startedAt: 8,
        endedAt: 30,
      },
      agentTrace: placeholder.agentTrace,
      attachments: [
        { name: 'server.pdf', mimeType: 'application/pdf' },
        { name: 'report.txt', mimeType: 'text/plain', previewUrl: 'local://report' },
      ],
    })
  })

  it('deduplicates attachments by visible identity', () => {
    const attachment = { name: 'report.txt', mimeType: 'text/plain', previewUrl: '/report' }

    expect(mergeMessageAttachments([attachment], [attachment])).toEqual([attachment])
    expect(mergeMessageAttachments(undefined, [])).toBeUndefined()
  })

  it('appends a stream error once while preserving partial output', () => {
    expect(mergeStreamErrorContent('partial answer', 'connector failed')).toBe(
      'partial answer\n\nconnector failed',
    )
    expect(mergeStreamErrorContent('partial answer\n\nconnector failed', 'connector failed')).toBe(
      'partial answer\n\nconnector failed',
    )
    expect(mergeStreamErrorContent('', 'connector failed')).toBe('connector failed')
  })
})
