<p align="center">
  <img src="docs/images/readme-logo-temp.png" alt="Linco Bridge logo" width="140" />
</p>

<h1 align="center">Linco Bridge</h1>

<p align="center">
  An open bridge layer that connects AI Agent tools running on a personal computer
  to web, H5, mini program, app, IM, and custom clients.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-open%20source%20alpha-0f766e" alt="status: open source alpha" />
  <img src="https://img.shields.io/badge/agents-Codex%20%7C%20Claude%20%7C%20Hermes%20%7C%20OpenClaw-2563eb" alt="supported agents" />
  <img src="https://img.shields.io/badge/channel-official%20%2B%20reference%20platform-f59e0b" alt="channel types" />
  <img src="https://img.shields.io/badge/license-MIT-111827" alt="license: MIT" />
</p>

**Status:** Open Source Alpha. Interfaces and compatibility may change with documented migration notes.

<p align="center">
  <a href="https://testflight.apple.com/join/Ahm1encB">iOS App</a>
  ·
  <a href="https://www.lincotalk.com/download/apk/linco.apk">Android App</a>
  ·
  <a href="https://bridge-demo.lincotalk.com">Hosted Demo</a>
  ·
  <a href="https://www.bilibili.com/video/BV18Fgf6CEpC/">Watch Demo</a>
  ·
  <a href="docs/quick-start.md">Quick Start</a>
  ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

![Linco Bridge hero preview](docs/images/demo/linco-bridge-hero.png)

## ✨ Highlights

| Local-first | Agent-oriented interaction | Open extension surface |
| --- | --- | --- |
| Keep Agent CLIs running on the user's computer while accessing sessions, attachments, and generated files from remote clients. | Present streaming output, permissions, tools, files, and long-running sessions in a dedicated client instead of a generic message relay. | Reuse the connector, protocol helpers, SDKs, and channel adapters to build a custom H5, mini program, app, web, or IM experience. |

## 🧭 Overview

Linco Bridge connects local Agent CLIs to remote clients without moving Agent execution away from the user's computer.

```text
Local Agent CLI
    ↕ local process, gateway, or session files
linco-connect on the user's computer
    ↕ authenticated WebSocket bridge
Official Linco channel, open reference platform, or custom backend
    ↕
Linco App, Reference Web, or custom client
```

| Repository area | Purpose |
| --- | --- |
| `linco-bridge-connect` | Local connector for Agent CLIs, sessions, permissions, attachments, and generated files. |
| `linco-bridge-platform` | NestJS + UniApp reference implementation for the open `linco-demo` channel. |
| `docs` | Setup, architecture, protocol, security, compatibility, and extension guides. |

The repository does not include the complete Linco App or the official hosted cloud-service implementation.

## 🚀 Choose a Path

| Path | Best for | Requirement |
| --- | --- | --- |
| Linco App | Users who want the official product experience | Install the app and run the page-generated connector commands. |
| Open reference platform | Local validation, self-hosting evaluation, and secondary development | Run `linco-bridge-platform/server` and `linco-bridge-platform/web`. |
| Hosted demo | Quick public evaluation without deploying the platform | Open the hosted H5 or mini program and run the generated connector commands locally. |

### 1. Linco App

Download Linco App:

- [iOS TestFlight](https://testflight.apple.com/join/Ahm1encB)
- [Android APK](https://www.lincotalk.com/download/apk/linco.apk)

Open **Bridge**, choose an Agent import path, and run the generated commands on the computer where the Agent CLI is installed. A typical command shape is:

```bash
npm install -g linco-connect
linco-connect init --token "<app-id>:<app-secret>" --agent codex
linco-connect start --daemon
```

Return to the app, confirm the connector is online, and send a test message.

### 2. Open Reference Platform

Start the backend:

```bash
cd linco-bridge-platform/server
npm install
npm run start:dev
```

Start the H5 frontend in another terminal:

```bash
cd linco-bridge-platform/web
npm install
npm run dev:h5
```

Open the printed H5 URL, then:

1. Open **Bridge** and select **Import from Codex**.
2. Copy the generated `setupCommands` and run them locally.
3. Return to the page and refresh the connection status.
4. Enter Codex, select a project or session from the folder menu, and send a test message.

The generated commands are the source of truth. A local command usually has this shape:

```bash
linco-connect init \
  --token "<app-id>:<app-secret>" \
  --agent codex \
  --channel linco-demo \
  --account "<account-id>" \
  --allow-insecure-ws

linco-connect start --daemon
```

See [Quick Start](docs/quick-start.md) and the [Platform README](linco-bridge-platform/README.md) for the complete local flow.

### 3. Hosted Demo

- H5: [https://bridge-demo.lincotalk.com](https://bridge-demo.lincotalk.com)
- WeChat Mini Program: search `agent桥接器` or scan the QR code below.

<p align="center">
  <img src="docs/images/demo/mini-program-qr.png" alt="Linco Bridge WeChat Mini Program QR code" width="220" />
</p>

Open **Bridge**, import an Agent, run the generated `setupCommands` on your computer, confirm the connector is online, and enter the chat page.

The hosted demo uses signed anonymous visitor sessions. It does not provide a formal account, durable cross-device recovery, or production-grade multi-tenant guarantees. Do not enter sensitive or production data. Custom frontends must [self-host the platform](docs/deploy-demo.md) instead of calling the official demo API.

## 🤖 Compatibility

| Agent | Status | Verified version |
| --- | --- | --- |
| Codex CLI | Supported | `codex-cli 0.142.5` |
| Claude Code | Supported | `2.1.198 (Claude Code)` |
| Hermes | Supported | `Hermes Agent v0.13.0 (2026.5.7)` |
| OpenClaw | Supported | `OpenClaw 2026.5.18 (50a2481)` |

Use Node.js 20 or 22–26; Node.js 22 LTS is recommended. See [Supported Platforms](docs/supported-platforms.md) for the current compatibility boundary.

## 🧩 Extension Points

| Area | Location |
| --- | --- |
| Connector SDK | `linco-bridge-connect/src/package/connector` |
| Protocol helpers | `linco-bridge-connect/src/package/protocol` |
| Reference Web SDKs | `linco-bridge-platform/web/src/bridge/sdk` |
| Channel adapters | `linco-bridge-connect/src/channel` |

Third-party integrations should add a custom channel adapter rather than changing the official `linco` channel. See [Secondary Development Rules](docs/secondary-development.md).

## 🔐 Security

- Never commit or log tokens, App Secrets, private keys, user data, or authenticated URLs.
- Use `ws://` only for trusted local development. Public deployments should use HTTPS/WSS and define their own authentication, storage, audit, and retention policies.
- TLS/WSS does not by itself provide end-to-end encryption.
- File delivery must keep hidden and sensitive paths blocked.
- Read [Security and Privacy](docs/security-and-privacy.md) before connecting real data. Report vulnerabilities through [SECURITY.md](SECURITY.md).

## 📚 Documentation

| Goal | Documentation |
| --- | --- |
| Get started | [Quick Start](docs/quick-start.md), [Troubleshooting](docs/troubleshooting.md) |
| Understand the system | [How It Works](docs/how-it-works.md), [Protocol](docs/protocol.md), [CLI Reference](docs/cli.md) |
| Run or extend the platform | [Hosted Deployment](docs/deploy-demo.md), [Reference Web](docs/reference-web.md), [Secondary Development](docs/secondary-development.md) |
| Review scope and policy | [Supported Platforms](docs/supported-platforms.md), [Security and Privacy](docs/security-and-privacy.md), [Support](SUPPORT.md) |
| Work on a subproject | [Connector README](linco-bridge-connect/README.en-US.md), [Platform README](linco-bridge-platform/README.md) |

## 💬 Community

Join the WeChat technical group for integration questions, product feedback, and Agent workflow discussions:

<img src="docs/images/community-wechat-group.jpg" alt="Linco technical WeChat group" width="320" />

Follow **Linco Lab** for project updates and implementation notes:

- [Xiaohongshu](https://xhslink.com/m/7tdp7JOYViz)
- WeChat Official Account: search `Linco Lab`

<img src="docs/images/linco-lab-wechat-official-account.jpg" alt="Linco Lab WeChat Official Account QR code" width="200" />

WeChat QR codes may expire. See [Community](COMMUNITY.md) for the latest entries and support guidance.

## 🤝 Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing protocol, cross-module, or breaking changes.

## ⚖️ License

Linco Bridge is licensed under the [MIT License](LICENSE). The license applies to repository code and documentation; it does not grant separate rights to use Linco names, logos, or other brand assets beyond normal nominative reference.
