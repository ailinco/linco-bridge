# 斜杠命令适配说明

斜杠命令是在远端 IM 会话中由 Linco Bridge connector 本地处理的命令。`src/command/index.js` 负责分发，部分复杂命令拆在 `src/command/*.js` 中。

除本文列出的本地命令外，其他 `/xxx` 默认透传给当前 Agent。部分 Agent 原生命令只适合交互式 CLI/TUI，在桥接模式下可能没有输出。

## 通用命令

| 命令 | 说明 |
| --- | --- |
| `/help` | 按当前 Agent 类型显示可用本地命令。 |
| `/status` | 显示当前会话、Agent、模型、审批模式和队列状态。 |
| `/session` | 显示当前 Claude/Codex 原生 Agent session ID。 |
| `/stop` | 停止当前 Agent 进程，保留可恢复会话 ID。 |
| `/reload` | 刷新当前 Agent 记忆，下次消息重新加载本地历史，并尝试预启动进程。 |
| `/update` / `/upgrade` | 查看、升级或降级 linco-connect CLI。 |
| `/remove-account` / `/delete-account` | 删除当前或指定 Agent 下的账号配置。 |
| `/accounts --channel <channel>` | 列出指定 channel 下已配置的账号 ID。 |
| `/base` | 显示 Linco 运行目录、会话运行目录和附件目录。 |
| `/get <路径>` | 读取连接器 Node.js 进程有权访问的任意本机普通文件并返回给远端 IM；相对路径仍以当前会话目录为准。 |
| `/approve` | 显示当前审批模式。 |
| `/approve manual` | 后续权限请求和危险操作由用户手动确认。 |
| `/approve auto` | 自动确认权限请求和危险操作，保留默认权限边界。 |
| `/approve yolo` | 尝试使用 Agent 原生跳过权限/沙箱模式。 |
| `/model` | 显示或切换当前 Agent 模型。 |
| `/reasoning` | 显示或切换 Claude/Codex reasoning/effort。 |
| `/settings` | 展示 Claude/Codex 模型与 reasoning 设置。 |
| `/settings apply --model <id> --reasoning <effort>` | 一次性应用 Claude/Codex 模型和 reasoning 设置。 |
| `/usage` | 显示 Token 用量统计；部分 Agent 可能暂不提供。 |
| `/compact` / `/compress` | 触发当前 Agent 原生上下文整理，若该 Agent 支持。 |

## Claude 和 Codex 命令

| 命令 | 说明 |
| --- | --- |
| `/pwd` | 显示当前项目目录。 |
| `/cd <路径>` | 将指定目录绑定为当前项目并开启新 Agent 会话。 |
| `/project` | 从本地记录中列出已知项目，远端 IM 可渲染按钮选择。 |
| `/project --select <路径>` | 选择项目并开启新 Agent 会话。 |
| `/sessions [--project <路径>] [--project-id <项目ID>] [limit]` | 列出当前项目最近的本地 Agent sessions；Codex 项目 ID 用于合并显式归属会话与未改派的同目录会话，并排除已归到其他项目的会话。 |
| `/bind <Session ID>` | 将未绑定的 IM 会话绑定到当前项目内已有 Agent session。 |
| `/history [limit]` | 显示当前已绑定 Agent session 的最近聊天内容，默认 10 轮。 |
| `/history-reload [limit]` / `/sync-history [limit]` | 先刷新本地 Agent 记忆，再重新加载历史。 |
| `/pc` | 显示 PC 端打开当前 Agent 会话的命令。 |

Codex 额外支持：

| 命令 | 说明 |
| --- | --- |
| `/chats [limit]` | 列出 Codex Desktop 侧边栏 Chats。 |
| `/bind --chat <Chat ID>` | 绑定到已有 Codex Desktop Chat。 |
| `/history --chat <Chat ID> [limit]` | 预览指定 Codex Desktop Chat 历史，不自动绑定。 |

## Hermes 命令

| 命令 | 说明 |
| --- | --- |
| `/profile` | 查看 Hermes Profile 列表和当前绑定。 |
| `/profile --bind <name>` | 给当前 IM 账号绑定后续新会话默认 Profile。当前会话的 Profile 不会被切换。 |

## OpenClaw 命令

| 命令 | 说明 |
| --- | --- |
| `/agent` | 查看 OpenClaw Agent 列表和当前绑定。 |
| `/agent --bind <id>` | 给当前 IM 账号绑定后续新会话默认 Agent。当前会话的 Agent 不会被切换。 |

## 已移除命令

| 命令 | 说明 |
| --- | --- |
| `/commands` | 已移除，请使用 `/help`。 |
| `/refresh` | 已移除，请使用 `/reload`。 |
| `/new`、`/list`、`/switch`、`/delete` | 已移除。当前 IM 会话固定绑定一个 Agent session；如需新会话，请在远端 IM 创建新的 session。 |

## 前端展示建议

前端展示命令时应按当前 `agentType` 过滤：

| Agent | 建议展示 |
| --- | --- |
| Claude | 通用命令，以及 `/pwd`、`/cd`、`/project`、`/sessions`、`/bind`、`/history`、`/pc`。 |
| Codex | Claude/Codex 命令，以及 `/chats`、`/bind --chat`、`/history --chat`。 |
| Hermes | 通用命令，以及 `/profile`。 |
| OpenClaw | 通用命令，以及 `/agent`。 |

## 结构化结果

以下命令会返回 `slash_command_result`，远端 IM 可按 `command` 和 `data` 渲染：

| command | data 概要 |
| --- | --- |
| `help` | `items[].command`、`items[].description`、`notes[]`。 |
| `accounts` | `channel`、`accountIds[]`。 |
| `project` | 项目候选和可点击 action。 |
| `sessions` | `items[].bindCommand`。 |
| `chats` | `items[].historyCommand`、`items[].bindCommand`。 |
| `history` | `rounds[]`。 |
| `agent` | OpenClaw Agent 候选。 |
| `profile` | Hermes Profile 候选。 |
| `model` | 当前模型、默认模型和候选项。 |
| `reasoning` | 当前 reasoning/effort 和候选项。 |
| `settings` | 模型与 reasoning 的组合设置。 |
| `update` | 当前版本、可升级版本或升级状态。 |

所有本地命令回合都应以 `turn_end` 结束。前端收到 `turn_end` 后应停止当前输入的 running 状态。
超大 `history` 结果会先以多个 `slash_command_result_chunk` 分片发送；远端必须在
`turn_end` 前完成 Base64 重组与字节校验，再按普通 `slash_command_result` 处理。
`history` 的 `rounds[]` 不包含用户或 Assistant 文件正文，也不返回文件 Base64；
正文中的 Markdown 文件路径保持可点击，用户点击后再通过 `/get <路径>` 按需取文件。
