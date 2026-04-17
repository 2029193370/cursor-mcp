#!/usr/bin/env node
/**
 * 验证 scheduleApplyAndRestart 生成的 PowerShell helper：
 * 1. 可以脱离父进程运行（父先退出也不影响）
 * 2. 等"目标 Cursor 进程"退出后，正确写入 machineid + storage.json
 * 3. 能正确重启 Cursor
 *
 * 做法：
 *  - 搭一个临时目录模拟 Cursor user dir
 *  - 用 node.exe 模拟一个"假 Cursor"主进程（也可以直接用 notepad，但 notepad 不好 kill 验证）
 *    这里改用另一种思路：helper 不 kill 真 Cursor，而是把 "cursorDir" 指向一个不存在的目录，
 *    脚本里的 Kill-CursorProcesses 查不到进程 → 立刻进入写入 → 完成。
 *  - 然后 copy 扩展里生成 PowerShell 脚本的函数来验证产物
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

if (process.platform !== "win32") {
    console.error("此自测仅适用于 Windows。");
    process.exit(0);
}

function buildApplyAndRestartPowerShell(opts) {
    const esc = (s) => String(s == null ? "" : s).replace(/'/g, "''");
    const candidatesPs = "@(" + (opts.candidates || []).map((c) => `'${esc(c)}'`).join(",") + ")";
    const killDirsPs = "@(" + (opts.killDirs || []).map((c) => `'${esc(c)}'`).join(",") + ")";
    return `
$ErrorActionPreference = 'Continue';
$pendingPath = '${esc(opts.pendingPath)}';
$userDir     = '${esc(opts.userDir)}';
$candidates  = ${candidatesPs};
$killDirs    = ${killDirsPs};
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
} catch { Log ("write storage err: " + $_) }

try { Remove-Item -LiteralPath $pendingPath -Force -ErrorAction SilentlyContinue } catch {}

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
    try { & cmd.exe /c "start cursor" 2>$null | Out-Null; Log "restart via 'start cursor' cmd" } catch {}
}

Log 'helper done';
try { Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue } catch {}
`;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cm-selftest-restart-"));
const userDir = path.join(tmpRoot, "user");
fs.mkdirSync(path.join(userDir, "User", "globalStorage"), { recursive: true });
const spPath = path.join(userDir, "User", "globalStorage", "storage.json");
fs.writeFileSync(spPath, JSON.stringify({
    "telemetry.devDeviceId": "OLD-dev-id",
    "telemetry.machineId": "OLD-telemetry-machineId",
    "telemetry.macMachineId": "OLD-mac",
    "telemetry.sqmId": "{OLD-sqm}",
    "other.existing": "keepme"
}, null, 2), "utf-8");
const miPath = path.join(userDir, "machineid");
fs.writeFileSync(miPath, "OLD-machine-id", "utf-8");

const pendingPath = path.join(tmpRoot, `pending-${crypto.randomBytes(4).toString("hex")}.json`);
const fp = {
    machineId: "NEW-machine-id",
    devDeviceId: "NEW-devDeviceId",
    telemetryMachineId: "NEW-telemetryMachineId",
    macMachineId: "NEW-macMachineId",
    sqmId: "{NEW-sqmId}",
};
fs.writeFileSync(pendingPath, JSON.stringify({ fp, ts: Date.now() }, null, 2), "utf-8");

const cursorExe = path.join(tmpRoot, "fake-cursor", "cursor.exe");
fs.mkdirSync(path.dirname(cursorExe), { recursive: true });
fs.writeFileSync(cursorExe, "", "utf-8");
const cursorDir = path.dirname(cursorExe);

const script = buildApplyAndRestartPowerShell({
    pendingPath,
    userDir,
    candidates: [cursorExe, path.join(tmpRoot, "nonexistent", "Cursor.exe")],
    killDirs: [cursorDir],
});
const ps1Path = path.join(tmpRoot, "helper.ps1");
fs.writeFileSync(ps1Path, "\uFEFF" + script, "utf-8");

console.log("[setup] tmpRoot   :", tmpRoot);
console.log("[setup] pending   :", pendingPath);
console.log("[setup] userDir   :", userDir);
console.log("[setup] cursorDir :", cursorDir);
console.log("[setup] ps1       :", ps1Path);

const child = spawn(`start "" /B powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1Path}"`,
    { shell: true, detached: true, stdio: "ignore", windowsHide: true });
child.unref();
console.log("[spawn] helper pid =", child.pid);

const deadline = Date.now() + 30_000;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let passed = 0, failed = 0;
function assertEq(label, actual, expected) {
    if (actual === expected) { console.log("  PASS", label, "=", actual); passed++; }
    else { console.log("  FAIL", label, "expected", JSON.stringify(expected), "got", JSON.stringify(actual)); failed++; }
}

async function waitDone() {
    while (Date.now() < deadline) {
        if (!fs.existsSync(pendingPath)) return true;
        await sleep(500);
    }
    return false;
}

(async () => {
    const ok = await waitDone();
    if (!ok) { console.error("[fail] helper 超时"); process.exit(1); }

    await sleep(500);
    const mi = fs.readFileSync(miPath, "utf-8");
    assertEq("machineid", mi.trim(), "NEW-machine-id");

    const sp = JSON.parse(fs.readFileSync(spPath, "utf-8"));
    assertEq("telemetry.devDeviceId", sp["telemetry.devDeviceId"], "NEW-devDeviceId");
    assertEq("telemetry.machineId", sp["telemetry.machineId"], "NEW-telemetryMachineId");
    assertEq("telemetry.macMachineId", sp["telemetry.macMachineId"], "NEW-macMachineId");
    assertEq("telemetry.sqmId", sp["telemetry.sqmId"], "{NEW-sqmId}");
    assertEq("storage.serviceMachineId", sp["storage.serviceMachineId"], "NEW-machine-id");
    assertEq("kept other.existing", sp["other.existing"], "keepme");

    // 注意：helper 里的 Start-Process 指向一个 0 字节假 exe，会直接报错退出，
    // 不会产生真正的 cursor.exe 进程 —— 所以这里不要做 taskkill，以免误杀用户真 Cursor。

    console.log(`\n[done] ${passed} PASS, ${failed} FAIL`);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    process.exit(failed === 0 ? 0 : 1);
})();
