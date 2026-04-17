# cursor-mcp fache-server

配合 Cursor MCP 插件「发车/上车」功能的**最小 HTTP 服务端**，用于在多台电脑间用短密钥 `sk-xxxxxxxxxxxxxxxxx`（20 字符）交换 Cursor 设备指纹。

- 纯 Node 标准库实现，**零依赖**
- 内存存储 + TTL 自动过期
- 默认**一次性领取**（pickup 成功即删除）
- 可选 `PUBLISH_TOKEN`，要求车头携带 Bearer token 才能发布

## 快速启动

```bash
cd fache-server
node server.mjs
```

默认监听 `0.0.0.0:8787`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `MAX_TTL_MS` | `86400000` (24h) | 单条车票最长 TTL |
| `ONE_SHOT` | `true` | 领取后是否立即删除；`false` 表示到期前可多次领取 |
| `MAX_ENTRIES` | `5000` | 内存中最多同时存在的车票数，达到上限拒绝新发布 |
| `PUBLISH_TOKEN` | 空 | 若设置，则 publish 需 `Authorization: Bearer <token>` |

## 接口

### `POST /api/fache/publish`

请求：
```json
{
  "fp": {
    "machineId": "...",
    "devDeviceId": "...",
    "telemetryMachineId": "...",
    "macMachineId": "...",
    "sqmId": "...",
    "machineGuid": "..."
  },
  "host": "DESKTOP-XXXX",
  "ip": ["以太网:192.168.1.100"],
  "ttlMs": 600000
}
```

响应：
```json
{ "ok": true, "key": "sk-xxxxxxxxxxxxxxxxx", "expiresAt": 1734567890000, "ttlMs": 600000 }
```

### `POST /api/fache/pickup`

请求：
```json
{ "key": "sk-xxxxxxxxxxxxxxxxx" }
```

响应：
```json
{
  "ok": true,
  "fp": { "...": "..." },
  "host": "DESKTOP-XXXX",
  "ip": ["..."],
  "ts": 1734567880000
}
```

错误响应统一为 `{ "ok": false, "message": "..." }`，HTTP 状态码：
- `400` 参数错误
- `401` token 不匹配
- `404` key 不存在或已领取
- `410` key 已过期
- `413` body 过大（单条上限 64KB）
- `503` 服务繁忙（超过 `MAX_ENTRIES`）

### `GET /health`

健康检查，返回 `{ ok: true, service: "cursor-mcp-fache", size: <N>, oneShot: <bool> }`。

## 客户端配置

在 Cursor 设置里填写：

```
cursorMcp.facheApiBaseUrl = http://你的机器IP:8787
cursorMcp.facheTicketTtlMs = 600000
```

> 留空 `facheApiBaseUrl` 时，插件会自动回退到 `cursorMcp.redeemApiBaseUrl`（卡密云端地址），方便同一台机器复用。

## 生产部署建议

- **反向代理 + HTTPS**：建议放在 Caddy / Nginx 后面暴露 443
- **进程守护**：`pm2 start server.mjs` 或 systemd
- **横向扩展**：内存存储不支持多实例共享；如需高可用，建议替换为 Redis/SQLite

## 许可

MIT
