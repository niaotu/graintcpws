# VLESS 代理 — 单出口 Final 版说明文档

> 文件：`gemini-code-final.js` ·   · Cloudflare Workers 运行时

## 一、项目概述

基于 Cloudflare Workers 的 VLESS 代理服务，通过 WebSocket 接收客户端连接，将流量转发至目标地址（直连或通过 ProxyIP 中转）。适用于将 Cloudflare CDN 节点作为代理入口的部署场景。

## 二、部署方式

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → 创建 Worker
2. 将 `gemini-code-final.js` 的内容粘贴到 Worker 编辑器中
3. 部署，记下 Worker 的访问地址（如 `https://xxx.workers.dev`）

## 三、URL 格式

```
https://<worker-domain>/<UUID>?ed=2560&mode=auto&proxyip=1.2.3.4:443
```

| 参数 | 说明 | 示例 |
|---|---|---|
| `<UUID>` | 路径中的认证 UUID，必须与代码中 `UUID` 常量一致 | `ef9d104e-ca0e-4202-ba4b-a0afb969c747` |
| `ed` | Early Data 长度（可选，需与客户端配置匹配） | `2560` |
| `mode` | 出口模式，见下方说明 | `auto` |
| `proxyip` | ProxyIP 中转节点地址 | `1.2.3.4:443` |

### 出口模式

| mode | 行为 |
|---|---|
| `auto` | 按 URL 参数出现顺序依次尝试（默认） |
| `direct` | 仅直连目标 |
| `proxy` | 直连优先，失败走 proxyip |

### URL 示例

```
# 直连
https://xxx.workers.dev/<UUID>

# ProxyIP 中转
https://xxx.workers.dev/<UUID>?mode=auto&proxyip=1.2.3.4:443

# 带 Early Data
https://xxx.workers.dev/<UUID>?ed=2560&mode=auto&direct
```

## 四、客户端配置

适用于 v2rayN / xray-core / sing-box 等支持 VLESS + WebSocket 的客户端。

### 通用参数

| 字段 | 值 |
|---|---|
| 协议 | VLESS |
| 地址 | Worker 域名（如 `xxx.workers.dev`） |
| 端口 | 443 |
| UUID | 与代码中 `UUID` 常量一致 |
| 传输协议 | WebSocket (ws) |
| 路径 | `/<UUID>` |
| TLS | 启用（Cloudflare 强制 HTTPS） |

### 启用 Early Data

部分客户端支持在 WebSocket 路径中附加 `ed` 参数以启用 0-RTT：

```
路径: /<UUID>?ed=2560
```

> Early Data 将首个 VLESS 数据包通过 WebSocket 握手的 `sec-websocket-protocol` 头传递，减少一个 RTT。

## 五、支持的目标协议

| 类型 | CMD 值 | 说明 |
|---|---|---|
| TCP | `1` | 标准 TCP 连接，支持 IPv4 / 域名 / IPv6 目标 |
| DNS over HTTPS | `2` | 将 DNS 查询转发至 Cloudflare DoH (`cloudflare-dns.com`) |

## 六、代码架构

```
客户端 ←──WebSocket──→ Worker ←──TCP──→ 目标 / ProxyIP
                           │
                           ├─ VLESS 头解析（UUID + 地址 + 端口）
                           ├─ 出口连接建立（direct / proxyip）
                           ├─ 上行数据转发：ws.onMessage → remote.write
                           └─ 下行数据转发：remote.readable → ws.send
```

### 关键函数

| 函数 | 行号 | 职责 |
|---|---|---|
| `fetch(req)` | L10 | 入口，处理 WS 升级或透传普通请求 |
| `socks5Connect(host, port)` | L74 | 建立 SOCKS5 代理连接（含认证） |
| `httpConnect(host, port)` | L103 | 建立 HTTP CONNECT 代理连接 |
| `cleanup()` | L64 | 释放所有资源（remoteWriter / remote / udpWriter） |

### 数据流

```
┌─ ReadableStream (WS 入站) ─┐
│  ├─ start: early data 入队  │
│  ├─ onMessage: 数据入队      │  → pipeTo → WritableStream (处理逻辑)
│  └─ close/error: 清理       │              ├─ DNS 分支: TransformStream → DoH fetch → ws.send
└─────────────────────────────┘              ├─ TCP 分支: 建立出口 → remoteWriter.write(payload)
                                              └─ 回程: remote.readable.pipeTo → ws.send
```

## 七、稳定性优化（Final 版 29 项改动）

### 输入校验

| # | 优化 | 说明 |
|---|---|---|
| 1 | UUID 格式预检 | 模块加载时校验 UUID 格式，非法直接 `throw TypeError` |
| 2 | `WS_CLOSE_DELAY_MS` 常量 | 提取 500ms 延迟为具名常量，消除魔法数字 |
| 3 | VLESS IPv4 越界检查 | `pos + 4 > data.byteLength` 时丢弃 |
| 4 | VLESS 域名越界检查 | `pos + len > data.byteLength` 时丢弃 |
| 5 | VLESS IPv6 越界检查 | `pos + 16 > data.byteLength` 时丢弃 |
| 6 | 最小包长度检查 | `data.byteLength < 24` 时丢弃 |

### 出口连接安全

| # | 优化 | 说明 |
|---|---|---|
| 7 | SOCKS5 auth 空检查 | `!auth \|\| auth.length < 2` 防止空响应 |
| 8 | SOCKS5 认证失败码 | `authResp[1] !== 0` 快速失败 |
| 9 | SOCKS5 连接失败码 | `connResp[1] !== 0` 快速失败 |
| 10 | SOCKS5 锁提前释放 | 每个错误路径都 `releaseLock()` 防泄漏 |
| 11 | HTTP 响应 8192 上限 | 防止恶意代理无限推送响应 |
| 12 | HTTP 状态码精确匹配 | `startsWith('HTTP/') && includes(' 200 ')` |

### 错误隔离

| # | 优化 | 说明 |
|---|---|---|
| 13 | remoteWriter 持久化 | 只 `getWriter()` 一次，避免竞态 |
| 14 | remoteWriter 错误隔离 | 写入失败 try/catch + cleanup |
| 15 | 首次 payload 写入错误隔离 | `remoteWriter.write(payload)` 加 try/catch |
| 16 | DNS udpWriter 空检查 | `!udpWriter` 时直接 cleanup |
| 17 | DNS udpWriter 错误隔离 | 写入失败 try/catch + cleanup |
| 18 | DNS 首次写入错误隔离 | `udpWriter.write(payload)` 加 try/catch |
| 19 | pipeTo 回程 ws.send 错误隔离 | `ws.send()` 异常不中断 pipeTo |
| 20 | dnsBusy 互斥锁 | 防止 DNS 并发查询导致乱序 |

### 资源管理

| # | 优化 | 说明 |
|---|---|---|
| 21 | cleanup 释放 remoteWriter | `remoteWriter?.releaseLock()` + 置 null |
| 22 | cleanup 释放 remote | `remote?.close()` |
| 23 | cleanup 释放 udpWriter | `udpWriter?.releaseLock()` + 置 null |
| 24 | cleanup 重置 isDNS | `isDNS = false` |
| 25 | onMessage removeEventListener | close/error/cancel 三处移除 |

### 性能与兼容

| # | 优化 | 说明 |
|---|---|---|
| 26 | 背压门控 | `ctrl.desiredSize > 0` 时才入队 |
| 27 | cancel 回调清理 | `cancel()` 中 removeEventListener |
| 28 | DNS TransformStream 边界检查 | `len === 0` 或越界时 break 防无限循环 |
| 29 | DNS 零拷贝 | `new Uint8Array(chunk.buffer, ...)` 避免内存拷贝 |

## 八、非 WebSocket 请求处理

代码对非 WebSocket 请求做了透传处理（L283-285）：

```javascript
const url = new URL(req.url);
url.hostname = 'example.com';
return fetch(new Request(url, req));
```

伪装为对 `example.com` 的普通 HTTP 请求，用于通过浏览器直接访问 Worker 地址时返回正常页面，降低被探测风险。

## 九、限制与已知约束

| 约束 | 说明 |
|---|---|
| CPU 时间 | 免费版 10ms / 付费版 30ms（I/O 等待不计） |
| 内存 | 128MB 限制 |
| WS 连接生命周期 | 由 CF 边缘节点管理，无明确 wall clock 限制 |
| TCP Keepalive | `connect()` API 不暴露 TCP 层参数，无法配置 |
| 多出口 | 本版本仅支持直连和 ProxyIP，多出口版请使用 `worker.js` |
