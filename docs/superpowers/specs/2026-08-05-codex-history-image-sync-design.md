# Codex 历史图片同步设计

## 目标

让用户在电脑端 Codex 发送图片并提问后，App 同步该会话历史时能够展示图片，同时保持现有文本历史、实时聊天、文件预览和旧版本客户端行为不变。

## 当前问题

Codex 会话 JSONL 同时保存两类图片信息：

- `response_item.payload.content` 中的 `input_image`，通常是数 MB 的 `data:` URI。
- 紧随其后的 `event_msg.payload.message` 中的本机临时文件路径。

连接器已经能从第二种记录中解析出 `userFiles`，但 `buildHistoryPayload()` 会删除 `user.files` 和 `assistant.files`。服务端随后只透传历史文本，App 的历史导入器也只保存 `TextPart`。最终消息只剩图片名称，没有 URL 或二进制内容，因此无法渲染。

## 方案选择

采用“结构化文件引用 + 按需取回”方案：

- 历史响应只携带文件元数据和本机文件引用，不携带 Base64。
- App 使用现有 `/im/bridge-files/preview` 接口请求文件。
- 服务端通过现有桥接 `/get` 流程向电脑端取回文件并上传 OSS。
- App 获得远端 URL 后将图片保存为 `ImagePart`。

不采用以下方案：

- 历史响应内嵌 Base64：单张图片可能达到数 MB，会显著放大历史包并触发分片或 32 MB 上限。
- 将路径拼入展示文本：依赖正则和 Markdown 约定，容易泄漏实现细节并导致去重、预览和多附件场景不稳定。

## 协议

历史轮次中的 `user` 和 `assistant` 可以增加可选 `files` 字段：

```json
{
  "user": {
    "messageId": "bridge_history_v2:...:user",
    "text": "这是什么图片？",
    "files": [
      {
        "name": "codex-clipboard-example.png",
        "mimeType": "image/png",
        "size": 2848555,
        "localPath": "D:\\path\\codex-clipboard-example.png"
      }
    ]
  }
}
```

约束：

- `files` 可选；缺失时行为与当前版本完全一致。
- 每个文件仅允许 `name`、`mimeType`、`size`、`localPath`。
- 禁止 `base64`、`mediaBase64`、`data:` URI 和远端未校验 URL 进入历史响应。
- 每条消息最多 10 个文件；`name`、`mimeType` 和 `localPath` 设置长度上限。
- 只有普通本机绝对路径可以作为 `localPath`；真正读取文件时继续由连接器现有 `/get` 安全校验负责。
- 现有 history version、文本字段、消息 ID 和分页语义保持不变；旧消费者会自然忽略新增的可选字段。

## 数据流

1. 连接器从 Codex JSONL 的用户消息中解析文本和本机图片元数据。
2. `buildHistoryPayload()` 将安全文件引用写入对应轮次的 `user.files`。
3. 服务端验证并保留允许的字段，不读取或持久化电脑端绝对路径为公共 URL。
4. App 将图片引用转换为现有 `【图片：name】(url:localPath)` 内部附件 marker，并在历史导入完成后为每张待解析图片调用 `/im/bridge-files/preview`。
5. 服务端向当前绑定的电脑端发送 `/get <localPath>`。
6. 连接器执行现有路径归属、文件类型和大小校验后返回文件内容。
7. 服务端使用现有文件服务上传 OSS，返回可访问 URL。
8. App 用返回的远端 URL 替换内部 marker 中的本机路径；现有用户消息组件直接将 marker 渲染为图片。后续同步按稳定消息 ID 合并，不重复创建图片。

## 兼容与降级

- 新插件 + 新 App：显示历史图片。
- 新插件 + 旧 App：旧 App 忽略 `files`，继续显示文本。
- 旧插件 + 新 App：没有 `files`，继续显示文本。
- 电脑离线、文件已删除、文件过大或上传失败：正文照常导入，附件 marker 保留并显示不可用占位；再次同步时重新解析。
- 已经解析为 OSS URL 的图片在后续历史同步中保留，不回退为本机引用。
- 图片解析不得阻塞整页历史导入；单个附件失败不得影响其他附件。

## 安全与性能

- 历史 payload 不传图片正文，维持当前包体控制目标。
- 服务端对文件数组、字段类型、字符串长度、文件数量和禁止字段做白名单校验。
- App 限制图片解析并发，避免一次同步触发大量 `/get` 请求。
- `/get` 继续限制允许目录、软链接逃逸、隐藏文件、扩展名和文件大小。
- 日志只记录数量、类型和结果，不记录本机完整路径、图片内容或 Base64。

## 修改范围

### 连接器

- `src/command/history/payloads.js`：输出经过白名单处理的文件引用。
- `src/command/history/readers.js`：保持只读取元数据，并确保 Codex 用户图片路径进入 `userFiles`。
- `test/command/history-payload-files.test.js`：覆盖无 Base64、包含路径元数据、多图片和旧文本行为。
- `docs/protocol.md`：更新 history 文件引用协议。

### 服务端

- `src/modules/im/utils/bridge-history-identity.ts`：规范化时保留合法 `files`。
- `src/modules/im/im.gateway.ts`：在接受历史 payload 前验证文件引用边界。
- 对应单元测试覆盖合法引用、禁止 Base64、超量文件和旧 payload。

### App

- `lib/chat/services/bridge_history_importer.dart`：读取历史 `files`，转换为现有附件 marker 并合并到稳定消息。
- `lib/chat/services/agent_link_service.dart`：让现有桥接图片修复流程同时处理用户附件 marker，复用桥接预览接口并持久化远端 URL。
- 对应测试覆盖电脑端首发图片、多图片、离线降级、重复同步和旧插件兼容。

管理后台不参与用户历史同步链路，不修改。

## 验收标准

- 电脑端 Codex 发送一张或多张图片并提问后，App 同步历史能展示这些图片和文本。
- 历史响应中不存在 Base64 或 `data:` URI。
- 图片无法取回时，历史文本仍能正常进入会话。
- 重复同步不会产生重复用户消息或重复图片。
- 旧插件、旧 App 和纯文本历史测试保持通过。
- 插件、服务端和 App 的相关单元测试及构建检查全部通过。
