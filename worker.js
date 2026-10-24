/**
 * Bangumi 反向代理 - Cloudflare Worker 版（延迟优化版）
 * --------------------------------------------------
 * 基于 makabaka11/bangumi-proxy-workers，本 fork 的延迟优化：
 *
 * 1. 公开 GET API 边缘缓存：/v0/subjects/<id>、/calendar 等无凭据请求
 *    直接命中 caches.default（默认 120s），二次访问零回源，
 *    省掉 Worker->上游的一个完整 RTT（对静态化数据这是最大的时延项）。
 * 2. 缓存键包含 IMG_HOST 维度：改写后的响应体依赖配置，换配置不串缓存。
 * 3. 带凭据的请求（Authorization / Cookie）绝不缓存，鉴权语义原样透传。
 * 4. 图片本体边缘缓存 30 天（原版行为，保留）。
 *
 * 代理：
 *   api.bgm.tv   (v0 / 旧版 REST API) ->  你的 API 域名
 *   next.bgm.tv  (评论等 API)         ->  你的 API 域名（自动按路径路由）
 *   lain.bgm.tv  (图片 CDN)           ->  你的图片域名
 *
 * 路由规则：所有请求共享 API 域名，Worker 按请求路径自动分流：
 *   /v0/*                       ->  api.bgm.tv
 *   /p1/*                       ->  next.bgm.tv
 *   /*                          ->  lain.bgm.tv（图片域名）
 *
 * 关键点：API 返回的 JSON 里图片地址是写死的 lain.bgm.tv 绝对 URL，
 * 本 Worker 会自动把响应体里的 lain.bgm.tv 改写成你的图片域名，
 * 这样客户端拿到数据后只访问你的域名，不会再碰被污染的 bgm.tv。
 *
 * ============== 部署（3 步）==============
 *  1. 把下面 CONFIG 里的 API_HOST / IMG_HOST 改成你的两个域名。
 *  2. Cloudflare Dashboard -> Workers & Pages -> Create -> 贴入本文件 -> Deploy。
 *  3. 进入该 Worker -> Settings -> Domains & Routes -> Add Custom Domain，
 *     把上面填的两个域名都绑上去。
 *
 * 域名随便取、根域不限，只要这里填对哪个是 API、哪个是图片即可。
 * 调试：访问 https://你的域名/__health 查看识别到的角色和上游。
 *
 * ============== 延迟压到两位数（优选 IP）==============
 * workers.dev / 自定义域默认由 Cloudflare DNS 指到地理就近 anycast，
 * 大陆宽带常被调度到美西（RTT 150~250ms）。优选方法见本仓库 README：
 * 用测速脚本找出对本地 ISP 延迟最低的 Cloudflare anycast IP，
 * 在 hosts / 自定义域 DNS 里指过去，SNI 不变即可被边缘正常受理。
 */

// ====== CONFIG（必填：填你的两个域名）======
const API_HOST = "bgm.example.com"; // 你的 API 域名（代理 api.bgm.tv）
const IMG_HOST = "bgmimg.example.com"; // 你的图片域名（代理 lain.bgm.tv）

// 可选：随机路径前缀。设置后只有带此前缀的请求才会被代理，例如：
//   PATH_PREFIX = "abc123xyz"  ->  实际 base_url = bgm.example.com/abc123xyz
// 设为空字符串 "" 则禁用此功能（所有路径直接代理）。
const PATH_PREFIX = "";

// 上游（不要改）
const BGM_API = "api.bgm.tv";
const BGM_API_NEXT = "next.bgm.tv"; // 评论等接口
const BGM_IMG = "lain.bgm.tv";

// 图片缓存时长（秒），默认 30 天
const IMG_CACHE_TTL = 30 * 24 * 60 * 60;
// 公开 GET API 的边缘缓存时长（秒）。120s 内重复请求零回源，数据不至过于陈旧。
const API_CACHE_TTL = 120;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname;

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // 路径前缀校验（如果配置了前缀）
    if (PATH_PREFIX) {
      if (!url.pathname.startsWith("/" + PATH_PREFIX)) {
        return new Response("Not Found", { status: 404 });
      }
      url.pathname = url.pathname.slice(("/" + PATH_PREFIX).length) || "/";
    }

    // 图片域名 -> 图片代理
    if (host === IMG_HOST) {
      if (url.pathname === "/__health") {
        return json({
          ok: true, host, role: "img",
          upstream: BGM_IMG,
          apiHost: API_HOST, imgHost: IMG_HOST,
          pathPrefix: PATH_PREFIX || "(disabled)",
        });
      }
      return handleImage(request, url, ctx);
    }

    // API 域名 -> 按路径决定上游
    const upstream = url.pathname.startsWith("/p1/") ? BGM_API_NEXT : BGM_API;

    // 健康检查 / 调试（纯边缘响应，零回源——测 RTT 用它）
    if (url.pathname === "/__health") {
      return json({
        ok: true, host,
        role: "api",
        upstream,
        apiHost: API_HOST, imgHost: IMG_HOST,
        pathPrefix: PATH_PREFIX || "(disabled)",
      });
    }

    return handleApi(request, url, upstream);
  },
};

// ---------- API：代理 + 改写 lain.bgm.tv + 公开 GET 边缘缓存 ----------
async function handleApi(request, url, upstream) {
  const upstreamURL = "https://" + upstream + url.pathname + url.search;

  // 公开 GET 的边缘缓存：仅 GET、无凭据（Authorization/Cookie 都没有）才尝试。
  // 缓存键带 IMG_HOST：改写后的响应依赖配置，避免换配置后串出旧改写内容。
  const isCacheable =
    request.method === "GET" &&
    !request.headers.has("Authorization") &&
    !request.headers.has("Cookie");

  if (isCacheable) {
    const cache = caches.default;
    const cacheKey = new Request("https://cache.local" + url.pathname + url.search + "?img=" + IMG_HOST, { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) {
      const r = new Response(hit.body, hit);
      r.headers.set("x-cache", "HIT");
      setCors(r.headers);
      return r;
    }

    const resp = await fetch(new Request(upstreamURL, {
      method: "GET",
      headers: cleanRequestHeaders(request.headers),
      redirect: "follow",
    }));
    const ct = (resp.headers.get("content-type") || "").toLowerCase();

    // 仅缓存 200 JSON（公开数据），带 Cache-Control 供客户端复用
    if (resp.status === 200 && ct.includes("application/json")) {
      const text = await resp.text();
      const rewritten = rewriteLain(text);
      const headers = new Headers(resp.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.set("cache-control", "public, max-age=" + API_CACHE_TTL);
      setCors(headers);
      headers.set("x-cache", "MISS");
      const out = new Response(rewritten, {
        status: resp.status,
        statusText: resp.statusText,
        headers,
      });
      ctx.waitUntil(cache.put(cacheKey, out.clone()));
      return out;
    }

    return passthrough(resp, upstream);
  }

  // 带凭据 / 非 GET：原样转发（鉴权语义透传，绝不缓存）
  const upstreamReq = new Request(upstreamURL, {
    method: request.method,
    headers: cleanRequestHeaders(request.headers),
    body: hasBody(request.method) ? request.body : undefined,
    redirect: "follow",
  });

  const resp = await fetch(upstreamReq);
  const ct = resp.headers.get("content-type") || "";
  const headers = new Headers(resp.headers);
  setCors(headers);

  // 文本/JSON 才改写
  if (ct.includes("application/json") || ct.includes("text/")) {
    let text = await resp.text();
    text = rewriteLain(text);
    headers.delete("content-length");
    headers.delete("content-encoding"); // body 已是解压后的文本
    return new Response(text, {
      status: resp.status,
      statusText: resp.statusText,
      headers,
    });
  }

  // 其它类型直接透传
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

function rewriteLain(text) {
  // 有路径前缀时图片地址一并带上（与原版语义一致）
  const imgReplacement = PATH_PREFIX ? IMG_HOST + "/" + PATH_PREFIX : IMG_HOST;
  return text.split("lain.bgm.tv").join(imgReplacement);
}

function passthrough(resp, upstream) {
  const headers = new Headers(resp.headers);
  setCors(headers);
  headers.set("x-upstream", upstream);
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

// ---------- 图片：代理 + 边缘缓存 ----------
async function handleImage(request, url, ctx) {
  const upstreamURL = "https://" + BGM_IMG + url.pathname + url.search;
  const cache = caches.default;
  const cacheKey = new Request(upstreamURL, { method: "GET" });

  let hit = await cache.match(cacheKey);
  if (hit) {
    const r = new Response(hit.body, hit);
    r.headers.set("x-cache", "HIT");
    setCors(r.headers);
    return r;
  }

  const upstreamReq = new Request(upstreamURL, {
    method: "GET",
    headers: cleanRequestHeaders(request.headers),
    redirect: "follow",
  });

  const resp = await fetch(upstreamReq);
  const out = new Response(resp.body, resp);
  out.headers.set("x-cache", "MISS");
  setCors(out.headers);

  if (resp.status === 200) {
    out.headers.set("cache-control", "public, max-age=" + IMG_CACHE_TTL);
    ctx.waitUntil(cache.put(cacheKey, out.clone()));
  }
  return out;
}

// ---------- 工具函数 ----------
function cleanRequestHeaders(h) {
  const out = new Headers(h);
  out.delete("host");
  out.delete("cf-connecting-ip");
  out.delete("cf-ipcountry");
  out.delete("x-forwarded-host");
  return out;
}

function hasBody(method) {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function setCors(headers) {
  headers.set("Access-Control-Allow-Origin", "*");
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}
