import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatSession } from '@/composables/useChatSession'

const mocks = vi.hoisted(() => ({
  sendMessageStream: vi.fn(),
  checkStatus: vi.fn(async () => undefined),
  scheduleNextFrame: vi.fn((callback: () => void) => callback()),
  delay: vi.fn(async () => undefined),
}))

vi.mock('@/stores', () => ({
  useSessionStore: () => ({
    sessions: [],
    getMessages: vi.fn(() => []),
    getSession: vi.fn(() => ({
      id: 'session-1',
      agentType: 'codex',
      title: 'Codex',
      updatedAt: 1,
      online: true,
    })),
    loadSessions: vi.fn(async () => undefined),
    loadMessages: vi.fn(async () => undefined),
    setMessages: vi.fn(),
    sendMessageStream: mocks.sendMessageStream,
    cancelActiveStream: vi.fn(async () => null),
  }),
  useBridgeStore: () => ({
    statusByType: { codex: { connected: true } },
    checkStatus: mocks.checkStatus,
  }),
}))

vi.mock('@/utils/platform-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/platform-runtime')>()),
  scheduleNextFrame: mocks.scheduleNextFrame,
  delay: mocks.delay,
}))

describe('useChatSession scrolling', () => {
  beforeEach(() => {
    mocks.sendMessageStream.mockReset()
    mocks.sendMessageStream.mockResolvedValue(undefined)
    mocks.scheduleNextFrame.mockClear()
    mocks.delay.mockClear()
    mocks.checkStatus.mockClear()
  })

  it('does not force another bottom scroll when a send settles', async () => {
    const chat = useChatSession()
    chat.sessionId.value = 'session-1'

    await chat.sendMessage('hello')
    await nextTick()
    await Promise.resolve()

    expect(mocks.scheduleNextFrame).toHaveBeenCalledTimes(1)
  })

  it('does not force another bottom scroll when generation is stopped', async () => {
    mocks.sendMessageStream.mockImplementationOnce(
      async (
        _sessionId,
        _content,
        options: { cancel: { onAbort: (listener: () => void) => void } },
      ) =>
        new Promise<never>((_resolve, reject) => {
          options.cancel.onAbort(() => reject(new Error('Aborted')))
        }),
    )
    const chat = useChatSession()
    chat.sessionId.value = 'session-1'

    const pending = chat.sendMessage('hello')
    await nextTick()
    await chat.stopGeneration()
    await pending
    await nextTick()

    expect(mocks.scheduleNextFrame).toHaveBeenCalledTimes(1)
  })
})
