# Chat Output Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bridge chat output error-visible, duplicate-free, phase-correct, scroll-friendly, and stable during long thinking and Markdown streams.

**Architecture:** Keep protocol state in the Pinia session Store, extract deterministic merge and view-policy logic into small pure utilities, and leave Server contracts unchanged. Vue pages and components consume those policies while retaining the existing uni-app rendering patterns.

**Tech Stack:** Vue 3.5 Composition API, Pinia 3, uni-app scroll-view, TypeScript 5.8, Vitest 3.

---

### Task 1: Stream Lifecycle And Message Reconciliation

**Files:**
- Create: `src/utils/chat-message-reconcile.ts`
- Create: `src/utils/chat-message-reconcile.spec.ts`
- Modify: `src/stores/index.ts:160-380`
- Modify: `src/stores/index.spec.ts`

- [ ] **Step 1: Write failing reconciliation utility tests**

Add tests that express the desired merge API:

```ts
expect(
  reconcileAssistantMessage({
    placeholder,
    synchronized: serverCopy,
    final: doneMessage,
  }),
).toMatchObject({
  id: 'assistant-final',
  content: 'final answer',
  streaming: false,
  agentTrace: placeholder.agentTrace,
})

expect(mergeStreamErrorContent('partial answer', 'connector failed')).toBe(
  'partial answer\n\nconnector failed',
)
expect(mergeStreamErrorContent('partial answer\n\nconnector failed', 'connector failed')).toBe(
  'partial answer\n\nconnector failed',
)
```

- [ ] **Step 2: Run utility tests and verify RED**

Run: `npm test -- src/utils/chat-message-reconcile.spec.ts`

Expected: FAIL because `chat-message-reconcile.ts` and its exports do not exist.

- [ ] **Step 3: Implement minimal reconciliation utilities**

Create pure helpers with these signatures:

```ts
export function mergeMessageAttachments(
  ...groups: Array<ChatMessageAttachment[] | undefined>
): ChatMessageAttachment[] | undefined

export function reconcileAssistantMessage(input: {
  placeholder?: ChatMessage
  synchronized?: ChatMessage
  final: ChatMessage
}): ChatMessage

export function mergeStreamErrorContent(content: string, error: string): string
```

Attachment identity is `${name}\0${mimeType ?? ''}\0${previewUrl ?? ''}`. The
reconciled result uses final content/time, keeps streamed trace/reasoning when
the final payload omits them, and always sets `streaming` and
`reasoningStreaming` to false.

- [ ] **Step 4: Run utility tests and verify GREEN**

Run: `npm test -- src/utils/chat-message-reconcile.spec.ts`

Expected: PASS.

- [ ] **Step 5: Write failing Store tests**

Extend `src/stores/index.spec.ts` with four behaviors:

```ts
it('keeps an SSE error visible and finalizes the placeholder', async () => {})
it('reconciles a synchronized final message without duplicating it', async () => {})
it('ignores late progress after final output starts', async () => {})
it('keeps streamed trace and attachments when done omits them', async () => {})
```

Use deferred stream mocks where an intermediate Store state must be asserted
before `onDone`.

- [ ] **Step 6: Run Store tests and verify RED**

Run: `npm test -- src/stores/index.spec.ts`

Expected: new tests FAIL because errors remain streaming, duplicate final IDs
remain, and late progress overwrites final content.

- [ ] **Step 7: Implement Store stream lifecycle**

Update `patchStreamingAssistant` to accept `streaming?: boolean`. Replace
`finalizeStreamingAssistant` with an order-preserving reconciliation flow:

```ts
const placeholderIndex = current.findIndex((item) => item.id === placeholderId)
const synchronized = current.find(
  (item) => item.id === message.id && item.id !== placeholderId,
)
const reconciled = reconcileAssistantMessage({ placeholder, synchronized, final: message })
const remaining = current.filter(
  (item) => item.id !== placeholderId && item.id !== message.id,
)
remaining.splice(Math.min(insertionIndex, remaining.length), 0, reconciled)
```

Inside `sendMessageStream`, track `finalPhaseStarted` and `streamError`. Ignore
ephemeral chunks after final output starts. Register `onError`, merge the error
into the placeholder, and set both streaming flags false. In the surrounding
`catch`, apply the same finalization for transport errors before rethrowing.
Always refresh the session list in `finally`.

- [ ] **Step 8: Run Store and SSE tests and verify GREEN**

Run: `npm test -- src/stores/index.spec.ts src/api/sse-stream.spec.ts`

Expected: PASS.

- [ ] **Step 9: Commit Task 1**

```bash
git add linco-bridge-platform/web/src/stores linco-bridge-platform/web/src/utils/chat-message-reconcile*
git commit -m "fix: reconcile web chat stream messages"
```

### Task 2: Follow-Latest Chat Scrolling

**Files:**
- Create: `src/utils/chat-scroll-policy.ts`
- Create: `src/utils/chat-scroll-policy.spec.ts`
- Modify: `src/pages/chat/index.vue:124-177,228-251`

- [ ] **Step 1: Write failing scroll-policy tests**

Define the desired pure policy behavior:

```ts
expect(updateChatFollowState(true, { previousTop: 500, scrollTop: 430 })).toBe(false)
expect(updateChatFollowState(false, { reachedBottom: true })).toBe(true)
expect(buildChatLayoutKey([traceOnlyMessage])).toContain('tool-1:running')
```

- [ ] **Step 2: Run scroll-policy tests and verify RED**

Run: `npm test -- src/utils/chat-scroll-policy.spec.ts`

Expected: FAIL because the utility does not exist.

- [ ] **Step 3: Implement scroll policy**

Create:

```ts
export function updateChatFollowState(
  following: boolean,
  input: { previousTop?: number; scrollTop?: number; reachedBottom?: boolean },
): boolean

export function buildChatLayoutKey(messages: ChatMessage[]): string
```

Disable following only for an upward movement greater than 24 CSS pixels.
`reachedBottom` always re-enables it. The layout key includes message count,
last ID, body/reasoning lengths, attachment identity, streaming flags, and each
trace action's ID/status/detail length.

- [ ] **Step 4: Run scroll-policy tests and verify GREEN**

Run: `npm test -- src/utils/chat-scroll-policy.spec.ts`

Expected: PASS.

- [ ] **Step 5: Integrate policy into the chat page**

Add `followLatest`, `lastScrollTop`, `handleMessageScroll`,
`handleMessageScrollToLower`, and `followLatestOutput`. Bind `@scroll`,
`@scrolltolower`, and `lower-threshold="120"` on `scroll-view`. Replace direct
watch/layout scrolling with `followLatestOutput`. `handleSend` explicitly sets
`followLatest.value = true` before scrolling and sending.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npm test -- src/utils/chat-scroll-policy.spec.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit Task 2**

```bash
git add linco-bridge-platform/web/src/pages/chat/index.vue linco-bridge-platform/web/src/utils/chat-scroll-policy*
git commit -m "fix: preserve web chat scroll position"
```

### Task 3: Unified Thinking Trace And Long-Chain Following

**Files:**
- Create: `src/utils/thinking-trace.ts`
- Create: `src/utils/thinking-trace.spec.ts`
- Modify: `src/components/ChatBubble.vue`
- Modify: `src/components/ThinkingProcessSheet.vue`
- Modify: `src/components/ChatBubble.spec.ts`

- [ ] **Step 1: Write failing thinking projection tests**

```ts
expect(resolveDisplayAgentTrace(undefined, reasoning, false)?.actions).toEqual([
  expect.objectContaining({ id: 'legacy-reasoning', type: 'thinking', status: 'done' }),
])

expect(resolveDisplayAgentTrace(traceWithThinking, reasoning, true)).toBe(traceWithThinking)
```

Also add a component assertion that legacy reasoning appears once through an
`AgentTraceActionCard`, not through a separate Markdown narrative.

- [ ] **Step 2: Run thinking tests and verify RED**

Run: `npm test -- src/utils/thinking-trace.spec.ts src/components/ChatBubble.spec.ts`

Expected: new tests FAIL because legacy reasoning is still a separate rendering
path.

- [ ] **Step 3: Implement projection and single-model rendering**

Create:

```ts
export function resolveDisplayAgentTrace(
  trace: AgentTrace | undefined,
  reasoning: ChatMessageReasoning | undefined,
  streaming: boolean,
): AgentTrace | undefined
```

Return the original trace if it already contains a thinking action. Otherwise
append one stable `legacy-reasoning` action with `detail_kind: 'markdown'`, the
reasoning text in `detail`, and timing/status derived from reasoning.

`ChatBubble` passes only the projected trace to `ThinkingProcessSheet`.
Remove the sheet's `content` prop and legacy Markdown branch.

- [ ] **Step 4: Add thinking-sheet follow behavior**

Use `scroll-into-view`, a stable `thinking-action-${index}` wrapper ID,
`@scroll`, and `@scrolltolower`. While visible and streaming, new action-state
keys update the anchor only if following remains enabled. Opening a completed
trace keeps the anchor empty so review starts at the beginning.

- [ ] **Step 5: Run thinking tests and verify GREEN**

Run: `npm test -- src/utils/thinking-trace.spec.ts src/components/ChatBubble.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add linco-bridge-platform/web/src/components/ChatBubble.vue linco-bridge-platform/web/src/components/ThinkingProcessSheet.vue linco-bridge-platform/web/src/components/ChatBubble.spec.ts linco-bridge-platform/web/src/utils/thinking-trace*
git commit -m "refactor: unify web agent thinking trace"
```

### Task 4: Throttled Streaming Rich Content

**Files:**
- Create: `src/composables/useThrottledStreamingContent.ts`
- Create: `src/composables/useThrottledStreamingContent.spec.ts`
- Modify: `src/components/MessageContent.vue:1-40,128-160`

- [ ] **Step 1: Write failing timer-based tests**

Using `vi.useFakeTimers()`, assert:

```ts
source.value = 'first'
source.value = 'latest'
expect(rendered.value).not.toBe('latest')
await vi.advanceTimersByTimeAsync(80)
expect(rendered.value).toBe('latest')

streaming.value = false
expect(rendered.value).toBe(source.value)
```

- [ ] **Step 2: Run composable tests and verify RED**

Run: `npm test -- src/composables/useThrottledStreamingContent.spec.ts`

Expected: FAIL because the composable does not exist.

- [ ] **Step 3: Implement the composable**

Create a Composition API utility that accepts source and streaming refs,
publishes the first value immediately, coalesces subsequent streaming updates
to the latest value at most every 80 ms, renders a non-streaming value
immediately, and clears its timer on scope disposal.

- [ ] **Step 4: Integrate rendered content**

In `MessageContent.vue`, wrap `toRef(props, 'content')` and
`toRef(props, 'streaming')` with the composable. Use `renderedContent` for
segment parsing, rich-content detection, and all child `content` props. Keep
link interaction disabled from the original `props.streaming` state.

- [ ] **Step 5: Run composable tests and verify GREEN**

Run: `npm test -- src/composables/useThrottledStreamingContent.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add linco-bridge-platform/web/src/composables/useThrottledStreamingContent* linco-bridge-platform/web/src/components/MessageContent.vue
git commit -m "perf: throttle web streaming rich content"
```

### Task 5: Full Verification

**Files:**
- Modify only files needed to resolve failures introduced by Tasks 1-4.

- [ ] **Step 1: Run formatting on changed source files**

Run: `npx prettier --write src/stores/index.ts src/stores/index.spec.ts src/pages/chat/index.vue src/components/ChatBubble.vue src/components/ThinkingProcessSheet.vue src/components/MessageContent.vue src/utils/chat-message-reconcile.ts src/utils/chat-message-reconcile.spec.ts src/utils/chat-scroll-policy.ts src/utils/chat-scroll-policy.spec.ts src/utils/thinking-trace.ts src/utils/thinking-trace.spec.ts src/composables/useThrottledStreamingContent.ts src/composables/useThrottledStreamingContent.spec.ts`

Expected: exit 0.

- [ ] **Step 2: Run the complete Web check**

Run: `npm run check`

Expected: typecheck, lint, formatting, and all Vitest suites pass with zero
warnings treated as errors.

- [ ] **Step 3: Run production H5 build**

Run: `npm run build:h5`

Expected: exit 0 and H5 tab-bar verification succeeds.

- [ ] **Step 4: Review scope and diff**

Run: `git status --short`

Expected: no changes outside `linco-bridge-platform/web`.

Run: `git diff --check HEAD~4..HEAD`

Expected: exit 0.

- [ ] **Step 5: Record verification evidence**

Summarize exact test counts, build result, commits, and any remaining
Server-contract blockers without claiming unsupported parity.
