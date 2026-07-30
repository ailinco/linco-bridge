import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSessionStore } from '@/stores'
import { createCancelToken } from '@/utils/platform-runtime'

vi.mock('@/api/session-api', () => ({
  fetchSessions: vi.fn(async () => [
    {
      id: 'session-1',
      agentType: 'codex',
      title: 'Codex',
      lastMessage: 'hello',
      updatedAt: 1,
      online: true,
    },
  ]),
  fetchMessages: vi.fn(async () => []),
  streamSessionMessage: vi.fn(async (_sessionId, _content, handlers) => {
    handlers.onUserMessage?.({
      id: 'm-user',
      sessionId: 'session-1',
      role: 'user',
      content: 'hi',
      createdAt: 1,
    })
    handlers.onChunk?.({ fullText: 'ack' })
    const reply = {
      id: 'm-assistant',
      sessionId: 'session-1',
      role: 'assistant' as const,
      content: 'ack',
      createdAt: 2,
    }
    handlers.onDone?.(reply)
    return reply
  }),
  cancelStreamMessage: vi.fn(async () => null),
}))

describe('useSessionStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('loads sessions from API layer', async () => {
    const store = useSessionStore()
    await store.loadSessions()
    expect(store.sessions).toHaveLength(1)
    expect(store.sessions[0]?.title).toBe('Codex')
  })

  it('replaces streaming placeholder on done instead of duplicating assistant message', async () => {
    const store = useSessionStore()
    await store.sendMessageStream('session-1', 'hi')

    const messages = store.getMessages('session-1')
    const assistantMessages = messages.filter((item) => item.role === 'assistant')

    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]?.content).toBe('ack')
    expect(assistantMessages[0]?.streaming).toBe(false)
  })

  it('stores agent trace snapshots during stream', async () => {
    const { streamSessionMessage } = await import('@/api/session-api')
    vi.mocked(streamSessionMessage).mockImplementationOnce(
      async (_sessionId, _content, handlers) => {
        handlers.onAgentTrace?.({
          task: { status: 'task_running', started_at: 1000 },
          actions: [
            {
              id: 'tool-1',
              type: 'tool',
              status: 'running',
              label: '读取文件',
            },
          ],
        })
        const reply = {
          id: 'm-assistant',
          sessionId: 'session-1',
          role: 'assistant' as const,
          content: 'done',
          createdAt: 2,
        }
        handlers.onDone?.(reply)
        return reply
      },
    )

    const store = useSessionStore()
    await store.sendMessageStream('session-1', 'hi')

    const assistant = store.getMessages('session-1').find((item) => item.role === 'assistant')
    expect(assistant?.agentTrace?.actions).toHaveLength(1)
    expect(assistant?.agentTrace?.actions[0]?.label).toBe('读取文件')
  })

  it('clears reasoning on reasoning_clear stream event', async () => {
    const { streamSessionMessage } = await import('@/api/session-api')
    vi.mocked(streamSessionMessage).mockImplementationOnce(
      async (_sessionId, _content, handlers) => {
        handlers.onReasoning?.({ fullText: 'plan step' })
        handlers.onReasoningClear?.()
        const reply = {
          id: 'm-assistant',
          sessionId: 'session-1',
          role: 'assistant' as const,
          content: 'done',
          createdAt: 2,
        }
        handlers.onDone?.(reply)
        return reply
      },
    )

    const store = useSessionStore()
    await store.sendMessageStream('session-1', 'hi')

    const assistant = store.getMessages('session-1').find((item) => item.role === 'assistant')
    expect(assistant?.reasoning).toBeUndefined()
    expect(assistant?.content).toBe('done')
  })

  it('accumulates reasoning before assistant body during stream', async () => {
    const { streamSessionMessage } = await import('@/api/session-api')
    vi.mocked(streamSessionMessage).mockImplementationOnce(
      async (_sessionId, _content, handlers) => {
        handlers.onReasoning?.({ fullText: 'plan step' })
        handlers.onReasoningEnd?.()
        handlers.onChunk?.({ fullText: 'hello' })
        const reply = {
          id: 'm-assistant',
          sessionId: 'session-1',
          role: 'assistant' as const,
          content: 'hello',
          createdAt: 2,
        }
        handlers.onDone?.(reply)
        return reply
      },
    )

    const store = useSessionStore()
    await store.sendMessageStream('session-1', 'hi')

    const assistant = store.getMessages('session-1').find((item) => item.role === 'assistant')
    expect(assistant?.reasoning?.content).toBe('plan step')
    expect(assistant?.reasoning?.endedAt).toBeTypeOf('number')
    expect(assistant?.content).toBe('hello')
    expect(assistant?.streaming).toBe(false)
  })

  it('shows optimistic user message before stream user event', async () => {
    const { streamSessionMessage } = await import('@/api/session-api')
    vi.mocked(streamSessionMessage).mockImplementationOnce(
      async (_sessionId, _content, handlers) => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        handlers.onUserMessage?.({
          id: 'm-user',
          sessionId: 'session-1',
          role: 'user',
          content: 'hi',
          createdAt: 1,
        })
        const reply = {
          id: 'm-assistant',
          sessionId: 'session-1',
          role: 'assistant' as const,
          content: 'ack',
          createdAt: 2,
        }
        handlers.onDone?.(reply)
        return reply
      },
    )

    const store = useSessionStore()
    const pending = store.sendMessageStream('session-1', 'hi')
    expect(
      store.getMessages('session-1').some((item) => item.role === 'user' && item.content === 'hi'),
    ).toBe(true)
    await pending
  })

  it('keeps user message above streaming placeholder when start arrives first', async () => {
    const { streamSessionMessage } = await import('@/api/session-api')
    vi.mocked(streamSessionMessage).mockImplementationOnce(
      async (_sessionId, _content, handlers) => {
        handlers.onStart?.({ streamId: 's1' })
        handlers.onUserMessage?.({
          id: 'm-user-2',
          sessionId: 'session-1',
          role: 'user',
          content: 'second',
          createdAt: 3,
        })
        await new Promise((resolve) => setTimeout(resolve, 10))
        const reply = {
          id: 'm-assistant-2',
          sessionId: 'session-1',
          role: 'assistant' as const,
          content: 'ok',
          createdAt: 4,
        }
        handlers.onDone?.(reply)
        return reply
      },
    )

    const store = useSessionStore()
    store.setMessages('session-1', [
      {
        id: 'm-user-1',
        sessionId: 'session-1',
        role: 'user',
        content: 'first',
        createdAt: 1,
      },
      {
        id: 'm-assistant-1',
        sessionId: 'session-1',
        role: 'assistant',
        content: 'reply',
        createdAt: 2,
      },
    ])

    const pending = store.sendMessageStream('session-1', 'second')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const roles = store
      .getMessages('session-1')
      .map((item) => (item.streaming ? 'streaming' : item.role))
    expect(roles).toEqual(['user', 'assistant', 'user', 'streaming'])

    await pending
  })

  it('keeps an SSE error visible and finalizes the placeholder', async () => {
    const { streamSessionMessage } = await import('@/api/session-api')
    vi.mocked(streamSessionMessage).mockImplementationOnce(
      async (_sessionId, _content, handlers) => {
        handlers.onStart?.({ streamId: 'stream-error' })
        handlers.onChunk?.({ fullText: 'partial answer' })
        handlers.onError?.('connector failed')
        throw new Error('connector failed')
      },
    )

    const store = useSessionStore()
    await expect(store.sendMessageStream('session-1', 'hi')).rejects.toThrow('connector failed')

    const assistant = store.getMessages('session-1').find((item) => item.role === 'assistant')
    expect(assistant?.content).toBe('partial answer\n\nconnector failed')
    expect(assistant?.streaming).toBe(false)
    expect(assistant?.reasoningStreaming).toBe(false)
  })

  it('reconciles a synchronized final message without duplicating it', async () => {
    const { streamSessionMessage } = await import('@/api/session-api')
    const store = useSessionStore()
    const finalMessage = {
      id: 'assistant-final',
      sessionId: 'session-1',
      role: 'assistant' as const,
      content: 'final answer',
      createdAt: 20,
    }
    vi.mocked(streamSessionMessage).mockImplementationOnce(
      async (_sessionId, _content, handlers) => {
        handlers.onStart?.({ streamId: 'stream-final' })
        handlers.onChunk?.({ fullText: 'draft answer' })
        store.upsertMessage('session-1', { ...finalMessage, content: 'synchronized draft' })
        handlers.onDone?.(finalMessage)
        return finalMessage
      },
    )

    await store.sendMessageStream('session-1', 'hi')

    const assistants = store.getMessages('session-1').filter((item) => item.id === finalMessage.id)
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.content).toBe('final answer')
  })

  it('ignores late progress after final output starts', async () => {
    const { streamSessionMessage } = await import('@/api/session-api')
    let release!: () => void
    const waitForDone = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(streamSessionMessage).mockImplementationOnce(
      async (_sessionId, _content, handlers) => {
        handlers.onStart?.({ streamId: 'stream-phase' })
        handlers.onChunk?.({ fullText: 'working', phase: 'progress', ephemeral: true })
        handlers.onChunk?.({
          fullText: 'final answer',
          phase: 'final_answer',
          ephemeral: false,
          replacePrevious: true,
        })
        handlers.onChunk?.({ fullText: 'late progress', phase: 'progress', ephemeral: true })
        await waitForDone
        const reply = {
          id: 'assistant-phase-final',
          sessionId: 'session-1',
          role: 'assistant' as const,
          content: 'final answer',
          createdAt: 30,
        }
        handlers.onDone?.(reply)
        return reply
      },
    )

    const store = useSessionStore()
    const pending = store.sendMessageStream('session-1', 'hi')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const streamingContent = store.getMessages('session-1').find((item) => item.streaming)?.content
    release()
    await pending

    expect(streamingContent).toBe('final answer')
  })

  it('keeps streamed trace and attachments when done omits them', async () => {
    const { streamSessionMessage } = await import('@/api/session-api')
    vi.mocked(streamSessionMessage).mockImplementationOnce(
      async (_sessionId, _content, handlers) => {
        handlers.onStart?.({ streamId: 'stream-metadata' })
        handlers.onAgentTrace?.({
          actions: [{ id: 'tool-1', type: 'tool', status: 'done', label: 'Read file' }],
        })
        handlers.onAttachment?.({ name: 'report.txt', mimeType: 'text/plain' })
        const reply = {
          id: 'assistant-metadata-final',
          sessionId: 'session-1',
          role: 'assistant' as const,
          content: 'done',
          createdAt: 40,
        }
        handlers.onDone?.(reply)
        return reply
      },
    )

    const store = useSessionStore()
    await store.sendMessageStream('session-1', 'hi')

    const assistant = store
      .getMessages('session-1')
      .find((item) => item.id === 'assistant-metadata-final')
    expect(assistant?.agentTrace?.actions[0]?.id).toBe('tool-1')
    expect(assistant?.attachments).toEqual([{ name: 'report.txt', mimeType: 'text/plain' }])
  })

  it('does not record an intentional cancellation before the stream starts as an error', async () => {
    const { streamSessionMessage } = await import('@/api/session-api')
    vi.mocked(streamSessionMessage).mockImplementationOnce(
      async (_sessionId, _content, _handlers, cancel) => {
        await new Promise<void>((resolve) => cancel?.onAbort(resolve))
        throw new Error('Aborted')
      },
    )

    const store = useSessionStore()
    const cancel = createCancelToken()
    const pending = store.sendMessageStream('session-1', 'hi', { cancel })
    cancel.abort()

    await expect(pending).rejects.toThrow('Aborted')
    expect(store.getMessages('session-1').filter((item) => item.role === 'assistant')).toEqual([])
  })
})
