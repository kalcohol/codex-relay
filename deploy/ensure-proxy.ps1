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
    Write-Host ("{0,-9} :{1} 健康但仍要求重启：先停旧进程" -f $ep.name, $ep.port)
    $conn = Get-NetTCPConnection -LocalPort $ep.port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conn) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
  }
  if ($Status) {
    Write-Host ("{0,-9} :{1} DOWN" -f $ep.name, $ep.port)
    $failures += 1
    continue
  }

  Write-Host ("{0,-9} :{1} down → 拉起监督进程" -f $ep.name, $ep.port)
  Start-Process -FilePath 'powershell' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $supervisor, '-Name', $ep.name) `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "$($ep.name)-ensure.out.log") `
    -RedirectStandardError (Join-Path $logDir "$($ep.name)-ensure.err.log") | Out-Null

  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  $up = $false
  while ((Get-Date) -lt $deadline) {
    if (Test-RelayHealthy -Port $ep.port -TimeoutMs 1000) { $up = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if ($up) {
    Write-Host ("{0,-9} :{1} up（已启动）" -f $ep.name, $ep.port)
  } else {
    Write-Host ("{0,-9} :{1} FAILED（${TimeoutMs}ms 内未就绪，见 $logDir）" -f $ep.name, $ep.port)
    $failures += 1
  }
}

if ($Status) { exit 0 }
if ($failures -gt 0 -and $Strict) { exit 1 }
if ($failures -gt 0) { Write-Warning "有 $failures 个端点未就绪" }
exit 0
