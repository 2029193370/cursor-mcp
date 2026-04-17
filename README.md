<div align="center">

# Cursor MCP

**Multi-channel MCP sidebar for Cursor** — concurrent workspaces, per-window binding, images & files, session memos.

**Cursor 侧栏多路 MCP** — 多项目/多工作区并行、多窗口独立通道、消息随附截图与文件。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE.txt)
[![Release](https://img.shields.io/github/v/release/2029193370/cursor-mcp?display_name=tag&sort=semver)](https://github.com/2029193370/cursor-mcp/releases)
[![Stars](https://img.shields.io/github/stars/2029193370/cursor-mcp?style=social)](https://github.com/2029193370/cursor-mcp/stargazers)
[![Issues](https://img.shields.io/github/issues/2029193370/cursor-mcp)](https://github.com/2029193370/cursor-mcp/issues)

[English](#english) · [中文](#中文)

</div>

---

<a id="english"></a>

## ✨ Highlights

- 🎛 **Up to 32 parallel MCP channels** in one sidebar — `cursor-mcp-1` … `cursor-mcp-N`
- 🪟 **Per-window binding** — each Cursor chat window binds to exactly one channel, no cross-talk
- 🗂 **Workspace-aware** — one click writes `.cursor/mcp.json` + rule file for the current project
- 🖼 **Images & files** can be attached to every message
- 📝 **Session memos** per channel to remember what each one is for
- 🔑 **Optional licensing** — HMAC key (`CMC1.`) or your own cloud redeem API. Comes **empty by default**, so it’s fully free/open-source out of the box

---

## 🚀 Quick Start

Requires [Node.js](https://nodejs.org) ≥ 16.

**Option A — Download the prebuilt `.vsix`**

Head to [Releases](https://github.com/2029193370/cursor-mcp/releases) → download the latest `cursor-mcp-*.vsix` → drag it into Cursor’s Extensions panel.

**Option B — Build locally**

```bash
git clone https://github.com/2029193370/cursor-mcp.git
cd cursor-mcp
npm install
npm run compile
npx vsce package --no-dependencies --allow-missing-repository
```

Then install the generated `cursor-mcp-1.0.0.vsix` into Cursor.

---

## 📖 Usage

1. Click the **Cursor MCP** icon in Cursor’s activity bar.
2. Pick a workspace (or use the current one).
3. Click **Configure workspace** → the extension writes:
   - `.cursor/mcp.json` with `cursor-mcp-1 … cursor-mcp-N`
   - `.cursor/rules/cursor-mcp.mdc` — rule that keeps the `check_messages` loop alive
4. In a Cursor chat window, say: `请使用 cursor-mcp-1 的 check_messages`
5. Switch back to the sidebar and start chatting — messages are delivered to the bound window in real time.

---

## ⚙️ Settings

Open Cursor Settings and search **"Cursor MCP"**:

| Key | Purpose |
| --- | --- |
| `cursorMcp.licenseSecret` | HMAC secret (must match the one used to generate keys) |
| `cursorMcp.adminPassword` | Admin password gate for key-gen / clear-license |
| `cursorMcp.redeemApiBaseUrl` | Your own cloud redeem API root (expects `/api/redeem`, `/api/license/verify`) |
| `cursorMcp.payStoreUrl` | URL opened when users click *"Buy online"* in the sidebar |
| `cursorMcp.redeemTimeoutMs` | Cloud redeem timeout (3000–120000 ms) |
| `cursorMcp.cloudLicenseOnly` | `true` = reject local `CMC1.` keys, force cloud redeem |
| `cursorMcp.cloudLicenseVerifyIntervalMs` | Interval for revocation check (default 15 min) |

> **No default secret or paid server is bundled.** Configure your own or leave empty to run fully free.

---

## 🏗 Architecture

```
cursor-mcp/
├── src/
│   ├── extension.js     Sidebar UI, webview, command wiring
│   └── license.js       HMAC + cloud redeem + trial logic
├── mcp-server/
│   ├── index.mjs        MCP process: check_messages / send_message / ask_question
│   └── package.json
├── resources/
│   └── icon.svg         Extension icon
└── package.json         Extension manifest
```

The sidebar and each `cursor-mcp-N` MCP process communicate through a file-based queue under `~/.cursor/cursor-mcp-messages/s/<id>/`, which keeps things stable even when Cursor restarts connections.

---

## 🤝 Contributing

Issues and PRs welcome — feel free to open a ticket describing bugs or feature ideas.

## 📄 License

[MIT](./LICENSE.txt) © 2026 litingfeng

---

<a id="中文"></a>

## ✨ 核心特性

- 🎛 **最多 32 路并行 MCP 通道**，侧栏统一管理 `cursor-mcp-1` … `cursor-mcp-N`
- 🪟 **每个 Cursor 窗口独立绑定**一路通道，互不串扰
- 🗂 **工作区感知** —— 一键写入当前项目的 `.cursor/mcp.json` 与规则文件
- 🖼 消息可随附 **图片 + 文件**
- 📝 每路会话独立 **备忘** ，记录这路用来做什么
- 🔑 **可选卡密体系** —— 支持本地 HMAC（`CMC1.`）或自建云端核销；默认全部留空，即开箱可用的免费版

## 🚀 快速开始

需要 [Node.js](https://nodejs.org) ≥ 16。

**方式 A — 下载现成的 `.vsix`**

前往 [Releases](https://github.com/2029193370/cursor-mcp/releases) → 下载最新 `cursor-mcp-*.vsix` → 拖入 Cursor 扩展面板。

**方式 B — 本地打包**

```bash
git clone https://github.com/2029193370/cursor-mcp.git
cd cursor-mcp
npm install
npm run compile
npx vsce package --no-dependencies --allow-missing-repository
```

## 📖 使用步骤

1. 点击 Cursor 活动栏中的 **Cursor MCP** 图标
2. 选择或使用当前工作区
3. 点击 **开始配置**，扩展会生成 `.cursor/mcp.json` 和 `.cursor/rules/cursor-mcp.mdc`
4. 在 Cursor 对话窗口说：`请使用 cursor-mcp-1 的 check_messages`
5. 回到侧栏发消息 —— 绑定窗口实时接收

## ⚙️ 配置项

在 Cursor 设置中搜索 **"Cursor MCP"**，主要配置见上方英文表格；**默认不携带任何发卡地址和密钥**，如果不启用付费体系留空即可。

## 📄 许可证

[MIT](./LICENSE.txt) © 2026 litingfeng
