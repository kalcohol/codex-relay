<#
.SYNOPSIS
  确保 codex-relay 单进程代理在运行（幂等、快速返回）。
.DESCRIPTION
  单进程架构（docs/deploy.md §3）：一个进程监听全部端点端口；计划任务
  codex-relay 以"登录时 + 每 1 分钟重复触发"充当看门狗。

  本脚本的行为：
    - 全部端点健康：只打印状态即返回（无副作用）；
    - 有端点不健康：优先通过计划任务修复（任务未运行则启动；任务在运行但
      端口仍未就绪则强制换血：结束 node 进程后再次启动任务）；没有注册任务
      时退回直接拉起 node（hook / 手工场景）；
    - -Restart：结束当前 relay 进程并立即重新拉起（比等看门狗快）；
    - -Status：只报告，不改动；配合 -Strict，有端点不健康时退出码 1。
.EXAMPLE
  powershell -NoProfile -File deploy\ensure-proxy.ps1
.EXAMPLE
  powershell -NoProfile -File deploy\ensure-proxy.ps1 -Status -Strict
#>
[CmdletBinding()]
param(
  [string]$ConfigPath,
  [string[]]$Only,
  [int]$TimeoutMs = 20000,
  [switch]$Status,
  [switch]$Strict,
  [switch]$Restart
)

$ErrorActionPreference = 'Stop'
# 注意：$PSScriptRoot 在 param 默认值中不可用（PS 5.1 + CmdletBinding），只能在脚本体内解析。

# ---- 路径解析：部署不依赖源码仓库的位置（仓库可随意挪动/删除） ----
$npmRoot = $null
try { $npmRoot = (& npm root -g).Trim() } catch { }
$repoRoot = Split-Path -Parent $PSScriptRoot
$installedRelay = if ($npmRoot) { Join-Path $npmRoot 'codex-relay\relay.js' } else { $null }
$relayJs = if ($installedRelay -and (Test-Path -LiteralPath $installedRelay)) { $installedRelay } else { Join-Path $repoRoot 'relay.js' }
$appDataConfig = Join-Path $env:APPDATA 'codex-relay\relay.config.json'
if (-not $ConfigPath) {
  $ConfigPath = if (Test-Path -LiteralPath $appDataConfig) { $appDataConfig } else { Join-Path $repoRoot 'relay.config.json' }
}

# PS 5.1 默认按 ANSI 读文件，中文注释会变乱码并破坏 JSON 解析，必须显式 UTF-8。
$cfg = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $ConfigPath), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$endpoints = $cfg.endpoints
if ($Only) { $endpoints = $endpoints | Where-Object { $Only -contains $_.name } }

$taskName = 'codex-relay'
$logDir = Join-Path $env:LOCALAPPDATA 'codex-relay\logs'
$logFile = Join-Path $logDir 'relay.log'

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

function Get-RelayTask {
  Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

# 单进程模式下任意一个监听端口的进程就是 relay 本体
function Get-RelayPid {
  param([int[]]$Ports)
  $conn = Get-NetTCPConnection -LocalPort $Ports -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { return $conn.OwningProcess }
  return $null
}

function Wait-Healthy {
  param([object[]]$Endpoints, [int]$TimeoutMs)
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  while ((Get-Date) -lt $deadline) {
    $down = @($Endpoints | Where-Object { -not (Test-RelayHealthy -Port $_.port -TimeoutMs 1000) })
    if ($down.Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Start-RelayProcess {
  # 无计划任务时的退路（hook / 手工场景）：直接拉起单进程，日志由 relay 自写文件
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $args = '"{0}" --config "{1}" --log-file "{2}"' -f $relayJs, $ConfigPath, $logFile
  Start-Process -FilePath 'node' -ArgumentList $args -WorkingDirectory $repoRoot -WindowStyle Hidden | Out-Null
}

function Stop-RelayProcesses {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'relay\.js' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

$ports = @($endpoints | ForEach-Object { $_.port })
$states = foreach ($ep in $endpoints) {
  [pscustomobject]@{ name = $ep.name; port = $ep.port; up = (Test-RelayHealthy -Port $ep.port) }
}

if ($Status) {
  $task = Get-RelayTask
  $taskState = if ($task) { $task.State } else { '未注册' }
  foreach ($s in $states) {
    Write-Host ("{0,-9} :{1} {2}" -f $s.name, $s.port, $(if ($s.up) { 'up' } else { 'DOWN' }))
  }
  Write-Host ("任务 {0}: {1}" -f $taskName, $taskState)
  $failures = @($states | Where-Object { -not $_.up }).Count
  if ($failures -gt 0 -and $Strict) { exit 1 }
  exit 0
}

if ($Restart) {
  Write-Host "重启：结束当前 relay 进程并立即重新拉起"
  Stop-RelayProcesses
  if (Get-RelayTask) { Start-ScheduledTask -TaskName $taskName }
  else { Start-RelayProcess }
  if (Wait-Healthy -Endpoints $endpoints -TimeoutMs ([Math]::Max($TimeoutMs, 15000))) {
    foreach ($s in $states) { Write-Host ("{0,-9} :{1} up（已重启）" -f $s.name, $s.port) }
    exit 0
  }
  Write-Warning '重启后仍有端点未就绪（看门狗会在 1 分钟内再试；详见日志）'
  exit 1
}

$down = @($states | Where-Object { -not $_.up })
if ($down.Count -eq 0) {
  foreach ($s in $states) { Write-Host ("{0,-9} :{1} up" -f $s.name, $s.port) }
  exit 0
}

$task = Get-RelayTask
$repaired = $false
if ($task) {
  if ($task.State -ne 'Running') {
    Write-Host "有端点不健康且任务未运行 → 启动任务 $taskName"
    Start-ScheduledTask -TaskName $taskName
    $repaired = Wait-Healthy -Endpoints $endpoints -TimeoutMs $TimeoutMs
  }
  if (-not $repaired) {
    # 任务实例在跑但端口仍未就绪：node 可能僵死或启动早期失败，强制换血
    Write-Host "任务在运行但端点仍未就绪 → 结束 node 进程后重启任务"
    Stop-RelayProcesses
    Start-ScheduledTask -TaskName $taskName
    $repaired = Wait-Healthy -Endpoints $endpoints -TimeoutMs $TimeoutMs
  }
} else {
  Write-Host "有端点不健康且未注册任务 $taskName → 直接拉起 relay 进程"
  Start-RelayProcess
  $repaired = Wait-Healthy -Endpoints $endpoints -TimeoutMs $TimeoutMs
}

foreach ($s in $states) {
  $up = if ($repaired) { $true } else { Test-RelayHealthy -Port $s.port }
  Write-Host ("{0,-9} :{1} {2}" -f $s.name, $s.port, $(if ($up) { 'up' } else { 'DOWN' }))
}
$stillDown = @($states | Where-Object { -not (Test-RelayHealthy -Port $_.port) })
if ($stillDown.Count -gt 0) {
  Write-Warning "有 $($stillDown.Count) 个端点未就绪（日志: $logFile）"
  if ($Strict) { exit 1 }
} elseif ($repaired) {
  Write-Host '已修复。'
}
exit 0
