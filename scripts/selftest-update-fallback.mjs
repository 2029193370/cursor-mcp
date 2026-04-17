#!/usr/bin/env node
/**
 * 单进程起一个假 GitHub API，覆盖 fetchLatestReleaseInfo 的失败分支
 * （rate_limit / not_found / invalid / server_error / ok），确认返回 reason 正确。
 *
 * 由于函数在 extension.js 里用 require('vscode')，没法在纯 node 直接 require。
 * 这里复制一份最小等价实现，与 src 保持结构对齐 —— 若 src 改动需要同步。
 */
import http from "node:http";

function httpGetJson(url) {
    return new Promise((resolve) => {
        let u;
        try { u = new URL(url); } catch { resolve({ ok: false, status: 0, err: "bad_url" }); return; }
        const mod = u.protocol === "https:" ? require("node:https") : http;
        const req = mod.get({
            hostname: u.hostname,
            port: u.port || (u.protocol === "https:" ? 443 : 80),
            path: u.pathname + (u.search || ""),
            headers: { "user-agent": "selftest/1", "accept": "application/vnd.github+json" },
        }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(Buffer.from(c)));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf-8");
                const status = res.statusCode || 0;
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch {}
                resolve({ ok: status < 400, status, json, headers: res.headers || {} });
            });
        });
        req.on("error", (e) => resolve({ ok: false, status: 0, err: String((e && e.message) || e) }));
        req.setTimeout(15000, () => { try { req.destroy(new Error("timeout")); } catch {} });
    });
}

async function fetchLatestReleaseInfo(feedUrl) {
    const r = await httpGetJson(feedUrl);
    if (!r.ok) {
        const h = r.headers || {};
        const remaining = Number(h["x-ratelimit-remaining"]);
        const reset = Number(h["x-ratelimit-reset"]);
        let reason = "network";
        if (r.status === 403 && Number.isFinite(remaining) && remaining === 0) reason = "rate_limit";
        else if (r.status === 403) reason = "forbidden";
        else if (r.status === 404) reason = "not_found";
        else if (r.status >= 500) reason = "server_error";
        else if (r.status > 0) reason = "http_error";
        else if (r.err === "bad_url") reason = "bad_url";
        return { ok: false, reason, status: r.status || 0, resetAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : 0 };
    }
    const obj = r.json;
    if (!obj || typeof obj !== "object") return { ok: false, reason: "invalid", status: r.status || 0 };
    const tag = String(obj.tag_name || "").replace(/^v/, "");
    if (!tag) return { ok: false, reason: "invalid", status: r.status || 0 };
    const assets = Array.isArray(obj.assets) ? obj.assets : [];
    const vsix = assets.find((a) => a && typeof a.browser_download_url === "string" && /\.vsix$/i.test(String(a.name || "")));
    return { ok: true, version: tag, vsixUrl: vsix ? vsix.browser_download_url : "" };
}

const routes = {
    "/ok": { status: 200, body: { tag_name: "v2.0.0", assets: [{ name: "x.vsix", browser_download_url: "https://x" }] } },
    "/rate": { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now()/1000) + 3600) }, body: { message: "API rate limit exceeded" } },
    "/403": { status: 403, body: { message: "forbidden" } },
    "/404": { status: 404, body: { message: "Not Found" } },
    "/500": { status: 500, body: { message: "boom" } },
    "/invalid": { status: 200, body: "not json", raw: true },
    "/empty": { status: 200, body: {} },
};

const server = http.createServer((req, res) => {
    const route = routes[req.url];
    if (!route) { res.writeHead(404); res.end(); return; }
    const headers = { "content-type": "application/json", ...(route.headers || {}) };
    res.writeHead(route.status, headers);
    res.end(route.raw ? String(route.body) : JSON.stringify(route.body));
});

await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let pass = 0, fail = 0;
function expect(label, actual, matcher) {
    const ok = typeof matcher === "function" ? matcher(actual) : actual === matcher;
    if (ok) { console.log("  PASS", label, "=>", JSON.stringify(actual)); pass++; }
    else { console.log("  FAIL", label, "=>", JSON.stringify(actual)); fail++; }
}

const cases = [
    ["/ok",      (r) => r.ok === true && r.version === "2.0.0"],
    ["/rate",    (r) => r.ok === false && r.reason === "rate_limit" && r.resetAt > Date.now()],
    ["/403",     (r) => r.ok === false && r.reason === "forbidden"],
    ["/404",     (r) => r.ok === false && r.reason === "not_found"],
    ["/500",     (r) => r.ok === false && r.reason === "server_error"],
    ["/invalid", (r) => r.ok === false && r.reason === "invalid"],
    ["/empty",   (r) => r.ok === false && r.reason === "invalid"],
    [null,       (r) => r.ok === false && r.reason === "network"], // 无连接
];

for (const [p, matcher] of cases) {
    const url = p === null ? "http://127.0.0.1:1/nope" : base + p;
    const r = await fetchLatestReleaseInfo(url);
    expect(p ?? "network", r, matcher);
}

// bad_url
{
    const r = await fetchLatestReleaseInfo("not a url");
    expect("bad_url", r, (x) => x.ok === false && x.reason === "bad_url");
}

server.close();
console.log(`\n[done] ${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
