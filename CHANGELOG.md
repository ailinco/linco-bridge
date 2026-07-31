# Changelog

Notable user-visible changes are recorded here.

## [Unreleased]

## [0.1.1] - 2026-07-31

### Added

- Added Agent account, workspace, project, and session discovery flows for the reference platform.
- Added stable history cursors, round identities, and optional thinking-history support for connector sessions.

### Changed

- Simplified the bilingual repository documentation and clarified the official app, local reference platform, and hosted demo paths.
- Aligned connector compatibility, anonymous visitor isolation, and deployment security guidance with the current implementation.
- Unified Web chat message reconciliation and thinking-trace rendering while throttling rich streaming updates.
- Improved image attachment delivery and the H5 and WeChat Mini Program chat experience.

### Fixed

- Preserved Web chat scroll position and completed thinking traces reliably across streaming lifecycle transitions.
- Hardened hosted Demo visitor sessions, CORS boundaries, and production fallback behavior.
- Filtered Codex subagent sessions and improved project and recent-history collection.

## [0.1.0] - 2026-07-09

### Added

- Initial open-source structure for `linco-bridge-connect`, `linco-bridge-platform`, and project-level documentation.
- Connector support for Codex CLI, Claude Code, Hermes, and OpenClaw.
- Reference Web and platform implementation for validating the `linco-demo` channel.
- Setup, protocol, troubleshooting, security, support, community, and secondary-development documentation.

### Known Limitations

- Open Source Alpha; interfaces and compatibility may change with migration notes.
- The reference platform and hosted demo are intended for evaluation and integration validation, not as a production SaaS release.

---

# 更新日志

本文件记录用户可感知的重要变化。

## [未发布]

## [0.1.1] - 2026-07-31

### 新增

- 为参考平台新增 Agent 账号、工作区、项目和会话发现流程。
- 为连接器会话新增稳定的历史游标、轮次标识及可选的思考历史支持。

### 变更

- 精简仓库中英文文档，明确官方 App、本地参考平台和在线 Demo 三种路径。
- 将连接器兼容性、匿名访客隔离和部署安全说明与当前实现对齐。
- 统一 Web 聊天消息对账与思考轨迹渲染，并对富文本流式更新进行节流。
- 改进图片附件传递以及 H5、微信小程序聊天体验。

### 修复

- 在流式生命周期切换期间可靠地保持 Web 聊天滚动位置并完成思考轨迹。
- 加固在线 Demo 的访客会话、CORS 边界和生产环境降级行为。
- 过滤 Codex 子 Agent 会话，并改进项目与最近历史记录收集。

## [0.1.0] - 2026-07-09

### 新增

- 初始开源仓库结构，包含 `linco-bridge-connect`、`linco-bridge-platform` 和项目级文档。
- 连接器支持 Codex CLI、Claude Code、Hermes 和 OpenClaw。
- 提供用于验证 `linco-demo` 通道的 Reference Web 和参考平台实现。
- 提供安装、协议、排障、安全、支持、社区和二次开发文档。

### 已知限制

- 当前为 Open Source Alpha；接口和兼容性可能随迁移说明调整。
- 参考平台和在线 Demo 用于体验与集成验证，不等同于生产 SaaS。
