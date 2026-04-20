"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
const crypto = __importStar(require("crypto"));
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const license_1 = require("./license");
const viewType = "cursorMcp.sidebar";
/* ===== 发车（Cursor 设备指纹同步） ===== */
const TICKET_PREFIX = "FCT1.";
const FP_BACKUP_DIRNAME = "cursor-mcp-fp-backup";
/** 上车后保存车头指纹，供「验证指纹」按钮对比 */
const GLOBAL_STATE_LAST_PICKUP_KEY = "cursorMcp.lastPickup.v1";
/** Cursor 用户目录（跨平台） */
function getCursorUserDir() {
    if (process.platform === "win32") {
        const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
        return path.join(appdata, "Cursor");
    }
    if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support", "Cursor");
    }
    return path.join(os.homedir(), ".config", "Cursor");
}
function getCursorMachineIdFilePath() {
    return path.join(getCursorUserDir(), "machineid");
}
function getCursorStorageJsonPath() {
    return path.join(getCursorUserDir(), "User", "globalStorage", "storage.json");
}
function readWindowsMachineGuid() {
    if (process.platform !== "win32")
        return null;
    try {
        const r = (0, child_process_1.spawnSync)("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8", windowsHide: true });
        if (r.status !== 0)
            return null;
        const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/.exec(r.stdout || "");
        return m ? m[1] : null;
    }
    catch {
        return null;
    }
}
/** 读取 MachineGuid 同步模式：auto / always / never，默认 auto */
function getMachineGuidMode() {
    try {
        const v = vscode.workspace.getConfiguration("cursorMcp").get("facheSyncMachineGuid");
        if (v === "never" || v === "always" || v === "auto")
            return v;
    }
    catch {
        // ignore
    }
    return "auto";
}
// 轻量缓存：一个进程生命周期内权限不会变
let _elevatedCache = null;
/** 当前 Cursor 进程是否已以管理员身份启动（Windows）。用 fsutil dirty query 探测，admin 才返回 0 */
function isCurrentProcessElevated() {
    if (process.platform !== "win32")
        return false;
    if (_elevatedCache !== null)
        return _elevatedCache;
    try {
        const sysDrive = (process.env.SystemDrive || "C:").replace(/\\$/, "");
        const r = (0, child_process_1.spawnSync)("fsutil", ["dirty", "query", sysDrive], {
            encoding: "utf8", windowsHide: true, timeout: 3000,
        });
        _elevatedCache = r.status === 0;
    }
    catch {
        _elevatedCache = false;
    }
    return _elevatedCache;
}
/**
 * 写回 Windows MachineGuid。
 * mode:
 *   - "never":  静默跳过
 *   - "auto":   当前进程已提权则直写（无 UAC，快）；否则自动回落到 UAC 提权路径（保证"点一次上车就全部写好"）
 *   - "always": 强制走 Start-Process -Verb RunAs 提权路径（即使已提权也走一遍，用于测试或保守用户）
 */
function writeWindowsMachineGuid(guid, mode) {
    const m = mode || "auto";
    if (m === "never")
        return { ok: false, skipped: true, msg: "已按配置跳过（facheSyncMachineGuid=never）" };
    if (process.platform !== "win32")
        return { ok: false, msg: "仅 Windows 支持 MachineGuid 修改" };
    const safe = String(guid || "").trim();
    if (!/^[0-9a-fA-F-]{8,}$/.test(safe))
        return { ok: false, msg: "MachineGuid 格式不合法" };
    // auto 且已提权：直接 reg add，无 UAC、快速返回
    if (m === "auto" && isCurrentProcessElevated()) {
        try {
            const r = (0, child_process_1.spawnSync)("reg", ["add", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/t", "REG_SZ", "/d", safe, "/f"], { encoding: "utf8", windowsHide: true });
            if (r.status === 0)
                return { ok: true };
            return { ok: false, msg: `写注册表失败，退出码 ${r.status}` };
        }
        catch (e) {
            return { ok: false, msg: String(e) };
        }
    }
    // auto 非管理员 / always：走 UAC 提权。若用户拒绝，返回失败但不影响其他 5 个字段
    const sysRoot = process.env.SystemRoot || "C:\\Windows";
    const psExe = path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const inner = `reg add \"HKLM\\SOFTWARE\\Microsoft\\Cryptography\" /v MachineGuid /t REG_SZ /d ${safe} /f`;
    const script = `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c ${inner}' -Verb RunAs -WindowStyle Hidden -PassThru -Wait; exit $p.ExitCode`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    try {
        const r = (0, child_process_1.spawnSync)(psExe, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { encoding: "utf8", windowsHide: true });
        if (r.status === 0)
            return { ok: true };
        return { ok: false, msg: `写注册表失败（用户可能在 UAC 弹窗拒绝了管理员授权），退出码 ${r.status}` };
    }
    catch (e) {
        return { ok: false, msg: String(e) };
    }
}
/** 读取完整 Cursor 指纹 */
function readCursorFingerprint() {
    const fp = {
        machineId: null,
        devDeviceId: null,
        telemetryMachineId: null,
        macMachineId: null,
        sqmId: null,
        machineGuid: null,
    };
    try {
        const mif = getCursorMachineIdFilePath();
        if (fs.existsSync(mif)) {
            const v = fs.readFileSync(mif, "utf-8").trim();
            if (v)
                fp.machineId = v;
        }
    }
    catch {
        // ignore
    }
    try {
        const sp = getCursorStorageJsonPath();
        if (fs.existsSync(sp)) {
            const obj = JSON.parse(fs.readFileSync(sp, "utf-8"));
            const pick = (k) => {
                const v = obj?.[k];
                return typeof v === "string" && v ? v : null;
            };
            fp.devDeviceId = pick("telemetry.devDeviceId");
            fp.telemetryMachineId = pick("telemetry.machineId");
            fp.macMachineId = pick("telemetry.macMachineId");
            fp.sqmId = pick("telemetry.sqmId");
        }
    }
    catch {
        // ignore
    }
    if (getMachineGuidMode() !== "never") {
        fp.machineGuid = readWindowsMachineGuid();
    }
    return fp;
}
function getLocalIps() {
    const out = [];
    try {
        const ifaces = os.networkInterfaces();
        Object.keys(ifaces).forEach((name) => {
            (ifaces[name] || []).forEach((ni) => {
                if (ni && ni.family === "IPv4" && !ni.internal)
                    out.push(`${name}:${ni.address}`);
            });
        });
    }
    catch {
        // ignore
    }
    return out;
}
function toBase64UrlStr(buf) {
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64UrlStr(s) {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}
/** 生成车票：FCT1.<base64url(JSON)> */
function buildTicket(fp, hostname, ips) {
    const payload = {
        v: 1,
        fp,
        host: hostname || os.hostname() || "",
        ip: ips || [],
        ts: Date.now(),
        nonce: crypto.randomBytes(4).toString("hex"),
    };
    return TICKET_PREFIX + toBase64UrlStr(Buffer.from(JSON.stringify(payload), "utf-8"));
}
function parseTicket(tok) {
    const t = String(tok || "").trim();
    if (!t.startsWith(TICKET_PREFIX))
        return null;
    try {
        const json = fromBase64UrlStr(t.slice(TICKET_PREFIX.length)).toString("utf-8");
        const o = JSON.parse(json);
        if (!o || typeof o !== "object" || !o.fp || typeof o.fp !== "object")
            return null;
        return o;
    }
    catch {
        return null;
    }
}
/** 字段级对比两份指纹，返回每个字段的 match/expected/actual */
function compareFingerprints(expected, actual) {
    const fields = ["machineId", "devDeviceId", "telemetryMachineId", "macMachineId", "sqmId", "machineGuid"];
    const rows = [];
    let matched = 0;
    let checked = 0;
    for (const k of fields) {
        const e = expected && expected[k] ? String(expected[k]) : null;
        const a = actual && actual[k] ? String(actual[k]) : null;
        // 车头那边为空（例如 never 模式或服务端没该字段）：跳过比较，不计入分母
        if (!e) {
            rows.push({ key: k, status: "skipped", expected: null, actual: a });
            continue;
        }
        checked += 1;
        // 对 machineGuid 做大小写不敏感对比（注册表写入可能改变大小写表现）
        const eq = k === "machineGuid"
            ? e.toLowerCase() === String(a || "").toLowerCase()
            : e === a;
        if (eq)
            matched += 1;
        rows.push({ key: k, status: eq ? "match" : "mismatch", expected: e, actual: a });
    }
    return { rows, matched, checked, allMatch: checked > 0 && matched === checked };
}
/** 把车票指纹写入本机 Cursor（含备份） */
function applyCursorFingerprint(fp) {
    const touched = [];
    const backupDir = path.join(getCursorUserDir(), FP_BACKUP_DIRNAME);
    if (!fs.existsSync(backupDir))
        fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const mif = getCursorMachineIdFilePath();
    if (fp.machineId) {
        try {
            if (fs.existsSync(mif))
                fs.copyFileSync(mif, path.join(backupDir, `machineid.${stamp}.bak`));
            fs.mkdirSync(path.dirname(mif), { recursive: true });
            fs.writeFileSync(mif, String(fp.machineId), "utf-8");
            touched.push("machineid");
        }
        catch (e) {
            throw new Error("写入 machineid 失败：" + String(e));
        }
    }
    const sp = getCursorStorageJsonPath();
    const hasStorageFields = fp.devDeviceId || fp.telemetryMachineId || fp.macMachineId || fp.sqmId;
    if (hasStorageFields) {
        try {
            fs.mkdirSync(path.dirname(sp), { recursive: true });
            let obj = {};
            if (fs.existsSync(sp)) {
                fs.copyFileSync(sp, path.join(backupDir, `storage.json.${stamp}.bak`));
                try {
                    obj = JSON.parse(fs.readFileSync(sp, "utf-8"));
                }
                catch {
                    obj = {};
                }
            }
            if (fp.devDeviceId)
                obj["telemetry.devDeviceId"] = fp.devDeviceId;
            if (fp.telemetryMachineId)
                obj["telemetry.machineId"] = fp.telemetryMachineId;
            if (fp.macMachineId)
                obj["telemetry.macMachineId"] = fp.macMachineId;
            if (fp.sqmId)
                obj["telemetry.sqmId"] = fp.sqmId;
            fs.writeFileSync(sp, JSON.stringify(obj, null, 2), "utf-8");
            touched.push("storage.json");
        }
        catch (e) {
            throw new Error("写入 storage.json 失败：" + String(e));
        }
    }
    let guidResult = null;
    const mguidMode = getMachineGuidMode();
    if (process.platform === "win32" && fp.machineGuid && mguidMode !== "never") {
        const cur = readWindowsMachineGuid();
        if (cur && cur.toLowerCase() === String(fp.machineGuid).toLowerCase()) {
            guidResult = { ok: true, skipped: true };
        }
        else {
            guidResult = writeWindowsMachineGuid(fp.machineGuid, mguidMode);
            if (guidResult.ok)
                touched.push("MachineGuid(注册表)");
        }
    }
    return { touched, backupDir, guidResult };
}
/* ===== Cursor.exe 实际路径检测（激活时一次性缓存，供发车重启复用） ===== */
/** 本会话内检测到的 Cursor 主程序绝对路径；activate 时尝试填充 */
let _detectedCursorExe = "";
const DETECTED_CURSOR_EXE_KEY = "cursorMcp.detectedCursorExePath";
function looksLikeCursorExe(p) {
    return typeof p === "string" && /cursor\.exe$/i.test(p.trim());
}
/** 以 WMI 从当前 PID 向上追溯父进程，找第一条以 Cursor.exe 结尾的 ExecutablePath（最多 walk 6 层，超时 6s） */
function probeCursorExeViaWmi() {
    if (process.platform !== "win32")
        return "";
    const script = `
$ErrorActionPreference = 'SilentlyContinue';
$cur = Get-CimInstance Win32_Process -Filter ("ProcessId=" + ${process.pid});
for ($i = 0; $i -lt 6 -and $cur; $i++) {
    if ($cur.ExecutablePath -and ($cur.ExecutablePath.ToLower().EndsWith('cursor.exe'))) {
        Write-Output $cur.ExecutablePath; exit 0
    }
    $ppid = $cur.ParentProcessId
    if (-not $ppid) { break }
    $cur = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ppid);
}
$any = Get-CimInstance Win32_Process -Filter "Name='Cursor.exe'" | Where-Object { $_.ExecutablePath } | Select-Object -First 1 ExecutablePath;
if ($any) { Write-Output $any.ExecutablePath }
`;
    try {
        const r = (0, child_process_1.spawnSync)("powershell.exe", [
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script,
        ], { encoding: "utf8", windowsHide: true, timeout: 6000 });
        const out = String(r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        return out.find((p) => looksLikeCursorExe(p) && fs.existsSync(p)) || "";
    }
    catch {
        return "";
    }
}
/** 激活时检测并缓存 Cursor.exe 真实路径：快路径 process.execPath，慢路径 WMI 异步兜底。 */
function detectAndCacheCursorExe(context) {
    try {
        const prev = context.globalState.get(DETECTED_CURSOR_EXE_KEY);
        if (typeof prev === "string" && prev && fs.existsSync(prev)) {
            _detectedCursorExe = prev;
        }
    }
    catch {
        // ignore
    }
    if (looksLikeCursorExe(process.execPath) && fs.existsSync(process.execPath)) {
        _detectedCursorExe = process.execPath;
        try {
            void context.globalState.update(DETECTED_CURSOR_EXE_KEY, _detectedCursorExe);
        }
        catch {
            // ignore
        }
        console.log(`[${viewType}] Cursor.exe detected via execPath = ${_detectedCursorExe}`);
        return;
    }
    if (process.platform !== "win32")
        return;
    setTimeout(() => {
        const p = probeCursorExeViaWmi();
        if (p) {
            _detectedCursorExe = p;
            try {
                void context.globalState.update(DETECTED_CURSOR_EXE_KEY, p);
            }
            catch {
                // ignore
            }
            console.log(`[${viewType}] Cursor.exe detected via WMI = ${p}`);
        }
        else {
            console.warn(`[${viewType}] Cursor.exe detection failed; cached=${_detectedCursorExe || "<none>"}`);
        }
    }, 0);
}
/** 返回 Cursor.exe 的多路径候选（按可信度从高到低，自动去重，不做 fs.existsSync 过滤） */
function getCursorExeCandidates() {
    const list = [];
    const push = (p) => {
        if (typeof p !== "string")
            return;
        const t = p.trim();
        if (!t)
            return;
        if (!list.some((x) => x.toLowerCase() === t.toLowerCase()))
            list.push(t);
    };
    // 1. 用户自定义配置（最高优先）
    try {
        const cfg = vscode.workspace.getConfiguration("cursorMcp").get("cursorExePath");
        if (typeof cfg === "string" && cfg.trim())
            push(cfg.trim());
    }
    catch {
        // ignore
    }
    // 2. activate 时锁定的真实 Cursor.exe（本次会话自证，最可靠的自动来源）
    if (_detectedCursorExe)
        push(_detectedCursorExe);
    // 3. 当前正在运行的 Cursor 进程可执行路径（实时 WMI 兜底）
    if (process.platform === "win32") {
        try {
            const r = (0, child_process_1.spawnSync)("powershell.exe", [
                "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
                "(Get-CimInstance Win32_Process -Filter \"Name='Cursor.exe'\" | Where-Object { $_.ExecutablePath } | Select-Object -First 1 ExecutablePath).ExecutablePath",
            ], { encoding: "utf8", windowsHide: true, timeout: 5000 });
            const p = (r.stdout || "").trim();
            if (p)
                push(p);
        }
        catch {
            // ignore
        }
    }
    // 4. 当前扩展 Host 进程的 execPath（通常就是 Cursor.exe）
    if (process.execPath)
        push(process.execPath);
    // 5. 常见硬编码路径
    if (process.platform === "win32") {
        const lad = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
        const pf = process.env.ProgramFiles || "C:\\Program Files";
        const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
        const defaults = [
            path.join(lad, "Programs", "cursor", "Cursor.exe"),
            path.join(lad, "Programs", "Cursor", "Cursor.exe"),
            path.join(pf, "Cursor", "Cursor.exe"),
            path.join(pf86, "Cursor", "Cursor.exe"),
            "C:\\Cursor\\Cursor.exe",
            "D:\\Cursor\\Cursor.exe",
            "E:\\Cursor\\Cursor.exe",
            "F:\\Cursor\\Cursor.exe",
        ];
        for (const p of defaults)
            push(p);
    }
    return list;
}
/** 从候选里选第一个实际存在的，作为"当前可用"的 Cursor.exe 路径（可能返回空字符串） */
function resolveCursorExe() {
    for (const p of getCursorExeCandidates()) {
        try {
            if (fs.existsSync(p))
                return p;
        }
        catch {
            // ignore
        }
    }
    return "";
}
/** 构造 helper PS1：等 Cursor 退出 → 写指纹 → 按 candidates 顺序重启（ShellExecute 模拟双击） */
function buildApplyAndRestartPowerShell(opts) {
    const esc = (s) => String(s == null ? "" : s).replace(/'/g, "''");
    const candidatesPs = "@(" + (opts.candidates || []).map((c) => `'${esc(c)}'`).join(",") + ")";
    const killDirsPs = "@(" + (opts.killDirs || []).map((c) => `'${esc(c)}'`).join(",") + ")";
    const lockStoragePs = opts.lockStorage ? "$true" : "$false";
    return `
$ErrorActionPreference = 'Continue';
$pendingPath = '${esc(opts.pendingPath)}';
$userDir     = '${esc(opts.userDir)}';
$candidates  = ${candidatesPs};
$killDirs    = ${killDirsPs};
$lockStorage = ${lockStoragePs};
$logPath     = Join-Path $env:TEMP ('cursor-mcp-fache-helper-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.log');
function Log($m) { try { Add-Content -LiteralPath $logPath -Value ('[' + (Get-Date -Format 'HH:mm:ss.fff') + '] ' + $m) -Encoding UTF8 } catch {} }
Log ("helper started pid=" + $PID + " candidates=" + ($candidates -join '; '));

function Get-CursorProcesses {
    param([int]$SelfPid)
    $procs = Get-Process -Name 'Cursor' -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $SelfPid }
    if (-not $killDirs -or $killDirs.Count -eq 0) { return $procs }
    return $procs | Where-Object {
        $path = $_.Path
        if (-not $path) { return $false }
        foreach ($d in $killDirs) {
            if ($d -and $path.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
        return $false
    }
}
# 模拟 auto-cursor："先 graceful，失败再 force kill"
try {
    Get-CursorProcesses -SelfPid $PID | ForEach-Object {
        try { $null = $_.CloseMainWindow() } catch {}
    }
} catch {}
$deadline = (Get-Date).AddSeconds(20);
while ((Get-Date) -lt $deadline) {
    $ps = Get-CursorProcesses -SelfPid $PID;
    if (-not $ps) { Log 'cursor processes all exited'; break }
    Log ('force killing ' + ($ps | Measure-Object).Count + ' processes...');
    $ps | Stop-Process -Force -ErrorAction SilentlyContinue;
    Start-Sleep -Milliseconds 500;
}
Start-Sleep -Seconds 2;
$ps = Get-CursorProcesses -SelfPid $PID;
if ($ps) { Log 'some cursor processes still alive; proceeding anyway' }

if (-not (Test-Path $pendingPath)) { Log ("pending missing: " + $pendingPath); exit 1 }
try {
    $raw = [System.IO.File]::ReadAllText($pendingPath, [System.Text.UTF8Encoding]::new($false));
    $pending = $raw | ConvertFrom-Json;
} catch { Log ("parse pending err: " + $_); exit 1 }
$fp = $pending.fp;
$utf8NoBom = New-Object System.Text.UTF8Encoding($false);

if ($fp.machineId) {
    try {
        $miPath = Join-Path $userDir 'machineid';
        $miDir = Split-Path $miPath -Parent; if (-not (Test-Path $miDir)) { New-Item -ItemType Directory -Path $miDir -Force | Out-Null }
        [System.IO.File]::WriteAllText($miPath, [string]$fp.machineId, $utf8NoBom);
        Log ("wrote machineid = " + $fp.machineId);
    } catch { Log ("write machineid err: " + $_) }
}

try {
    $spPath = Join-Path $userDir 'User\\globalStorage\\storage.json';
    $spDir = Split-Path $spPath -Parent; if (-not (Test-Path $spDir)) { New-Item -ItemType Directory -Path $spDir -Force | Out-Null }
    # 写入前先移除只读属性：若上次开启 lockStorage 会在这里卡死
    if (Test-Path $spPath) {
        try { (Get-Item -LiteralPath $spPath).IsReadOnly = $false; Log "storage.json readonly cleared" } catch { Log ("clear readonly err: " + $_) }
    }
    $obj = if (Test-Path $spPath) {
        try { [System.IO.File]::ReadAllText($spPath, $utf8NoBom) | ConvertFrom-Json } catch { New-Object psobject }
    } else { New-Object psobject }
    function Set-Prop([ref]$o, [string]$k, $v) { $o.Value | Add-Member -MemberType NoteProperty -Name $k -Value $v -Force }
    if ($fp.devDeviceId)        { Set-Prop ([ref]$obj) 'telemetry.devDeviceId' $fp.devDeviceId }
    if ($fp.telemetryMachineId) { Set-Prop ([ref]$obj) 'telemetry.machineId' $fp.telemetryMachineId }
    if ($fp.macMachineId)       { Set-Prop ([ref]$obj) 'telemetry.macMachineId' $fp.macMachineId }
    if ($fp.sqmId)              { Set-Prop ([ref]$obj) 'telemetry.sqmId' $fp.sqmId }
    if ($fp.machineId)          { Set-Prop ([ref]$obj) 'storage.serviceMachineId' $fp.machineId }
    $json = $obj | ConvertTo-Json -Depth 100;
    [System.IO.File]::WriteAllText($spPath, $json, $utf8NoBom);
    Log "wrote storage.json";
    if ($lockStorage) {
        try { (Get-Item -LiteralPath $spPath).IsReadOnly = $true; Log "storage.json locked (readonly)" } catch { Log ("lock storage err: " + $_) }
    }
} catch { Log ("write storage err: " + $_) }

try { Remove-Item -LiteralPath $pendingPath -Force -ErrorAction SilentlyContinue } catch {}

# 启动 Cursor：按 candidates 顺序 ShellExecute（等价于双击）+ WorkingDirectory 指到 exe 目录，
# 避免把 helper 的 cwd 当作 Cursor 启动目录。
$launched = $false
foreach ($exe in $candidates) {
    if (-not $exe) { continue }
    if (-not (Test-Path -LiteralPath $exe)) { Log ("candidate missing: " + $exe); continue }
    try {
        $wd = Split-Path -LiteralPath $exe -Parent
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $exe
        $psi.WorkingDirectory = $wd
        $psi.UseShellExecute = $true
        $psi.WindowStyle = 'Normal'
        $p = [System.Diagnostics.Process]::Start($psi) | Out-Null
        Log ("restarted via ShellExecute: " + $exe)
        $launched = $true
        break
    } catch { Log ("restart failed from " + $exe + ": " + $_) }
}
if (-not $launched) {
    # 最后兜底：试 App Paths / where cursor / 快捷方式
    try {
        & cmd.exe /c "start cursor" 2>$null | Out-Null
        Log "restart via 'start cursor' cmd"
    } catch { Log ("final fallback 'start cursor' failed: " + $_) }
}

Log 'helper done';
try { Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue } catch {}
`;
}
/** 安排"退出 Cursor → 后台写入 → 重启"流程。仅 Windows 实现；其它平台回退到直接写。 */
function scheduleApplyAndRestart(fp) {
    if (process.platform !== "win32") {
        const r = applyCursorFingerprint(fp);
        return { mode: "in-place", touched: r.touched, backupDir: r.backupDir, pendingPath: "", guidResult: r.guidResult };
    }
    // MachineGuid 放在主进程（当前用户交互期间）处理：
    // - helper 在 Cursor 退出后才运行，此时再弹 UAC 体验差；
    // - 主进程提前写好也便于在成功对话里即时反馈。
    const mguidMode = getMachineGuidMode();
    let guidResult = null;
    if (fp.machineGuid && mguidMode !== "never") {
        const cur = readWindowsMachineGuid();
        if (cur && cur.toLowerCase() === String(fp.machineGuid).toLowerCase()) {
            guidResult = { ok: true, skipped: true };
        }
        else {
            guidResult = writeWindowsMachineGuid(fp.machineGuid, mguidMode);
        }
    }
    const pendingPath = path.join(os.tmpdir(), `cursor-mcp-fp-pending-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`);
    fs.writeFileSync(pendingPath, JSON.stringify({ fp, ts: Date.now() }, null, 2), "utf-8");
    // 先备份一次，保留可回滚的快照（主进程仍然存活时执行）
    const backupDir = path.join(getCursorUserDir(), FP_BACKUP_DIRNAME);
    try {
        if (!fs.existsSync(backupDir))
            fs.mkdirSync(backupDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const mif = getCursorMachineIdFilePath();
        if (fs.existsSync(mif))
            fs.copyFileSync(mif, path.join(backupDir, `machineid.${stamp}.pre-restart.bak`));
        const sp = getCursorStorageJsonPath();
        if (fs.existsSync(sp))
            fs.copyFileSync(sp, path.join(backupDir, `storage.json.${stamp}.pre-restart.bak`));
    }
    catch {
        // ignore
    }
    const candidates = getCursorExeCandidates().filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
    // kill 范围：候选路径所在的目录（去重），避免误杀与 Cursor 同名但不同路径的进程
    const killDirs = Array.from(new Set(candidates.map((p) => path.dirname(p))));
    const cursorExe = candidates[0] || process.execPath;
    const userDir = getCursorUserDir();
    const lockStorage = !!vscode.workspace.getConfiguration("cursorMcp").get("facheLockStorageAfterApply");
    const script = buildApplyAndRestartPowerShell({ pendingPath, candidates, killDirs, userDir, lockStorage });
    const ps1Path = path.join(os.tmpdir(), `cursor-mcp-fache-helper-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.ps1`);
    // 写 UTF-8 BOM，保证 PowerShell 5.1 能正确识别非 ASCII 字面量
    fs.writeFileSync(ps1Path, "\uFEFF" + script, "utf-8");
    // 关键：走 `start "" /B` 让进程真正脱离 Cursor 扩展 host 的生命周期
    // 直接 spawn("powershell.exe", {detached:true}) 在 Windows 上会用 DETACHED_PROCESS 导致 PS 异常
    const child = (0, child_process_1.spawn)(`start "" /B powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1Path}"`, {
        shell: true,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
    });
    child.unref();
    return { mode: "restart", pendingPath, backupDir, cursorExe, candidates, ps1Path, guidResult, lockStorage };
}
/** 上车公用流程：弹确认对话框 → 走重启或就地模式 → 回发 fcApplyResult */
async function handleApplyFlow(webviewView, fp, meta) {
    const metaHost = (meta && meta.host) || "未知";
    const metaTs = (meta && meta.ts) ? new Date(meta.ts).toLocaleString() : "?";
    const header = `将用车头指纹覆盖本机 Cursor（已自动备份）。\n来源机器：${metaHost}\n时间：${metaTs}`;
    const isWin = process.platform === "win32";
    const primary = isWin ? "关闭并应用" : "确认上车";
    const choice = await vscode.window.showWarningMessage(isWin
        ? `${header}\n\n立即关闭 Cursor 并由后台 helper 写入 → 自动重启。`
        : `${header}\n\n生效前需退出并重启 Cursor。`, { modal: true }, primary);
    if (!choice) {
        webviewView.webview.postMessage({ command: "fcApplyResult", ok: false, msg: "已取消" });
        return;
    }
    if (isWin) {
        try {
            const s = scheduleApplyAndRestart(fp);
            const exeLines = (s.candidates && s.candidates.length)
                ? s.candidates.map((p, i) => `  ${i + 1}. ${p}`).join("\n")
                : "  （未识别到 Cursor 主程序，启动可能失败；请在设置中配置 cursorMcp.cursorExePath）";
            let guidLine = "";
            if (s.guidResult) {
                if (s.guidResult.ok) {
                    guidLine = s.guidResult.skipped
                        ? "\nMachineGuid：已与车头一致，跳过"
                        : "\nMachineGuid：已写入注册表";
                }
                else {
                    guidLine = `\nMachineGuid：未写入（${s.guidResult.msg || "原因未知"}）`;
                }
            }
            const lockLine = s.lockStorage
                ? "\nstorage.json：写入后将被设为只读，阻止 Cursor 启动时回写 devDeviceId（偏好设置将无法保存，可点「解锁 storage.json」恢复）"
                : "";
            webviewView.webview.postMessage({
                command: "fcApplyResult",
                ok: true,
                msg: `已调度后台 helper：\n• 约 2-5 秒后 Cursor 将被关闭\n• 关闭完成后写入指纹（含 devDeviceId）\n• 随后自动重新打开 Cursor\n\n重启候选路径（按顺序尝试）：\n${exeLines}\n\n备份：${s.backupDir}${guidLine}${lockLine}\n任务记录：${s.pendingPath}\nhelper 日志：%TEMP%\\cursor-mcp-fache-helper-*.log`,
                mode: "restart",
                pendingPath: s.pendingPath,
                backupDir: s.backupDir,
                cursorExe: s.cursorExe,
                candidates: s.candidates || [],
                guidResult: s.guidResult || null,
                lockStorage: !!s.lockStorage,
            });
        }
        catch (e) {
            webviewView.webview.postMessage({ command: "fcApplyResult", ok: false, msg: "调度失败：" + String(e) });
        }
        return;
    }
    try {
        const ar = applyCursorFingerprint(fp);
        const warn = ar.guidResult && !ar.guidResult.ok && !ar.guidResult.skipped
            ? `\n注意：MachineGuid 未写入（${ar.guidResult.msg || "需要管理员权限"}）。`
            : "";
        webviewView.webview.postMessage({
            command: "fcApplyResult",
            ok: true,
            msg: `已写入：${ar.touched.join("、") || "（无变化）"}\n备份目录：${ar.backupDir}${warn}\n\n⚠ Cursor 仍在运行，devDeviceId 可能被回写。请完全退出后再打开 Cursor 以确保生效。`,
            mode: "in-place",
            touched: ar.touched,
            backupDir: ar.backupDir,
        });
    }
    catch (e) {
        webviewView.webview.postMessage({ command: "fcApplyResult", ok: false, msg: String(e) });
    }
}
/** 获取发车云端 API 根地址：优先 facheApiBaseUrl，其次 redeemApiBaseUrl */
function getFacheApiBaseUrl() {
    const cfg = vscode.workspace.getConfiguration("cursorMcp");
    const a = cfg.get("facheApiBaseUrl");
    if (typeof a === "string" && a.trim())
        return a.trim().replace(/\/+$/, "");
    const b = cfg.get("redeemApiBaseUrl");
    if (typeof b === "string" && b.trim())
        return b.trim().replace(/\/+$/, "");
    return "";
}
function getFacheTicketTtlMs() {
    const cfg = vscode.workspace.getConfiguration("cursorMcp");
    const v = cfg.get("facheTicketTtlMs");
    const x = typeof v === "number" ? Math.floor(v) : 600000;
    return Math.min(24 * 3600 * 1000, Math.max(60000, x));
}
function getFacheHttpTimeoutMs() {
    const cfg = vscode.workspace.getConfiguration("cursorMcp");
    const v = cfg.get("redeemTimeoutMs");
    const x = typeof v === "number" ? Math.floor(v) : 20000;
    return Math.min(120000, Math.max(3000, x));
}
/** 最小 HTTP 客户端：POST JSON，返回 JSON */
function httpPostJson(baseUrl, pathPart, body, extraHeaders) {
    return new Promise((resolve) => {
        let u;
        try {
            u = new URL(baseUrl + pathPart);
        }
        catch (e) {
            resolve({ ok: false, status: 0, err: "URL 不合法：" + String(e) });
            return;
        }
        const payload = Buffer.from(JSON.stringify(body || {}), "utf-8");
        const mod = u.protocol === "https:" ? https : http;
        const headers = {
            "content-type": "application/json",
            "content-length": String(payload.length),
            "user-agent": "cursor-mcp-fache/1",
            ...(extraHeaders || {}),
        };
        const req = mod.request({
            method: "POST",
            hostname: u.hostname,
            port: u.port || (u.protocol === "https:" ? 443 : 80),
            path: u.pathname + (u.search || ""),
            headers,
        }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(Buffer.from(c)));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf-8");
                let json = null;
                try {
                    json = text ? JSON.parse(text) : null;
                }
                catch {
                    // 非 JSON 响应
                }
                resolve({ ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, status: res.statusCode || 0, json, text });
            });
        });
        req.on("error", (e) => resolve({ ok: false, status: 0, err: String(e) }));
        req.setTimeout(getFacheHttpTimeoutMs(), () => {
            try {
                req.destroy(new Error("timeout"));
            }
            catch {
                // ignore
            }
        });
        req.write(payload);
        req.end();
    });
}
function isValidShortKey(k) {
    return typeof k === "string" && /^sk-[A-Za-z0-9]{17}$/.test(k);
}
/* ===== 扩展自升级（GitHub Releases） ===== */
function getUpdateFeedUrl() {
    const cfg = vscode.workspace.getConfiguration("cursorMcp");
    const v = cfg.get("updateFeedUrl");
    return (typeof v === "string" && v.trim())
        ? v.trim()
        : "https://api.github.com/repos/2029193370/cursor-mcp/releases/latest";
}
/** 数字与预发后缀语义化对比：返回 -1 / 0 / 1 */
function cmpSemver(a, b) {
    const parse = (s) => String(s).replace(/^v/, "").split("-");
    const [an, apre] = parse(a);
    const [bn, bpre] = parse(b);
    const ap = an.split(".").map((x) => parseInt(x, 10) || 0);
    const bp = bn.split(".").map((x) => parseInt(x, 10) || 0);
    const len = Math.max(ap.length, bp.length);
    for (let i = 0; i < len; i++) {
        const x = ap[i] ?? 0;
        const y = bp[i] ?? 0;
        if (x !== y)
            return x < y ? -1 : 1;
    }
    if (!apre && !bpre)
        return 0;
    if (!apre)
        return 1;
    if (!bpre)
        return -1;
    return apre < bpre ? -1 : apre > bpre ? 1 : 0;
}
function httpGetJson(url) {
    return new Promise((resolve) => {
        let u;
        try {
            u = new URL(url);
        }
        catch {
            resolve({ ok: false, status: 0, err: "bad_url" });
            return;
        }
        const mod = u.protocol === "https:" ? https : http;
        const req = mod.get({
            hostname: u.hostname,
            port: u.port || (u.protocol === "https:" ? 443 : 80),
            path: u.pathname + (u.search || ""),
            headers: {
                "user-agent": "cursor-mcp-updater/1",
                "accept": "application/vnd.github+json",
            },
        }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(Buffer.from(c)));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf-8");
                const status = res.statusCode || 0;
                let json = null;
                try {
                    json = text ? JSON.parse(text) : null;
                }
                catch {
                    // ignore parse err
                }
                resolve({ ok: status < 400, status, json, headers: res.headers || {} });
            });
        });
        req.on("error", (e) => resolve({ ok: false, status: 0, err: String((e && e.message) || e) }));
        req.setTimeout(15000, () => {
            try {
                req.destroy(new Error("timeout"));
            }
            catch {
                // ignore
            }
        });
    });
}
/** 从 feedUrl（通常是 GitHub API）推出对应的 Release HTML 页，供降级打开 */
function deriveReleasesHtmlUrl(feedUrl) {
    try {
        const u = new URL(feedUrl);
        if (u.hostname === "api.github.com") {
            const m = /^\/repos\/([^/]+)\/([^/]+)\/releases/.exec(u.pathname);
            if (m)
                return `https://github.com/${m[1]}/${m[2]}/releases/latest`;
        }
        return feedUrl;
    }
    catch {
        return feedUrl;
    }
}
async function fetchLatestReleaseInfo() {
    const feedUrl = getUpdateFeedUrl();
    const derivedHtmlUrl = deriveReleasesHtmlUrl(feedUrl);
    const r = await httpGetJson(feedUrl);
    if (!r.ok) {
        const h = r.headers || {};
        const remaining = Number(h["x-ratelimit-remaining"]);
        const reset = Number(h["x-ratelimit-reset"]);
        let reason = "network";
        if (r.status === 403 && Number.isFinite(remaining) && remaining === 0)
            reason = "rate_limit";
        else if (r.status === 403)
            reason = "forbidden";
        else if (r.status === 404)
            reason = "not_found";
        else if (r.status >= 500)
            reason = "server_error";
        else if (r.status > 0)
            reason = "http_error";
        else if (r.err === "bad_url")
            reason = "bad_url";
        return {
            ok: false,
            reason,
            status: r.status || 0,
            message: (r.json && typeof r.json.message === "string" ? r.json.message : r.err) || "",
            resetAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : 0,
            htmlUrl: derivedHtmlUrl,
        };
    }
    const obj = r.json;
    if (!obj || typeof obj !== "object")
        return { ok: false, reason: "invalid", status: r.status || 0, message: "", resetAt: 0, htmlUrl: derivedHtmlUrl };
    const tag = String(obj.tag_name || "").replace(/^v/, "");
    if (!tag)
        return { ok: false, reason: "invalid", status: r.status || 0, message: "", resetAt: 0, htmlUrl: derivedHtmlUrl };
    const assets = Array.isArray(obj.assets) ? obj.assets : [];
    const vsix = assets.find((a) => a && typeof a.browser_download_url === "string" && /\.vsix$/i.test(String(a.name || "")));
    return {
        ok: true,
        version: tag,
        htmlUrl: typeof obj.html_url === "string" ? obj.html_url : derivedHtmlUrl,
        vsixUrl: vsix ? String(vsix.browser_download_url) : "",
        vsixName: vsix ? String(vsix.name || "") : "",
        notes: typeof obj.body === "string" ? obj.body.slice(0, 4000) : "",
        publishedAt: typeof obj.published_at === "string" ? obj.published_at : "",
    };
}
/** 把 failReason 转成简短中文提示 */
function updateFailHint(info) {
    if (!info)
        return "未知错误";
    if (info.reason === "rate_limit") {
        const when = info.resetAt ? "，" + new Date(info.resetAt).toLocaleTimeString() + " 后恢复" : "";
        return "GitHub API 限流（每小时 60 次/IP）" + when;
    }
    if (info.reason === "network")
        return "无法连接 GitHub（检查网络/代理）";
    if (info.reason === "not_found")
        return "Release 不存在（检查 cursorMcp.updateFeedUrl 配置）";
    if (info.reason === "forbidden")
        return "被拒绝：" + (info.message || "403");
    if (info.reason === "server_error")
        return "GitHub 服务端异常：" + (info.status || "");
    if (info.reason === "invalid")
        return "返回内容无法解析";
    if (info.reason === "bad_url")
        return "updateFeedUrl 配置不合法";
    return info.message || "检查更新失败";
}
/** 跟随 302 下载 vsix 到本地 */
function downloadToFile(url, destPath, maxRedirects = 6) {
    return new Promise((resolve) => {
        const go = (rawUrl, left) => {
            let u;
            try {
                u = new URL(rawUrl);
            }
            catch {
                resolve({ ok: false, err: "URL 解析失败" });
                return;
            }
            const mod = u.protocol === "https:" ? https : http;
            const req = mod.get({
                hostname: u.hostname,
                port: u.port || (u.protocol === "https:" ? 443 : 80),
                path: u.pathname + (u.search || ""),
                headers: { "user-agent": "cursor-mcp-updater/1", "accept": "*/*" },
            }, (res) => {
                const status = res.statusCode || 0;
                if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && left > 0) {
                    res.resume();
                    const next = new URL(res.headers.location, u).toString();
                    go(next, left - 1);
                    return;
                }
                if (status !== 200) {
                    res.resume();
                    resolve({ ok: false, err: `HTTP ${status}` });
                    return;
                }
                fs.mkdirSync(path.dirname(destPath), { recursive: true });
                const ws = fs.createWriteStream(destPath);
                res.pipe(ws);
                ws.on("finish", () => ws.close(() => resolve({ ok: true })));
                ws.on("error", (e) => resolve({ ok: false, err: String(e) }));
            });
            req.on("error", (e) => resolve({ ok: false, err: String(e) }));
            req.setTimeout(120000, () => {
                try {
                    req.destroy(new Error("timeout"));
                }
                catch {
                    // ignore
                }
            });
        };
        go(url, maxRedirects);
    });
}
async function installVsixFromFile(filePath) {
    try {
        await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(filePath));
        return { ok: true };
    }
    catch (e) {
        return { ok: false, err: String(e) };
    }
}



/** MCP 在 mcp.json 中最多注册数量（与 cursor-mcp-1 … cursor-mcp-N 一致） */
const MAX_SESSIONS = 32;
const DEFAULT_SESSION_ORDER = ["1", "2", "3"];
/** 在线购买支付页（与 cursorMcp.payStoreUrl 默认一致；设置留空时用此值） */
const DEFAULT_PAY_STORE_URL = "";
const GLOBAL_STATE_SESSION_KEY = "cursorMcp.sessionMessages.v1";
const GLOBAL_STATE_SESSION_ORDER_KEY = "cursorMcp.sessionOrder.v1";
const GLOBAL_STATE_SESSION_MEMOS_KEY = "cursorMcp.sessionMemos.v1";
const MAX_SESSION_MEMO_CHARS = 200;
function isValidSessionId(id) {
    const n = parseInt(id, 10);
    return Number.isInteger(n) && n >= 1 && n <= MAX_SESSIONS && String(n) === id;
}
/** 去重、校验、按编号排序 */
function normalizeSessionOrder(raw) {
    const arr = Array.isArray(raw) ? raw : [];
    const ids = arr.map((x) => String(x)).filter(isValidSessionId);
    const unique = [...new Set(ids)];
    unique.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    return unique;
}
function readSessionOrder(context) {
    const stored = normalizeSessionOrder(context.globalState.get(GLOBAL_STATE_SESSION_ORDER_KEY));
    if (stored.length > 0)
        return stored;
    return [...DEFAULT_SESSION_ORDER];
}
function readSessionMemos(context) {
    const raw = context.globalState.get(GLOBAL_STATE_SESSION_MEMOS_KEY);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (!isValidSessionId(k))
            continue;
        const s = String(v ?? "")
            .trim()
            .slice(0, MAX_SESSION_MEMO_CHARS);
        if (s)
            out[k] = s;
    }
    return out;
}
const MANAGED_MCP_KEY = /^cursor-mcp-\d+$/;
/** 单条消息里所有附件 Base64 字符总长度上限（约 2MB 量级） */
const MAX_ATTACH_BASE64_CHARS = Math.floor(2.5 * 1024 * 1024);
function parseSendAttachments(message) {
    const images = [];
    const files = [];
    let total = 0;
    const rawImg = message.images;
    if (Array.isArray(rawImg)) {
        for (const x of rawImg) {
            if (!x || typeof x !== "object")
                continue;
            const o = x;
            const mimeType = String(o.mimeType ?? "");
            const data = String(o.data ?? "").replace(/\s/g, "");
            if (!mimeType || !data)
                continue;
            if (!mimeType.startsWith("image/"))
                continue;
            total += data.length;
            if (total > MAX_ATTACH_BASE64_CHARS) {
                return { images: [], files: [], error: "附件总体积过大（单条约 2MB 上限）" };
            }
            images.push({ mimeType, data });
        }
    }
    const rawFiles = message.files;
    if (Array.isArray(rawFiles)) {
        for (const x of rawFiles) {
            if (!x || typeof x !== "object")
                continue;
            const o = x;
            const name = String(o.name ?? "file")
                .replace(/[/\\]/g, "_")
                .slice(0, 240);
            const mimeType = String(o.mimeType ?? "application/octet-stream");
            const data = String(o.data ?? "").replace(/\s/g, "");
            if (!data)
                continue;
            total += data.length;
            if (total > MAX_ATTACH_BASE64_CHARS) {
                return { images: [], files: [], error: "附件总体积过大（单条约 2MB 上限）" };
            }
            files.push({ name, mimeType, data });
        }
    }
    return { images, files };
}
console.log(`[${viewType}] module loaded`);
/** Windows：侧栏 Webview 内无法使用浏览器 Speech API 的麦克风，改用系统语音识别（PowerShell + System.Speech） */
const WIN_VOICE_PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Speech | Out-Null
  $zh = [System.Globalization.CultureInfo]::new('zh-CN')
  $e = $null
  try { $e = New-Object System.Speech.Recognition.SpeechRecognitionEngine($zh) } catch { $e = New-Object System.Speech.Recognition.SpeechRecognitionEngine }
  $e.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $e.SetInputToDefaultAudioDevice()
  $res = $e.Recognize()
  if (-not $res -or -not $res.Text) { exit 2 }
  $b = [System.Text.Encoding]::UTF8.GetBytes($res.Text)
  [Console]::Out.Write([Convert]::ToBase64String($b))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`.trim();
function encodePowerShellCommandBody(body) {
    return Buffer.from(body, "utf16le").toString("base64");
}
function recognizeSpeechWindows(timeoutMs) {
    return new Promise((resolve) => {
        const sysRoot = process.env.SystemRoot || "C:\\Windows";
        const psExe = path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const encoded = encodePowerShellCommandBody(WIN_VOICE_PS_SCRIPT);
        const ps = (0, child_process_1.spawn)(psExe, ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
            windowsHide: true,
        });
        const outChunks = [];
        let stderr = "";
        ps.stdout.on("data", (d) => {
            outChunks.push(Buffer.from(d));
        });
        ps.stderr.on("data", (d) => {
            stderr += d.toString("utf8");
        });
        const timer = setTimeout(() => {
            try {
                ps.kill();
            }
            catch {
                // ignore
            }
        }, timeoutMs);
        ps.on("close", (code) => {
            clearTimeout(timer);
            const stdout = Buffer.concat(outChunks).toString("utf8");
            const b64 = stdout.replace(/\s+/g, "").trim();
            if (code === 0 && b64.length > 0) {
                try {
                    const text = Buffer.from(b64, "base64").toString("utf8");
                    resolve({ ok: true, text });
                }
                catch {
                    resolve({ ok: false, err: "无法解析识别结果" });
                }
                return;
            }
            if (code === 2) {
                resolve({ ok: false, err: "未识别到有效语句，请重试并靠近麦克风说话" });
                return;
            }
            const errLine = stderr.trim() || (code != null ? `识别进程退出码 ${code}` : "识别失败");
            resolve({ ok: false, err: errLine });
        });
        ps.on("error", (e) => {
            clearTimeout(timer);
            resolve({ ok: false, err: String(e) });
        });
    });
}
function activate(context) {
    console.log(`[${viewType}] activate() called`);
    // 激活即探测本次 Cursor.exe 真实路径，供后续"关闭并重启"流程直接使用
    detectAndCacheCursorExe(context);
    // 诊断命令：查看本会话检测到的 Cursor.exe 与所有候选
    context.subscriptions.push(vscode.commands.registerCommand("cursorMcp.showCursorExe", async () => {
        const candidates = getCursorExeCandidates();
        const existing = candidates.filter((p) => { try {
            return fs.existsSync(p);
        }
        catch {
            return false;
        } });
        const detail = [
            `激活时缓存：${_detectedCursorExe || "<未检测到>"}`,
            `process.execPath：${process.execPath || "<空>"}`,
            `process.pid=${process.pid} ppid=${process.ppid ?? "?"}`,
            "",
            "候选（按优先顺序，★=文件存在）：",
            ...candidates.map((p, i) => `  ${i + 1}. ${fs.existsSync(p) ? "★" : "  "} ${p}`),
        ].join("\n");
        const copyBtn = "复制到剪贴板";
        const pick = await vscode.window.showInformationMessage(`Cursor 主程序路径诊断（命中 ${existing.length} / ${candidates.length}）`, { modal: true, detail }, copyBtn);
        if (pick === copyBtn) {
            await vscode.env.clipboard.writeText(detail);
        }
    }));
    // 解锁 storage.json：移除只读属性，便于 Cursor 保存偏好
    context.subscriptions.push(vscode.commands.registerCommand("cursorMcp.unlockStorageJson", async () => {
        const sp = getCursorStorageJsonPath();
        if (!fs.existsSync(sp)) {
            vscode.window.showWarningMessage("storage.json 不存在：" + sp);
            return;
        }
        try {
            const before = fs.statSync(sp).mode;
            const wasReadOnly = (before & 0o200) === 0;
            fs.chmodSync(sp, 0o666);
            vscode.window.showInformationMessage(`已解锁 storage.json${wasReadOnly ? "（之前为只读）" : "（本来就可写）"}：${sp}`);
        }
        catch (e) {
            vscode.window.showErrorMessage("解锁失败：" + String(e));
        }
    }));
    // 配置工作区命令：接收目标路径参数
    context.subscriptions.push(vscode.commands.registerCommand("cursorMcp.configureWorkspace", async (targetPath, sessionOrderOverride) => {
        // 如果没有传入路径，使用当前工作区
        let workspacePath = targetPath;
        if (!workspacePath) {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) {
                throw new Error("请先选择或打开一个工作区文件夹");
            }
            workspacePath = folder.uri.fsPath;
        }
        // 验证路径存在
        if (!fs.existsSync(workspacePath)) {
            throw new Error(`路径不存在：${workspacePath}`);
        }
        const srcDir = path.join(context.extensionPath, "mcp-server");
        const destDir = path.join(os.homedir(), ".cursor", "cursor-mcp-server");
        const copyDir = (src, dest) => {
            if (!fs.existsSync(dest))
                fs.mkdirSync(dest, { recursive: true });
            for (const name of fs.readdirSync(src)) {
                if (name === "node_modules")
                    continue; // 跳过 node_modules
                const s = path.join(src, name);
                const d = path.join(dest, name);
                if (fs.statSync(s).isDirectory())
                    copyDir(s, d);
                else
                    fs.copyFileSync(s, d);
            }
        };
        copyDir(srcDir, destDir);
        const nodeModules = path.join(destDir, "node_modules");
        if (!fs.existsSync(nodeModules)) {
            (0, child_process_1.execSync)("npm install", { cwd: destDir, stdio: "inherit" });
        }
        const cursorDir = path.join(workspacePath, ".cursor");
        const mcpPath = path.join(cursorDir, "mcp.json");
        const mcpServerPath = path.join(destDir, "index.mjs");
        let mcpServers = {};
        if (fs.existsSync(mcpPath)) {
            try {
                const raw = fs.readFileSync(mcpPath, "utf-8");
                const existing = JSON.parse(raw);
                mcpServers = existing.mcpServers ?? {};
            }
            catch {
                mcpServers = {};
            }
        }
        const mcpServerPathNorm = mcpServerPath.replace(/\\/g, "/");
        delete mcpServers["cursor-mcp"];
        for (const key of Object.keys(mcpServers)) {
            if (MANAGED_MCP_KEY.test(key)) {
                delete mcpServers[key];
            }
        }
        let order;
        if (Array.isArray(sessionOrderOverride) && sessionOrderOverride.length > 0) {
            order = normalizeSessionOrder(sessionOrderOverride);
            if (order.length === 0) {
                order = readSessionOrder(context);
            }
        }
        else {
            order = readSessionOrder(context);
        }
        if (order.length === 0) {
            throw new Error("会话列表为空，请先在侧栏至少保留一路会话");
        }
        void context.globalState.update(GLOBAL_STATE_SESSION_ORDER_KEY, order);
        for (const id of order) {
            mcpServers[`cursor-mcp-${id}`] = {
                command: "node",
                args: [mcpServerPathNorm],
                env: { CURSOR_MCP_SESSION: id },
            };
        }
        if (!fs.existsSync(cursorDir)) {
            fs.mkdirSync(cursorDir, { recursive: true });
        }
        fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers }, null, 2), "utf-8");
        // 写入规则文件，让 Cursor 持续调用 check_messages
        const rulesDir = path.join(cursorDir, "rules");
        if (!fs.existsSync(rulesDir)) {
            fs.mkdirSync(rulesDir, { recursive: true });
        }
        const rulePath = path.join(rulesDir, "cursor-mcp.mdc");
        const ruleContent = `---
description: 助手正文只在 Cursor 显示；用 check_messages 保持循环，不向插件镜像长回复
globs:
alwaysApply: true
---

# Cursor MCP 多会话规则

侧栏可「添加/删除会话」管理通道（最多 **${MAX_SESSIONS}** 路）。点击 **「开始配置」** 时，仅按**当前侧栏会话列表**在本工作区 \`mcp.json\` 写入对应的 **cursor-mcp-N**；**增删会话后必须再次配置**，否则 Cursor 里 MCP 列表与插件不一致。每个 Cursor 对话窗口只绑定其中一个 **cursor-mcp-N**。

## 核心规则

1. **先正常对话**：用户寒暄、提问、下任务时，要像普通聊天一样直接回应；**禁止**用「工具正常」「通道已验证」等套话代替回答（例如用户说「你好」就要正常回问候）。
2. **用户要看的内容**：写在 **Cursor 对话窗口**；**默认不传 \`reply\`**。
3. **循环**：每轮回应后**必须立刻**再调用当前 MCP 的 \`check_messages()\`，否则用户会感觉对话被中断。
4. 插件可能**每次只推一条消息**；连发多条会分多次送达，请逐次回复并继续 \`check_messages\`。

## 禁止

- ❌ 长篇解释 MCP/插件原理来代替对用户消息的回复
- ❌ 不调用 \`check_messages\` 就结束（等于中断用户）
- ❌ 等待用户在 Cursor 里打字（用户从插件发消息）

## 流程

\`\`\`
check_messages → 收到插件消息 → 【Cursor 完整回复】→ check_messages() → 等待…
\`\`\`
`;
        fs.writeFileSync(rulePath, ruleContent, "utf-8");
        return { mcpPath, rulePath, destDir, workspacePath, sessionIds: order };
    }));
    context.subscriptions.push(vscode.commands.registerCommand("cursorMcp.generateLicenseKey", async () => {
        const adminPwd = vscode.workspace.getConfiguration("cursorMcp").get("adminPassword") ?? "";
        if (typeof adminPwd === "string" && adminPwd.trim().length > 0) {
            const pw = await vscode.window.showInputBox({
                password: true,
                title: "Cursor MCP 管理员",
                prompt: "请输入管理员密码",
            });
            if (pw !== adminPwd) {
                void vscode.window.showErrorMessage("密码错误");
                return;
            }
        }
        const pick = await vscode.window.showQuickPick([
            { label: "$(infinity) 永久卡", description: "长期有效", dur: "perm" },
            { label: "$(calendar) 天卡", description: "激活后 24 小时", dur: "1d" },
            { label: "$(clock) 小时卡", description: "激活后 1 小时", dur: "1h" },
            { label: "$(watch) 自定义时长", description: "指定分钟数（激活后起算）", dur: "timed" },
        ], { placeHolder: "选择卡密类型", title: "生成 Cursor MCP 卡密" });
        if (!pick)
            return;
        const secret = (0, license_1.getLicenseSecret)();
        let key;
        if (pick.dur === "timed") {
            const rawMin = await vscode.window.showInputBox({
                title: "自定义时长（分钟）",
                prompt: "激活后有效时长，整数分钟",
                placeHolder: "例如 4320 表示 3 天",
                validateInput: (v) => {
                    const n = parseInt(String(v).trim(), 10);
                    if (!Number.isFinite(n) || n < 1 || n > 5256000) {
                        return "请输入 1～5256000 之间的整数（约 10 年）";
                    }
                    return undefined;
                },
            });
            if (rawMin === undefined)
                return;
            const durationMs = parseInt(String(rawMin).trim(), 10) * 60 * 1000;
            key = (0, license_1.generateLicenseToken)(secret, "timed", durationMs);
        }
        else {
            key = (0, license_1.generateLicenseToken)(secret, pick.dur);
        }
        await vscode.env.clipboard.writeText(key);
        const choice = await vscode.window.showInformationMessage(`卡密已复制到剪贴板。\n类型：${pick.label}\n（验证端 settings 中 cursorMcp.licenseSecret 须与发卡时一致）`, "再复制一次");
        if (choice === "再复制一次") {
            await vscode.env.clipboard.writeText(key);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("cursorMcp.clearLicense", async () => {
        const adminPwd = vscode.workspace.getConfiguration("cursorMcp").get("adminPassword") ?? "";
        if (typeof adminPwd === "string" && adminPwd.trim().length > 0) {
            const pw = await vscode.window.showInputBox({
                password: true,
                title: "Cursor MCP",
                prompt: "请输入管理员密码",
            });
            if (pw !== adminPwd) {
                void vscode.window.showErrorMessage("密码错误");
                return;
            }
        }
        const confirm = await vscode.window.showWarningMessage("将清除本机激活状态，需重新输入卡密后才能使用插件。", { modal: true }, "确定清除");
        if (confirm !== "确定清除")
            return;
        await (0, license_1.clearLicenseState)(context);
        await (0, license_1.clearTrialUntilState)(context);
        void vscode.window.showInformationMessage("已清除激活状态，请重新打开侧栏或激活。");
    }));
    const provider = {
        resolveWebviewView(webviewView) {
            console.log(`[${viewType}] resolveWebviewView() called`);
            webviewView.webview.options = {
                enableScripts: true,
                localResourceRoots: [context.extensionUri],
            };
            const nonce = getNonce();
            const extVer = String(context.extension.packageJSON.version ?? "");
            const payStoreRaw = vscode.workspace.getConfiguration("cursorMcp").get("payStoreUrl");
            const payStoreUrl = typeof payStoreRaw === "string" && payStoreRaw.trim() ? payStoreRaw.trim() : DEFAULT_PAY_STORE_URL;
            webviewView.webview.html = getHtml(webviewView.webview, nonce, extVer, payStoreUrl);
            const queueDirFixed = path.join(os.homedir(), ".cursor", "cursor-mcp-messages");
            const lastReplyBySession = {};
            for (let n = 1; n <= MAX_SESSIONS; n++) {
                lastReplyBySession[String(n)] = "";
            }
            const pollIntervalMs = 800;
            const intervalId = setInterval(() => {
                for (let n = 1; n <= MAX_SESSIONS; n++) {
                    const sid = String(n);
                    try {
                        const replyPath = path.join(queueDirFixed, "s", sid, "reply.json");
                        if (!fs.existsSync(replyPath))
                            continue;
                        const raw = fs.readFileSync(replyPath, "utf-8");
                        const parsed = JSON.parse(raw);
                        const ts = String(parsed.timestamp ?? "");
                        if (!ts || ts === lastReplyBySession[sid])
                            continue;
                        lastReplyBySession[sid] = ts;
                        const reply = String(parsed.reply ?? "");
                        webviewView.webview.postMessage({
                            command: "cursorReply",
                            reply,
                            time: ts,
                            sessionId: sid,
                        });
                        try {
                            fs.unlinkSync(replyPath);
                        }
                        catch {
                            // ignore
                        }
                    }
                    catch {
                        // ignore
                    }
                }
            }, pollIntervalMs);
            const sessionOrder = readSessionOrder(context);
            setTimeout(() => {
                webviewView.webview.postMessage({ command: "restoreSessionOrder", order: sessionOrder });
                webviewView.webview.postMessage({ command: "restoreSessionMemos", memos: readSessionMemos(context) });
            }, 50);
            const savedHist = context.globalState.get(GLOBAL_STATE_SESSION_KEY);
            if (savedHist) {
                setTimeout(() => {
                    webviewView.webview.postMessage({ command: "restoreHistories", payload: savedHist });
                }, 100);
            }
            const disposable = webviewView.webview.onDidReceiveMessage(async (message) => {
                if (!message || typeof message !== "object")
                    return;
                const cmd = message.command;
                const cmdStr = typeof cmd === "string" ? cmd : "";
                if (cmdStr === "requestLicenseStatus") {
                    (0, license_1.clearExpiredLicenseIfNeeded)(context);
                    (0, license_1.clearExpiredTrialIfNeeded)(context);
                    await (0, license_1.enforceCloudLicenseRevocationCheck)(context);
                    (0, license_1.clearExpiredLicenseIfNeeded)(context);
                    webviewView.webview.postMessage({
                        command: "licenseStatus",
                        ...(0, license_1.getLicenseStatusForWebview)(context),
                    });
                    return;
                }
                if (cmdStr === "activateLicense") {
                    const key = String(message.key ?? "");
                    const r = await (0, license_1.tryActivateLicenseAsync)(context, key);
                    webviewView.webview.postMessage({
                        command: "licenseActivationResult",
                        ok: r.ok,
                        msg: r.msg,
                    });
                    if (r.ok) {
                        webviewView.webview.postMessage({
                            command: "licenseStatus",
                            ...(0, license_1.getLicenseStatusForWebview)(context),
                        });
                        const ord = readSessionOrder(context);
                        webviewView.webview.postMessage({ command: "restoreSessionOrder", order: ord });
                        webviewView.webview.postMessage({ command: "restoreSessionMemos", memos: readSessionMemos(context) });
                        const hist = context.globalState.get(GLOBAL_STATE_SESSION_KEY);
                        if (hist) {
                            webviewView.webview.postMessage({ command: "restoreHistories", payload: hist });
                        }
                    }
                    return;
                }
                if (cmdStr === "startTrial30") {
                    const r = (0, license_1.tryStartTrial30)(context);
                    webviewView.webview.postMessage({
                        command: "trialResult",
                        ok: r.ok,
                        msg: r.msg,
                    });
                    if (r.ok) {
                        webviewView.webview.postMessage({
                            command: "licenseStatus",
                            ...(0, license_1.getLicenseStatusForWebview)(context),
                        });
                        const ord = readSessionOrder(context);
                        webviewView.webview.postMessage({ command: "restoreSessionOrder", order: ord });
                        webviewView.webview.postMessage({ command: "restoreSessionMemos", memos: readSessionMemos(context) });
                        const hist = context.globalState.get(GLOBAL_STATE_SESSION_KEY);
                        if (hist) {
                            webviewView.webview.postMessage({ command: "restoreHistories", payload: hist });
                        }
                    }
                    return;
                }
                if (cmdStr === "deactivateLicense") {
                    const choice = await vscode.window.showWarningMessage("确定注销激活？清除后需重新输入卡密才能使用本扩展。", { modal: true }, "确定注销");
                    if (choice !== "确定注销") {
                        return;
                    }
                    await (0, license_1.clearLicenseState)(context);
                    await (0, license_1.clearTrialUntilState)(context);
                    webviewView.webview.postMessage({
                        command: "licenseStatus",
                        ...(0, license_1.getLicenseStatusForWebview)(context),
                    });
                    void vscode.window.showInformationMessage("已注销激活");
                    return;
                }
                if (cmdStr === "openPayStore") {
                    const raw = vscode.workspace.getConfiguration("cursorMcp").get("payStoreUrl");
                    const u = typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_PAY_STORE_URL;
                    await vscode.env.openExternal(vscode.Uri.parse(u));
                    return;
                }
                // 选择文件夹
                if (cmd === "selectFolder") {
                    try {
                        const result = await vscode.window.showOpenDialog({
                            canSelectFiles: false,
                            canSelectFolders: true,
                            canSelectMany: false,
                            openLabel: "选择工作区",
                            title: "选择要配置 MCP 的工作区文件夹",
                        });
                        if (result && result.length > 0) {
                            const selectedPath = result[0].fsPath;
                            webviewView.webview.postMessage({
                                command: "folderSelected",
                                path: selectedPath,
                            });
                        }
                    }
                    catch (e) {
                        webviewView.webview.postMessage({
                            command: "folderSelected",
                            path: null,
                            error: String(e),
                        });
                    }
                    return;
                }
                /** 将当前窗口打开的工作区根路径填回侧栏输入框 */
                if (cmd === "requestCurrentWorkspace") {
                    const folder = vscode.workspace.workspaceFolders?.[0];
                    if (folder) {
                        webviewView.webview.postMessage({
                            command: "folderSelected",
                            path: folder.uri.fsPath,
                            fromCurrentWorkspace: true,
                        });
                    }
                    else {
                        webviewView.webview.postMessage({
                            command: "folderSelected",
                            path: null,
                            error: "当前没有打开工作区，请先用「文件 → 打开文件夹」打开一个项目",
                        });
                    }
                    return;
                }
                // 配置工作区（带路径参数）
                if (cmd === "configureWorkspace") {
                    const targetPath = message.path;
                    const orderRaw = message.sessionOrder;
                    const orderFromUi = Array.isArray(orderRaw) ? orderRaw.map((x) => String(x)) : undefined;
                    try {
                        const result = await vscode.commands.executeCommand("cursorMcp.configureWorkspace", targetPath, orderFromUi);
                        const mcpList = (result?.sessionIds ?? []).map((id) => `cursor-mcp-${id}`).join("、");
                        webviewView.webview.postMessage({
                            command: "configResult",
                            ok: true,
                            msg: `已配置 MCP！\n工作区：${result?.workspacePath}\n已按当前侧栏注册 ${result?.sessionIds?.length ?? 0} 路：${mcpList || "（无）"}\n已清理本扩展在旧配置里多余的 cursor-mcp-* 项。\n配置文件：${result?.mcpPath}\n规则：${result?.rulePath}\n保存后 Cursor 会按新列表加载 MCP。`,
                            workspacePath: result?.workspacePath,
                        });
                    }
                    catch (e) {
                        webviewView.webview.postMessage({
                            command: "configResult",
                            ok: false,
                            msg: String(e),
                        });
                    }
                    return;
                }
                if (cmd === "persistSessionOrder") {
                    const raw = message.order;
                    const next = normalizeSessionOrder(raw);
                    if (next.length === 0)
                        return;
                    void context.globalState.update(GLOBAL_STATE_SESSION_ORDER_KEY, next);
                    return;
                }
                if (cmd === "persistSessionMemos") {
                    const raw = message.memos;
                    if (!raw || typeof raw !== "object" || Array.isArray(raw))
                        return;
                    const next = {};
                    for (const [k, v] of Object.entries(raw)) {
                        if (!isValidSessionId(k))
                            continue;
                        const s = String(v ?? "")
                            .trim()
                            .slice(0, MAX_SESSION_MEMO_CHARS);
                        if (s)
                            next[k] = s;
                    }
                    void context.globalState.update(GLOBAL_STATE_SESSION_MEMOS_KEY, next);
                    return;
                }
                if (cmd === "copyCheckPhrase") {
                    const sid = String(message.sessionId ?? "1");
                    if (!isValidSessionId(sid)) {
                        return;
                    }
                    const phrase = `请使用 cursor-mcp-${sid} 的 check_messages`;
                    await vscode.env.clipboard.writeText(phrase);
                    webviewView.webview.postMessage({ command: "copyPhraseResult", ok: true });
                    return;
                }
                if (cmd === "persistHistories") {
                    const payload = message.payload;
                    if (typeof payload === "string") {
                        void context.globalState.update(GLOBAL_STATE_SESSION_KEY, payload);
                    }
                    return;
                }
                if (cmdStr === "voiceInputNative") {
                    if (process.platform !== "win32") {
                        webviewView.webview.postMessage({
                            command: "voiceInputResult",
                            ok: false,
                            msg: "系统语音仅支持 Windows",
                        });
                        return;
                    }
                    const r = await recognizeSpeechWindows(50000);
                    webviewView.webview.postMessage({
                        command: "voiceInputResult",
                        ok: r.ok,
                        text: r.text ?? "",
                        msg: r.err ?? "",
                    });
                    return;
                }
                if (cmd === "sendMessage") {
                    const msgObj = message;
                    const text = String(msgObj.text ?? "").trim();
                    const workspacePath = msgObj.workspacePath;
                    const sessionId = String(msgObj.sessionId ?? "1");
                    if (!isValidSessionId(sessionId)) {
                        webviewView.webview.postMessage({ command: "sendResult", ok: false, msg: "无效会话 ID（超出范围）" });
                        return;
                    }
                    const { images, files, error: attachErr } = parseSendAttachments(msgObj);
                    if (attachErr) {
                        webviewView.webview.postMessage({ command: "sendResult", ok: false, msg: attachErr });
                        return;
                    }
                    if (!text && images.length === 0 && files.length === 0) {
                        webviewView.webview.postMessage({
                            command: "sendResult",
                            ok: false,
                            msg: "请输入文字或添加图片/文件",
                        });
                        return;
                    }
                    const queueDir = path.join(os.homedir(), ".cursor", "cursor-mcp-messages");
                    const sessionDir = path.join(queueDir, "s", sessionId);
                    const queuePath = path.join(sessionDir, "messages.json");
                    if (workspacePath) {
                        const workspaceInfoPath = path.join(queueDir, "workspace.json");
                        try {
                            if (!fs.existsSync(queueDir))
                                fs.mkdirSync(queueDir, { recursive: true });
                            fs.writeFileSync(workspaceInfoPath, JSON.stringify({ workspacePath, time: new Date().toISOString() }, null, 2), "utf-8");
                        }
                        catch {
                            // ignore
                        }
                    }
                    let data = { messages: [] };
                    try {
                        if (fs.existsSync(queuePath)) {
                            data = JSON.parse(fs.readFileSync(queuePath, "utf-8"));
                        }
                    }
                    catch {
                        data = { messages: [] };
                    }
                    data.messages = data.messages ?? [];
                    const entry = {
                        text: text || (images.length || files.length ? "(附件)" : ""),
                        time: new Date().toISOString(),
                    };
                    if (images.length > 0)
                        entry.images = images;
                    if (files.length > 0)
                        entry.files = files;
                    data.messages.push(entry);
                    const attachmentLabels = [];
                    if (images.length > 0)
                        attachmentLabels.push(`图片 ×${images.length}`);
                    if (files.length > 0)
                        attachmentLabels.push(...files.map((f) => f.name));
                    try {
                        if (!fs.existsSync(sessionDir))
                            fs.mkdirSync(sessionDir, { recursive: true });
                        fs.writeFileSync(queuePath, JSON.stringify(data, null, 2), "utf-8");
                        webviewView.webview.postMessage({
                            command: "sendResult",
                            ok: true,
                            msg: `已发送到 MCP-${sessionId}！在对应 Cursor 对话中说「请使用 cursor-mcp-${sessionId} 的 check_messages」获取。`,
                            text: text || "(仅附件)",
                            attachmentLabels,
                            sessionId,
                        });
                    }
                    catch (e) {
                        webviewView.webview.postMessage({ command: "sendResult", ok: false, msg: String(e) });
                    }
                    return;
                }
                if (cmd === "fcGetInfo") {
                    const fp = readCursorFingerprint();
                    const ips = getLocalIps();
                    const cursorExe = resolveCursorExe();
                    const cursorCandidates = getCursorExeCandidates().map((p) => {
                        let exists = false;
                        try { exists = fs.existsSync(p); } catch { exists = false; }
                        return { path: p, exists };
                    });
                    webviewView.webview.postMessage({
                        command: "fcInfo",
                        fp,
                        ips,
                        host: os.hostname(),
                        userDir: getCursorUserDir(),
                        platform: process.platform,
                        defaultTtlMs: getFacheTicketTtlMs(),
                        cursorExe,
                        cursorCandidates,
                    });
                    return;
                }
                if (cmd === "fcCreateTicket") {
                    try {
                        const fp = readCursorFingerprint();
                        if (!fp.machineId && !fp.devDeviceId && !fp.telemetryMachineId) {
                            webviewView.webview.postMessage({
                                command: "fcTicketResult",
                                ok: false,
                                msg: `未在 ${getCursorUserDir()} 读到 Cursor 指纹；请确认 Cursor 已安装并至少启动过一次`,
                            });
                            return;
                        }
                        const ticket = buildTicket(fp, os.hostname(), getLocalIps());
                        webviewView.webview.postMessage({
                            command: "fcTicketResult",
                            ok: true,
                            ticket,
                            fp,
                            host: os.hostname(),
                            ips: getLocalIps(),
                        });
                    }
                    catch (e) {
                        webviewView.webview.postMessage({ command: "fcTicketResult", ok: false, msg: String(e) });
                    }
                    return;
                }
                if (cmd === "fcApplyTicket") {
                    const tok = String(message.ticket ?? "");
                    const parsed = parseTicket(tok);
                    if (!parsed) {
                        webviewView.webview.postMessage({
                            command: "fcApplyResult",
                            ok: false,
                            msg: "无效车票：请复制以 FCT1. 开头的完整字符串",
                        });
                        return;
                    }
                    void context.globalState.update(GLOBAL_STATE_LAST_PICKUP_KEY, {
                        fp: parsed.fp,
                        host: parsed.host || "",
                        ts: parsed.ts || Date.now(),
                        src: "ticket",
                        savedAt: Date.now(),
                    });
                    await handleApplyFlow(webviewView, parsed.fp, {
                        host: parsed.host,
                        ts: parsed.ts,
                    });
                    return;
                }
                if (cmd === "fcOpenBackupDir") {
                    const dir = path.join(getCursorUserDir(), FP_BACKUP_DIRNAME);
                    try {
                        if (!fs.existsSync(dir))
                            fs.mkdirSync(dir, { recursive: true });
                        await vscode.env.openExternal(vscode.Uri.file(dir));
                    }
                    catch (e) {
                        void vscode.window.showErrorMessage("打开备份目录失败：" + String(e));
                    }
                    return;
                }
                if (cmd === "fcCloudPublish") {
                    const base = getFacheApiBaseUrl();
                    if (!base) {
                        webviewView.webview.postMessage({
                            command: "fcCloudPublishResult",
                            ok: false,
                            msg: "云端地址为空：请恢复 cursorMcp.facheApiBaseUrl 默认值，或填入自建地址",
                        });
                        return;
                    }
                    const fp = readCursorFingerprint();
                    if (!fp.machineId && !fp.devDeviceId && !fp.telemetryMachineId) {
                        webviewView.webview.postMessage({
                            command: "fcCloudPublishResult",
                            ok: false,
                            msg: `未在 ${getCursorUserDir()} 读到 Cursor 指纹；请确认 Cursor 已安装并至少启动过一次`,
                        });
                        return;
                    }
                    const reqTtl = Number(message.ttlMs);
                    const ttlMs = Number.isFinite(reqTtl) && reqTtl > 0
                        ? Math.min(24 * 3600 * 1000, Math.max(60000, Math.floor(reqTtl)))
                        : getFacheTicketTtlMs();
                    const tokenRaw = vscode.workspace.getConfiguration("cursorMcp").get("fachePublishToken");
                    const token = typeof tokenRaw === "string" ? tokenRaw.trim() : "";
                    const headers = token ? { authorization: "Bearer " + token } : undefined;
                    const r = await httpPostJson(base, "/api/fache/publish", {
                        fp,
                        host: os.hostname(),
                        ip: getLocalIps(),
                        ttlMs,
                    }, headers);
                    if (r.status === 401) {
                        webviewView.webview.postMessage({
                            command: "fcCloudPublishResult",
                            ok: false,
                            msg: token
                                ? "服务端拒绝：令牌不匹配。请检查 cursorMcp.fachePublishToken 与服务端 PUBLISH_TOKEN 是否一致"
                                : "服务端要求令牌：请在 Cursor 设置中填写 cursorMcp.fachePublishToken",
                        });
                        return;
                    }
                    if (!r.ok) {
                        const detail = r.err || (r.json && r.json.message) || r.text || `HTTP ${r.status}`;
                        webviewView.webview.postMessage({ command: "fcCloudPublishResult", ok: false, msg: "发布失败：" + detail });
                        return;
                    }
                    const key = r.json && typeof r.json.key === "string" ? r.json.key : "";
                    const expiresAt = r.json && typeof r.json.expiresAt === "number" ? r.json.expiresAt : Date.now() + ttlMs;
                    if (!isValidShortKey(key)) {
                        webviewView.webview.postMessage({
                            command: "fcCloudPublishResult",
                            ok: false,
                            msg: "服务端返回的 key 格式不合法（需为 sk- 开头 20 字符）",
                        });
                        return;
                    }
                    webviewView.webview.postMessage({
                        command: "fcCloudPublishResult",
                        ok: true,
                        key,
                        expiresAt,
                        base,
                    });
                    return;
                }
                if (cmd === "fcCloudPickup") {
                    const key = String(message.key ?? "").trim();
                    if (!isValidShortKey(key)) {
                        webviewView.webview.postMessage({
                            command: "fcApplyResult",
                            ok: false,
                            msg: "密钥格式不正确（应形如 sk- 开头、共 20 位）",
                        });
                        return;
                    }
                    const base = getFacheApiBaseUrl();
                    if (!base) {
                        webviewView.webview.postMessage({
                            command: "fcApplyResult",
                            ok: false,
                            msg: "云端地址为空：请恢复 cursorMcp.facheApiBaseUrl 默认值，或填入自建地址",
                        });
                        return;
                    }
                    const r = await httpPostJson(base, "/api/fache/pickup", { key });
                    if (!r.ok) {
                        const detail = r.err || (r.json && r.json.message) || r.text || `HTTP ${r.status}`;
                        webviewView.webview.postMessage({ command: "fcApplyResult", ok: false, msg: "领取失败：" + detail });
                        return;
                    }
                    const parsed = r.json || {};
                    if (!parsed.fp || typeof parsed.fp !== "object") {
                        webviewView.webview.postMessage({ command: "fcApplyResult", ok: false, msg: "服务端未返回指纹数据" });
                        return;
                    }
                    void context.globalState.update(GLOBAL_STATE_LAST_PICKUP_KEY, {
                        fp: parsed.fp,
                        host: parsed.host || "",
                        ts: parsed.ts || Date.now(),
                        src: "cloud",
                        savedAt: Date.now(),
                    });
                    await handleApplyFlow(webviewView, parsed.fp, {
                        host: parsed.host,
                        ts: parsed.ts,
                    });
                    return;
                }
                if (cmd === "fcCopyTicket") {
                    const t = String(message.ticket ?? "");
                    if (t) {
                        await vscode.env.clipboard.writeText(t);
                        webviewView.webview.postMessage({ command: "fcClipboardResult", ok: true });
                    }
                    return;
                }
                if (cmd === "fcUnlockStorage") {
                    try {
                        const sp = getCursorStorageJsonPath();
                        if (!fs.existsSync(sp)) {
                            webviewView.webview.postMessage({ command: "fcUnlockResult", ok: false, msg: "storage.json 不存在：" + sp });
                            return;
                        }
                        const before = fs.statSync(sp).mode;
                        const wasReadOnly = (before & 0o200) === 0;
                        fs.chmodSync(sp, 0o666);
                        webviewView.webview.postMessage({
                            command: "fcUnlockResult",
                            ok: true,
                            wasReadOnly,
                            msg: wasReadOnly ? "已解锁 storage.json（之前为只读）" : "storage.json 本来就是可写的，未做改动",
                        });
                    }
                    catch (e) {
                        webviewView.webview.postMessage({ command: "fcUnlockResult", ok: false, msg: "解锁失败：" + String(e) });
                    }
                    return;
                }
                if (cmd === "fcVerifyFingerprint") {
                    const saved = context.globalState.get(GLOBAL_STATE_LAST_PICKUP_KEY);
                    if (!saved || typeof saved !== "object" || !saved.fp) {
                        webviewView.webview.postMessage({
                            command: "fcVerifyResult",
                            ok: false,
                            msg: "未找到上车记录：请先执行一次「上车」，之后再回来验证",
                        });
                        return;
                    }
                    const actual = readCursorFingerprint();
                    const cmp = compareFingerprints(saved.fp, actual);
                    webviewView.webview.postMessage({
                        command: "fcVerifyResult",
                        ok: true,
                        allMatch: cmp.allMatch,
                        matched: cmp.matched,
                        checked: cmp.checked,
                        rows: cmp.rows,
                        expected: saved.fp,
                        actual,
                        host: saved.host || "",
                        ts: saved.ts || 0,
                        savedAt: saved.savedAt || 0,
                        src: saved.src || "",
                    });
                    return;
                }
                if (cmd === "updateCheck") {
                    const current = String(context.extension.packageJSON.version || "");
                    const info = await fetchLatestReleaseInfo();
                    if (!info || info.ok === false) {
                        webviewView.webview.postMessage({
                            command: "updateCheckResult",
                            ok: false,
                            current,
                            reason: info && info.reason,
                            status: info && info.status,
                            resetAt: info && info.resetAt,
                            htmlUrl: info && info.htmlUrl,
                            msg: updateFailHint(info),
                        });
                        return;
                    }
                    const hasUpdate = cmpSemver(current, info.version) < 0;
                    webviewView.webview.postMessage({
                        command: "updateCheckResult",
                        ok: true,
                        current,
                        latest: info.version,
                        hasUpdate,
                        hasVsix: !!info.vsixUrl,
                        htmlUrl: info.htmlUrl,
                        publishedAt: info.publishedAt,
                        notes: info.notes,
                    });
                    return;
                }
                if (cmd === "updateOpenReleasePage") {
                    const raw = String(message.url ?? "").trim();
                    const target = raw || deriveReleasesHtmlUrl(getUpdateFeedUrl());
                    try {
                        if (target)
                            await vscode.env.openExternal(vscode.Uri.parse(target));
                    }
                    catch {
                        // ignore
                    }
                    return;
                }
                if (cmd === "updateInstall") {
                    const current = String(context.extension.packageJSON.version || "");
                    const info = await fetchLatestReleaseInfo();
                    if (!info || info.ok === false) {
                        webviewView.webview.postMessage({
                            command: "updateInstallResult",
                            ok: false,
                            msg: updateFailHint(info),
                            htmlUrl: info && info.htmlUrl,
                            reason: info && info.reason,
                        });
                        return;
                    }
                    if (cmpSemver(current, info.version) >= 0) {
                        webviewView.webview.postMessage({ command: "updateInstallResult", ok: false, msg: `已是最新：v${current}` });
                        return;
                    }
                    if (!info.vsixUrl) {
                        const go = await vscode.window.showWarningMessage(`v${info.version} 未附带 vsix 资源，打开 Releases 页面手动下载？`, { modal: false }, "打开 Releases");
                        if (go === "打开 Releases" && info.htmlUrl) {
                            await vscode.env.openExternal(vscode.Uri.parse(info.htmlUrl));
                        }
                        webviewView.webview.postMessage({ command: "updateInstallResult", ok: false, msg: "release 未附 vsix" });
                        return;
                    }
                    const tmpPath = path.join(os.tmpdir(), `cursor-mcp-${info.version}.vsix`);
                    webviewView.webview.postMessage({ command: "updateInstallProgress", step: "downloading", version: info.version });
                    const dl = await downloadToFile(info.vsixUrl, tmpPath);
                    if (!dl.ok) {
                        webviewView.webview.postMessage({ command: "updateInstallResult", ok: false, msg: "下载失败：" + (dl.err || "unknown") });
                        return;
                    }
                    webviewView.webview.postMessage({ command: "updateInstallProgress", step: "installing", version: info.version });
                    const ins = await installVsixFromFile(tmpPath);
                    if (!ins.ok) {
                        const go = await vscode.window.showErrorMessage(`自动安装失败：${ins.err || "unknown"}\n\n是否打开 vsix 所在目录手动安装？`, { modal: false }, "打开目录");
                        if (go === "打开目录") {
                            await vscode.env.openExternal(vscode.Uri.file(path.dirname(tmpPath)));
                        }
                        webviewView.webview.postMessage({ command: "updateInstallResult", ok: false, msg: "安装失败：" + (ins.err || "") });
                        return;
                    }
                    webviewView.webview.postMessage({
                        command: "updateInstallResult",
                        ok: true,
                        version: info.version,
                        msg: `v${info.version} 安装完成，请重新加载窗口使新版生效。`,
                    });
                    const reload = await vscode.window.showInformationMessage(`Cursor MCP 已升级到 v${info.version}，建议立即重新加载窗口。`, "立即重新加载", "稍后");
                    if (reload === "立即重新加载") {
                        await vscode.commands.executeCommand("workbench.action.reloadWindow");
                    }
                    return;
                }
                if (cmd === "ping") {
                    const text = String(message.text ?? "");
                    console.log(`[${viewType}] onDidReceiveMessage ping, text=`, text);
                    webviewView.webview.postMessage({ command: "pong", text, time: new Date().toISOString() });
                }
            });
            context.subscriptions.push(disposable);
            context.subscriptions.push({ dispose: () => clearInterval(intervalId) });
        },
    };
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(viewType, provider));
}
exports.activate = activate;
function deactivate() { }
exports.deactivate = deactivate;
function escapeHtmlText(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function getHtml(webview, nonce, extensionVersion, payStoreUrl) {
    const payUrlDisplay = escapeHtmlText(payStoreUrl);
    const csp = `
    default-src 'none';
    img-src ${webview.cspSource} data:;
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
  `.replace(/\s+/g, " ").trim();
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Cursor MCP</title>
  <style>
    :root {
      --bg-primary: #1e1e2e;
      --bg-secondary: #313244;
      --bg-tertiary: #45475a;
      --text-primary: #cdd6f4;
      --text-secondary: #a6adc8;
      --text-muted: #6c7086;
      --accent: #89b4fa;
      --accent-hover: #b4befe;
      --success: #a6e3a1;
      --error: #f38ba8;
      --warning: #f9e2af;
      --border: #45475a;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: 8px;
      font-size: 13px;
      line-height: 1.5;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #licenseGate { display: none !important; }
    .license-gate {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      justify-content: center;
      max-width: 380px;
      margin: 0 auto;
      width: 100%;
      gap: 10px;
      min-height: 0;
    }
    .license-gate-head {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }
    .license-logo { font-size: 18px; font-weight: 700; text-align: center; letter-spacing: 0.02em; }
    .license-gate .header-version { margin-top: 0; }
    .license-desc { font-size: 12px; color: var(--text-muted); text-align: center; line-height: 1.45; }
    .license-pay-strip {
      width: 100%;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid rgba(137, 180, 250, 0.35);
      background: rgba(137, 180, 250, 0.08);
      text-align: center;
    }
    .license-pay-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--accent);
      margin-bottom: 6px;
      letter-spacing: 0.02em;
    }
    .license-pay-url {
      font-family: ui-monospace, Consolas, monospace;
      font-size: 10px;
      color: var(--text-secondary);
      word-break: break-all;
      line-height: 1.4;
      margin-bottom: 8px;
      user-select: all;
    }
    .btn-pay-store {
      width: 100%;
      padding: 8px 12px;
      border-radius: 8px;
      border: 1px solid var(--accent);
      background: rgba(137, 180, 250, 0.15);
      color: var(--accent-hover);
      font-weight: 600;
      font-size: 12px;
      cursor: pointer;
    }
    .btn-pay-store:hover { filter: brightness(1.12); background: rgba(137, 180, 250, 0.22); }
    .license-key-input {
      width: 100%;
      padding: 10px 11px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 12px;
      font-family: ui-monospace, Consolas, monospace;
      outline: none;
    }
    .license-key-input:focus { border-color: var(--accent); }
    .license-actions { display: flex; flex-direction: column; gap: 8px; width: 100%; }
    .license-gate .btn-primary { width: 100%; justify-content: center; }
    .btn-trial {
      width: 100%;
      padding: 9px 12px;
      border-radius: 8px;
      border: 1px dashed var(--border);
      background: transparent;
      color: var(--accent);
      font-weight: 600;
      font-size: 12px;
      cursor: pointer;
    }
    .btn-trial:hover { background: rgba(137, 180, 250, 0.1); border-style: solid; }
    .license-foot { font-size: 9px; color: var(--text-muted); text-align: center; margin-top: 8px; line-height: 1.45; }
    #licenseFeedback { margin-top: 4px; }
    .app-layout {
      display: flex;
      flex: 1;
      gap: 0;
      min-height: 0;
      align-items: stretch;
    }
    .rail-resizer {
      width: 6px;
      flex-shrink: 0;
      margin: 0 2px;
      cursor: col-resize;
      align-self: stretch;
      border-radius: 4px;
      background: transparent;
      transition: background 0.15s;
    }
    .rail-resizer:hover,
    .rail-resizer.is-dragging {
      background: rgba(137, 180, 250, 0.35);
    }
    .session-rail {
      min-width: 56px;
      max-width: 220px;
      width: 88px;
      flex-shrink: 0;
      background: var(--bg-secondary);
      border-radius: 8px;
      padding: 8px 6px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-items: stretch;
      box-sizing: border-box;
    }
    .session-rail-title {
      font-size: 10px;
      font-weight: 600;
      color: var(--text-muted);
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .session-item {
      border: 1px solid transparent;
      padding: 8px 4px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: box-shadow 0.15s, border-color 0.15s, filter 0.15s;
    }
    .session-item:hover { filter: brightness(1.08); }
    .session-item.active {
      box-shadow: 0 0 0 2px var(--sess-ring, rgba(137, 180, 250, 0.55));
    }
    /* 12 色循环：MCP 编号按 (N-1)%12 取色，便于一眼区分各路 */
    .session-item.session-tone-0 { --sess-ring: rgba(34, 211, 238, 0.65); background: rgba(34, 211, 238, 0.14); border-color: rgba(34, 211, 238, 0.42); color: #a5f3fc; }
    .session-item.session-tone-1 { --sess-ring: rgba(96, 165, 250, 0.65); background: rgba(96, 165, 250, 0.14); border-color: rgba(96, 165, 250, 0.42); color: #bfdbfe; }
    .session-item.session-tone-2 { --sess-ring: rgba(129, 140, 248, 0.65); background: rgba(129, 140, 248, 0.14); border-color: rgba(129, 140, 248, 0.42); color: #c7d2fe; }
    .session-item.session-tone-3 { --sess-ring: rgba(192, 132, 252, 0.65); background: rgba(192, 132, 252, 0.14); border-color: rgba(192, 132, 252, 0.42); color: #e9d5ff; }
    .session-item.session-tone-4 { --sess-ring: rgba(244, 114, 182, 0.65); background: rgba(244, 114, 182, 0.14); border-color: rgba(244, 114, 182, 0.42); color: #fbcfe8; }
    .session-item.session-tone-5 { --sess-ring: rgba(251, 113, 133, 0.65); background: rgba(251, 113, 133, 0.14); border-color: rgba(251, 113, 133, 0.42); color: #fecdd3; }
    .session-item.session-tone-6 { --sess-ring: rgba(251, 146, 60, 0.65); background: rgba(251, 146, 60, 0.14); border-color: rgba(251, 146, 60, 0.42); color: #fed7aa; }
    .session-item.session-tone-7 { --sess-ring: rgba(250, 204, 21, 0.65); background: rgba(250, 204, 21, 0.14); border-color: rgba(250, 204, 21, 0.42); color: #fef08a; }
    .session-item.session-tone-8 { --sess-ring: rgba(163, 230, 53, 0.65); background: rgba(163, 230, 53, 0.14); border-color: rgba(163, 230, 53, 0.42); color: #d9f99d; }
    .session-item.session-tone-9 { --sess-ring: rgba(52, 211, 153, 0.65); background: rgba(52, 211, 153, 0.14); border-color: rgba(52, 211, 153, 0.42); color: #a7f3d0; }
    .session-item.session-tone-10 { --sess-ring: rgba(45, 212, 191, 0.65); background: rgba(45, 212, 191, 0.14); border-color: rgba(45, 212, 191, 0.42); color: #99f6e4; }
    .session-item.session-tone-11 { --sess-ring: rgba(125, 211, 252, 0.65); background: rgba(125, 211, 252, 0.14); border-color: rgba(125, 211, 252, 0.42); color: #bae6fd; }

    .session-memo-strip {
      border-radius: 8px;
      padding: 8px 10px;
      margin-bottom: 10px;
      border: 1px solid var(--border);
      border-left-width: 4px;
      background: var(--bg-secondary);
    }
    .session-memo-strip.session-tone-0 { border-left-color: #22d3ee; background: linear-gradient(90deg, rgba(34, 211, 238, 0.1) 0%, var(--bg-secondary) 48%); }
    .session-memo-strip.session-tone-1 { border-left-color: #60a5fa; background: linear-gradient(90deg, rgba(96, 165, 250, 0.1) 0%, var(--bg-secondary) 48%); }
    .session-memo-strip.session-tone-2 { border-left-color: #818cf8; background: linear-gradient(90deg, rgba(129, 140, 248, 0.1) 0%, var(--bg-secondary) 48%); }
    .session-memo-strip.session-tone-3 { border-left-color: #c084fc; background: linear-gradient(90deg, rgba(192, 132, 252, 0.1) 0%, var(--bg-secondary) 48%); }
    .session-memo-strip.session-tone-4 { border-left-color: #f472b6; background: linear-gradient(90deg, rgba(244, 114, 182, 0.1) 0%, var(--bg-secondary) 48%); }
    .session-memo-strip.session-tone-5 { border-left-color: #fb7185; background: linear-gradient(90deg, rgba(251, 113, 133, 0.1) 0%, var(--bg-secondary) 48%); }
    .session-memo-strip.session-tone-6 { border-left-color: #fb923c; background: linear-gradient(90deg, rgba(251, 146, 60, 0.1) 0%, var(--bg-secondary) 48%); }
    .session-memo-strip.session-tone-7 { border-left-color: #facc15; background: linear-gradient(90deg, rgba(250, 204, 21, 0.1) 0%, var(--bg-secondary) 48%); }
    .session-memo-strip.session-tone-8 { border-left-color: #a3e635; background: linear-gradient(90deg, rgba(163, 230, 53, 0.1) 0%, var(--bg-secondary) 48%); }
    .session-memo-strip.session-tone-9 { border-left-color: #34d399; background: linear-gradient(90deg, rgba(52, 211, 153, 0.1) 0%, var(--bg-secondary) 48%); }
    .session-memo-strip.session-tone-10 { border-left-color: #2dd4bf; background: linear-gradient(90deg, rgba(45, 212, 191, 0.1) 0%, var(--bg-secondary) 48%); }
    .session-memo-strip.session-tone-11 { border-left-color: #7dd3fc; background: linear-gradient(90deg, rgba(125, 211, 252, 0.1) 0%, var(--bg-secondary) 48%); }
    .session-memo-strip-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    .session-memo-badge {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      letter-spacing: 0.02em;
    }
    .session-memo-hint { font-size: 10px; color: var(--text-muted); }
    .session-memo-input {
      width: 100%;
      padding: 7px 9px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 12px;
      outline: none;
    }
    .session-memo-input:focus { border-color: var(--accent); }
    .session-memo-input::placeholder { color: var(--text-muted); font-size: 11px; }

    .send-message-section.session-tone-0 { border-left: 4px solid #22d3ee; background: linear-gradient(180deg, rgba(34, 211, 238, 0.06) 0%, var(--bg-secondary) 36%); }
    .send-message-section.session-tone-1 { border-left: 4px solid #60a5fa; background: linear-gradient(180deg, rgba(96, 165, 250, 0.06) 0%, var(--bg-secondary) 36%); }
    .send-message-section.session-tone-2 { border-left: 4px solid #818cf8; background: linear-gradient(180deg, rgba(129, 140, 248, 0.06) 0%, var(--bg-secondary) 36%); }
    .send-message-section.session-tone-3 { border-left: 4px solid #c084fc; background: linear-gradient(180deg, rgba(192, 132, 252, 0.06) 0%, var(--bg-secondary) 36%); }
    .send-message-section.session-tone-4 { border-left: 4px solid #f472b6; background: linear-gradient(180deg, rgba(244, 114, 182, 0.06) 0%, var(--bg-secondary) 36%); }
    .send-message-section.session-tone-5 { border-left: 4px solid #fb7185; background: linear-gradient(180deg, rgba(251, 113, 133, 0.06) 0%, var(--bg-secondary) 36%); }
    .send-message-section.session-tone-6 { border-left: 4px solid #fb923c; background: linear-gradient(180deg, rgba(251, 146, 60, 0.06) 0%, var(--bg-secondary) 36%); }
    .send-message-section.session-tone-7 { border-left: 4px solid #facc15; background: linear-gradient(180deg, rgba(250, 204, 21, 0.06) 0%, var(--bg-secondary) 36%); }
    .send-message-section.session-tone-8 { border-left: 4px solid #a3e635; background: linear-gradient(180deg, rgba(163, 230, 53, 0.06) 0%, var(--bg-secondary) 36%); }
    .send-message-section.session-tone-9 { border-left: 4px solid #34d399; background: linear-gradient(180deg, rgba(52, 211, 153, 0.06) 0%, var(--bg-secondary) 36%); }
    .send-message-section.session-tone-10 { border-left: 4px solid #2dd4bf; background: linear-gradient(180deg, rgba(45, 212, 191, 0.06) 0%, var(--bg-secondary) 36%); }
    .send-message-section.session-tone-11 { border-left: 4px solid #7dd3fc; background: linear-gradient(180deg, rgba(125, 211, 252, 0.06) 0%, var(--bg-secondary) 36%); }
    .send-message-section .section-title { display: flex; align-items: center; gap: 8px; }
    .send-section-color-dot {
      width: 8px; height: 8px; border-radius: 50%;
      flex-shrink: 0;
    }
    .send-message-section.session-tone-0 .send-section-color-dot { background: #22d3ee; }
    .send-message-section.session-tone-1 .send-section-color-dot { background: #60a5fa; }
    .send-message-section.session-tone-2 .send-section-color-dot { background: #818cf8; }
    .send-message-section.session-tone-3 .send-section-color-dot { background: #c084fc; }
    .send-message-section.session-tone-4 .send-section-color-dot { background: #f472b6; }
    .send-message-section.session-tone-5 .send-section-color-dot { background: #fb7185; }
    .send-message-section.session-tone-6 .send-section-color-dot { background: #fb923c; }
    .send-message-section.session-tone-7 .send-section-color-dot { background: #eab308; }
    .send-message-section.session-tone-8 .send-section-color-dot { background: #a3e635; }
    .send-message-section.session-tone-9 .send-section-color-dot { background: #34d399; }
    .send-message-section.session-tone-10 .send-section-color-dot { background: #2dd4bf; }
    .send-message-section.session-tone-11 .send-section-color-dot { background: #7dd3fc; }
    .session-row {
      display: flex;
      align-items: stretch;
      gap: 4px;
    }
    .session-row .session-item { flex: 1; min-width: 0; }
    .session-del {
      flex-shrink: 0;
      width: 26px;
      border: 1px solid var(--border);
      background: var(--bg-primary);
      color: var(--text-muted);
      border-radius: 6px;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      padding: 0;
    }
    .session-del:hover { color: var(--error); border-color: var(--error); }
    .btn-add-session {
      width: 100%;
      margin-top: 6px;
      padding: 6px 4px;
      border: 1px dashed var(--border);
      border-radius: 6px;
      background: transparent;
      color: var(--accent);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-add-session:hover { border-color: var(--accent); background: rgba(137,180,250,0.08); }
    .btn-add-session:disabled { opacity: 0.4; cursor: not-allowed; }
    .session-rail-hint {
      font-size: 8px;
      color: var(--text-muted);
      line-height: 1.35;
      margin-top: 4px;
      text-align: center;
    }
    .app-main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 0;
      overflow-y: auto;
      overflow-x: hidden;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 12px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
    }
    .header h2 { font-size: 15px; font-weight: 600; flex-shrink: 0; }
    .header-version {
      font-size: 10px;
      font-weight: 500;
      color: var(--text-muted);
      font-family: ui-monospace, Consolas, monospace;
      padding: 2px 8px;
      border-radius: 6px;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      flex-shrink: 0;
    }
    .update-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 9px;
      font-size: 10px;
      font-weight: 700;
      border-radius: 999px;
      border: 1px solid rgba(166, 227, 161, 0.55);
      background: rgba(166, 227, 161, 0.12);
      color: var(--success);
      cursor: pointer;
      letter-spacing: 0.02em;
      transition: filter 0.15s, background 0.15s;
    }
    .update-badge:hover { filter: brightness(1.12); background: rgba(166, 227, 161, 0.2); }
    .update-badge.busy { color: var(--warning); border-color: rgba(249, 226, 175, 0.55); background: rgba(249, 226, 175, 0.12); pointer-events: none; }
    .update-badge .update-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: currentColor;
      box-shadow: 0 0 0 2px rgba(166, 227, 161, 0.25);
      animation: pulse 1.8s infinite;
    }
    .status-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--text-muted);
      transition: background 0.3s;
    }
    .status-dot.connected { background: var(--success); }
    .status-dot.pending { background: var(--warning); animation: pulse 1.5s infinite; }
    .status-dot.error { background: var(--error); }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

    .section {
      background: var(--bg-secondary);
      border-radius: 8px;
      padding: 10px;
      margin-bottom: 10px;
    }
    .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 8px;
      letter-spacing: 0.5px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      border: none;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }
    .btn:hover { background: var(--accent); color: var(--bg-primary); }
    .btn:active { transform: scale(0.98); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: var(--accent); color: var(--bg-primary); }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-small { padding: 5px 10px; font-size: 11px; }

    .path-input-group {
      display: flex;
      gap: 6px;
      margin-bottom: 8px;
    }
    .path-input {
      flex: 1;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 11px;
      outline: none;
      font-family: 'Consolas', 'Monaco', monospace;
    }
    .path-input:focus { border-color: var(--accent); }
    .path-input::placeholder { color: var(--text-muted); }

    .btn-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .input-actions {
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
      align-items: stretch;
    }
    .btn-voice {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 7px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s, border-color 0.2s, box-shadow 0.2s;
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }
    .btn-voice:hover { border-color: var(--accent); color: var(--accent); }
    .btn-voice:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn-voice.listening {
      border-color: rgba(243, 139, 168, 0.55);
      color: #f38ba8;
      box-shadow: 0 0 0 2px rgba(243, 139, 168, 0.2);
      animation: pulse 1.2s ease-in-out infinite;
    }
    .input-group {
      display: flex;
      gap: 8px;
      margin-top: 8px;
      align-items: flex-end;
    }
    .input-group input,
    .input-group textarea {
      flex: 1;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 12px;
      outline: none;
    }
    .input-group textarea {
      min-height: 40px;
      max-height: 160px;
      resize: vertical;
      font-family: inherit;
      line-height: 1.45;
    }
    .input-group input:focus,
    .input-group textarea:focus { border-color: var(--accent); }
    .input-group input::placeholder,
    .input-group textarea::placeholder { color: var(--text-muted); }

    .fc-section { border: 1px solid rgba(137, 180, 250, 0.25); }
    .fc-emoji { margin-right: 4px; }
    .fc-role-tabs {
      display: flex;
      gap: 6px;
      margin: 6px 0 10px;
    }
    .fc-tab {
      flex: 1;
      padding: 6px 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-primary);
      color: var(--text-secondary);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .fc-tab:hover { color: var(--accent); border-color: var(--accent); }
    .fc-tab.active { background: rgba(137, 180, 250, 0.15); color: var(--accent-hover); border-color: var(--accent); }
    .fc-meta-box {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-primary);
      margin-bottom: 10px;
      overflow: hidden;
    }
    .fc-meta-head {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: var(--bg-tertiary);
      border-bottom: 1px solid var(--border);
    }
    .fc-meta-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: 0.02em;
    }
    .fc-meta-time {
      font-size: 10px;
      color: var(--text-muted);
      margin-left: 6px;
      font-family: ui-monospace, Consolas, monospace;
      flex: 1;
    }
    .fc-meta {
      font-size: 11px;
      color: var(--text-secondary);
      padding: 8px 10px;
      font-family: ui-monospace, Consolas, monospace;
      line-height: 1.6;
      max-height: 220px;
      overflow-y: auto;
    }
    .fc-meta .fc-row {
      display: flex;
      gap: 6px;
      align-items: center;
      padding: 2px 0;
    }
    .fc-meta .fc-row + .fc-row { border-top: 1px dashed rgba(108,112,134,0.2); }
    .fc-meta .fc-key {
      color: var(--text-muted);
      min-width: 120px;
      flex-shrink: 0;
      font-weight: 600;
    }
    .fc-meta .fc-val {
      flex: 1;
      color: var(--text-primary);
      word-break: break-all;
      user-select: all;
      min-width: 0;
    }
    .fc-meta .fc-empty { color: var(--warning); font-style: italic; }
    .fc-meta .fc-copy {
      flex-shrink: 0;
      padding: 1px 6px;
      font-size: 10px;
      color: var(--text-muted);
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 4px;
      cursor: pointer;
    }
    .fc-meta .fc-copy:hover { color: var(--accent); border-color: var(--accent); }
    .fc-meta .fc-copy:disabled { opacity: 0.3; cursor: not-allowed; }
    .fc-ticket {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 11px;
      font-family: ui-monospace, Consolas, monospace;
      outline: none;
      resize: vertical;
      min-height: 60px;
      max-height: 180px;
      margin-bottom: 8px;
      word-break: break-all;
    }
    .fc-ticket:focus { border-color: var(--accent); }
    .fc-key-box {
      margin: 0 0 8px;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid rgba(166, 227, 161, 0.35);
      background: rgba(166, 227, 161, 0.08);
    }
    .fc-key-line {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .fc-key-label {
      font-size: 10px;
      font-weight: 700;
      color: var(--success);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .fc-key-value {
      flex: 1;
      min-width: 180px;
      font-family: ui-monospace, Consolas, monospace;
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
      background: var(--bg-primary);
      padding: 6px 10px;
      border-radius: 6px;
      user-select: all;
      letter-spacing: 0.04em;
      cursor: text;
    }
    .fc-key-hint {
      font-size: 11px;
      color: var(--text-secondary);
      margin-top: 6px;
    }
    .fc-key-hint.expired { color: var(--error); }
    .fc-ttl-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin: 0 0 8px;
    }
    .fc-ttl-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
    }
    .fc-ttl-select, .fc-ttl-custom {
      padding: 5px 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 11px;
      outline: none;
    }
    .fc-ttl-select:focus, .fc-ttl-custom:focus { border-color: var(--accent); }
    .fc-ttl-custom { width: 90px; }
    .fc-ttl-hint { flex: 1; min-width: 120px; }

    .fc-verify-box {
      margin-top: 10px;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg-primary);
      font-size: 11px;
      animation: fadeIn 0.3s;
    }
    .fc-verify-box.ok { border-color: rgba(166,227,161,0.45); background: rgba(166,227,161,0.08); }
    .fc-verify-box.bad { border-color: rgba(243,139,168,0.45); background: rgba(243,139,168,0.08); }
    .fc-verify-head {
      font-weight: 700;
      font-size: 12px;
      margin-bottom: 6px;
    }
    .fc-verify-head .ok { color: var(--success); }
    .fc-verify-head .bad { color: var(--error); }
    .fc-verify-sub {
      color: var(--text-secondary);
      font-size: 10px;
      margin-bottom: 8px;
    }
    .fc-verify-row {
      display: grid;
      grid-template-columns: 16px 1fr;
      gap: 6px;
      padding: 3px 0;
      align-items: flex-start;
      border-top: 1px dashed var(--border);
    }
    .fc-verify-row:first-of-type { border-top: none; }
    .fc-verify-icon {
      font-weight: 700;
      line-height: 18px;
      text-align: center;
    }
    .fc-verify-icon.match { color: var(--success); }
    .fc-verify-icon.mismatch { color: var(--error); }
    .fc-verify-icon.skipped { color: var(--text-secondary); }
    .fc-verify-field {
      font-family: ui-monospace, Consolas, monospace;
      font-size: 11px;
      line-height: 1.4;
      word-break: break-all;
    }
    .fc-verify-field .k { color: var(--text-primary); font-weight: 600; }
    .fc-verify-field .kv { color: var(--text-secondary); display: block; }
    .fc-verify-field .kv.actual.mismatch { color: var(--error); }

    .feedback {
      margin-top: 8px;
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 11px;
      display: none;
      animation: fadeIn 0.3s;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .feedback.show { display: block; }
    .feedback.success { background: rgba(166,227,161,0.15); color: var(--success); border: 1px solid rgba(166,227,161,0.3); }
    .feedback.error { background: rgba(243,139,168,0.15); color: var(--error); border: 1px solid rgba(243,139,168,0.3); }
    .feedback.info { background: rgba(137,180,250,0.15); color: var(--accent); border: 1px solid rgba(137,180,250,0.3); }
    .feedback.pending { background: rgba(249,226,175,0.15); color: var(--warning); border: 1px solid rgba(249,226,175,0.3); }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }

    .chat-container {
      max-height: 280px;
      overflow-y: auto;
      background: var(--bg-primary);
      border-radius: 6px;
      padding: 8px;
      border: 1px solid var(--border);
    }
    .chat-container::-webkit-scrollbar { width: 5px; }
    .chat-container::-webkit-scrollbar-track { background: var(--bg-secondary); }
    .chat-container::-webkit-scrollbar-thumb { background: var(--bg-tertiary); border-radius: 3px; }

    .message {
      padding: 8px 10px;
      border-radius: 8px;
      margin-bottom: 8px;
      animation: slideIn 0.3s;
    }
    .message:last-child { margin-bottom: 0; }
    @keyframes slideIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    .message.user { background: var(--bg-tertiary); margin-left: 16px; }
    .message.cursor { background: rgba(137,180,250,0.1); border: 1px solid rgba(137,180,250,0.2); margin-right: 16px; }
    .message.system { background: rgba(249,226,175,0.1); border: 1px solid rgba(249,226,175,0.2); font-size: 11px; color: var(--text-secondary); }
    .message-header { display: flex; justify-content: space-between; margin-bottom: 4px; }
    .message-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .message.user .message-label { color: var(--text-muted); }
    .message.cursor .message-label { color: var(--accent); }
    .message-time { font-size: 10px; color: var(--text-muted); }
    .message-content { color: var(--text-primary); white-space: pre-wrap; word-break: break-word; font-size: 12px; }

    .empty-state { text-align: center; padding: 20px; color: var(--text-muted); }
    .empty-state svg { width: 40px; height: 40px; margin-bottom: 8px; opacity: 0.5; }
    .hint { font-size: 10px; color: var(--text-muted); margin-top: 6px; }

    .loading-spinner {
      display: inline-block;
      width: 12px; height: 12px;
      border: 2px solid var(--bg-tertiary);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .current-path {
      font-size: 10px;
      color: var(--text-muted);
      margin-top: 4px;
      padding: 4px 8px;
      background: var(--bg-primary);
      border-radius: 4px;
      font-family: 'Consolas', 'Monaco', monospace;
      word-break: break-all;
    }
    .current-path.set { color: var(--success); }

    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }
    .section-head .section-title { margin-bottom: 0; }

    .attach-row {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      gap: 8px;
      margin-top: 8px;
    }
    .attach-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      flex: 1;
      min-width: 0;
    }
    .attach-chip {
      font-size: 10px;
      padding: 3px 6px 3px 8px;
      background: var(--bg-tertiary);
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 100%;
    }
    .attach-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; }
    .attach-chip .rm {
      border: none;
      background: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 0 4px;
      font-size: 12px;
      line-height: 1;
    }
    .attach-chip .rm:hover { color: var(--error); }
    #filePick { display: none; }

    #messagesList { min-height: 0; }

    .hint-row { margin-top: 6px; }
    .hint-copy-line {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      flex-wrap: wrap;
    }
    .hint-code {
      flex: 1;
      min-width: 0;
      font-size: 11px;
      font-family: ui-monospace, Consolas, monospace;
      background: var(--bg-primary);
      color: var(--accent);
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      word-break: break-all;
      line-height: 1.4;
    }
    .copy-hint-btn { flex-shrink: 0; }
    .btn-test-hello {
      border: 1px dashed rgba(137, 180, 250, 0.45);
      background: rgba(137, 180, 250, 0.08);
      color: var(--accent);
      font-size: 11px;
      font-weight: 600;
    }
    .btn-test-hello:hover:not(:disabled) {
      background: rgba(137, 180, 250, 0.18);
      border-style: solid;
    }
    .send-extra-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-top: 8px;
    }
    .btn-help-open {
      width: 100%;
      margin-top: 4px;
      padding: 8px 12px;
      border-radius: 8px;
      border: 1px solid rgba(137, 180, 250, 0.35);
      background: rgba(137, 180, 250, 0.06);
      color: var(--accent);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-help-open:hover {
      background: rgba(137, 180, 250, 0.14);
      border-color: var(--accent);
    }
    .btn-help-header {
      flex-shrink: 0;
      padding: 4px 10px;
      font-size: 10px;
      font-weight: 600;
      border: 1px solid rgba(137, 180, 250, 0.4);
      border-radius: 6px;
      background: rgba(137, 180, 250, 0.08);
      color: var(--accent);
      cursor: pointer;
    }
    .btn-help-header:hover {
      background: rgba(137, 180, 250, 0.16);
    }
    .help-overlay {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 100000;
      align-items: center;
      justify-content: center;
      padding: 10px;
      box-sizing: border-box;
    }
    .help-overlay.visible {
      display: flex;
    }
    .help-overlay-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
    }
    .help-panel {
      position: relative;
      z-index: 1;
      width: min(440px, 100%);
      max-height: min(88vh, 640px);
      display: flex;
      flex-direction: column;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    }
    .help-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .help-panel-header h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 700;
      color: var(--text-primary);
    }
    .btn-close-help {
      flex-shrink: 0;
      padding: 5px 12px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      cursor: pointer;
    }
    .btn-close-help:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
    .help-panel-body {
      padding: 12px 14px 16px;
      overflow-y: auto;
      font-size: 12px;
      line-height: 1.55;
      color: var(--text-secondary);
    }
    .help-panel-body .help-h {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-primary);
      margin: 14px 0 6px;
    }
    .help-panel-body .help-h:first-of-type { margin-top: 0; }
    .help-panel-body p { margin: 6px 0; }
    .help-panel-body ul {
      margin: 6px 0 8px;
      padding-left: 18px;
    }
    .help-panel-body li { margin: 4px 0; }
    .help-panel-body code {
      font-family: ui-monospace, Consolas, monospace;
      font-size: 11px;
      background: var(--bg-primary);
      padding: 1px 5px;
      border-radius: 4px;
      color: var(--accent);
    }
  </style>
</head>
<body>
  <div id="licenseGate" class="license-gate">
    <div class="license-gate-head">
      <div class="license-logo">Cursor MCP</div>
      <span class="header-version" title="扩展版本">v${extensionVersion}</span>
    </div>
    <p class="license-desc"><strong>多项目、多窗口</strong>一起用：侧栏多路 MCP，各绑独立通道，<strong>稳定不断连</strong>。支持<strong>免费试用 30 分钟</strong>（每机一次），<strong>好用再下单</strong>。下方粘贴卡密激活即可。</p>
    <div class="license-pay-strip">
      <div class="license-pay-title">Cursor MCP 激活码 · 在线购买</div>
      <div class="license-pay-url" id="payStoreUrlDisplay">${payUrlDisplay}</div>
      <button type="button" class="btn-pay-store" id="openPayStoreBtn" title="在系统浏览器中打开支付页">在浏览器打开支付页</button>
    </div>
    <input type="text" class="license-key-input" id="licenseKeyInput" placeholder="粘贴卡密…" autocomplete="off" spellcheck="false" />
    <div class="license-actions">
      <button type="button" class="btn btn-primary" id="licenseActivateBtn">激活</button>
      <button type="button" class="btn-trial" id="trial30Btn" title="每机仅一次，30 分钟后需卡密或再次安装">试用30分钟</button>
    </div>
    <button type="button" class="btn-help-open" id="openHelpGateBtn">使用说明</button>
    <div class="feedback" id="licenseFeedback"></div>
    <p class="license-foot">试用与正式激活均可使用侧栏全部功能；到期后将返回本页。</p>
  </div>
  <div class="app-layout" id="mainApp">
  <aside class="session-rail" id="sessionRail" aria-label="会话列表" style="width:88px">
    <div class="session-rail-title">会话</div>
    <div id="sessionRailInner"></div>
    <button type="button" class="btn-add-session" id="addSessionBtn" title="添加一路会话（对应 cursor-mcp-N）">+ 添加会话</button>
    <div class="session-rail-hint">每路对应 cursor-mcp-N。点「开始配置」只注册当前这几路；增删会话后请再配置一次</div>
  </aside>
  <div class="rail-resizer" id="railResizer" title="拖动调整会话栏宽度" role="separator" aria-orientation="vertical"></div>
  <div class="app-main">
  <div class="header">
    <h2>Cursor MCP</h2>
    <span class="header-version" id="extVersionBadge" title="扩展版本">v${extensionVersion}</span>
    <button type="button" class="update-badge" id="updateBadge" style="display:none" title="点击一键升级到最新版本">
      <span class="update-dot"></span><span id="updateBadgeText">有新版</span>
    </button>
    <div class="status-dot" id="statusDot" title="连接状态"></div>
    <span id="activeMcpHint" class="hint" style="margin-left:auto;font-size:10px;">当前：MCP-1</span>
    <button type="button" class="btn-help-header" id="openHelpMainBtn" title="查看详细使用说明">使用说明</button>
  </div>

  <div class="section">
    <div class="section-title">工作区配置</div>
    <div class="path-input-group">
      <input type="text" class="path-input" id="pathInput" placeholder="选择或输入工作区路径..." />
      <button class="btn btn-small" id="browseBtn" title="浏览文件夹">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
      </button>
    </div>
    <div class="btn-row">
      <button class="btn btn-primary" id="cfgBtn">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
        开始配置
      </button>
      <button class="btn btn-small" id="useCurrentBtn" title="使用当前工作区">
        使用当前
      </button>
    </div>
    <div class="hint">选择工作区后点「开始配置」：仅把<strong>当前侧栏会话</strong>写入 mcp.json（不会一次注册 32 个）</div>
    <div class="feedback" id="cfgFeedback"></div>
  </div>

  <div class="session-memo-strip session-tone-0" id="sessionMemoStrip">
    <div class="session-memo-strip-head">
      <span class="session-memo-badge" id="sessionMemoBadge">MCP-1</span>
      <span class="session-memo-hint">本路备忘（仅本机保存）</span>
    </div>
    <input type="text" class="session-memo-input" id="sessionMemoInput" placeholder="用途说明，例如：前端仓库 / 写文档 / 测试通道" maxlength="200" />
  </div>

  <div class="section send-message-section session-tone-0" id="sendMessageSection">
    <div class="section-title"><span class="send-section-color-dot" aria-hidden="true"></span>发送消息</div>
    <div class="input-group">
      <textarea id="msgInput" rows="2" placeholder="输入消息… 可直接 Ctrl+V 粘贴截图/图片，或与下方「图片/文件」一起发送"></textarea>
      <div class="input-actions">
        <button type="button" class="btn-voice" id="voiceInputBtn" title="语音输入" aria-pressed="false">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>
          </svg>
          语音
        </button>
        <button class="btn btn-primary" id="sendBtn">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
          </svg>
          发送
        </button>
      </div>
    </div>
    <div class="send-extra-actions">
      <button type="button" class="btn btn-small btn-test-hello" id="testHelloBtn" title="向当前通道发送一条「你好」测试消息">测试发送你好</button>
    </div>
    <div class="attach-row">
      <button class="btn btn-small" type="button" id="pickFilesBtn" title="选择图片或任意文件">图片/文件</button>
      <input type="file" id="filePick" multiple accept="image/*,*/*" />
      <div class="attach-chips" id="attachChips"></div>
    </div>
    <div class="hint-row">
      <div class="hint">发送后，在<strong>绑定本通道</strong>的 Cursor 对话里发送下方指令（可点「复制」）。单条约 2MB 附件上限。</div>
      <div class="hint-copy-line">
        <code class="hint-code" id="hintPhrase">请使用 cursor-mcp-1 的 check_messages</code>
        <button type="button" class="btn btn-small copy-hint-btn" id="copyHintBtn" title="复制到剪贴板">复制</button>
      </div>
    </div>
    <div class="feedback" id="sendFeedback"></div>
  </div>

  <div class="section fc-section">
    <div class="section-head">
      <div class="section-title"><span class="fc-emoji" aria-hidden="true">🚗</span>发车 / 上车</div>
      <button class="btn btn-small" type="button" id="fcToggleRoleBtn" title="切换车头/乘客">切换身份</button>
    </div>
    <div class="fc-role-tabs" id="fcRoleTabs">
      <button type="button" class="fc-tab active" data-role="driver">我是车头（生成车票）</button>
      <button type="button" class="fc-tab" data-role="rider">我要上车（粘贴车票）</button>
    </div>

    <div class="fc-meta-box">
      <div class="fc-meta-head">
        <span class="fc-meta-title">本机 Cursor 设备指纹</span>
        <span class="fc-meta-time" id="fcMetaTime">未读取</span>
        <button class="btn btn-small" id="fcMetaRefreshBtn" type="button" title="重新读取">刷新</button>
        <button class="btn btn-small" id="fcMetaCopyAllBtn" type="button" title="复制全部指纹为多行文本">复制全部</button>
      </div>
      <div class="fc-meta" id="fcDriverMeta">正在读取本机 Cursor 指纹…</div>
    </div>

    <div class="fc-panel" id="fcDriverPanel">
      <div class="fc-ttl-row">
        <label class="fc-ttl-label" for="fcTtlSelect">有效期</label>
        <select id="fcTtlSelect" class="fc-ttl-select" title="sk- 密钥到期自动失效">
          <option value="300000">5 分钟</option>
          <option value="600000" selected>10 分钟</option>
          <option value="1800000">30 分钟</option>
          <option value="3600000">1 小时</option>
          <option value="21600000">6 小时</option>
          <option value="43200000">12 小时</option>
          <option value="86400000">24 小时</option>
          <option value="custom">自定义…</option>
        </select>
        <input type="number" id="fcTtlCustom" class="fc-ttl-custom" min="1" max="1440" step="1" placeholder="分钟" style="display:none" />
        <span class="hint fc-ttl-hint" id="fcTtlHint">一次性领取；过期自动删除</span>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="fcCloudPubBtn" title="云端发车：生成 20 位 sk- 密钥，一次性领取">云端 sk- 密钥</button>
        <button class="btn" id="fcGenBtn" title="本地发车：生成完整 FCT1. 车票，无需联网">本地 FCT1. 车票</button>
        <button class="btn btn-small" id="fcOpenBackupBtn" title="打开备份目录">备份</button>
      </div>

      <div class="fc-key-box" id="fcKeyBox" style="display:none">
        <div class="fc-key-line">
          <span class="fc-key-label">sk-密钥</span>
          <code class="fc-key-value" id="fcKeyValue" title="点击全选"></code>
          <button class="btn btn-small" id="fcKeyCopyBtn">复制</button>
        </div>
        <div class="fc-key-hint" id="fcKeyExpires">—</div>
      </div>

      <textarea id="fcTicketOut" class="fc-ticket" rows="3" readonly placeholder="点击「本地 FCT1. 车票」后，此处显示可复制的长车票（完全离线可用）"></textarea>
      <div class="btn-row">
        <button class="btn btn-small" id="fcCopyBtn" disabled>复制 FCT1.</button>
        <span class="hint">sk- 密钥走云端（默认使用官方 Render 实例，如需自建改 <code>cursorMcp.facheApiBaseUrl</code>）；FCT1. 长车票不依赖服务器。</span>
      </div>
    </div>

    <div class="fc-panel" id="fcRiderPanel" style="display:none">
      <textarea id="fcTicketIn" class="fc-ticket" rows="3" placeholder="粘贴 sk- 密钥（20 位）或 FCT1. 长车票，插件会自动识别"></textarea>
      <div class="btn-row">
        <button class="btn btn-primary" id="fcApplyBtn">上车（覆盖本机指纹）</button>
        <button class="btn" id="fcVerifyBtn" title="读取当前 Cursor 指纹，与上次车头指纹逐字段对比">验证指纹</button>
        <button class="btn btn-small" id="fcUnlockBtn" title="若开启了 facheLockStorageAfterApply 导致 Cursor 偏好无法保存，点此解锁 storage.json">解锁 storage.json</button>
        <button class="btn btn-small" id="fcOpenBackupBtn2" title="打开备份目录">备份目录</button>
      </div>
      <div class="hint">
        上车前会自动把本机旧指纹备份到 <code>Cursor/cursor-mcp-fp-backup</code>。<strong>请先退出 Cursor 再点「上车」</strong>，写入后重新启动 Cursor 才会生效。Windows 上若车票含 MachineGuid，会弹出 UAC 请求管理员权限写注册表。重启 Cursor 后回到此处点「验证指纹」，可逐字段对比是否与车头一致。<br><strong>默认会把 storage.json 锁成只读</strong>以阻止 Cursor 启动时把 devDeviceId 回写（需要改 Cursor 主题/窗口位置时先点「解锁 storage.json」；可在设置 <code>cursorMcp.facheLockStorageAfterApply</code> 里关闭此行为）。
      </div>
      <div class="fc-verify-box" id="fcVerifyBox" style="display:none"></div>
    </div>

    <div class="feedback" id="fcFeedback"></div>
  </div>

  <div class="section">
    <div class="section-head">
      <div class="section-title">对话记录</div>
      <button class="btn btn-small" type="button" id="clearChatBtn" title="清空本面板中的记录">清空记录</button>
    </div>
    <div class="chat-container" id="chatContainer">
      <div id="messagesList"></div>
      <div class="empty-state" id="emptyState">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <div>暂无消息</div>
        <div style="font-size: 10px; margin-top: 4px;">发送消息开始对话</div>
      </div>
    </div>
  </div>
  </div>
  </div>

  <div id="helpOverlay" class="help-overlay" aria-hidden="true" role="presentation">
    <div class="help-overlay-backdrop" id="helpBackdrop" aria-hidden="true"></div>
    <div class="help-panel" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
      <div class="help-panel-header">
        <h3 id="helpTitle">Cursor MCP 使用说明</h3>
        <button type="button" class="btn-close-help" id="closeHelpBtn">关闭</button>
      </div>
      <div class="help-panel-body">
        <div class="help-h">1. 激活与试用</div>
        <p>在侧栏输入<strong>卡密</strong>后点「激活」；未购买可先点「试用 30 分钟」（每机一次）。激活或试用期间可使用侧栏全部功能，到期后会回到本页。</p>
        <div class="help-h">2. 工作区与 MCP 配置</div>
        <p>在「工作区配置」中填写或浏览项目路径，也可点「使用当前」自动填入当前 Cursor 打开的工作区根目录。点<strong>开始配置</strong>后，扩展会把<strong>当前侧栏会话列表</strong>写入本工作区的 <code>.cursor/mcp.json</code>，对应通道为 <code>cursor-mcp-1</code> … <code>cursor-mcp-N</code>。</p>
        <p><strong>注意：</strong>在侧栏<strong>添加或删除会话</strong>后，需要再点一次「开始配置」，否则 Cursor 里 MCP 列表与侧栏不一致。</p>
        <div class="help-h">3. 多路会话</div>
        <p>左侧「会话」可切换 MCP-1、MCP-2… 每路独立；拖动会话栏右侧竖条可调整宽度。每路可写<strong>本路备忘</strong>（仅本机保存）。</p>
        <div class="help-h">4. 发送消息</div>
        <p>在「发送消息」中输入文字，可粘贴截图或添加图片/文件。发送成功后，请在<strong>绑定该通道</strong>的 Cursor 对话窗口里，让 AI 执行侧栏提示的指令（例如 <code>请使用 cursor-mcp-1 的 check_messages</code>），以便拉取插件消息。</p>
        <p>可点「测试发送你好」快速发送一条「你好」做通道测试。</p>
        <div class="help-h">5. 设置（可选）</div>
        <p>在 Cursor 设置中搜索「Cursor MCP」可配置：云端核销地址 <code>cursorMcp.redeemApiBaseUrl</code>、仅云端卡密 <code>cursorMcp.cloudLicenseOnly</code>（默认关闭，可同时用本地 CMC1）、吊销校验间隔 <code>cursorMcp.cloudLicenseVerifyIntervalMs</code> 等。</p>
        <div class="help-h">6. 常见问题</div>
        <ul>
          <li>MCP 连不上：确认已「开始配置」且对话里已按提示调用 <code>check_messages</code>。</li>
          <li>换电脑或重装：需重新激活（卡密按你的发卡规则可能一机一码）。</li>
        </ul>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    var VOICE_USE_WIN_NATIVE = ${process.platform === "win32" ? "true" : "false"};

    function showLicenseFeedback(type, text) {
      var el = document.getElementById('licenseFeedback');
      if (!el) return;
      el.className = 'feedback show ' + type;
      el.textContent = text || '';
      if (type === 'success' || type === 'info') {
        setTimeout(function () { el.classList.remove('show'); }, 6000);
      }
    }
    function applyLicenseShell(ok, label) {
      document.body.classList.add('license-ok');
    }
    (function setupLicenseUi() {
      var licenseKeyInput = document.getElementById('licenseKeyInput');
      var licenseActivateBtn = document.getElementById('licenseActivateBtn');
      function doActivate() {
        if (!licenseKeyInput) return;
        showLicenseFeedback('pending', '正在校验…');
        vscodeApi.postMessage({ command: 'activateLicense', key: licenseKeyInput.value });
      }
      if (licenseActivateBtn) licenseActivateBtn.addEventListener('click', doActivate);
      var trial30Btn = document.getElementById('trial30Btn');
      if (trial30Btn) {
        trial30Btn.addEventListener('click', function () {
          showLicenseFeedback('pending', '正在开始试用…');
          vscodeApi.postMessage({ command: 'startTrial30' });
        });
      }
      if (licenseKeyInput) {
        licenseKeyInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); doActivate(); }
        });
      }
      var openPayStoreBtn = document.getElementById('openPayStoreBtn');
      if (openPayStoreBtn) {
        openPayStoreBtn.addEventListener('click', function () {
          vscodeApi.postMessage({ command: 'openPayStore' });
        });
      }
    })();
    (function setupDeactivateLicense() {
      var btn = document.getElementById('deactivateLicenseBtn');
      if (!btn) return;
      btn.addEventListener('click', function () {
        vscodeApi.postMessage({ command: 'deactivateLicense' });
      });
    })();
    (function setupHelpOverlay() {
      var overlay = document.getElementById('helpOverlay');
      var closeBtn = document.getElementById('closeHelpBtn');
      var backdrop = document.getElementById('helpBackdrop');
      var openGate = document.getElementById('openHelpGateBtn');
      var openMain = document.getElementById('openHelpMainBtn');
      function open() {
        if (!overlay) return;
        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');
      }
      function close() {
        if (!overlay) return;
        overlay.classList.remove('visible');
        overlay.setAttribute('aria-hidden', 'true');
      }
      if (openGate) openGate.addEventListener('click', open);
      if (openMain) openMain.addEventListener('click', open);
      if (closeBtn) closeBtn.addEventListener('click', close);
      if (backdrop) backdrop.addEventListener('click', close);
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && overlay && overlay.classList.contains('visible')) {
          close();
        }
      });
    })();
    applyLicenseShell(true, '');

    const statusDot = document.getElementById('statusDot');
    const pathInput = document.getElementById('pathInput');
    const browseBtn = document.getElementById('browseBtn');
    const cfgBtn = document.getElementById('cfgBtn');
    const useCurrentBtn = document.getElementById('useCurrentBtn');
    const cfgFeedback = document.getElementById('cfgFeedback');
    const msgInput = document.getElementById('msgInput');
    const voiceInputBtn = document.getElementById('voiceInputBtn');
    const sendBtn = document.getElementById('sendBtn');
    const testHelloBtn = document.getElementById('testHelloBtn');
    const sendFeedback = document.getElementById('sendFeedback');
    const chatContainer = document.getElementById('chatContainer');
    const messagesList = document.getElementById('messagesList');
    const emptyState = document.getElementById('emptyState');
    const pickFilesBtn = document.getElementById('pickFilesBtn');
    const filePick = document.getElementById('filePick');
    const attachChips = document.getElementById('attachChips');
    const clearChatBtn = document.getElementById('clearChatBtn');
    const sessionRail = document.getElementById('sessionRail');
    const railResizer = document.getElementById('railResizer');
    const sessionRailInner = document.getElementById('sessionRailInner');
    const addSessionBtn = document.getElementById('addSessionBtn');
    const activeMcpHint = document.getElementById('activeMcpHint');
    const hintPhrase = document.getElementById('hintPhrase');
    const copyHintBtn = document.getElementById('copyHintBtn');
    const sendMessageSection = document.getElementById('sendMessageSection');
    const sessionMemoStrip = document.getElementById('sessionMemoStrip');
    const sessionMemoBadge = document.getElementById('sessionMemoBadge');
    const sessionMemoInput = document.getElementById('sessionMemoInput');

    var MAX_SESSIONS = ${MAX_SESSIONS};
    /** @type string[] */
    var sessionOrder = ['1', '2', '3'];
    var activeSessionId = '1';
    /** @type Record<string, Array<{type:string,content:string,time:string|Date}>> */
    var messagesBySession = {};
    /** @type Record<string, Array<{id:number,name:string,mimeType:string,data:string,kind:string}>> */
    var pendingBySession = {};
    var persistTimer = null;
    var sessionOrderTimer = null;
    var memoTimer = null;
    /** @type Record<string, string> */
    var sessionMemos = {};

    let currentWorkspacePath = '';

    function sessionToneClass(sid) {
      var n = parseInt(sid, 10);
      if (!n || n < 1) n = 1;
      return 'session-tone-' + ((n - 1) % 12);
    }

    function persistMemoSoon() {
      if (memoTimer) clearTimeout(memoTimer);
      memoTimer = setTimeout(function () {
        memoTimer = null;
        vscodeApi.postMessage({ command: 'persistSessionMemos', memos: sessionMemos });
      }, 300);
    }

    function ensureSessionStructures(sid) {
      if (!messagesBySession[sid]) messagesBySession[sid] = [];
      if (!pendingBySession[sid]) pendingBySession[sid] = [];
    }

    function getPending() {
      ensureSessionStructures(activeSessionId);
      return pendingBySession[activeSessionId];
    }

    function setSessionUi() {
      var tone = sessionToneClass(activeSessionId);
      sessionRailInner.querySelectorAll('.session-item').forEach(function (el) {
        el.classList.toggle('active', el.getAttribute('data-sid') === activeSessionId);
      });
      if (sendMessageSection) sendMessageSection.className = 'section send-message-section ' + tone;
      if (sessionMemoStrip) sessionMemoStrip.className = 'session-memo-strip ' + tone;
      if (sessionMemoBadge) sessionMemoBadge.textContent = 'MCP-' + activeSessionId;
      if (sessionMemoInput) sessionMemoInput.value = sessionMemos[activeSessionId] || '';
      if (activeMcpHint) activeMcpHint.textContent = '当前：MCP-' + activeSessionId;
      if (hintPhrase) hintPhrase.textContent = '请使用 cursor-mcp-' + activeSessionId + ' 的 check_messages';
    }

    function persistSessionOrderSoon() {
      if (sessionOrderTimer) clearTimeout(sessionOrderTimer);
      sessionOrderTimer = setTimeout(function () {
        sessionOrderTimer = null;
        vscodeApi.postMessage({ command: 'persistSessionOrder', order: sessionOrder.slice() });
      }, 200);
    }

    function renderSessionRail() {
      if (!sessionRailInner || !addSessionBtn) return;
      sessionOrder.forEach(function (sid) { ensureSessionStructures(sid); });
      sessionRailInner.innerHTML = sessionOrder.map(function (sid) {
        var tc = sessionToneClass(sid);
        return '<div class="session-row">' +
          '<button type="button" class="session-item ' + tc + (sid === activeSessionId ? ' active' : '') + '" data-sid="' + sid + '">MCP-' + sid + '</button>' +
          '<button type="button" class="session-del" data-del-sid="' + sid + '" title="删除此会话">×</button>' +
          '</div>';
      }).join('');
      sessionRailInner.querySelectorAll('.session-item').forEach(function (btn) {
        btn.addEventListener('click', function () {
          switchSession(btn.getAttribute('data-sid'));
        });
      });
      sessionRailInner.querySelectorAll('.session-del').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          deleteSession(btn.getAttribute('data-del-sid'));
        });
      });
      addSessionBtn.disabled = sessionOrder.length >= MAX_SESSIONS;
      setSessionUi();
    }

    function switchSession(sid) {
      if (sessionOrder.indexOf(sid) < 0) return;
      activeSessionId = sid;
      setSessionUi();
      renderAttachChips();
      renderMessages();
    }

    function addSession() {
      if (sessionOrder.length >= MAX_SESSIONS) return;
      var used = {};
      sessionOrder.forEach(function (s) { used[s] = true; });
      var next = null;
      for (var n = 1; n <= MAX_SESSIONS; n++) {
        var id = String(n);
        if (!used[id]) { next = id; break; }
      }
      if (!next) return;
      ensureSessionStructures(next);
      sessionOrder.push(next);
      activeSessionId = next;
      persistSessionOrderSoon();
      renderSessionRail();
      renderAttachChips();
      renderMessages();
      schedulePersist();
      hintReconfigureAfterSessionChange();
    }

    function deleteSession(sid) {
      if (!sid || sessionOrder.length <= 1) {
        showFeedback(sendFeedback, 'error', '至少保留一个会话');
        return;
      }
      var idx = sessionOrder.indexOf(sid);
      if (idx < 0) return;
      sessionOrder.splice(idx, 1);
      delete messagesBySession[sid];
      delete pendingBySession[sid];
      delete sessionMemos[sid];
      persistMemoSoon();
      if (activeSessionId === sid) {
        activeSessionId = sessionOrder[0];
      }
      persistSessionOrderSoon();
      renderSessionRail();
      renderAttachChips();
      renderMessages();
      schedulePersist();
      hintReconfigureAfterSessionChange();
    }

    addSessionBtn.addEventListener('click', function () { addSession(); });

    if (sessionMemoInput) {
      sessionMemoInput.addEventListener('input', function () {
        var v = sessionMemoInput.value.slice(0, 200);
        sessionMemoInput.value = v;
        sessionMemos[activeSessionId] = v;
        if (!v) delete sessionMemos[activeSessionId];
        persistMemoSoon();
      });
    }

    ['1', '2', '3'].forEach(function (s) { ensureSessionStructures(s); });
    renderSessionRail();

    copyHintBtn.addEventListener('click', function () {
      vscodeApi.postMessage({ command: 'copyCheckPhrase', sessionId: activeSessionId });
    });

    function schedulePersist() {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(function () {
        persistTimer = null;
        var out = {};
        Object.keys(messagesBySession).forEach(function (sid) {
          out[sid] = (messagesBySession[sid] || []).map(function (m) {
            return { type: m.type, content: m.content, time: m.time instanceof Date ? m.time.toISOString() : m.time };
          });
        });
        vscodeApi.postMessage({ command: 'persistHistories', payload: JSON.stringify(out) });
      }, 400);
    }

    function showFeedback(el, type, text) {
      el.className = 'feedback show ' + type;
      el.textContent = text;
      if (type === 'success' || type === 'info') {
        setTimeout(() => el.classList.remove('show'), 8000);
      }
    }

    function formatTime(date) {
      const d = date instanceof Date ? date : new Date(date);
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function addMessage(type, content, time, sessionId) {
      var sid = sessionId || activeSessionId;
      if (!messagesBySession[sid]) messagesBySession[sid] = [];
      messagesBySession[sid].push({ type: type, content: content, time: time || new Date() });
      if (sid === activeSessionId) renderMessages();
      schedulePersist();
    }

    function renderAttachChips() {
      var pendingAttachments = getPending();
      attachChips.innerHTML = pendingAttachments.map(function (a) {
        return '<span class="attach-chip"><span title="' + escapeHtml(a.name) + '">' + escapeHtml(a.name) + '</span>' +
          '<button type="button" class="rm" data-rm="' + a.id + '" title="移除">×</button></span>';
      }).join('');
    }

    attachChips.addEventListener('click', function (e) {
      const t = e.target;
      if (!t || !t.getAttribute) return;
      const id = t.getAttribute('data-rm');
      if (id == null) return;
      var pa = getPending();
      var idx = pa.findIndex(function (x) { return String(x.id) === String(id); });
      if (idx >= 0) pa.splice(idx, 1);
      renderAttachChips();
    });

    pickFilesBtn.addEventListener('click', function () { filePick.click(); });

    filePick.addEventListener('change', function () {
      const files = Array.prototype.slice.call(filePick.files || []);
      filePick.value = '';
      files.forEach(function (file) {
        const reader = new FileReader();
        reader.onload = function () {
          const result = reader.result;
          if (typeof result !== 'string') return;
          const comma = result.indexOf(',');
          const data = comma >= 0 ? result.slice(comma + 1) : result;
          const mimeType = file.type || 'application/octet-stream';
          const kind = mimeType.indexOf('image/') === 0 ? 'image' : 'file';
          getPending().push({
            id: Date.now() + Math.random(),
            name: file.name || (kind === 'image' ? 'image' : 'file'),
            mimeType: mimeType,
            data: data,
            kind: kind
          });
          renderAttachChips();
        };
        reader.readAsDataURL(file);
      });
    });

    clearChatBtn.addEventListener('click', function () {
      messagesBySession[activeSessionId] = [];
      renderMessages();
      schedulePersist();
    });

    function renderMessages() {
      var messages = messagesBySession[activeSessionId] || [];
      if (messages.length === 0) {
        messagesList.innerHTML = '';
        emptyState.style.display = 'block';
        return;
      }
      emptyState.style.display = 'none';
      messagesList.innerHTML = messages.map(function (m) {
        const label = m.type === 'user' ? '你' : m.type === 'cursor' ? 'Cursor' : '系统';
        return '<div class="message ' + m.type + '">' +
          '<div class="message-header">' +
            '<span class="message-label">' + label + '</span>' +
            '<span class="message-time">' + formatTime(m.time) + '</span>' +
          '</div>' +
          '<div class="message-content">' + escapeHtml(m.content) + '</div>' +
        '</div>';
      }).join('');
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function setLoading(btn, loading) {
      if (loading) {
        btn.disabled = true;
        btn.dataset.originalHtml = btn.innerHTML;
        btn.innerHTML = '<span class="loading-spinner"></span> 处理中...';
      } else {
        btn.disabled = false;
        btn.innerHTML = btn.dataset.originalHtml || btn.innerHTML;
      }
    }

    // 浏览文件夹
    browseBtn.addEventListener('click', () => {
      vscodeApi.postMessage({ command: 'selectFolder' });
    });

    // 使用当前工作区：向扩展查询当前窗口工作区路径并填入输入框
    useCurrentBtn.addEventListener('click', () => {
      vscodeApi.postMessage({ command: 'requestCurrentWorkspace' });
    });

    function hintReconfigureAfterSessionChange() {
      showFeedback(cfgFeedback, 'info', '会话路数已变：请再点「开始配置」，才会按当前侧栏同步 .cursor/mcp.json（并清理多余的 cursor-mcp-*）。');
    }

    // 开始配置
    cfgBtn.addEventListener('click', () => {
      setLoading(cfgBtn, true);
      const targetPath = pathInput.value.trim() || undefined;
      showFeedback(cfgFeedback, 'pending', '正在配置工作区...' + (targetPath ? '\\n路径：' + targetPath : '（使用当前工作区）'));
      statusDot.className = 'status-dot pending';
      vscodeApi.postMessage({ command: 'configureWorkspace', path: targetPath, sessionOrder: sessionOrder.slice() });
    });

    sendBtn.addEventListener('click', sendMessage);
    function sendTestHello() {
      if (voiceNativePending) {
        showFeedback(sendFeedback, 'error', '请等待语音识别结束');
        return;
      }
      stopVoiceInput();
      var workspacePath = currentWorkspacePath || pathInput.value.trim();
      if (testHelloBtn) setLoading(testHelloBtn, true);
      showFeedback(sendFeedback, 'pending', '正在发送...');
      vscodeApi.postMessage({
        command: 'sendMessage',
        text: '你好',
        workspacePath: workspacePath,
        images: [],
        files: [],
        sessionId: activeSessionId
      });
    }
    if (testHelloBtn) testHelloBtn.addEventListener('click', sendTestHello);
    (function setupRailResize() {
      if (!railResizer || !sessionRail) return;
      var RAIL_MIN = 56;
      var RAIL_MAX = 220;
      try {
        var s = localStorage.getItem('cursorMcp.sessionRailWidthPx');
        if (s) {
          var w = parseInt(s, 10);
          if (!isNaN(w) && w >= RAIL_MIN && w <= RAIL_MAX) {
            sessionRail.style.width = w + 'px';
          }
        }
      } catch (e) { /* ignore */ }
      railResizer.addEventListener('mousedown', function (e) {
        e.preventDefault();
        railResizer.classList.add('is-dragging');
        var startX = e.clientX;
        var startW = sessionRail.getBoundingClientRect().width;
        function onMove(e2) {
          var dx = e2.clientX - startX;
          var nw = Math.round(startW + dx);
          nw = Math.max(RAIL_MIN, Math.min(RAIL_MAX, nw));
          sessionRail.style.width = nw + 'px';
        }
        function onUp() {
          railResizer.classList.remove('is-dragging');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          try {
            localStorage.setItem(
              'cursorMcp.sessionRailWidthPx',
              String(Math.round(sessionRail.getBoundingClientRect().width))
            );
          } catch (err) { /* ignore */ }
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    })();
    msgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    /** @type {SpeechRecognition | null} */
    var activeSpeechRec = null;
    var voiceBaseText = '';
    var voiceAccumulated = '';
    var voiceNativePending = false;

    function setVoiceNativeBusy(busy) {
      voiceNativePending = busy;
      if (!voiceInputBtn) return;
      if (busy) {
        voiceInputBtn.classList.add('listening');
        voiceInputBtn.setAttribute('aria-pressed', 'true');
        voiceInputBtn.disabled = true;
      } else {
        voiceInputBtn.classList.remove('listening');
        voiceInputBtn.setAttribute('aria-pressed', 'false');
        voiceInputBtn.disabled = false;
      }
    }

    function stopVoiceInput() {
      if (activeSpeechRec) {
        try {
          activeSpeechRec.stop();
        } catch (e) { /* ignore */ }
        activeSpeechRec = null;
      }
      if (voiceInputBtn) {
        voiceInputBtn.classList.remove('listening');
        voiceInputBtn.setAttribute('aria-pressed', 'false');
      }
    }

    function initVoiceInput() {
      if (!voiceInputBtn || !msgInput) return;
      if (VOICE_USE_WIN_NATIVE) {
        voiceInputBtn.title = '语音输入（Windows 系统识别：说完一句后自动结束，最长约 50 秒）';
        voiceInputBtn.addEventListener('click', function () {
          if (voiceNativePending) return;
          setVoiceNativeBusy(true);
          showFeedback(sendFeedback, 'pending', '正在听写… 请对着麦克风清晰说一句话');
          vscodeApi.postMessage({ command: 'voiceInputNative' });
        });
        return;
      }
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) {
        voiceInputBtn.disabled = true;
        voiceInputBtn.title = '当前环境不支持浏览器语音识别';
        return;
      }
      voiceInputBtn.title = '语音输入（浏览器识别；再点一次结束）';

      voiceInputBtn.addEventListener('click', function () {
        if (activeSpeechRec) {
          stopVoiceInput();
          return;
        }
        var Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!Rec) {
          showFeedback(sendFeedback, 'error', '当前环境不支持语音输入');
          return;
        }
        var rec = new Rec();
        rec.lang = 'zh-CN';
        rec.continuous = true;
        rec.interimResults = true;
        voiceBaseText = msgInput.value;
        voiceAccumulated = '';

        rec.onstart = function () {
          voiceInputBtn.classList.add('listening');
          voiceInputBtn.setAttribute('aria-pressed', 'true');
          showFeedback(sendFeedback, 'info', '正在聆听… 再点「语音」结束');
        };

        rec.onresult = function (event) {
          var interim = '';
          for (var i = event.resultIndex; i < event.results.length; i++) {
            var r = event.results[i];
            var t = r[0] ? r[0].transcript : '';
            if (r.isFinal) {
              voiceAccumulated += t;
            } else {
              interim += t;
            }
          }
          msgInput.value = voiceBaseText + voiceAccumulated + interim;
        };

        rec.onerror = function (ev) {
          var err = ev.error || '';
          if (err === 'not-allowed') {
            showFeedback(sendFeedback, 'error', '侧栏页面无法使用麦克风（编辑器限制）。若在 macOS/Linux 可尝试系统听写；Windows 本扩展已改用系统识别。');
          } else if (err !== 'aborted' && err !== 'no-speech') {
            showFeedback(sendFeedback, 'error', '语音识别：' + err);
          }
          stopVoiceInput();
        };

        rec.onend = function () {
          activeSpeechRec = null;
          if (voiceInputBtn) {
            voiceInputBtn.classList.remove('listening');
            voiceInputBtn.setAttribute('aria-pressed', 'false');
          }
        };

        try {
          activeSpeechRec = rec;
          rec.start();
        } catch (e) {
          activeSpeechRec = null;
          showFeedback(sendFeedback, 'error', '无法启动语音识别：' + String(e));
        }
      });
    }
    initVoiceInput();

    function pushImageFromBlob(blob, nameHint) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = reader.result;
        if (typeof result !== 'string') return;
        var comma = result.indexOf(',');
        var data = comma >= 0 ? result.slice(comma + 1) : result;
        var mimeType = blob.type || 'image/png';
        var ext = 'png';
        if (mimeType.indexOf('jpeg') >= 0 || mimeType.indexOf('jpg') >= 0) ext = 'jpg';
        else if (mimeType.indexOf('gif') >= 0) ext = 'gif';
        else if (mimeType.indexOf('webp') >= 0) ext = 'webp';
        var name = nameHint || ('粘贴-' + Date.now() + '.' + ext);
        getPending().push({
          id: Date.now() + Math.random(),
          name: name,
          mimeType: mimeType,
          data: data,
          kind: 'image'
        });
        renderAttachChips();
      };
      reader.readAsDataURL(blob);
    }

    msgInput.addEventListener('paste', function (e) {
      var cd = e.clipboardData;
      if (!cd) return;
      var foundImage = false;
      if (cd.files && cd.files.length) {
        for (var fi = 0; fi < cd.files.length; fi++) {
          var f = cd.files[fi];
          if (f.type && f.type.indexOf('image/') === 0) {
            e.preventDefault();
            foundImage = true;
            pushImageFromBlob(f, f.name || null);
          }
        }
      }
      if (!foundImage && cd.items) {
        for (var ii = 0; ii < cd.items.length; ii++) {
          var item = cd.items[ii];
          if (item.type && item.type.indexOf('image/') === 0) {
            e.preventDefault();
            var file = item.getAsFile();
            if (file) pushImageFromBlob(file, null);
            break;
          }
        }
      }
    });

    function sendMessage() {
      if (voiceNativePending) {
        showFeedback(sendFeedback, 'error', '请等待语音识别结束');
        return;
      }
      stopVoiceInput();
      const text = msgInput.value.trim();
      var pa = getPending();
      const images = pa.filter(function (a) { return a.kind === 'image'; }).map(function (a) {
        return { mimeType: a.mimeType, data: a.data };
      });
      const files = pa.filter(function (a) { return a.kind === 'file'; }).map(function (a) {
        return { name: a.name, mimeType: a.mimeType, data: a.data };
      });
      if (!text && images.length === 0 && files.length === 0) {
        showFeedback(sendFeedback, 'error', '请输入文字或添加图片/文件');
        return;
      }
      const workspacePath = currentWorkspacePath || pathInput.value.trim();
      setLoading(sendBtn, true);
      showFeedback(sendFeedback, 'pending', '正在发送...');
      vscodeApi.postMessage({
        command: 'sendMessage',
        text: text,
        workspacePath: workspacePath,
        images: images,
        files: files,
        sessionId: activeSessionId
      });
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || !msg.command) return;

      switch (msg.command) {
        case 'licenseStatus':
          if (msg.ok) {
            applyLicenseShell(true, msg.label || '');
          } else {
            applyLicenseShell(false, '');
          }
          break;
        case 'licenseActivationResult':
          if (msg.ok) {
            showLicenseFeedback('success', msg.msg || '激活成功');
            var lki = document.getElementById('licenseKeyInput');
            if (lki) lki.value = '';
          } else {
            showLicenseFeedback('error', msg.msg || '激活失败');
          }
          break;
        case 'trialResult':
          if (msg.ok) {
            showLicenseFeedback('success', msg.msg || '试用已开始');
          } else {
            showLicenseFeedback('error', msg.msg || '无法开始试用');
          }
          break;
        case 'copyPhraseResult':
          if (msg.ok) {
            showFeedback(sendFeedback, 'success', '已复制到剪贴板');
          }
          break;

        case 'folderSelected':
          if (msg.path) {
            pathInput.value = msg.path;
            var prefix = msg.fromCurrentWorkspace ? '已填入当前工作区：' : '已选择：';
            showFeedback(cfgFeedback, 'info', prefix + msg.path);
          } else if (msg.error) {
            var err = String(msg.error);
            showFeedback(cfgFeedback, 'error', err.indexOf('当前没有') === 0 ? err : '选择失败：' + err);
          }
          break;

        case 'configResult':
          setLoading(cfgBtn, false);
          if (msg.ok) {
            currentWorkspacePath = msg.workspacePath || '';
            showFeedback(cfgFeedback, 'success', msg.msg);
            statusDot.className = 'status-dot connected';
            addMessage('system', '工作区配置成功，MCP 已就绪\\n' + currentWorkspacePath);
          } else {
            showFeedback(cfgFeedback, 'error', '配置失败：' + msg.msg);
            statusDot.className = 'status-dot error';
          }
          break;

        case 'restoreSessionOrder':
          if (Array.isArray(msg.order) && msg.order.length) {
            sessionOrder = msg.order.map(String).filter(function (id) {
              var n = parseInt(id, 10);
              return n >= 1 && n <= MAX_SESSIONS && String(n) === id;
            });
            if (sessionOrder.length === 0) sessionOrder = ['1', '2', '3'];
            var seen = {};
            sessionOrder = sessionOrder.filter(function (id) {
              if (seen[id]) return false;
              seen[id] = true;
              return true;
            });
            if (sessionOrder.indexOf(activeSessionId) < 0) {
              activeSessionId = sessionOrder[0];
            }
            sessionOrder.forEach(function (s) { ensureSessionStructures(s); });
            renderSessionRail();
            renderAttachChips();
            renderMessages();
          }
          break;

        case 'restoreSessionMemos':
          if (msg.memos && typeof msg.memos === 'object') {
            Object.keys(msg.memos).forEach(function (k) {
              var raw = msg.memos[k];
              if (raw == null) return;
              var t = String(raw).trim().slice(0, 200);
              if (t) sessionMemos[k] = t;
            });
            if (sessionMemoInput) sessionMemoInput.value = sessionMemos[activeSessionId] || '';
          }
          break;

        case 'restoreHistories':
          try {
            var data = JSON.parse(msg.payload || '{}');
            Object.keys(data).forEach(function (sid) {
              if (!Array.isArray(data[sid])) return;
              ensureSessionStructures(sid);
              messagesBySession[sid] = data[sid].map(function (row) {
                return { type: row.type, content: row.content, time: row.time ? new Date(row.time) : new Date() };
              });
            });
            renderMessages();
          } catch (e) { /* ignore */ }
          break;

        case 'voiceInputResult':
          setVoiceNativeBusy(false);
          if (msg.ok) {
            var vt = String(msg.text || '').trim();
            if (vt) {
              var curV = msgInput.value;
              var sep = curV && !/\\s$/.test(curV) ? ' ' : '';
              msgInput.value = curV + sep + vt;
              showFeedback(sendFeedback, 'success', '已写入语音识别结果');
            } else {
              showFeedback(sendFeedback, 'info', '未获得有效文字');
            }
          } else {
            showFeedback(sendFeedback, 'error', msg.msg || '语音识别失败');
          }
          break;

        case 'sendResult':
          setLoading(sendBtn, false);
          if (testHelloBtn) setLoading(testHelloBtn, false);
          if (msg.ok) {
            var sid = msg.sessionId || activeSessionId;
            var line = msg.text || msgInput.value.trim() || '(仅附件)';
            if (msg.attachmentLabels && msg.attachmentLabels.length) {
              line += '\\n' + msg.attachmentLabels.join(' · ');
            }
            addMessage('user', line, undefined, sid);
            msgInput.value = '';
            pendingBySession[sid] = [];
            renderAttachChips();
            showFeedback(sendFeedback, 'success', msg.msg);
          } else {
            showFeedback(sendFeedback, 'error', '发送失败：' + msg.msg);
          }
          break;

        case 'cursorReply':
          if (msg.reply) {
            addMessage('cursor', msg.reply, msg.time, msg.sessionId || activeSessionId);
            statusDot.className = 'status-dot connected';
          }
          break;

        case 'pong':
          addMessage('system', 'pong: ' + msg.text);
          break;
      }
    });

    renderMessages();

    /* ===== 自动检查更新 ===== */
    (function setupAutoUpdate() {
      var badge = document.getElementById('updateBadge');
      var badgeText = document.getElementById('updateBadgeText');
      if (!badge) return;
      var latestVer = '';
      var fallbackUrl = '';
      var fallbackMode = false; // true: 点击打开 release 页；false: 走一键升级
      function setBadge(state, text) {
        badgeText.textContent = text;
        badge.classList.toggle('busy', state === 'busy');
        badge.style.display = '';
      }
      function hide() { badge.style.display = 'none'; }
      badge.addEventListener('click', function () {
        if (badge.classList.contains('busy')) return;
        if (fallbackMode) {
          vscodeApi.postMessage({ command: 'updateOpenReleasePage', url: fallbackUrl });
          return;
        }
        setBadge('busy', '下载中…');
        vscodeApi.postMessage({ command: 'updateInstall' });
      });
      setTimeout(function () {
        vscodeApi.postMessage({ command: 'updateCheck' });
      }, 1500);
      window.addEventListener('message', function (event) {
        var msg = event.data;
        if (!msg || !msg.command) return;
        if (msg.command === 'updateCheckResult') {
          if (msg.ok && msg.hasUpdate && msg.hasVsix) {
            latestVer = msg.latest;
            fallbackUrl = msg.htmlUrl || '';
            fallbackMode = false;
            setBadge('ready', '有新版 v' + msg.latest);
            badge.title = '点击一键升级：v' + msg.current + ' → v' + msg.latest;
          } else if (msg.ok && msg.hasUpdate && !msg.hasVsix) {
            latestVer = msg.latest;
            fallbackUrl = msg.htmlUrl || '';
            fallbackMode = true;
            setBadge('ready', '有新版 v' + msg.latest + '（需手动）');
            badge.title = '点击打开 Releases 页面手动下载';
          } else if (!msg.ok) {
            fallbackUrl = msg.htmlUrl || '';
            fallbackMode = true;
            setBadge('ready', '检查更新');
            badge.title = (msg.msg || '检查更新失败') + '\\n点击打开 GitHub Releases 页面';
          } else {
            hide();
          }
        } else if (msg.command === 'updateInstallProgress') {
          setBadge('busy', msg.step === 'downloading' ? '下载 v' + msg.version + '…' : '安装 v' + msg.version + '…');
        } else if (msg.command === 'updateInstallResult') {
          if (msg.ok) {
            fallbackMode = false;
            setBadge('ready', '已升级到 v' + msg.version);
            badge.title = '请重新加载窗口生效';
          } else {
            if (msg.htmlUrl) { fallbackUrl = msg.htmlUrl; fallbackMode = true; }
            setBadge('ready', fallbackMode ? '去下载' : '升级失败：点此重试');
            badge.title = (msg.msg || '升级失败') + (fallbackMode ? '\\n点击打开 Releases 页面手动下载' : '');
          }
        }
      });
    })();

    /* ===== 发车/上车 UI ===== */
    (function setupFaChe() {
      var driverPanel = document.getElementById('fcDriverPanel');
      var riderPanel = document.getElementById('fcRiderPanel');
      var tabs = document.querySelectorAll('#fcRoleTabs .fc-tab');
      var driverMeta = document.getElementById('fcDriverMeta');
      var metaTimeEl = document.getElementById('fcMetaTime');
      var metaRefreshBtn = document.getElementById('fcMetaRefreshBtn');
      var metaCopyAllBtn = document.getElementById('fcMetaCopyAllBtn');
      var genBtn = document.getElementById('fcGenBtn');
      var lastFpInfo = null;
      var openBackupBtn = document.getElementById('fcOpenBackupBtn');
      var openBackupBtn2 = document.getElementById('fcOpenBackupBtn2');
      var ticketOut = document.getElementById('fcTicketOut');
      var copyBtn = document.getElementById('fcCopyBtn');
      var ticketIn = document.getElementById('fcTicketIn');
      var applyBtn = document.getElementById('fcApplyBtn');
      var verifyBtn = document.getElementById('fcVerifyBtn');
      var verifyBox = document.getElementById('fcVerifyBox');
      var fbEl = document.getElementById('fcFeedback');
      var roleToggleBtn = document.getElementById('fcToggleRoleBtn');
      var cloudPubBtn = document.getElementById('fcCloudPubBtn');
      var keyBox = document.getElementById('fcKeyBox');
      var keyValueEl = document.getElementById('fcKeyValue');
      var keyExpiresEl = document.getElementById('fcKeyExpires');
      var keyCopyBtn = document.getElementById('fcKeyCopyBtn');
      var ttlSelect = document.getElementById('fcTtlSelect');
      var ttlCustom = document.getElementById('fcTtlCustom');
      var keyExpiresAt = 0;
      var keyTimer = null;
      var FC_TTL_MIN_MS = 60 * 1000;
      var FC_TTL_MAX_MS = 24 * 3600 * 1000;
      function getSelectedTtlMs() {
        if (!ttlSelect) return 600000;
        if (ttlSelect.value === 'custom') {
          var mins = parseInt(ttlCustom && ttlCustom.value, 10);
          if (!mins || mins < 1) mins = 10;
          return Math.min(FC_TTL_MAX_MS, Math.max(FC_TTL_MIN_MS, mins * 60 * 1000));
        }
        var v = parseInt(ttlSelect.value, 10);
        return Math.min(FC_TTL_MAX_MS, Math.max(FC_TTL_MIN_MS, v || 600000));
      }
      if (ttlSelect) ttlSelect.addEventListener('change', function () {
        if (ttlCustom) ttlCustom.style.display = ttlSelect.value === 'custom' ? '' : 'none';
      });

      function fcFeedback(type, text) {
        if (!fbEl) return;
        fbEl.className = 'feedback show ' + type;
        fbEl.textContent = text;
        if (type === 'success' || type === 'info') {
          setTimeout(function () { fbEl.classList.remove('show'); }, 8000);
        }
      }

      function switchRole(role) {
        tabs.forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-role') === role); });
        driverPanel.style.display = role === 'driver' ? '' : 'none';
        riderPanel.style.display = role === 'rider' ? '' : 'none';
      }
      tabs.forEach(function (t) {
        t.addEventListener('click', function () { switchRole(t.getAttribute('data-role')); });
      });
      if (roleToggleBtn) roleToggleBtn.addEventListener('click', function () {
        var curDriver = driverPanel.style.display !== 'none';
        switchRole(curDriver ? 'rider' : 'driver');
      });

      function row(key, val) {
        var hasVal = !!val;
        var safeVal = hasVal ? escapeHtml(val) : '（未读到）';
        var valCls = hasVal ? 'fc-val' : 'fc-val fc-empty';
        var copyAttr = hasVal ? ' data-fc-copy="' + escapeHtml(val) + '"' : ' disabled';
        return '<div class="fc-row">' +
          '<span class="fc-key">' + escapeHtml(key) + '</span>' +
          '<span class="' + valCls + '">' + safeVal + '</span>' +
          '<button type="button" class="fc-copy"' + copyAttr + ' title="复制">复制</button>' +
          '</div>';
      }
      function renderDriverMeta(info) {
        if (!driverMeta) return;
        if (!info) { driverMeta.innerHTML = '<span class="fc-empty">读取失败</span>'; return; }
        lastFpInfo = info;
        var fp = info.fp || {};
        var ips = Array.isArray(info.ips) ? info.ips.join(', ') : '';
        var cursorLine = info.cursorExe
          ? row('Cursor 可执行', info.cursorExe)
          : '<div class="fc-row"><span class="fc-key">Cursor 可执行</span><span class="fc-val fc-empty">未识别（可在设置 cursorMcp.cursorExePath 指定）</span><button type="button" class="fc-copy" disabled>复制</button></div>';
        driverMeta.innerHTML =
          row('主机名', info.host || '') +
          row('IPv4', ips) +
          row('平台', info.platform || '') +
          cursorLine +
          row('machineId', fp.machineId) +
          row('devDeviceId', fp.devDeviceId) +
          row('telemetry.machineId', fp.telemetryMachineId) +
          row('telemetry.macMachineId', fp.macMachineId) +
          row('telemetry.sqmId', fp.sqmId) +
          row('MachineGuid', fp.machineGuid);
        if (metaTimeEl) metaTimeEl.textContent = '读取于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
      }
      if (driverMeta) driverMeta.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.classList || !t.classList.contains('fc-copy')) return;
        var v = t.getAttribute('data-fc-copy');
        if (!v) return;
        vscodeApi.postMessage({ command: 'fcCopyTicket', ticket: v });
      });
      if (metaCopyAllBtn) metaCopyAllBtn.addEventListener('click', function () {
        if (!lastFpInfo) return;
        var fp = lastFpInfo.fp || {};
        var lines = [
          'host: ' + (lastFpInfo.host || ''),
          'ipv4: ' + (Array.isArray(lastFpInfo.ips) ? lastFpInfo.ips.join(', ') : ''),
          'platform: ' + (lastFpInfo.platform || ''),
          'cursorExe: ' + (lastFpInfo.cursorExe || ''),
          'machineId: ' + (fp.machineId || ''),
          'devDeviceId: ' + (fp.devDeviceId || ''),
          'telemetry.machineId: ' + (fp.telemetryMachineId || ''),
          'telemetry.macMachineId: ' + (fp.macMachineId || ''),
          'telemetry.sqmId: ' + (fp.sqmId || ''),
          'MachineGuid: ' + (fp.machineGuid || '')
        ];
        vscodeApi.postMessage({ command: 'fcCopyTicket', ticket: lines.join('\\n') });
      });
      function requestInfo() {
        if (metaTimeEl) metaTimeEl.textContent = '读取中…';
        vscodeApi.postMessage({ command: 'fcGetInfo' });
      }
      requestInfo();
      if (metaRefreshBtn) metaRefreshBtn.addEventListener('click', requestInfo);

      if (genBtn) genBtn.addEventListener('click', function () {
        genBtn.disabled = true;
        fcFeedback('pending', '正在生成车票…');
        vscodeApi.postMessage({ command: 'fcCreateTicket' });
      });
      if (copyBtn) copyBtn.addEventListener('click', function () {
        var v = ticketOut.value.trim();
        if (!v) return;
        vscodeApi.postMessage({ command: 'fcCopyTicket', ticket: v });
      });
      if (applyBtn) applyBtn.addEventListener('click', function () {
        var v = ticketIn.value.trim();
        if (!v) { fcFeedback('error', '请先粘贴密钥或车票'); return; }
        applyBtn.disabled = true;
        if (/^sk-[A-Za-z0-9]{17}$/.test(v)) {
          fcFeedback('pending', '正在向云端领取指纹…');
          vscodeApi.postMessage({ command: 'fcCloudPickup', key: v });
        } else if (v.indexOf('FCT1.') === 0) {
          fcFeedback('pending', '正在覆盖本机 Cursor 指纹…');
          vscodeApi.postMessage({ command: 'fcApplyTicket', ticket: v });
        } else {
          applyBtn.disabled = false;
          fcFeedback('error', '无法识别：应为 sk- 开头 20 位密钥 或 FCT1. 开头的长车票');
        }
      });
      if (verifyBtn) verifyBtn.addEventListener('click', function () {
        verifyBtn.disabled = true;
        fcFeedback('pending', '正在读取本机 Cursor 指纹并与车头对比…');
        vscodeApi.postMessage({ command: 'fcVerifyFingerprint' });
      });
      var unlockBtn = document.getElementById('fcUnlockBtn');
      if (unlockBtn) unlockBtn.addEventListener('click', function () {
        unlockBtn.disabled = true;
        fcFeedback('pending', '正在解锁 storage.json…');
        vscodeApi.postMessage({ command: 'fcUnlockStorage' });
      });
      function esc(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }
      function renderVerifyResult(msg) {
        if (!verifyBox) return;
        if (!msg.ok) {
          verifyBox.className = 'fc-verify-box bad';
          verifyBox.innerHTML = '<div class="fc-verify-head"><span class="bad">验证失败</span></div>'
            + '<div class="fc-verify-sub">' + esc(msg.msg || '') + '</div>';
          verifyBox.style.display = '';
          return;
        }
        var ok = !!msg.allMatch;
        verifyBox.className = 'fc-verify-box ' + (ok ? 'ok' : 'bad');
        var headHtml = ok
          ? '<span class="ok">✓ 全部一致（' + msg.matched + '/' + msg.checked + '）</span>'
          : '<span class="bad">✗ ' + (msg.checked - msg.matched) + ' 项不一致（' + msg.matched + '/' + msg.checked + '）</span>';
        var srcLabel = msg.src === 'cloud' ? '云端 sk-' : (msg.src === 'ticket' ? '本地 FCT1.' : '');
        var savedAt = msg.savedAt ? new Date(msg.savedAt).toLocaleString() : '';
        var subHtml = '车头：' + esc(msg.host || '未知')
          + (srcLabel ? ' · 来源：' + esc(srcLabel) : '')
          + (savedAt ? ' · 上车时间：' + esc(savedAt) : '');
        var rowsHtml = '';
        (msg.rows || []).forEach(function (r) {
          var icon = r.status === 'match' ? '✓' : (r.status === 'mismatch' ? '✗' : '—');
          var iconCls = r.status;
          if (r.status === 'skipped') {
            rowsHtml += '<div class="fc-verify-row">'
              + '<div class="fc-verify-icon ' + iconCls + '">' + icon + '</div>'
              + '<div class="fc-verify-field">'
              + '<span class="k">' + esc(r.key) + '</span>'
              + '<span class="kv">车头未提供此字段（跳过）</span>'
              + '</div></div>';
            return;
          }
          var mismatchCls = r.status === 'mismatch' ? ' mismatch' : '';
          rowsHtml += '<div class="fc-verify-row">'
            + '<div class="fc-verify-icon ' + iconCls + '">' + icon + '</div>'
            + '<div class="fc-verify-field">'
            + '<span class="k">' + esc(r.key) + '</span>'
            + '<span class="kv">车头：' + esc(r.expected || '(空)') + '</span>'
            + '<span class="kv actual' + mismatchCls + '">本机：' + esc(r.actual || '(空)') + '</span>'
            + '</div></div>';
        });
        verifyBox.innerHTML = '<div class="fc-verify-head">' + headHtml + '</div>'
          + '<div class="fc-verify-sub">' + subHtml + '</div>'
          + rowsHtml;
        verifyBox.style.display = '';
      }

      function formatRemain(ms) {
        if (ms <= 0) return '已过期';
        var s = Math.ceil(ms / 1000);
        var m = Math.floor(s / 60);
        var r = s % 60;
        return '剩余 ' + (m > 0 ? m + ' 分 ' : '') + r + ' 秒';
      }
      function tickKeyExpires() {
        if (!keyExpiresAt || !keyExpiresEl) return;
        var remain = keyExpiresAt - Date.now();
        keyExpiresEl.textContent = formatRemain(remain);
        keyExpiresEl.classList.toggle('expired', remain <= 0);
        if (remain <= 0 && keyTimer) { clearInterval(keyTimer); keyTimer = null; }
      }
      if (cloudPubBtn) cloudPubBtn.addEventListener('click', function () {
        cloudPubBtn.disabled = true;
        var ttlMs = getSelectedTtlMs();
        fcFeedback('pending', '正在向云端发布指纹（有效期 ' + Math.round(ttlMs / 60000) + ' 分钟）…');
        vscodeApi.postMessage({ command: 'fcCloudPublish', ttlMs: ttlMs });
      });
      if (keyCopyBtn) keyCopyBtn.addEventListener('click', function () {
        var v = keyValueEl ? keyValueEl.textContent : '';
        if (!v) return;
        vscodeApi.postMessage({ command: 'fcCopyTicket', ticket: v });
      });
      function openBackup() { vscodeApi.postMessage({ command: 'fcOpenBackupDir' }); }
      if (openBackupBtn) openBackupBtn.addEventListener('click', openBackup);
      if (openBackupBtn2) openBackupBtn2.addEventListener('click', openBackup);

      window.addEventListener('message', function (event) {
        var msg = event.data;
        if (!msg || !msg.command) return;
        switch (msg.command) {
          case 'fcInfo':
            renderDriverMeta(msg);
            if (ttlSelect && msg.defaultTtlMs) {
              var d = String(msg.defaultTtlMs);
              var hit = Array.prototype.some.call(ttlSelect.options, function (o) { return o.value === d; });
              if (hit) {
                ttlSelect.value = d;
                if (ttlCustom) ttlCustom.style.display = 'none';
              } else {
                ttlSelect.value = 'custom';
                if (ttlCustom) {
                  ttlCustom.style.display = '';
                  ttlCustom.value = String(Math.max(1, Math.round(msg.defaultTtlMs / 60000)));
                }
              }
            }
            break;
          case 'fcTicketResult':
            genBtn.disabled = false;
            if (msg.ok) {
              ticketOut.value = msg.ticket || '';
              copyBtn.disabled = !ticketOut.value;
              renderDriverMeta({ fp: msg.fp, ips: msg.ips, host: msg.host, platform: (msg.platform || '') });
              fcFeedback('success', '车票已生成，点「复制车票」发给乘客即可');
            } else {
              fcFeedback('error', msg.msg || '生成失败');
            }
            break;
          case 'fcApplyResult':
            applyBtn.disabled = false;
            if (msg.ok) {
              fcFeedback('success', msg.msg || '已上车');
              if (msg.mode === 'restart') {
                addMessage('system', '已调度后台 helper：Cursor 将关闭 → 写入指纹 → 自动重启\\n备份：' + (msg.backupDir || '') + '\\n任务：' + (msg.pendingPath || ''));
              } else {
                addMessage('system', '已上车：' + (Array.isArray(msg.touched) ? msg.touched.join('、') : '') + (msg.backupDir ? '\\n备份：' + msg.backupDir : ''));
              }
            } else {
              fcFeedback('error', msg.msg || '上车失败');
            }
            break;
          case 'fcVerifyResult':
            if (verifyBtn) verifyBtn.disabled = false;
            renderVerifyResult(msg);
            if (msg.ok) {
              fcFeedback(msg.allMatch ? 'success' : 'error',
                msg.allMatch
                  ? '验证通过：当前指纹与车头完全一致'
                  : '有 ' + (msg.checked - msg.matched) + ' 项不一致，请查看下方详情');
            } else {
              fcFeedback('error', msg.msg || '验证失败');
            }
            break;
          case 'fcUnlockResult':
            if (unlockBtn) unlockBtn.disabled = false;
            fcFeedback(msg.ok ? 'success' : 'error', msg.msg || (msg.ok ? '已解锁' : '解锁失败'));
            break;
          case 'fcCloudPublishResult':
            cloudPubBtn.disabled = false;
            if (msg.ok) {
              if (keyValueEl) keyValueEl.textContent = msg.key || '';
              if (keyBox) keyBox.style.display = '';
              keyExpiresAt = +msg.expiresAt || 0;
              if (keyTimer) clearInterval(keyTimer);
              tickKeyExpires();
              keyTimer = setInterval(tickKeyExpires, 1000);
              fcFeedback('success', '云端发车成功：把上方 sk- 密钥发给乘客即可（一次性领取）');
            } else {
              if (keyBox) keyBox.style.display = 'none';
              fcFeedback('error', msg.msg || '云端发车失败');
            }
            break;
          case 'fcClipboardResult':
            if (msg.ok) fcFeedback('success', '已复制到剪贴板');
            break;
        }
      });
    })();
  </script>
</body>
</html>`;
}
function getNonce() {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
//# sourceMappingURL=extension.js.map
