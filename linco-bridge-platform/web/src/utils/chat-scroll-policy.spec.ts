import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/bridge/types'
import {
  buildChatLayoutKey,
  updateChatFollowState,
  type ChatFollowState,
} from './chat-scroll-policy'

describe('chat-scroll-policy', () => {
  it('stops following after a meaningful upward scroll', () => {
    expect(
      updateChatFollowState({ following: true, referenceTop: 500 }, { scrollTop: 430 }).following,
    ).toBe(false)
    expect(
      updateChatFollowState({ following: true, referenceTop: 500 }, { scrollTop: 490 }).following,
    ).toBe(true)
  })

  it('stops following after cumulative small upward scroll events', () => {
    let state: ChatFollowState = { following: true }
    for (const scrollTop of [500, 490, 480, 470]) {
      state = updateChatFollowState(state, { scrollTop })
    }

    expect(state.following).toBe(false)
  })

  it('resumes following when the bottom threshold is reached', () => {
    expect(updateChatFollowState({ following: false }, { reachedBottom: true })).toEqual({
      following: true,
    })
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
