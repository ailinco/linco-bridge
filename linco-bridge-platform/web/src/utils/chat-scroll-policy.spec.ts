import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/bridge/types'
import { buildChatLayoutKey, updateChatFollowState } from './chat-scroll-policy'

describe('chat-scroll-policy', () => {
  it('stops following after a meaningful upward scroll', () => {
    expect(updateChatFollowState(true, { previousTop: 500, scrollTop: 430 })).toBe(false)
    expect(updateChatFollowState(true, { previousTop: 500, scrollTop: 490 })).toBe(true)
  })

  it('resumes following when the bottom threshold is reached', () => {
    expect(updateChatFollowState(false, { reachedBottom: true })).toBe(true)
  })

  it('includes trace-only changes in the chat layout key', () => {
    const message: ChatMessage = {
      id: 'assistant-1',
      sessionId: 'session-1',
      role: 'assistant',
      content: '',
      createdAt: 1,
      streaming: true,
      agentTrace: {
        actions: [
          {
            id: 'tool-1',
            type: 'tool',
            status: 'running',
            label: 'Read file',
            detail: 'src/main.ts',
          },
        ],
      },
    }

    const runningKey = buildChatLayoutKey([message])
    const doneKey = buildChatLayoutKey([
      {
        ...message,
        agentTrace: {
          actions: [{ ...message.agentTrace!.actions[0]!, status: 'done' }],
        },
      },
    ])

    expect(runningKey).toContain('tool-1:running')
    expect(doneKey).toContain('tool-1:done')
    expect(doneKey).not.toBe(runningKey)
  })
})
