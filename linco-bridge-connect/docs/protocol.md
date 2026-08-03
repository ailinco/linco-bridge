# Linco Bridge connector 协议说明

本文描述 `linco-bridge-connect` 与远端 channel 之间的主要消息约定。公共连接入口在 `src/core/channelConnector.js`，channel 注册入口在 `src/core/channelRegistry.js`，官方 Linco IM 协议实现位于 `src/channel/linco/`，开源 H5 示例 channel 位于 `src/channel/lincoDemo/`。

`linco` 和 `linco-demo` 是两个独立 channel。当前 `linco-demo` 采用 Linco 兼容协议，后续可以在自己的 adapter 内独立演进，不应反向修改官方 `linco` adapter。

开源参考 platform 对应 `linco-demo`。它用于展示一套更适合 Agent 的 H5 交互形态，第三方也可以实现自己的 H5、小程序、App 或其他前端 channel，并在自己的 adapter 内定义外部消息类型和展示结构。

## 公共层与 Channel Adapter

公共连接器不定义新的外部网络协议。它只处理稳定的内部输入和 Agent 输出事件：

| 层级 | 职责 |
| --- | --- |
| channel adapter | 识别各自外部 `type`，转换入站消息，生成出站 payload，构造心跳和连接客户端。 |
| `src/core/channelConnector.js` | 处理连接生命周期、session、斜杠命令、附件、Agent runner 和权限回传。 |
| `src/agent/` / `src/runtime/` | 执行具体 Agent，并产生 `assistant_chunk`、`tool_call`、`turn_end` 等内部事件。 |

因此，外部 `type` 由各 channel 自己定义；进入公共层后必须转换为公共连接器已知的内部输入和事件。第三方 channel 应新增自己的 channel 目录，而不是修改 `src/channel/linco/`。

## 通用字段

桥接事件通常包含以下字段：

| 字段 | 说明 |
| --- | --- |
| `type` | 消息类型。 |
| `channel` | 远端 channel 名称，默认 `linco`。 |
| `accountId` | 当前账号。 |
| `agentId` | 当前 Agent 标识。 |
| `sessionKey` | 桥接层会话 ID。 |
| `messageId` | 原始 IM 消息 ID。 |
| `streamId` | 一次回复流的 ID。未提供时通常由 `messageId` 派生。 |
| `ts` | 毫秒时间戳。 |

## 入站消息

远端 IM 发给连接器的消息类型包括：

| 类型 | 说明 |
| --- | --- |
| `ping` / `pong` | 心跳。 |
| `inbound_message` | 用户消息。 |
| `danger_confirm` | 用户对危险操作的确认结果。 |
| `permission_response` | 用户对工具权限请求的确认结果。 |
| `stop_turn` | 停止当前回合。 |

`inbound_message` 常用字段：

```json
{
  "type": "inbound_message",
  "sessionKey": "s-1",
  "messageId": "m-1",
  "streamId": "linco-stream-m-1",
  "text": "用户输入",
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

附件也兼容旧字段 `mediaName`、`mediaType`、`mediaUrl`、`mediaBase64`。连接器会统一转换为内部 attachments。

## 出站消息

连接器返回给远端 IM 的主要事件包括：

| 类型 | 说明 |
| --- | --- |
| `turn_start` | 当前用户消息开始处理。 |
| `stream_chunk` | 助手回复流式增量。 |
| `thinking` / `thinking_clear` | 推理、规划或思考内容。 |
| `agent_task` | Agent 任务级进度。 |
| `agent_action` | Agent 行动、补丁、编辑等结构化进度。 |
| `tool_call` / `tool_result` | 工具调用开始和完成。 |
| `permission_request` | 请求用户确认工具权限。 |
| `danger_warning` | 请求用户确认危险操作。 |
| `outbound_message` | 普通系统消息、错误消息、文件下发或非流式回复。 |
| `slash_command_result` | 本地斜杠命令的结构化结果。 |
| `slash_command_result_chunk` | 超大历史结果的分片；远端 IM 重组后按 `slash_command_result` 处理。 |
| `agent_session` | Agent 原生会话已建立或恢复。 |
| `context_compaction` | 上下文整理进度。 |
| `turn_end` | 当前回合结束。 |

远端 IM 应以 `turn_end` 作为一次用户消息处理完成的最终信号。即使本地命令只返回结构化结果，也会以 `turn_end` 收尾。

## 流式回复

`stream_chunk` 使用 `delta` 表示本次增量，`fullText` 表示当前完整文本，`done` 表示该回复流是否结束。可选字段 `phase` 用于区分 `progress`（过程输出）和 `final_answer`（最终答案）；`ephemeral: true` 表示前端可临时展示并在最终答案到达时清理；`replacePrevious: true` 表示当前最终答案应替换此前临时正文。

```json
{
  "type": "stream_chunk",
  "sessionKey": "s-1",
  "messageId": "m-1",
  "streamId": "linco-stream-m-1",
  "mode": "chunk",
  "delta": "你好",
  "fullText": "你好",
  "phase": "final_answer",
  "ephemeral": false,
  "replacePrevious": false,
  "done": false
}
```

当 `done: true` 时，事件可能带有 `references`，用于展示 Agent 生成文件的可点击引用。

## 斜杠命令结果

`slash_command_result` 用于列表、历史、模型、设置等结构化 UI。

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

前端应按 `command` 分发渲染逻辑。无法识别的 `command` 可以回退为普通 JSON 或文本摘要。

`command: "history"` 的 `data.version: 2` 会为每轮提供稳定的
`roundId`、绝对 `ordinal`、`user.messageId`，以及存在最终回复时的
`assistant.messageId`。`index` 只是当前最近历史窗口中的展示序号，不能用作
持久化主键。Codex 历史继续只收录 `phase: "final_answer"`，不会把
`commentary` 过程消息写入 Assistant 历史。

`/history --thinking` 或 `/history-reload --thinking` 会在每轮额外返回
`thinking` 字段，用于展示该回合模型过程输出；未带参数时历史 payload
保持原结构。工具输出不会进入 `thinking`。

history payload 不返回 `user.files`、`assistant.files` 或文件 Base64。回复正文中的
Markdown 文件路径会原样保留，远端 IM 只在用户点击该路径后发送 `/get <路径>`，
由连接器届时校验并读取文件。历史解析阶段只允许读取文件元数据，不应预读文件正文。

当 history 的 `data` 序列化后超过 256 KiB，连接器不会发送单个超大
`slash_command_result`，而是按顺序发送 `slash_command_result_chunk`。每个分片
保留相同的 `requestId`、`streamId`、`sessionKey` 和 `command: "history"`，并提供
`encoding: "base64"`、`chunkIndex`、`chunkCount`、`payloadBytes`、`chunkData`。
远端 IM 必须按 `chunkIndex` 重组全部 `chunkData`，Base64 解码并校验字节数，
再把 JSON 解析结果作为原 `data` 处理；在分片缺失或校验失败时应结束请求并
返回明确错误，不能继续等待到通用超时。小于等于阈值的 history 仍使用原
`slash_command_result`，兼容旧链路。

## 权限与危险操作

Agent 适配器可能发送 `permission_request` 或 `danger_warning`。远端 IM 应让用户明确确认，然后回传：

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

## 文件下发

Agent 生成文件时通常先在回复中返回文件路径引用。Agent 可见提示词只要求返回 `[filename.ext](absolute-local-path)` 这类 Markdown 绝对路径引用，不暴露 `/get` 命令或下发实现细节。历史同步只传递该路径文本，不携带文件正文。远端 IM 点击引用后可以发送 `/get <路径>`，连接器校验路径、文件类型和大小后才读取文件，并返回包含 `mediaBase64` 或 `files` 的 `outbound_message`。

连接器只应下发当前工作目录、`/project` 当前列出的项目、会话运行目录或附件目录内的普通非隐藏文件。相对路径保持当前会话目录语义，绝对路径按真实路径校验归属并拒绝软链接逃逸；默认拒绝 `.env`、`.git/config`、`.ssh/*` 等隐藏路径。

## 内部元数据

`_lincoMeta` 是连接器内部路由信息，不是协议正文。Agent 适配器在构造 prompt 时必须过滤 `type: "meta"` 和 `_lincoMeta`，远端 IM 也不应把这些字段拼入用户 `text`。
