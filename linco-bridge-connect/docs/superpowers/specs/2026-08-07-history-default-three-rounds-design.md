# 历史消息默认三轮设计

## 目标

将插件历史消息命令在未显式传入数量时的默认返回数量从 10 轮调整为 3 轮。

## 行为范围

- `/history` 默认返回最近 3 轮。
- `/history --chat <Chat ID>` 默认返回最近 3 轮。
- `/history --project <项目路径> --session <session-id>` 默认返回最近 3 轮。
- `/history-reload` 和 `/sync-history` 未传数量时沿用 `/history` 的 3 轮默认值。
- 显式数量参数保持有效，例如 `/history 10` 仍返回 10 轮。
- `MAX_HISTORY_ROUNDS_LIMIT` 及数量合法范围保持不变。
- 历史分页、游标、thinking、结构化返回和文件元数据行为保持不变。

## 实现方案

将 `src/command/history/constants.js` 中共享的 `DEFAULT_HISTORY_ROUNDS_LIMIT` 从 `10` 改为 `3`。所有历史参数解析入口继续引用同一常量，不增加入口级分支或新配置项。

同步更新 `/help` 描述、README 和中英文斜杠命令文档中的默认轮数说明。

## 测试

按照 TDD 流程先添加未传参数时默认值为 3 的解析测试，并确认旧实现返回 10 导致测试失败；再修改共享常量并验证测试通过。显式数量测试继续断言传入值不受默认值变化影响，最后运行完整 `npm test`。
