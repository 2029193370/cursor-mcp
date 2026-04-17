# Cursor MCP

一个面向 Cursor 的 **侧栏多路 MCP** 扩展：支持多项目/多工作区并行、多窗口各自绑定独立通道，消息可随附截图与文件，内置会话备忘。

- 包名：`cursor-mcp`
- 显示名：`Cursor MCP`
- License：MIT

---

## 功能概览

- 侧栏可管理多路会话（最多 **32** 路），每路对应 `cursor-mcp-N`
- 点击「开始配置」按当前侧栏会话列表一次性写入工作区 `.cursor/mcp.json`
- 每个 Cursor 对话窗口只绑定其中一个 `cursor-mcp-N`，互不干扰
- 支持发送文本 + 截图 + 文件
- 可选卡密/授权体系（默认留空，按需在设置里配置自己的密钥和核销地址）

---

## 快速开始（打包安装）

系统需已安装 [Node.js](https://nodejs.org/)。

在项目根目录依次执行：

```bash
npm install
npm run compile
npx vsce package --no-dependencies --allow-missing-repository
```

打包完成后会生成 `cursor-mcp-1.0.0.vsix`，拖入 Cursor 的扩展视图即可安装。

---

## 在 Cursor 中使用

1. 打开 Cursor，在活动栏点击 **Cursor MCP** 图标
2. 在侧栏选择或使用当前工作区
3. 点击 **开始配置**：扩展会写入 `.cursor/mcp.json` 与 `.cursor/rules/cursor-mcp.mdc`
4. 在 Cursor 对话窗口输入：`请使用 cursor-mcp-1 的 check_messages`
5. 返回侧栏发送消息；对话会自动拉取到 Cursor 中

---

## 可配置项（Settings → 搜索 "Cursor MCP"）

| 配置 | 说明 |
| --- | --- |
| `cursorMcp.licenseSecret` | 卡密 HMAC 签名密钥（发卡与验证须一致） |
| `cursorMcp.adminPassword` | 生成/清除卡密前需输入的管理员密码 |
| `cursorMcp.redeemApiBaseUrl` | 自建云端核销 API 根地址（`/api/redeem`、`/api/license/verify`） |
| `cursorMcp.payStoreUrl` | 侧栏「在线购买」跳转的支付页 URL |
| `cursorMcp.redeemTimeoutMs` | 云端核销超时（毫秒，3000–120000） |
| `cursorMcp.cloudLicenseOnly` | 为 true 时仅允许云端卡密，拒绝本地 `CMC1.` 卡密 |
| `cursorMcp.cloudLicenseVerifyIntervalMs` | 云端卡密吊销校验间隔（默认 15 分钟） |

> 项目默认不携带任何发卡服务器地址/默认密钥。若你要启用付费，请自行部署后端并在设置里填入。

---

## 目录结构

```
cursor-mcp/
├── src/
│   ├── extension.js    侧栏 UI 与命令注册
│   └── license.js      卡密/试用/云端核销
├── mcp-server/
│   ├── index.mjs       MCP 进程：check_messages / send_message / ask_question
│   └── package.json
├── resources/
│   └── icon.svg        扩展图标
├── package.json        扩展清单
└── LICENSE.txt
```

---

## 贡献

欢迎 Issue / PR。项目仓库：<https://github.com/2029193370/cursor-mcp>
