# Chat Output Consistency Design

## Background

Recent `aichat` changes tightened bridge chat output around visible stream errors,
stable message reconciliation, Codex progress/final correction, history scrolling,
and long-running output performance. The Web client already parses the unified
SSE protocol and renders Markdown, attachments, reasoning, and `agentTrace`, but
its Store and scroll lifecycle do not yet enforce the same consistency rules.

Only `linco-bridge-platform/web` is in scope. Server and connector contracts are
read-only dependencies for this work.

## Approaches Considered

### 1. Store-first incremental convergence (selected)

Fix message identity, stream lifecycle, and scroll following first. Follow with
thinking-chain and Markdown rendering improvements in a separate batch. This
keeps correctness changes independently testable and avoids coupling protocol
state to rendering details.

### 2. UI-only patching

Show a toast for errors and suppress visibly duplicated rows in components.
This is smaller, but leaves duplicate and stale messages in Store state and
causes later history reloads to reproduce the problem. This approach is
rejected.

### 3. Full protocol parity in one change

Add deterministic request IDs, cursor history, attachment preview metadata, and
action cards together. This cannot be completed inside Web because the current
Server API does not expose all required fields. This approach is rejected for
the current scope.

## Batch 1: Output Correctness

### Stream error lifecycle

`sendMessageStream` must register `onError`. When an SSE error arrives, the
current assistant placeholder becomes non-streaming and shows the server error.
If partial assistant text already exists, retain it and append the error on a
new line. Repeated delivery of the same error must not append duplicates.

If the request subsequently rejects, the same placeholder remains finalized;
it must not be removed or replaced by a second error message. The caller may
still surface its existing toast, but the conversation itself remains an
accurate record of the failed turn.

### Message reconciliation

Finalization must reconcile three possible representations of one assistant
reply:

- the local `stream-assistant-*` placeholder;
- a message with the final Server ID already inserted by synchronization;
- the `done.message` payload.

The final Server ID is authoritative. Preserve the placeholder's list position,
remove any duplicate final-ID row, and merge fields without losing streamed
attachments, reasoning, or `agentTrace`. Attachments are deduplicated by their
stable visible identity (`name`, `mimeType`, and `previewUrl`). The final payload
wins for content and timestamps; final trace/attachments win when present,
otherwise streamed data is retained.

User confirmation messages use the same ID-based upsert behavior so an
optimistic row and an already synchronized Server row cannot create duplicates.
Generating deterministic bridge request IDs remains out of scope because the
current Web-to-Server API does not accept one.

### Codex progress/final phases

Each active assistant stream keeps separate progress and final display state.
Ephemeral or `phase=progress` chunks may update the visible placeholder only
until a non-ephemeral chunk begins the final phase. Once final output starts,
late progress chunks are ignored. `replacePrevious=true` replaces the visible
progress draft with the final phase's `fullText` without briefly combining the
two buffers.

The `done.message` payload remains authoritative and closes the stream.

### Chat scroll following

Automatic scrolling follows new output only while the user is near the bottom.
Sending a new message explicitly re-enables following. User scrolling upward
disables following until they return near the bottom. Body text, attachments,
and `agentTrace.actions` updates all participate in the layout-change key.

The near-bottom threshold must tolerate normal image and Markdown layout shifts
without pulling a user who is reading older messages back to the latest output.

## Batch 2: Rendering Stability

### Unified thinking display

`agentTrace` is the primary thinking model. Legacy `reasoning` remains accepted
at the Store boundary for protocol compatibility, but the UI must not render two
independent thinking narratives. When no thinking action exists, legacy
reasoning is projected into one synthetic thinking action for display.

### Long thinking chains

While a thinking sheet is open and the user remains at its bottom, new actions
follow the latest step. Scrolling upward pauses following. Completed traces open
at the beginning for review. Rendering should avoid rebuilding unchanged action
cards when only the latest action changes.

### Streaming rich text

Throttle expensive streaming Markdown/rich-content parsing to a short bounded
interval while retaining the latest full text. Final content renders
immediately. Existing lazy chunking for completed long Markdown remains in use.

## Contract-blocked Features

The following are intentionally excluded until Server/connector contracts are
available:

- cursor history fields (`cursor`, `hasMore`, `snapshotId`);
- PDF preview and attachment scan/error metadata;
- interactive permission, danger confirmation, and batch-question cards;
- end-to-end deterministic request-derived message IDs.

## Tests

Batch 1 tests must cover:

- an SSE error finalizes the placeholder and remains visible;
- partial output is preserved when an error arrives;
- finalization removes a pre-existing final-ID duplicate;
- streamed trace and attachments survive finalization when absent from `done`;
- late progress cannot overwrite final output;
- the scroll policy follows only when near the bottom or after a local send;
- trace-only updates change the chat layout key.

Batch 2 tests must cover legacy reasoning projection, thinking-chain follow
state, and throttled parsing with immediate final rendering.

## Success Criteria

- One user turn produces at most one user row and one assistant row after
  synchronization and completion.
- Failed streams leave a readable, non-streaming assistant message.
- Codex final output cannot be overwritten by progress output.
- Reading older messages is not interrupted by incoming stream updates.
- All new behavior is covered by tests, and the existing Web typecheck, lint,
  formatting, and test commands remain clean.
