<#
.SYNOPSIS
  注册 / 卸载 codex-relay 的常驻任务（单进程 + 任务看门狗，见 docs/deploy.md §3）。
.DESCRIPTION
  注册一个任务 codex-relay：动作直接运行 node relay.js --config relay.config.json
  （单进程监听全部端点端口），触发器 = 登录时 + 每 1 分钟重复。
  看门狗语义：任务实例活着（进程在跑）时重复触发被 IgnoreNew 跳过；实例死亡
  （进程退出/被杀）后最多 1 分钟由下一次重复触发拉起——不需要任何常驻守护进程。
  这是 2026-09-13 事故（监督进程被外部终止后无人接管）的结构性修复。

  安装时自动迁移：停止并卸载旧版任务（codex-relay-<端点> / codex-relay-watch），
  清掉旧的多进程 relay，然后注册并立即启动单进程。

  注册计划任务需要管理员权限（非提权时报 0x80070005）。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-tasks.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-tasks.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$ConfigPath,
  [switch]$AtStartup,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
# 注意：$PSScriptRoot 在 param 默认值中不可用（PS 5.1 + CmdletBinding），只能在脚本体内解析。

# ---- 路径解析：部署不依赖源码仓库的位置（仓库可随意挪动/删除） ----
# relay.js：优先 npm 全局安装（npm install -g .），退回仓库内文件
$npmRoot = $null
try { $npmRoot = (& npm root -g).Trim() } catch { }
$repoRoot = Split-Path -Parent $PSScriptRoot
$installedRelay = if ($npmRoot) { Join-Path $npmRoot 'codex-relay\relay.js' } else { $null }
$relayJs = if ($installedRelay -and (Test-Path -LiteralPath $installedRelay)) { $installedRelay } else { Join-Path $repoRoot 'relay.js' }

# relay.config.json：优先 Roaming 配置目录，退回仓库内文件
$appDataConfig = Join-Path $env:APPDATA 'codex-relay\relay.config.json'
if (-not $ConfigPath) {
  $ConfigPath = if (Test-Path -LiteralPath $appDataConfig) { $appDataConfig } else { Join-Path $repoRoot 'relay.config.json' }
}

$taskName = 'codex-relay'
$legacyTaskNames = @('codex-relay-deepseek', 'codex-relay-glm', 'codex-relay-kimi', 'codex-relay-watch')
$logDir = Join-Path $env:LOCALAPPDATA 'codex-relay\logs'
$logFile = Join-Path $logDir 'relay.log'

$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $elevated) {
  Write-Warning '当前不是管理员会话：注册计划任务会被拒绝（0x80070005）。请以管理员身份重跑。'
}

# PS 5.1 默认按 ANSI 读文件，必须显式 UTF-8。
$null = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $ConfigPath), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'PATH 中找不到 node（需要 Node.js >= 18）' }
Write-Host ("relay.js : {0}" -f $relayJs)
Write-Host ("config   : {0}" -f $ConfigPath)

function Remove-Legacy {
  foreach ($name in $legacyTaskNames) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $name -Confirm:$false
      Write-Host "已卸载旧版任务 $name"
    }
  }
  # 停止任何仍在跑的 relay 进程：此刻新任务尚未启动，存在的都属旧进程；
  # 重复执行安装脚本时这一步等于重启服务（随后会以新任务拉起）。
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'relay\.js' } |
    ForEach-Object { Write-Host "停止 relay 进程 pid=$($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
  Remove-Legacy
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "已卸载计划任务 $taskName"
  }
  Write-Host '提示：全局安装的包仍在（npm uninstall -g codex-relay 可移除）；配置在 %APPDATA%\codex-relay\，日志在 %LOCALAPPDATA%\codex-relay\，需要可手动删除。'
  exit 0
}

if (-not (Test-Path -LiteralPath $relayJs)) { throw "找不到 $relayJs（先在仓库执行 npm install -g . 安装，或检查 npm root -g）" }
Remove-Legacy

# 动作直接运行 node：没有中间包装进程，任务实例的生死 = relay 进程的生死，
# 看门狗（重复触发）才能可靠判定。日志由 relay 自己写文件（计划任务抓不到 stdout）。
# WorkingDirectory 指向 relay.js 所在目录（全局安装包内），不依赖仓库位置。
$action = New-ScheduledTaskAction -Execute $node.Source `
  -Argument ('"{0}" --config "{1}" --log-file "{2}"' -f $relayJs, $ConfigPath, $logFile) `
  -WorkingDirectory (Split-Path -Parent $relayJs)

# 注意：不要写 @( (if ...) , ... ) —— 圆括号表达式里的 if 能通过语法解析，
# 却在运行时被当作命令名（PS 5.1 实测）；"$x = if ..."（赋值取语句值）才是合法形态。
$logonTrigger = if ($AtStartup) { New-ScheduledTaskTrigger -AtStartup } else { New-ScheduledTaskTrigger -AtLogOn }
# 看门狗：每分钟触发一次；实例仍活着则被 IgnoreNew 跳过，死了则拉起新实例
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$triggers = @($logonTrigger, $watchdogTrigger)

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings `
  -Description 'codex-relay 单进程常驻代理（全部端点）；登录时 + 每 1 分钟看门狗触发，进程死亡后由下一次触发拉起' `
  -Force | Out-Null
Write-Host "已注册计划任务 $taskName（登录时 + 每 1 分钟看门狗触发，时长不限）"

Start-ScheduledTask -TaskName $taskName
Write-Host '已启动任务，等待端点就绪...'
$cfg = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $ConfigPath), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  $down = @($cfg.endpoints | Where-Object {
    try { (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($_.port)/healthz" -TimeoutSec 1).StatusCode -ne 200 } catch { $true }
  })
  if ($down.Count -eq 0) { break }
  Start-Sleep -Milliseconds 500
}
foreach ($ep in $cfg.endpoints) {
  $up = try { (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($ep.port)/healthz" -TimeoutSec 2).StatusCode -eq 200 } catch { $false }
  Write-Host ("{0,-9} :{1} {2}" -f $ep.name, $ep.port, $(if ($up) { 'up' } else { 'DOWN（30s 内未就绪，查日志 $logFile）' }))
}
Write-Host ''
Write-Host "日志: $logFile（5MB 轮转为 relay.log.1）"
