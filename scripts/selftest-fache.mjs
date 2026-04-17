#!/usr/bin/env node
// 端到端自测：发车 / 上车 —— 验证乘客指纹与车头完全一致
// 函数为 src/extension.js 中 fache 相关工具函数的精确复刻（camelCase fp shape）
// 不依赖 vscode，不改真实 Cursor 目录，不改注册表

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const TICKET_PREFIX = "FCT1.";
const FP_BACKUP_DIRNAME = "_cursor_mcp_fp_backup";

/* ===== extension.js 里 fache 工具函数的精确复刻 ===== */

function getUserDirMachineIdPath(userDir) { return path.join(userDir, "machineid"); }
function getUserDirStoragePath(userDir)   { return path.join(userDir, "User", "globalStorage", "storage.json"); }

function readCursorFingerprint(userDir) {
  const fp = {
    machineId: null, devDeviceId: null, telemetryMachineId: null,
    macMachineId: null, sqmId: null, machineGuid: null,
  };
  try {
    const mif = getUserDirMachineIdPath(userDir);
    if (fs.existsSync(mif)) {
      const v = fs.readFileSync(mif, "utf-8").trim();
      if (v) fp.machineId = v;
    }
  } catch {}
  try {
    const sp = getUserDirStoragePath(userDir);
    if (fs.existsSync(sp)) {
      const obj = JSON.parse(fs.readFileSync(sp, "utf-8"));
      const pick = (k) => (typeof obj?.[k] === "string" && obj[k] ? obj[k] : null);
      fp.devDeviceId        = pick("telemetry.devDeviceId");
      fp.telemetryMachineId = pick("telemetry.machineId");
      fp.macMachineId       = pick("telemetry.macMachineId");
      fp.sqmId              = pick("telemetry.sqmId");
    }
  } catch {}
  // machineGuid 在真实扩展中来自注册表；自测里不动注册表，保持 null
  return fp;
}

function toBase64UrlStr(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64UrlStr(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}
function buildTicket(fp, hostname, ips) {
  const payload = {
    v: 1, fp,
    host: hostname || os.hostname() || "",
    ip: ips || [],
    ts: Date.now(),
    nonce: crypto.randomBytes(4).toString("hex"),
  };
  return TICKET_PREFIX + toBase64UrlStr(Buffer.from(JSON.stringify(payload), "utf-8"));
}
function parseTicket(tok) {
  const t = String(tok || "").trim();
  if (!t.startsWith(TICKET_PREFIX)) return null;
  try {
    const json = fromBase64UrlStr(t.slice(TICKET_PREFIX.length)).toString("utf-8");
    const o = JSON.parse(json);
    if (!o || typeof o !== "object" || !o.fp || typeof o.fp !== "object") return null;
    return o;
  } catch { return null; }
}

function applyCursorFingerprint(userDir, fp) {
  const touched = [];
  const backupDir = path.join(userDir, FP_BACKUP_DIRNAME);
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const mif = getUserDirMachineIdPath(userDir);
  if (fp.machineId) {
    if (fs.existsSync(mif)) fs.copyFileSync(mif, path.join(backupDir, `machineid.${stamp}.bak`));
    fs.mkdirSync(path.dirname(mif), { recursive: true });
    fs.writeFileSync(mif, String(fp.machineId), "utf-8");
    touched.push("machineid");
  }
  const sp = getUserDirStoragePath(userDir);
  const hasStorageFields = fp.devDeviceId || fp.telemetryMachineId || fp.macMachineId || fp.sqmId;
  if (hasStorageFields) {
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    let obj = {};
    if (fs.existsSync(sp)) {
      fs.copyFileSync(sp, path.join(backupDir, `storage.json.${stamp}.bak`));
      try { obj = JSON.parse(fs.readFileSync(sp, "utf-8")); } catch { obj = {}; }
    }
    if (fp.devDeviceId)        obj["telemetry.devDeviceId"] = fp.devDeviceId;
    if (fp.telemetryMachineId) obj["telemetry.machineId"]   = fp.telemetryMachineId;
    if (fp.macMachineId)       obj["telemetry.macMachineId"]= fp.macMachineId;
    if (fp.sqmId)              obj["telemetry.sqmId"]       = fp.sqmId;
    fs.writeFileSync(sp, JSON.stringify(obj, null, 2), "utf-8");
    touched.push("storage.json");
  }
  return { touched, backupDir };
}

function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/* ===== 测试结果输出 ===== */

const results = [];
function pass(name) { results.push({ name, ok: true }); console.log("  \x1b[32m[OK]\x1b[0m " + name); }
function fail(name, detail) { results.push({ name, ok: false, detail }); console.log("  \x1b[31m[FAIL]\x1b[0m " + name + (detail ? "\n       " + detail : "")); }

function seedHead(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "User", "globalStorage"), { recursive: true });
  const machineId = "HEAD-machineid-" + crypto.randomBytes(6).toString("hex");
  const storage = {
    "telemetry.machineId":    "HEAD-telemMachineId-" + crypto.randomBytes(4).toString("hex"),
    "telemetry.devDeviceId":  "HEAD-dev-" + crypto.randomUUID(),
    "telemetry.macMachineId": "HEAD-mac-" + crypto.randomBytes(4).toString("hex"),
    "telemetry.sqmId":        "{HEAD-SQM-" + crypto.randomBytes(4).toString("hex") + "}",
    "unrelated.head.key":     "unrelated-value-on-head",
  };
  fs.writeFileSync(path.join(dir, "machineid"), machineId, "utf-8");
  fs.writeFileSync(path.join(dir, "User", "globalStorage", "storage.json"), JSON.stringify(storage, null, 2), "utf-8");
}
function seedRider(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "User", "globalStorage"), { recursive: true });
  fs.writeFileSync(path.join(dir, "machineid"), "RIDER-original-machineid", "utf-8");
  fs.writeFileSync(path.join(dir, "User", "globalStorage", "storage.json"), JSON.stringify({
    "telemetry.machineId":    "RIDER-original-telemMachineId",
    "telemetry.devDeviceId":  "RIDER-original-devDeviceId",
    "telemetry.macMachineId": "RIDER-original-macMachineId",
    "telemetry.sqmId":        "{RIDER-ORIGINAL-SQM}",
    "rider.only.key":         "rider-specific-should-be-kept",
  }, null, 2), "utf-8");
}

/* ===== 场景 1: 本地 FCT1. 长车票 ===== */

function testLocalTicket(headDir, riderDir) {
  console.log("\n[1] 本地 FCT1. 车票端到端");

  const fpHead = readCursorFingerprint(headDir);
  if (fpHead.machineId && fpHead.devDeviceId && fpHead.telemetryMachineId && fpHead.macMachineId && fpHead.sqmId) {
    pass("车头读取指纹字段齐全");
  } else {
    fail("车头读取指纹字段齐全", JSON.stringify(fpHead));
    return;
  }

  const ticket = buildTicket(fpHead, "head-host", ["192.168.1.10"]);
  if (typeof ticket === "string" && ticket.startsWith("FCT1.") && ticket.length > 20) {
    pass("车头生成 FCT1. 车票：长度=" + ticket.length);
  } else {
    fail("车头生成 FCT1. 车票", "ticket=" + ticket);
    return;
  }

  const parsed = parseTicket(ticket);
  if (parsed && deepEqual(parsed.fp, fpHead)) pass("parseTicket 还原指纹一致");
  else fail("parseTicket 还原指纹一致", JSON.stringify({ got: parsed?.fp, want: fpHead }));

  const fpRiderBefore = readCursorFingerprint(riderDir);
  if (!deepEqual(fpRiderBefore, fpHead)) pass("乘客原始指纹 != 车头（前置条件）");
  else fail("乘客原始指纹 != 车头（前置条件）", "两者一致");

  const { touched, backupDir } = applyCursorFingerprint(riderDir, parsed.fp);
  if (touched.includes("machineid") && touched.includes("storage.json")) {
    pass("apply 已修改 machineid + storage.json");
  } else {
    fail("apply 已修改 machineid + storage.json", "touched=" + touched.join(","));
  }

  const bakFiles = fs.readdirSync(backupDir);
  if (bakFiles.some((f) => f.startsWith("machineid.")) && bakFiles.some((f) => f.startsWith("storage.json."))) {
    pass("备份目录已保存原始文件");
  } else {
    fail("备份目录已保存原始文件", bakFiles.join(","));
  }

  const fpRiderAfter = readCursorFingerprint(riderDir);
  const checks = [
    ["machineId",          fpRiderAfter.machineId,          fpHead.machineId],
    ["devDeviceId",        fpRiderAfter.devDeviceId,        fpHead.devDeviceId],
    ["telemetryMachineId", fpRiderAfter.telemetryMachineId, fpHead.telemetryMachineId],
    ["macMachineId",       fpRiderAfter.macMachineId,       fpHead.macMachineId],
    ["sqmId",              fpRiderAfter.sqmId,              fpHead.sqmId],
  ];
  for (const [name, got, want] of checks) {
    if (got === want) pass(`乘客 fp.${name} 已替换为车头值`);
    else fail(`乘客 fp.${name} 未正确替换`, `got=${got} want=${want}`);
  }

  const riderSto = JSON.parse(fs.readFileSync(getUserDirStoragePath(riderDir), "utf-8"));
  if (riderSto["rider.only.key"] === "rider-specific-should-be-kept") {
    pass("乘客 storage 中无关字段被保留（rider.only.key）");
  } else {
    fail("乘客 storage 中无关字段被保留", JSON.stringify(riderSto));
  }
  if (!Object.prototype.hasOwnProperty.call(riderSto, "unrelated.head.key")) {
    pass("乘客 storage 未被车头的无关字段污染");
  } else {
    fail("乘客 storage 未被车头的无关字段污染", "出现了 unrelated.head.key");
  }

  // 错误格式车票
  const bad = parseTicket("NOT-A-TICKET");
  if (bad === null) pass("非 FCT1. 前缀 parseTicket 返回 null");
  else fail("非 FCT1. 前缀 parseTicket 返回 null", JSON.stringify(bad));

  const bad2 = parseTicket("FCT1.!!!garbled-base64");
  if (bad2 === null) pass("损坏 base64 parseTicket 返回 null");
  else fail("损坏 base64 parseTicket 返回 null", JSON.stringify(bad2));
}

/* ===== 场景 2: sk- 云端短密钥（真实 fache-server） ===== */

function postJson(baseUrl, pathPart, body, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(baseUrl + pathPart);
    const data = Buffer.from(JSON.stringify(body), "utf-8");
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(data.length),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(Buffer.from(c)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode || 0, json, text });
      });
    });
    req.on("error", (e) => resolve({ status: 0, error: String(e) }));
    req.write(data);
    req.end();
  });
}

async function waitForServer(baseUrl, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const u = new URL(baseUrl + "/health");
      const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "GET", timeout: 500 }, (res) => {
        res.resume(); resolve((res.statusCode || 0) === 200);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { try { req.destroy(); } catch {} resolve(false); });
      req.end();
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

async function testCloudKey(headDir, riderDir) {
  console.log("\n[2] sk- 云端短密钥端到端（启动真实 fache-server）");

  const port = 18800 + Math.floor(Math.random() * 500);
  const baseUrl = `http://127.0.0.1:${port}`;
  const TOKEN = "test-tok-" + crypto.randomBytes(4).toString("hex");

  const server = spawn(process.execPath, [path.join(ROOT, "fache-server", "server.mjs")], {
    env: { ...process.env, PORT: String(port), PUBLISH_TOKEN: TOKEN, ONE_SHOT: "true" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let serverLog = "";
  server.stdout.on("data", (c) => { serverLog += c.toString(); });
  server.stderr.on("data", (c) => { serverLog += c.toString(); });

  const up = await waitForServer(baseUrl, 6000);
  if (!up) {
    fail("fache-server 启动", "超时未就绪\n" + serverLog);
    try { server.kill("SIGKILL"); } catch {}
    return;
  }
  pass("fache-server 已启动 " + baseUrl);

  try {
    const fpHead = readCursorFingerprint(headDir);

    const r0 = await postJson(baseUrl, "/api/fache/publish", { fp: fpHead, host: "head", ip: "1.1.1.1", ttlMs: 120000 });
    if (r0.status === 401) pass("无 Authorization 发布被拒 (401)");
    else fail("无 Authorization 发布被拒 (401)", "status=" + r0.status + " body=" + JSON.stringify(r0.json));

    const r0b = await postJson(baseUrl, "/api/fache/publish",
      { fp: fpHead, host: "head", ip: "1.1.1.1", ttlMs: 120000 },
      { authorization: "Bearer wrong-token" });
    if (r0b.status === 401) pass("错误 Authorization 发布被拒 (401)");
    else fail("错误 Authorization 发布被拒 (401)", "status=" + r0b.status);

    const r1 = await postJson(baseUrl, "/api/fache/publish",
      { fp: fpHead, host: "head", ip: "1.1.1.1", ttlMs: 120000 },
      { authorization: "Bearer " + TOKEN });
    if (r1.status === 200 && r1.json?.ok && /^sk-[A-Za-z0-9]{17}$/.test(r1.json.key || "")) {
      pass("车头发布成功，得到 sk- 密钥：" + r1.json.key);
    } else {
      fail("车头发布成功，得到 sk- 密钥", JSON.stringify(r1));
      return;
    }
    const skKey = r1.json.key;

    const r2 = await postJson(baseUrl, "/api/fache/pickup", { key: skKey });
    if (r2.status === 200 && r2.json?.ok && r2.json.fp) pass("乘客 pickup 成功");
    else { fail("乘客 pickup 成功", JSON.stringify(r2)); return; }

    if (deepEqual(r2.json.fp, fpHead)) pass("pickup 返回的 fp === 车头 fp（字段完全一致）");
    else fail("pickup 返回的 fp === 车头 fp", JSON.stringify({ got: r2.json.fp, want: fpHead }));

    const r3 = await postJson(baseUrl, "/api/fache/pickup", { key: skKey });
    if (r3.status === 404) pass("一次性取货：二次 pickup 返回 404");
    else fail("一次性取货：二次 pickup 返回 404", "status=" + r3.status);

    const r4 = await postJson(baseUrl, "/api/fache/pickup", { key: "sk-invalid" });
    if (r4.status === 400) pass("非法格式 key 被 400 拒绝");
    else fail("非法格式 key 被 400 拒绝", "status=" + r4.status);

    const r5 = await postJson(baseUrl, "/api/fache/publish",
      { fp: fpHead, host: "head", ttlMs: 999999999999 },
      { authorization: "Bearer " + TOKEN });
    if (r5.status === 200 && r5.json?.ok) pass("超大 ttlMs 被服务端 clamp 后正常接受");
    else fail("超大 ttlMs 被服务端 clamp", JSON.stringify(r5));

    // 把 pickup 的 fp 应用到乘客目录，确认磁盘层面一致
    const r6 = await postJson(baseUrl, "/api/fache/publish",
      { fp: fpHead, host: "head", ttlMs: 60000 },
      { authorization: "Bearer " + TOKEN });
    const key2 = r6.json?.key;
    const r7 = await postJson(baseUrl, "/api/fache/pickup", { key: key2 });
    applyCursorFingerprint(riderDir, r7.json.fp);
    const fpRiderAfter = readCursorFingerprint(riderDir);
    if (deepEqual(fpRiderAfter, fpHead)) {
      pass("sk- 链路：乘客磁盘指纹 === 车头磁盘指纹");
    } else {
      fail("sk- 链路：乘客磁盘指纹 === 车头磁盘指纹", JSON.stringify({ got: fpRiderAfter, want: fpHead }));
    }
  } finally {
    try { server.kill("SIGKILL"); } catch {}
  }
}

/* ===== 运行 ===== */

async function main() {
  const tmp = path.join(os.tmpdir(), "cursor-mcp-selftest-" + Date.now());
  const headDir = path.join(tmp, "head");
  const riderDir = path.join(tmp, "rider");

  console.log("临时目录：" + tmp);
  seedHead(headDir);
  seedRider(riderDir);

  testLocalTicket(headDir, riderDir);

  seedRider(riderDir);
  await testCloudKey(headDir, riderDir);

  const ok = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log("\n========= 结果 =========");
  console.log(`通过: ${ok} / ${total}`);
  if (ok < total) {
    console.log("\x1b[31m失败项：\x1b[0m");
    results.filter((r) => !r.ok).forEach((r) => console.log(" - " + r.name + (r.detail ? " :: " + r.detail : "")));
    process.exit(1);
  } else {
    console.log("\x1b[32m全部通过 ✓\x1b[0m");
    console.log("临时目录可删：" + tmp);
    process.exit(0);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
