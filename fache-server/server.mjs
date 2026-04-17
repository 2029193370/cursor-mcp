import http from "node:http";
import crypto from "node:crypto";

/* ===== 配置（可通过环境变量覆盖） ===== */
const PORT = parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "0.0.0.0";
/** 车票最大 TTL（ms），客户端提交值会被夹紧到 [60s, MAX_TTL] */
const MAX_TTL_MS = parseInt(process.env.MAX_TTL_MS || String(24 * 3600 * 1000), 10);
const MIN_TTL_MS = 60 * 1000;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
/** 一次性领取：true = pickup 成功即删除；false = 到期前可被多次领取 */
const ONE_SHOT = (process.env.ONE_SHOT || "true").toLowerCase() !== "false";
/** 内存上限：超过则拒绝新的 publish（简单防滥用） */
const MAX_ENTRIES = parseInt(process.env.MAX_ENTRIES || "5000", 10);
/** 单条 body 最大字节（防滥发大 payload） */
const MAX_BODY_BYTES = 64 * 1024;
/** 可选：要求 publish 时带一个共享 token（Authorization: Bearer <token>） */
const PUBLISH_TOKEN = process.env.PUBLISH_TOKEN || "";

/* ===== 内存存储 ===== */
/** @type Map<string, {fp:any, host:string, ip:string[], ts:number, expiresAt:number}> */
const store = new Map();

function nowMs() { return Date.now(); }

function gc() {
  const now = nowMs();
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
}
setInterval(gc, 30 * 1000).unref();

/** 生成 sk- + 17 位 base62 = 20 字符 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function genKey() {
  const bytes = crypto.randomBytes(17);
  let out = "sk-";
  for (let i = 0; i < 17; i++) out += ALPHABET[bytes[i] % 62];
  return out;
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf-8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "POST, OPTIONS",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { statusCode: 413 }));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (e) {
        reject(Object.assign(new Error("invalid json"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function clampTtl(x) {
  const n = typeof x === "number" ? Math.floor(x) : DEFAULT_TTL_MS;
  if (!Number.isFinite(n)) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, n));
}

function validFp(fp) {
  if (!fp || typeof fp !== "object") return false;
  const keys = ["machineId", "devDeviceId", "telemetryMachineId", "macMachineId", "sqmId", "machineGuid"];
  let anyFilled = false;
  for (const k of keys) {
    const v = fp[k];
    if (v == null) continue;
    if (typeof v !== "string" || v.length > 256) return false;
    if (v) anyFilled = true;
  }
  return anyFilled;
}

async function handlePublish(req, res) {
  if (PUBLISH_TOKEN) {
    const auth = String(req.headers["authorization"] || "");
    const expect = "Bearer " + PUBLISH_TOKEN;
    if (auth !== expect) return sendJson(res, 401, { ok: false, message: "unauthorized" });
  }
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJson(res, e.statusCode || 400, { ok: false, message: e.message }); }

  if (!validFp(body.fp)) return sendJson(res, 400, { ok: false, message: "invalid fp" });
  if (store.size >= MAX_ENTRIES) {
    gc();
    if (store.size >= MAX_ENTRIES) return sendJson(res, 503, { ok: false, message: "server busy" });
  }

  const ttlMs = clampTtl(body.ttlMs);
  const host = typeof body.host === "string" ? body.host.slice(0, 128) : "";
  const ip = Array.isArray(body.ip) ? body.ip.filter((s) => typeof s === "string").slice(0, 16).map((s) => s.slice(0, 64)) : [];
  let key;
  do { key = genKey(); } while (store.has(key));
  const rec = {
    fp: {
      machineId: body.fp.machineId || null,
      devDeviceId: body.fp.devDeviceId || null,
      telemetryMachineId: body.fp.telemetryMachineId || null,
      macMachineId: body.fp.macMachineId || null,
      sqmId: body.fp.sqmId || null,
      machineGuid: body.fp.machineGuid || null,
    },
    host,
    ip,
    ts: nowMs(),
    expiresAt: nowMs() + ttlMs,
  };
  store.set(key, rec);
  console.log(`[publish] key=${key} host=${host} ttl=${ttlMs} size=${store.size}`);
  sendJson(res, 200, { ok: true, key, expiresAt: rec.expiresAt, ttlMs });
}

async function handlePickup(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJson(res, e.statusCode || 400, { ok: false, message: e.message }); }

  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!/^sk-[A-Za-z0-9]{17}$/.test(key)) {
    return sendJson(res, 400, { ok: false, message: "invalid key format" });
  }
  const rec = store.get(key);
  if (!rec) return sendJson(res, 404, { ok: false, message: "key not found or expired" });
  if (rec.expiresAt <= nowMs()) {
    store.delete(key);
    return sendJson(res, 410, { ok: false, message: "key expired" });
  }
  if (ONE_SHOT) store.delete(key);
  console.log(`[pickup] key=${key} remain=${store.size} one-shot=${ONE_SHOT}`);
  sendJson(res, 200, {
    ok: true,
    fp: rec.fp,
    host: rec.host,
    ip: rec.ip,
    ts: rec.ts,
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-allow-methods": "POST, OPTIONS",
    });
    res.end();
    return;
  }
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    sendJson(res, 200, { ok: true, service: "cursor-mcp-fache", size: store.size, oneShot: ONE_SHOT });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "method not allowed" });
    return;
  }
  if (req.url === "/api/fache/publish") return handlePublish(req, res);
  if (req.url === "/api/fache/pickup") return handlePickup(req, res);
  sendJson(res, 404, { ok: false, message: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`[fache-server] listening on http://${HOST}:${PORT}`);
  console.log(`  POST /api/fache/publish   -> 车头发布指纹，返回 sk-xxxxxxxxxxxxxxxxx`);
  console.log(`  POST /api/fache/pickup    -> 乘客用 key 领取指纹${ONE_SHOT ? "（一次性）" : "（可重复领取直到过期）"}`);
  console.log(`  TTL  min=${MIN_TTL_MS}ms  default=${DEFAULT_TTL_MS}ms  max=${MAX_TTL_MS}ms`);
  if (PUBLISH_TOKEN) console.log(`  PUBLISH_TOKEN enabled (Authorization: Bearer <token>)`);
});
