<#
.SYNOPSIS
  监督单个端点的 relay 进程：进程退出即拉起，带快速重启与退避。
.DESCRIPTION
  §5.4 的进程韧性：三层 ensure 都只在会话启动时触发，覆盖不了会话中途崩溃；
  由本脚本常驻监督，进程一退出立刻重启（1s 起，连续快速失败则退避到 30s），
  使 Codex 的 stream_max_retries 重试窗口内即可恢复。

  同一端点同时只允许一个监督进程（锁文件 + 端口健康探测去重）。
.EXAMPLE
  powershell -NoProfile -File deploy\supervise-endpoint.ps1 -Name deepseek
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$ConfigPath,
  [int]$BackoffMaxSeconds = 30,
  [switch]$Once
)

$ErrorActionPreference = 'Stop'
# 注意：$PSScriptRoot 在 param 默认值中不可用（PS 5.1 + CmdletBinding），只能在脚本体内解析。
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot '..\relay.config.json' }

function Write-Log {
  param([string]$Message)
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host "[supervise:$Name] $Message"
  if ($script:SupervisorLog) {
    Add-Content -LiteralPath $script:SupervisorLog -Value $line -ErrorAction SilentlyContinue
  }
}

# PS 5.1 默认按 ANSI 读文件，中文注释会变乱码并破坏 JSON 解析，必须显式 UTF-8。
$cfg = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $ConfigPath), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$endpoint = $cfg.endpoints | Where-Object { $_.name -eq $Name } | Select-Object -First 1
if (-not $endpoint) { throw "relay.config.json 中找不到端点 '$Name'" }

$repoRoot = Split-Path -Parent $PSScriptRoot
$relayJs = Join-Path $repoRoot 'relay.js'
if (-not (Test-Path -LiteralPath $relayJs)) { throw "找不到 $relayJs" }

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw 'PATH 中找不到 node（需要 Node.js >= 18）' }

$logDir = Join-Path $env:LOCALAPPDATA 'codex-relay\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$script:SupervisorLog = Join-Path $logDir "$Name-supervisor.log"

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

# 单实例保护。锁文件内容写自己的 PID（便于日志定位），但"是否陈旧"不依赖它：
# 进程被强杀时文件句柄由系统释放，因此**能重新独占打开 = 原持有者已死**（含旧版本留下的空锁）；
# 反之打不开就说明确有活着的持有者。这样避免了"陈旧锁要等固定秒数"的启动延迟。
$lockPath = Join-Path $logDir "$Name.lock"
$lock = $null

function Acquire-Lock {
  try {
    $handle = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  } catch {
    try {
      $handle = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      $handle.SetLength(0)
    } catch {
      return $null
    }
  }
  $bytes = [System.Text.Encoding]::ASCII.GetBytes("pid=$PID`nstarted=$(Get-Date -Format o)`n")
  $handle.Write($bytes, 0, $bytes.Length)
  $handle.Flush()
  return $handle
}

function Get-LockOwnerPid {
  try {
    $text = [System.IO.File]::ReadAllText($lockPath)
    if ($text -match 'pid=(\d+)') { return [int]$Matches[1] }
  } catch { }
  return $null
}

for ($attempt = 1; $attempt -le 3; $attempt++) {
  $lock = Acquire-Lock
  if ($lock) { break }

  if (Test-RelayHealthy -Port $endpoint.port) {
    Write-Log '已有实例在运行（健康检查通过），退出'
    exit 0
  }
  $owner = Get-LockOwnerPid
  $ownerText = if ($owner) { "pid=$owner" } else { '未知持有者' }
  Write-Log "锁被 $ownerText 持有但端口 $($endpoint.port) 不健康；等待 2 秒后重试（$attempt/3）"
  Start-Sleep -Seconds 2
}

if (-not $lock) {
  Write-Log '无法取得锁，退出（避免重复拉起）'
  exit 0
}

try {
  $backoff = 1
  while ($true) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $outLog = Join-Path $logDir "$Name-$stamp.out.log"
    $errLog = Join-Path $logDir "$Name-$stamp.err.log"
    $argList = @($relayJs, "$($endpoint.port)", "$($endpoint.upstream)", '--name', $endpoint.name)

    Write-Log "启动: node $($argList -join ' ')"
    $started = Get-Date
    $proc = Start-Process -FilePath $node.Source -ArgumentList $argList -WindowStyle Hidden `
      -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    $proc.WaitForExit()
    $uptime = [int]((Get-Date) - $started).TotalSeconds
    $exitCode = if ($null -eq $proc.ExitCode) { 'n/a' } else { $proc.ExitCode }
    Write-Log "进程退出 code=$exitCode uptime=${uptime}s（日志: $outLog）"

    if ($Once) { exit $proc.ExitCode }

    if ($uptime -ge 30) { $backoff = 1 } else { $backoff = [Math]::Min($backoff * 2, $BackoffMaxSeconds) }
    Write-Log "${backoff}s 后重启"
    Start-Sleep -Seconds $backoff
  }
} finally {
  if ($lock) { $lock.Dispose() }
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
