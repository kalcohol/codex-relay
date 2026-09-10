<#
.SYNOPSIS
  确保 codex-relay 各端点代理在运行（幂等、快速返回）。
.DESCRIPTION
  供三种入口复用（见 docs/plan.md §5.2）：
    1. Codex SessionStart hook（首次需信任）——兜底；
    2. codex-*.ps1 启动器——第三道保险；
    3. 手工运维 / 排障。
  逐端点探测 GET /healthz，不健康则拉起监督进程（supervise-endpoint.ps1）并等待就绪。
  默认始终以退出码 0 结束（避免 hook 阻塞会话）；需要严格判定时加 -Strict。
.EXAMPLE
  powershell -NoProfile -File deploy\ensure-proxy.ps1
.EXAMPLE
  powershell -NoProfile -File deploy\ensure-proxy.ps1 -Status
#>
[CmdletBinding()]
param(
  [string]$ConfigPath,
  [string[]]$Only,
  [int]$TimeoutMs = 8000,
  [switch]$Status,
  [switch]$Strict,
  [switch]$Restart
)

$ErrorActionPreference = 'Stop'
# 注意：$PSScriptRoot 在 param 默认值中不可用（PS 5.1 + CmdletBinding），只能在脚本体内解析。
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot '..\relay.config.json' }

function Test-RelayHealthy {
  param([int]$Port, [int]$TimeoutMs = 1500)
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" `
      -TimeoutSec ([Math]::Max(1, [int][Math]::Ceiling($TimeoutMs / 1000)))
    return $resp.StatusCode -eq 200
  } catch {
    return $false
  }
}

# 轮询等待就绪（监督进程接管通常 1–3 秒）
function Wait-RelayHealthy {
  param([int]$Port, [int]$TimeoutMs)
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  while ((Get-Date) -lt $deadline) {
    if (Test-RelayHealthy -Port $Port -TimeoutMs 1000) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

# 判断该端点是否已有活着的监督进程：锁文件被独占说明持有者还活着，
# 能独占打开则说明持有者已死（与 supervise-endpoint.ps1 同一判据）。
function Test-SupervisorAlive {
  param([string]$Name)
  $lockPath = Join-Path $logDir "$Name.lock"
  if (-not (Test-Path -LiteralPath $lockPath)) { return $false }
  try {
    $handle = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $handle.Dispose()
    return $false
  } catch {
    return $true
  }
}

# 停掉正在监听该端口的 relay 进程（监督进程会按自己的节奏把它拉回来）
function Stop-RelayListener {
  param([int]$Port)
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conn) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
}

# PS 5.1 默认按 ANSI 读文件，中文注释会变乱码并破坏 JSON 解析，必须显式 UTF-8。
$cfg = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $ConfigPath), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$endpoints = $cfg.endpoints
if ($Only) { $endpoints = $endpoints | Where-Object { $Only -contains $_.name } }

$repoRoot = Split-Path -Parent $PSScriptRoot
$supervisor = Join-Path $PSScriptRoot 'supervise-endpoint.ps1'
$logDir = Join-Path $env:LOCALAPPDATA 'codex-relay\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$failures = 0
foreach ($ep in $endpoints) {
  $healthy = Test-RelayHealthy -Port $ep.port
  if ($healthy -and -not $Restart) {
    Write-Host ("{0,-9} :{1} up" -f $ep.name, $ep.port)
    continue
  }
  if ($Restart -and $healthy) {
    Write-Host ("{0,-9} :{1} 重启：停掉当前 relay 进程，等监督进程拉起新进程" -f $ep.name, $ep.port)
    Stop-RelayListener -Port $ep.port
  }
  if ($Status) {
    Write-Host ("{0,-9} :{1} DOWN" -f $ep.name, $ep.port)
    $failures += 1
    continue
  }

  # 已在跑的监督进程会自己把 relay 拉回来，等它就够——这里再起一个监督进程
  # 只会和现任争锁，最后报出"未就绪"的假失败。
  if ($Restart -or (Test-SupervisorAlive -Name $ep.name)) {
    # 手动重启会被监督进程当作"快速失败"，退避可能涨到 30s；这里等够一个退避周期。
    $waitMs = if ($Restart) { [Math]::Max($TimeoutMs, 35000) } else { [Math]::Min($TimeoutMs, 6000) }
    if (Wait-RelayHealthy -Port $ep.port -TimeoutMs $waitMs) {
      Write-Host ("{0,-9} :{1} up（监督进程已拉起）" -f $ep.name, $ep.port)
      continue
    }
    if (Test-SupervisorAlive -Name $ep.name) {
      Write-Host ("{0,-9} :{1} 未就绪，但监督进程在运行（可能正在退避重启，见 $logDir）" -f $ep.name, $ep.port)
      $failures += 1
      continue
    }
  }

  Write-Host ("{0,-9} :{1} down → 拉起监督进程" -f $ep.name, $ep.port)
  Start-Process -FilePath 'powershell' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $supervisor, '-Name', $ep.name) `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "$($ep.name)-ensure.out.log") `
    -RedirectStandardError (Join-Path $logDir "$($ep.name)-ensure.err.log") | Out-Null

  if (Wait-RelayHealthy -Port $ep.port -TimeoutMs $TimeoutMs) {
    Write-Host ("{0,-9} :{1} up（已启动）" -f $ep.name, $ep.port)
  } else {
    Write-Host ("{0,-9} :{1} FAILED（${TimeoutMs}ms 内未就绪，见 $logDir）" -f $ep.name, $ep.port)
    $failures += 1
  }
}

if ($Status) {
  # 只报告状态：默认 0；配合 -Strict 时有端点不可用返回 1，便于脚本判定
  if ($failures -gt 0 -and $Strict) { exit 1 }
  exit 0
}
if ($failures -gt 0 -and $Strict) { exit 1 }
if ($failures -gt 0) { Write-Warning "有 $failures 个端点未就绪" }
exit 0
