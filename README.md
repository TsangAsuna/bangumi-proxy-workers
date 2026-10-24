# Bangumi Proxy Workers

Cloudflare Worker 实现的反向代理，用于代理 Bangumi (bgm.tv) 的 API 和图片 CDN。

- **主API**：`api.bgm.tv` → 你的 API 域名
- **评论API**：`next.bgm.tv` → 你的 API 域名（同主API）
- **图片**：`lain.bgm.tv` → 你的图片域名（带边缘缓存）
- **自动改写**：API 响应中的图片链接自动替换为你的图片域名
- **路径前缀保护**：可选的随机字符串路径前缀，防止未授权访问

---

## Quick Start

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/makabaka11/bangumi-proxy-workers)

1. 点击上方 **Deploy** 按钮，按引导完成部署
2. 部署完成后进入 Worker → **Settings** → **Domains & Routes** → **Add Custom Domain**，绑定你的两个域名
3. 编辑 Worker 代码，修改 `CONFIG` 区域：

```js
const API_HOST = "your-api-domain.example.com";   // 你的 API 域名
const IMG_HOST = "your-img-domain.example.com";   // 你的图片域名

// 可选：路径前缀（推荐设置，防止未授权访问）
// 设为空字符串 "" 则禁用
const PATH_PREFIX = "your-random-string";
```

4. 重新部署即可

---

## 配置说明

### CONFIG 变量

| 变量 | 说明 | 示例 |
|---|---|---|
| `API_HOST` | 代理 API 的域名 | `"example.com"` |
| `IMG_HOST` | 代理图片的域名 | `"bgmimg.example.com"` |
| `PATH_PREFIX` | 路径前缀（可选），设为 `""` 禁用 | `"abc123xyz"` |
| `IMG_CACHE_TTL` | 图片缓存时长（秒） | `30 * 24 * 60 * 60`（30天） |

### 路径前缀

设置 `PATH_PREFIX` 后，所有请求必须带上此前缀才会被代理：

```
# 无前缀 → 404
https://example.com/v0/search/subjects?keyword=test

# 带前缀 → 正常代理
https://example.com/abc123xyz/v0/search/subjects?keyword=test
```

API 响应中的图片链接也会自动加上前缀：

```json
{
  "images": {
    "large": "https://bgmimg.example.com/abc123xyz/pic/cover/l/ab/cd/12345.jpg"
  }
}
```

> **提示**：用 `openssl rand -hex 16` 生成一个强随机前缀。

---

## 使用示例

### 健康检查

```
GET https://example.com/abc123xyz/__health
```

```json
{
  "ok": true,
  "host": "example.com",
  "role": "api",
  "upstream": "api.bgm.tv",
  "apiHost": "example.com",
  "imgHost": "bgmimg.example.com",
  "pathPrefix": "abc123xyz"
}
```

### 搜索条目

```
GET https://example.com/abc123xyz/v0/search/subjects?keyword=吹响!上低音号
```

### 获取条目详情

```
GET https://example.com/abc123xyz/v0/subjects/12345
```

### 获取图片

```
GET https://bgmimg.retr0.xyz/abc123xyz/pic/cover/l/ab/cd/12345.jpg
```

首次请求 `MISS`，后续命中 Cloudflare 边缘缓存 `HIT`。

---

## 架构

```
客户端
  │
  ├── https://example.com/abc123xyz/v0/...  ──→  Worker  ──→  api.bgm.tv
  │    (API 域名)                                    │
  │                                                  ├── 检查路径前缀
  │                                                  ├── 剥离前缀，转发请求
  │                                                  ├── 改写响应中的图片域名
  │                                                  └── 返回
  │
  └── https://bgmimg.example.com/abc123xyz/...  ──→  Worker  ──→  lain.bgm.tv
       (图片域名)                                               └── 边缘缓存
```

---

## 域名配置

你需要两个域名，可以是任意根域下的子域名：

| 角色 | 示例 | 用途 |
|---|---|---|
| API | `example.com` | 代理 Bangumi API |
| 图片 | `bgmimg.example.com` | 代理 Bangumi 图片 CDN |

两个域名都绑定到同一个 Worker 即可，Worker 根据请求的 `Host` 头自动区分角色。

---

## 注意事项

- 该 Worker 仅代理 Bangumi **v0 REST API**（`api.bgm.tv`），不适用于 GraphQL 端点
- `PATH_PREFIX` 为可选功能，但建议设置以防止被扫描和滥用
- 图片缓存时间默认为 30 天，Bangumi 的图片 URL 是稳定不变的（基于内容哈希），可以放心缓存

---

## 鸣谢

本脚本基于 [Yuri-NagaSaki/bangumi-proxy](https://github.com/Yuri-NagaSaki/bangumi-proxy) 修改而来。


---

## 延迟优化：把边缘 RTT 压进两位数毫秒

### 延迟去哪了（实测拆解，大陆移动宽带 IPv6 → Cloudflare 美西 LAX）

以 worker 本地响应 `/__health`（零回源）为基准，单请求 ~930ms 的构成：

| 阶段 | 耗时 | 占比 |
| --- | --- | --- |
| DNS | ~6ms（缓存热） | <1% |
| TCP 握手 | ~220ms | 23% |
| TLS 握手 | ~450ms | 49% |
| 请求→首字节 | ~250ms（其中 worker 开销仅 ~20ms） | 27% |

**结论：几乎全部时延是大陆↔美西的地理 RTT**（单 RTT ≈ 220ms，光纤物理下限 ~130ms），worker 代码本身只有 ~20ms，代码层无压榨空间。TLS/传输层优化（TLS1.3、h2/h3、连接复用）只能把 929ms 降到 ~243ms，RTT 本身不动。

### 唯一能把 RTT 压进两位数的路径：优选 IP

Cloudflare 是 anycast 网络：**任何 CF 边缘 IP 都受理任意 CF 托管域名的 SNI**。所以只要找到对本地 ISP 延迟最低的边缘 IP（走香港/东京等亚太 colo 的路由），把域名指向它，RTT 就能从 220ms 降到 30~80ms。

**方法一：本机 hosts（只影响本机，最简单）**

1. 用优选工具（如 [CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest)）扫出低延迟 IP；
2. 编辑 `C:\Windows\System32\drivers\etc\hosts`，加一行：
   ```text
   <优选IP>  你的API域名
   <优选IP>  你的图片域名
   ```
3. 客户端清 DNS 缓存后实测。

**方法二：自定义域（全端生效，需要你有一个域名）**

1. 域名 NS 托管到 Cloudflare；
2. Worker 绑定 Custom Domain；
3. **关键**：把该域名的解析记录 A 值手动改成优选 IP（CF DNS 里"仅 DNS"灰云），或客户端侧用 DoH 指向优选；
4. App 端（无法改 hosts）由此吃到优选线路——这是手机端把 RTT 压进两位数的唯一办法。

### 客户端填法速查

- **czy0729/Bangumi（安卓）**：主站 `https://<API域>/site`、API `https://<API域>/api`、图片 `https://<IMG域>/img`；「自建 Worker」开关关闭（透明反代形态）。注意该客户端收藏/进度走**旧版 API**（`/collection/<id>`、`/ep/<id>/status`），本 worker 的 API 域名路由已覆盖（非 /p1 的路径全部转发 api.bgm.tv）。
- **官方 Bangumi App（iOS）**：建议用[镜像根域四域名方案](https://github.com/)（`next.<根域>` / `lain.<根域>` 子域路由），本仓库单域形态不覆盖其子域派生。
- **NipaPlay**：Bangumi 服务器填 API 域名即可；JSON 里图片链接已改写。

### 本 fork 相对上游的改动

- 公开 GET API 边缘缓存 120s（无凭据请求二次访问零回源）；
- 缓存键带 IMG_HOST 维度；带凭据请求不缓存；
- `x-upstream` / `x-cache` 调试头。
