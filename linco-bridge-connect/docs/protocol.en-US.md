# Linco Bridge connector Protocol

This document describes the main message contract between `linco-bridge-connect` and remote channels. The shared connector entry is `src/core/channelConnector.js`, channel registration is in `src/core/channelRegistry.js`, the official Linco IM protocol implementation is in `src/channel/linco/`, and the open-source H5 demo channel is in `src/channel/lincoDemo/`.

`linco` and `linco-demo` are independent channels. `linco-demo` currently uses a Linco-compatible protocol and can evolve independently inside its own adapter.

The open-source reference platform maps to `linco-demo`. It demonstrates an H5 interaction model that is better suited to Agents. Third parties can implement their own H5 page, mini program, app, or other frontend channel and define external message types and display structures inside their own adapter.

## Shared Layer And Channel Adapters

The shared connector does not define a new external network protocol. It only handles stable internal input and Agent output events.

| Layer | Responsibility |
| --- | --- |
| channel adapter | Recognizes its external `type`, converts inbound messages, builds outbound payloads, creates heartbeats, and provides the connection client. |
| `src/core/channelConnector.js` | Handles connection lifecycle, sessions, slash commands, attachments, Agent runner, and permission responses. |
| `src/agent/` / `src/runtime/` | Runs concrete Agents and produces internal events such as `assistant_chunk`, `tool_call`, and `turn_end`. |

External `type` values are owned by each channel. Before entering the shared layer, adapters must convert external messages into internal connector inputs and events. Third-party channels should add their own channel directory instead of modifying `src/channel/linco/`.

## Common Fields

Bridge events usually contain:

| Field | Description |
| --- | --- |
| `type` | Message type. |
| `channel` | Remote channel name. Defaults to `linco`. |
| `accountId` | Current account. |
| `agentId` | Current Agent identifier. |
| `sessionKey` | Bridge-layer session ID. |
| `messageId` | Original IM message ID. |
| `streamId` | Reply stream ID. Usually derived from `messageId` when missing. |
| `ts` | Millisecond timestamp. |

## Inbound Messages

Remote IM messages sent to the connector include:

| Type | Description |
| --- | --- |
| `ping` / `pong` | Heartbeat. |
| `inbound_message` | User message. |
| `danger_confirm` | User confirmation for a dangerous operation. |
| `permission_response` | User confirmation for a tool permission request. |
| `stop_turn` | Stop the current turn. |

Common `inbound_message` fields:

```json
{
  "type": "inbound_message",
  "sessionKey": "s-1",
  "messageId": "m-1",
  "streamId": "linco-stream-m-1",
  "text": "user input",
  "files": [
    {
      "name": "report.pdf",
      "mimeType": "application/pdf",
      "base64": "..."
    }
  ],
  "agentId": "main",
  "accountId": "default"
}
```

Attachments also support legacy fields such as `mediaName`, `mediaType`, `mediaUrl`, and `mediaBase64`. The connector normalizes them into internal attachments.

## Outbound Messages

Main connector events sent back to remote IM:

| Type | Description |
| --- | --- |
| `turn_start` | Current user message processing has started. |
| `stream_chunk` | Assistant streaming delta. |
| `thinking` / `thinking_clear` | Reasoning, planning, or thought content. |
| `agent_task` | Agent task-level progress. |
| `agent_action` | Structured action, patch, or edit progress. |
| `tool_call` / `tool_result` | Tool call start and completion. |
| `permission_request` | Ask the user to confirm tool permission. |
| `danger_warning` | Ask the user to confirm a dangerous operation. |
| `outbound_message` | System message, error message, file delivery, or non-streaming reply. |
| `slash_command_result` | Structured result of a local slash command. |
| `agent_session` | Native Agent session established or resumed. |
| `context_compaction` | Context compaction progress. |
| `turn_end` | Current turn is complete. |

Remote IM should treat `turn_end` as the final signal for one user-message turn.

## Streaming Replies

`stream_chunk` uses `delta` for the current increment, `fullText` for the accumulated text, and `done` for stream completion. Optional `phase` distinguishes `progress` output from `final_answer`; `ephemeral: true` means the frontend may show the text temporarily and clear it when the final answer arrives; `replacePrevious: true` means the current final answer should replace previous temporary body text.

```json
{
  "type": "stream_chunk",
  "sessionKey": "s-1",
  "messageId": "m-1",
  "streamId": "linco-stream-m-1",
  "mode": "chunk",
  "delta": "hello",
  "fullText": "hello",
  "phase": "final_answer",
  "ephemeral": false,
  "replacePrevious": false,
  "done": false
}
```

When `done: true`, the event may include `references` for clickable generated-file links.

## Slash Command Results

`slash_command_result` is used for structured UI such as lists, history, model settings, and configuration results.

```json
{
  "type": "slash_command_result",
  "command": "history",
  "version": 1,
  "sessionKey": "s-1",
  "streamId": "linco-stream-m-1",
  "data": {
    "version": 2,
    "rounds": []
  }
}
```

Frontend implementations should dispatch rendering by `command`. Unknown commands can fall back to JSON or a text summary.

For `command: "history"`, `data.version: 2` provides a stable `roundId`, an
absolute `ordinal`, `user.messageId`, and `assistant.messageId` when a final
answer exists. `index` is only the display position inside the current recent
history window and must not be used as a persistence key. Codex history still
accepts only `phase: "final_answer"`; commentary progress messages are not
included in Assistant history.

`/history --thinking` or `/history-reload --thinking` adds a per-round
`thinking` field for model progress output. Without the flag, the history
payload keeps the original shape. Tool output is not included in `thinking`.

## Permissions And Dangerous Operations

Agent adapters may send `permission_request` or `danger_warning`. Remote IM should ask the user for explicit confirmation and send back:

```json
{
  "type": "permission_response",
  "sessionKey": "s-1",
  "requestId": "req-1",
  "approved": true
}
```

```json
{
  "type": "danger_confirm",
  "sessionKey": "s-1",
  "approved": false
}
```

## File Delivery

When an Agent creates a file, it should usually return a Markdown link with an absolute local path, for example `[filename.ext](absolute-local-path)`. The Agent prompt should only describe this output format and should not expose internal delivery implementation details.

The connector returns any ordinary local file readable by its Node.js process. Relative paths retain the current-session directory semantics, while absolute paths may point anywhere on the machine. `/get` does not block hidden, empty, large, executable, or script files; operating-system permissions and transport limits still apply.

## Internal Metadata

`_lincoMeta` is connector-internal routing metadata, not protocol body text. Agent adapters must filter `type: "meta"` and `_lincoMeta` when constructing prompts, and remote IM should not concatenate these fields into user `text`.
