<p align="center">
  <img src="docs/images/readme-logo-temp.png" alt="Linco Bridge logo" width="140" />
</p>

<h1 align="center">Linco Bridge</h1>

<p align="center">
  一个开放的桥接层，用来把运行在个人电脑上的 AI Agent 工具连接到
  Web、H5、小程序、App、IM 或自定义客户端。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-open%20source%20alpha-0f766e" alt="status: open source alpha" />
  <img src="https://img.shields.io/badge/agents-Codex%20%7C%20Claude%20%7C%20Hermes%20%7C%20OpenClaw-2563eb" alt="supported agents" />
  <img src="https://img.shields.io/badge/channel-official%20%2B%20reference%20platform-f59e0b" alt="channel types" />
  <img src="https://img.shields.io/badge/license-MIT-111827" alt="license: MIT" />
</p>

**项目状态：** Open Source Alpha。接口和兼容性可能变化，破坏性变更将配套迁移说明。

<p align="center">
  <a href="https://testflight.apple.com/join/Ahm1encB">iOS 下载</a>
  ·
  <a href="https://www.lincotalk.com/download/apk/linco.apk">Android 下载</a>
  ·
  <a href="https://bridge-demo.lincotalk.com">在线 Demo</a>
  ·
  <a href="https://www.bilibili.com/video/BV18Fgf6CEpC/">观看演示</a>
  ·
  <a href="docs/zh-CN/quick-start.md">快速开始</a>
  ·
  <a href="README.md">English</a>
</p>

![Linco Bridge 主视觉预览](docs/images/demo/linco-bridge-hero.png)

## ✨ 亮点

| 本地优先 | 面向 Agent 的交互 | 开放扩展 |
| --- | --- | --- |
| Agent CLI 继续运行在用户电脑上，同时可在远端客户端访问会话、附件和生成文件。 | 在专用客户端中呈现流式输出、权限确认、工具调用、文件和长会话，而不只是转发消息。 | 复用连接器、协议工具、SDK 和 channel adapter，构建自定义 H5、小程序、App、Web 或 IM 体验。 |

## 🧭 项目概览

Linco Bridge 连接本地 Agent CLI 与远端客户端，Agent 仍在用户自己的电脑上执行。

```text
本地 Agent CLI
    ↕ 本地进程、Gateway 或会话文件
用户电脑上的 linco-connect
    ↕ 已鉴权 WebSocket 桥接
官方 Linco 通道、开源参考平台或自定义后端
    ↕
Linco App、Reference Web 或自定义客户端
```

| 仓库区域 | 作用 |
| --- | --- |
| `linco-bridge-connect` | 本地 Agent CLI 连接器，处理会话、权限、附件和生成文件。 |
| `linco-bridge-platform` | 基于 NestJS + UniApp 的开源 `linco-demo` 通道参考实现。 |
| `docs` | 安装、架构、协议、安全、兼容性和扩展文档。 |

仓库不包含完整 Linco App，也不包含官方托管云服务实现。

## 🚀 选择体验路径

| 路径 | 适合场景 | 所需操作 |
| --- | --- | --- |
| Linco App | 直接体验官方产品链路 | 安装 App，执行页面生成的连接命令。 |
| 开源参考平台 | 本地验证、自部署评估和二次开发 | 启动 `linco-bridge-platform/server` 和 `linco-bridge-platform/web`。 |
| 在线 Demo | 不部署平台，快速验证公网桥接 | 打开在线 H5 或小程序，在本机执行生成的连接命令。 |

### 1. Linco App

下载 Linco App：

- [iOS TestFlight](https://testflight.apple.com/join/Ahm1encB)
- [Android APK](https://www.lincotalk.com/download/apk/linco.apk)

在 App 中打开 **桥接**，选择 Agent 导入方式，然后在已安装 Agent CLI 的电脑上执行页面生成的命令。命令形态通常如下：

```bash
npm install -g linco-connect
linco-connect init --token "<app-id>:<app-secret>" --agent codex
linco-connect start --daemon
```

返回 App，确认连接器在线后发送测试消息。

### 2. 开源参考平台

启动后端：

```bash
cd linco-bridge-platform/server
npm install
npm run start:dev
```

在另一个终端启动 H5：

```bash
cd linco-bridge-platform/web
npm install
npm run dev:h5
```

打开命令输出的 H5 地址，然后：

1. 打开 **桥接**，选择 **从 Codex 导入**。
2. 复制页面生成的 `setupCommands` 并在本机执行。
3. 返回页面刷新连接状态。
4. 进入 Codex，通过文件夹菜单选择项目或会话，然后发送测试消息。

页面生成的命令为准。本地命令通常具有以下形态：

```bash
linco-connect init \
  --token "<app-id>:<app-secret>" \
  --agent codex \
  --channel linco-demo \
  --account "<account-id>" \
  --allow-insecure-ws

linco-connect start --daemon
```

完整本地流程见 [快速开始](docs/zh-CN/quick-start.md) 和 [参考平台 README](linco-bridge-platform/README.zh-CN.md)。

### 3. 在线 Demo

- H5：[https://bridge-demo.lincotalk.com](https://bridge-demo.lincotalk.com)
- 微信小程序：搜索 `agent桥接器` 或扫描下方体验码。

<p align="center">
  <img src="docs/images/demo/mini-program-qr.png" alt="Linco Bridge 微信小程序体验码" width="220" />
</p>

打开 **桥接**，导入 Agent，在电脑上执行页面生成的 `setupCommands`，确认连接器在线后进入聊天页。

在线 Demo 使用签名匿名访客 Session，不提供正式账号、持久跨设备恢复或生产级多租户保证。请勿输入敏感或正式业务数据。自定义前端请[自行部署参考平台](docs/zh-CN/deploy-demo.md)，不要调用官方 Demo API。

## 🤖 兼容性

| Agent | 状态 | 已验证版本 |
| --- | --- | --- |
| Codex CLI | 支持 | `codex-cli 0.142.5` |
| Claude Code | 支持 | `2.1.198 (Claude Code)` |
| Hermes | 支持 | `Hermes Agent v0.13.0 (2026.5.7)` |
| OpenClaw | 支持 | `OpenClaw 2026.5.18 (50a2481)` |

使用 Node.js 20 或 22–26，推荐 Node.js 22 LTS。当前兼容边界见 [支持平台](docs/zh-CN/supported-platforms.md)。

## 🧩 扩展点

| 区域 | 位置 |
| --- | --- |
| Connector SDK | `linco-bridge-connect/src/package/connector` |
| 协议工具 | `linco-bridge-connect/src/package/protocol` |
| Reference Web SDK | `linco-bridge-platform/web/src/bridge/sdk` |
| Channel adapter | `linco-bridge-connect/src/channel` |

第三方集成应新增自定义 channel adapter，不要修改官方 `linco` 通道。详见 [二次开发规则](docs/zh-CN/secondary-development.md)。

## 🔐 安全

- 不要提交或记录 Token、App Secret、私钥、用户数据或带鉴权信息的 URL。
- `ws://` 仅用于可信本地开发。公网部署应使用 HTTPS/WSS，并定义自己的鉴权、存储、审计和保留策略。
- TLS/WSS 不等于端到端加密。
- 文件下发必须继续拦截隐藏路径和敏感文件。
- 连接真实数据前请阅读 [安全与隐私](docs/zh-CN/security-and-privacy.md)；漏洞请按 [SECURITY.md](SECURITY.md) 私密报告。

## 📚 文档

| 目标 | 文档 |
| --- | --- |
| 快速上手 | [快速开始](docs/zh-CN/quick-start.md)、[排障](docs/zh-CN/troubleshooting.md) |
| 理解系统 | [工作原理](docs/zh-CN/how-it-works.md)、[公开协议](docs/zh-CN/protocol.md)、[CLI 命令参考](docs/zh-CN/cli.md) |
| 部署或扩展 | [在线 Demo 部署](docs/zh-CN/deploy-demo.md)、[Reference Web](docs/zh-CN/reference-web.md)、[二次开发](docs/zh-CN/secondary-development.md) |
| 查看边界与政策 | [支持平台](docs/zh-CN/supported-platforms.md)、[安全与隐私](docs/zh-CN/security-and-privacy.md)、[支持边界](SUPPORT.md) |
| 开发子项目 | [连接器 README](linco-bridge-connect/README.zh-CN.md)、[参考平台 README](linco-bridge-platform/README.zh-CN.md) |

## 💬 社区与动态

微信技术交流群用于讨论接入问题、产品反馈和 Agent 工作流：

<img src="docs/images/community-wechat-group.jpg" alt="Linco technical WeChat group" width="320" />

关注 **Linco Lab** 获取项目更新和实践内容：

- [小红书](https://xhslink.com/m/7tdp7JOYViz)
- 微信公众号：搜索 `Linco Lab`

<img src="docs/images/linco-lab-wechat-official-account.jpg" alt="Linco Lab 微信公众号二维码" width="200" />

微信二维码可能过期。最新入口和支持说明见 [社区页](COMMUNITY.zh-CN.md)。

## 🤝 参与贡献

欢迎提交 Issue 和 Pull Request。协议、跨模块或破坏性变更请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## ⚖️ 许可证

Linco Bridge 基于 [MIT License](LICENSE) 开源。许可证适用于仓库代码和文档，不单独授予超出正常指代范围的 Linco 名称、Logo 或其他品牌资产使用权。
