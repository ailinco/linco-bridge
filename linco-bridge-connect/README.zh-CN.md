# Linco Bridge connector

[English](README.en-US.md) | [简体中文](README.zh-CN.md)

Linco Bridge connector 是运行在用户电脑上的本机 Agent 连接器，用于把 Linco IM 消息转发给本机 Agent CLI，并把回复、流式输出、工具调用、权限确认、附件和生成文件回传到 IM。

它不是鉴权服务，也不是托管式多租户服务。用户凭证保存在本机配置文件中，连接地址默认由程序内置；普通用户不需要在 README 或配置中手动填写服务端地址。

## 开源定位

很多 Agent 桥接项目会接入飞书、微信、钉钉等既有协作平台。这种方式接入成本低，但展示和交互形式受平台限制，工具进度、权限确认、生成文件、长会话和多 Agent 状态往往很难做出舒适体验。

Linco Bridge connector 会配套开源一个参考 platform 项目，对应插件里的 `linco-demo` 通道。它不是要求所有人都使用 Linco 官方 IM，而是给用户一个可先部署体验的参考实现：如果现有 IM 平台的交互不满足需求，可以基于自己的 H5、小程序、App 或其他前端形态实现新的 channel adapter，让消息协议、展示结构和交互体验按自己的产品需求演进。

## 功能

- 支持 Claude Code、Codex、Hermes、OpenClaw 等 Agent。
- 支持远端 IM 连接，也支持本地测试页调试。
- 支持文本、图片和常见文档附件上传。
- 支持 Agent 生成文件路径引用：Agent 返回带绝对本机路径的 Markdown 链接，远端 IM 可展示为可点击文件引用。
- 支持通过 `/get <路径>` 校验并按需取回远端 IM 收到的本机文件引用。
- 支持工具/命令权限确认和危险操作确认，默认 auto 审批模式，可在会话内切换 manual/auto/yolo。
- 支持会话历史查看、绑定、切换、删除和 Token 用量查看。
- 支持自定义 channel adapter；`linco` 是官方 Linco IM 通道，`linco-demo` 是开源参考 platform 对应的示例通道。

## 前置条件

- Node.js 20 或 22–26；推荐 Node.js 22 LTS。连接器依赖原生模块 `better-sqlite3`，因此 Node.js 21 不在当前支持范围内。
- 已安装需要使用的 Agent CLI，并完成对应登录或配置：
  - `claude`
  - `codex`
  - `hermes`
  - `openclaw`
- Windows 用户建议安装 Git for Windows。

只需要安装实际启用的 Agent。

升级 Node.js 主版本后，如遇 `better-sqlite3` native module 或 `NODE_MODULE_VERSION` 报错，请在连接器安装目录重新执行 `npm install` 或 `npm rebuild better-sqlite3`。

当前 Agent 适配验证版本：

| Agent | 已验证版本 | 适配说明 |
| --- | --- | --- |
| Claude Code | `2.1.198 (Claude Code)` | 使用 stream-json 输入/输出、stdio 权限确认和 `--append-system-prompt`；配置统一走 `agents.claude.*`，会话 ID 统一保存为 `agentSessionId`。 |
| Codex CLI | `codex-cli 0.142.5` | 默认使用 `codex app-server --listen stdio://`；工作区沙箱为 `workspace-write`，默认允许网络访问，可用 `LINCO_CODEX_NETWORK_ACCESS=0` 关闭。 |
| OpenClaw | `OpenClaw 2026.5.18 (50a2481)` | 支持 Gateway agent session、`openclaw agents list --json` / `openclaw gateway call --json agents.list`；Linco 会话内可用 `/agent` 查看/绑定后续 OpenClaw Agent。 |
| Hermes | `Hermes Agent v0.13.0 (2026.5.7)` | 支持 Hermes Gateway `/v1/runs` 和 `hermes profile list`；Linco 会话内可用 `/profile` 查看/绑定后续 Hermes Profile。 |

连接器会向 Agent 注入统一的 Linco Bridge connector 桥接身份说明：Agent 正在通过 Linco Bridge connector 连接 Linco IM，普通文本回复会自动发送给用户，不需要额外调用发送机制。Claude/Hermes 走系统级或 `instructions` 注入；Codex app-server 通过 `developerInstructions` 注入并与用户现有 Codex 指令合并，失败时回退到输入层；OpenClaw 保持现有协议字段结构并在输入层追加提示。

## 安装

源码运行：

```bash
npm install
npm start
```

作为 CLI 使用：

```bash
npm install -g linco-connect
```

本地源码也可以直接运行 CLI：

```bash
node bin/linco-connect.js --help
```

## 初始化

推荐使用 token 初始化：

```bash
linco-connect init --token "<appId>:<appSecret>" --agent claude
```

也可以分别传入：

```bash
linco-connect init --app-id "<appId>" --app-secret "<appSecret>" --agent codex
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--agent <类型>` | 启用指定 Agent，如 `claude`、`codex`、`hermes`、`openclaw` |
| `--account <名称>` | 指定账号名，默认 `default` |
| `--force` | 覆盖已有配置 |

如需启用多个 Agent，可多次执行 `init`，每次传入不同的 `--agent`。

删除某个账号配置：

```bash
linco-connect remove-account --agent claude --account default
```

`delete-account` 是 `remove-account` 的同义命令。若删除的是当前 Agent 的默认账号，连接器会自动切换到剩余账号；若该 Agent 已无账号，会移除该 Agent 的 channel 配置。

运行中的远端 IM 会话也可以用本地斜杠命令删除账号配置：

```text
/remove-account
/remove-account --agent claude --account default
```

`/delete-account` 是 `/remove-account` 的同义命令。无参数时会删除当前 IM 会话对应的账号。

## 启动和停止

前台启动：

```bash
linco-connect start
```

后台启动：

```bash
linco-connect start --daemon
```

停止后台服务：

```bash
linco-connect stop
```

手动重载运行中服务的配置：

```bash
linco-connect reload
```

检查本机环境：

```bash
linco-connect doctor
```

手机端远程升降级运行中的连接器：

```text
/update check
/update list
/update latest
/update 1.2.8
/update status
```

`/update latest` 或 `/update <版本>` 会安装 npm 上的对应版本。安装完成后，无论原来是前台还是后台启动，都会自动以后台服务方式重新启动；手机端等待重新上线即可继续使用。

### 本地模拟页

插件内置的本地模拟页是用于连接器开发、自测和协议调试的浏览器 IM 调试界面。它不是开源 `linco-demo` 通道，也不是生产 Web 服务，不应暴露到公网。

本地模拟页默认关闭。需要本地联调时显式开启：

```bash
linco-connect start --local-im
```

启动后终端会输出带访问 token 的本地测试页地址。首次打开请使用完整地址；访问成功后浏览器会保存本地访问 cookie，后续刷新或重新打开同源页面可以继续使用。不要把该地址或 token 发给不可信的人。

## 配置

配置默认保存在用户目录下的 `.linco/config.json`。初始化命令会自动写入凭证和本地测试 token，一般不需要手动编辑。

运行中的连接器会监听 `config.json` 变化，也可以用 `linco-connect reload` 手动触发。账号新增、删除、凭证更新、Agent 启停和远端 IM 连接参数会自动重载，并只重启受影响的远端 IM 连接。`host`、`port`、`lincoHome`、`sessionsDir` 和本地测试页开关等服务级配置仍需重启进程后生效。配置重载失败时会保留旧配置继续运行。

`linco` 和 `linco-demo` 是两个独立 channel key。官方 Linco IM 协议实现位于 `src/channel/linco/`，开源 H5 示例 adapter 位于 `src/channel/lincoDemo/`；当前 demo 采用 Linco 兼容协议，后续可以独立演进。第三方平台扩展应新增自己的 channel 目录并注册 adapter，而不是修改官方 Linco channel。

最小配置结构示例：

```json
{
  "defaultChannel": "linco",
  "channels": {
    "linco": {
      "agents": {
        "claude": {
          "defaultAccount": "default",
          "accounts": {
            "default": {
              "appId": "<appId>",
              "appSecret": "<appSecret>",
              "enabled": true
            }
          }
        }
      }
    }
  }
}
```

常用环境变量：

| 变量 | 说明 |
| --- | --- |
| `LINCO_TOKEN` | `<appId>:<appSecret>` 简写形式 |
| `LINCO_AGENT` | 当前默认 Agent 类型 |
| `LINCO_ACCOUNT` | 当前账号名 |
| `LINCO_HOME` | 运行数据目录 |
| `LINCO_LOCAL_AGENT` | 本地测试页默认 Agent |
| `LINCO_CLAUDE_ENABLED` | 是否启用 Claude |
| `LINCO_CODEX_ENABLED` | 是否启用 Codex |
| `LINCO_HERMES_ENABLED` | 是否启用 Hermes |
| `LINCO_OPENCLAW_ENABLED` | 是否启用 OpenClaw |
| `LINCO_<AGENT>_BIN` | 覆盖对应 Agent CLI 命令或路径 |
| `LINCO_<AGENT>_WS_URL` | 私有化部署时覆盖对应 Agent 的连接地址 |
| `LINCO_CLAUDE_INSTRUCTIONS` | 覆盖 Claude 适配器追加的默认回复风格指令 |
| `LINCO_CLAUDE_ADD_RUNTIME_DIR` | 设为 `0` 时不向 Claude CLI 传入会话运行目录 `--add-dir` |
| `LINCO_CODEX_NETWORK_ACCESS` | 设为 `0` 时关闭 Codex app-server 工作区沙箱的网络访问 |

## 附件和文件下发

默认支持常见图片、文本、表格、文档、PDF、压缩包等附件。高风险可执行文件和脚本扩展名默认会被拦截。

默认限制：

| 项目 | 限制 |
| --- | --- |
| 单次附件数量 | 50 |
| 单文件大小 | 50 MB |
| 单次附件总大小 | 250 MB |

Agent 需要把文件发给用户时，应将文件保存到当前工作目录或会话运行目录，并且必须在回复中返回 Markdown 文件引用，链接目标必须是绝对路径，例如 `[report.md](D:\path\report.md)`，不要只返回裸文件路径或相对路径。Agent 可见提示词只描述这个返回格式，不暴露 `/get` 命令或下发实现细节；远端 IM 点击引用后会发送 `/get <路径>`，连接器校验后返回文件 base64。

连接器会判断路径是绝对路径还是相对路径。相对路径只从当前工作目录、运行目录或附件目录解析；绝对路径还允许位于 `/project` 当前列出的任一项目中。读取前会按真实路径重新校验项目归属，拒绝通过软链接跳出允许目录，并继续执行普通文件、大小限制、隐藏路径和危险扩展名规则。校验通过后，远端 IM 会收到带 `mediaName`、`mediaType`、`mediaBase64`、`size` 和 `references` 的 `outbound_message`。

默认不允许 `/get` 读取隐藏文件或隐藏目录下的文件，例如 `.env`、`.git/config`、`.ssh/*`。如确有兼容需要，可显式设置 `ALLOW_HIDDEN_GET_FILES=1` 或配置 `allowHiddenGetFiles: true`。

## Linco 消息元数据

远端 IM 下发的 `inbound_message` 会被连接器转换成本地 Agent 输入。为了在回复、流式消息、权限确认和会话路由时能关联原始 IM 消息，连接器会保留一份内部元数据，例如：

```json
{
  "type": "meta",
  "agentId": "<agentId>",
  "_lincoMeta": {
    "accountId": "default",
    "messageId": "m-...",
    "agentId": "<agentId>"
  }
}
```

这段数据是桥接层内部使用的路由信息，不是用户正文，也不应该显示给 Agent 或回显给用户。各 Agent 适配器需要在把输入转成 prompt 时过滤 `type: "meta"` 块；如果在 Codex 对话正文里看到类似 `{"type":"meta",...}` 的 JSON，通常表示 Codex 适配器没有正确过滤内部元数据，或 IM 前端把元数据拼进了文本字段。排查时优先确认前端发送的用户正文只放在 `text` 字段，`agentId`、`messageId`、`accountId` 等只作为消息字段传递。

## 斜杠命令

更多开源协作和前端适配文档：

- [架构说明](docs/architecture.md)
- [协议说明](docs/protocol.md)
- [斜杠命令适配说明](docs/slash-commands.md)
- [安全说明](docs/security.md)
- [English documentation](README.en-US.md)

常用命令：

| 命令 | 说明 |
| --- | --- |
| `/help` | 按当前模式显示可用本地命令 |
| `/status` | 显示当前会话状态 |
| `/pwd` | 显示当前项目目录；仅 Claude/Codex |
| `/cd <路径>` | 将指定目录绑定为当前项目并开启新 Agent 会话；仅 Claude/Codex |
| `/project` | 从 Claude/Codex 本地记录中列出已知项目，远端 IM 可渲染按钮选择；仅 Claude/Codex |
| `/project --select <路径>` | 将指定目录绑定为当前项目并开启新 Agent 会话；仅 Claude/Codex |
| `/sessions [--project <路径>] [--project-id <项目ID>] [limit]` | 列出当前项目最近的本地 Agent 会话；Codex 项目 ID 用于合并显式归属会话与未改派的同目录会话；仅 Claude/Codex |
| `/chats [limit]` | 列出 Codex Desktop 侧边栏 Chats；仅 Codex |
| `/bind <Session ID>` | 将未绑定的 IM 会话绑定到当前项目内已有 Agent 会话；仅 Claude/Codex |
| `/bind --chat <Chat ID>` | 将未绑定的 IM 会话绑定到已有 Codex Desktop Chat；仅 Codex |
| `/history [limit]` | 显示当前已绑定 Agent session 最近聊天内容，默认 10 轮；仅 Claude/Codex |
| `/history --chat <Chat ID> [limit]` | 预览 Codex Desktop Chat 历史但不自动绑定；仅 Codex |
| `/history-reload [limit]` | 刷新本地 Agent 记忆后重新加载最近历史；当前回合忙碌时会静默结束 |
| `/agent` | 查看 OpenClaw Agent，并可用 `/agent --bind <id>` 给当前 IM 账号绑定后续新会话默认 Agent；当前会话 Agent 不可切换；仅 OpenClaw |
| `/profile` | 查看 Hermes Profile，并可用 `/profile --bind <name>` 给当前 IM 账号绑定后续新会话默认 Profile；当前会话 Profile 不可切换；仅 Hermes |
| `/stop` | 停止当前 Agent 进程，保留可恢复会话 ID |
| `/reload` | 刷新当前 Agent 记忆，下次消息重新加载本地历史，并尝试预启动进程 |
| `/pc` | 显示 PC 端打开当前 Agent 会话的命令；支持 Claude 和 Codex |
| `/base` | 显示运行目录和附件目录 |
| `/get <路径>` | 按需读取当前工作目录、`/project` 项目、运行目录或附件目录内的非隐藏文件，并返回给前端 |
| `/approve` | 显示当前审批模式 |
| `/approve manual` | 手动确认权限请求和危险操作 |
| `/approve auto` | 自动确认权限请求和危险操作，保留默认权限边界 |
| `/approve yolo` | 启用 Agent 原生跳过权限/沙箱模式 |
| `/model` | 显示当前模式可选模型列表 |
| `/model status` | 显示当前模型覆盖和默认模型 |
| `/model --list` | 展示 Agent 原生/Provider 支持的模型列表（若支持）；也可手动输入任意 Agent 支持的模型名 |
| `/model <序号>` / `/model switch <序号>` | 按 `/model` 列表序号切换模型 |
| `/model <名称>` | 切换当前 Agent 模型，不清除 Agent session；Claude 会重启 print 进程并用 `--resume` 接回同一会话 |
| `/model --clear` | 清除运行时模型覆盖（若当前 Agent 支持） |
| `/usage` | 显示 Token 用量统计；部分 Agent 可能暂不提供 |
| `/remove-account` | 删除当前 IM 会话对应的账号配置 |
| `/remove-account --agent <agent> --account <account>` | 删除指定 Agent 下的账号配置；可附加 `--channel <channel>` |
| `/delete-account` | `/remove-account` 的同义命令 |

前端展示命令时应按当前 `agentType` 过滤：Claude 展示 `/pwd`、`/cd`、`/project`、`/sessions`、`/bind`、`/history`、`/pc`；Codex 额外展示 `/chats`、`/bind --chat`、`/history --chat`；OpenClaw 展示 `/agent`；Hermes 展示 `/profile`；`/model`、`/compact`、`/remove-account` 等通用命令在各模式下都可展示。`/commands`、`/refresh` 已移除，不应再展示。除本地命令外，其他 `/xxx` 会透传给当前 Agent。部分 Agent 原生命令只适合交互式 CLI/TUI，在桥接模式下可能没有输出。

`/help`、`/project`、`/sessions`、`/chats`、`/history`、`/agent`、`/profile` 这类列表/历史命令会直接返回 `slash_command_result` 结构化事件，远端 IM 可按 `command` 和 `data` 渲染；命令回合仍以 `turn_end` 结束。

例如 `/help` 返回 `command: "help"`、`data.items[].command` 和 `data.items[].description`；`/history` 返回 `type: "slash_command_result"`、`command: "history"`、`data.rounds`；`/sessions` 返回 `command: "sessions"`、`data.items[].bindCommand`；`/chats` 返回 `command: "chats"`、`data.items[].historyCommand` 和 `data.items[].bindCommand`。

## 安全注意

- 不要公开配置文件、访问 token、`appSecret` 或带 token 的本地测试页地址。
- 本地测试页只用于开发和自测。
- `/approve auto` 会允许后续工具/命令权限请求和危险操作确认；如需人工确认，请在会话内执行 `/approve manual`。
- `/approve yolo` 会尝试使用 Agent 原生跳过权限/沙箱模式，仅应在可信环境中使用。
- 附件会保存到本机，请避免上传不应落盘的敏感文件。
- `/get` 默认拒绝隐藏文件和隐藏目录下的文件，避免误下发 `.env`、`.git/config`、`.ssh/*` 等敏感内容。

## 开发命令

```bash
npm install
npm start
node bin/linco-connect.js doctor
npm test
```
