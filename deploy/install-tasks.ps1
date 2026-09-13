<#
.SYNOPSIS
  注册 / 卸载 codex-relay 的常驻任务（保底层与看护层，见 docs/plan.md §5.2 / §5.4）。
.DESCRIPTION
  注册两类任务：
    1. 每个端点一个（codex-relay-<端点>），登录时启动 supervise-endpoint.ps1：
       - ExecutionTimeLimit = 0（不限时长，否则代理会被默认 3 天限制杀掉）；
       - RestartCount/RestartInterval（监督进程自身崩溃也能被任务计划拉起）；
       - MultipleInstances = IgnoreNew（避免重复拉起）。
    2. 看护任务（codex-relay-watch）：登录时 + 每 5 分钟跑一次 ensure-proxy.ps1。
       登录触发的端点任务兜不住"监督进程在会话中途被外部杀掉"——实测会留下
       无人接管的孤儿 relay，端点一挂就没人补。定时 ensure 幂等（健康时只做一次
       探活），能在几分钟内把缺失的监督进程补回来。
  任务在用户会话内运行，无需存储密码；需要未登录也运行时加 -AtStartup
  （需要任务计划权限，且通常要求保存凭据）。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-tasks.ps1
.EXAMPLE
  # 只补看护任务（不动已有端点任务）
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-tasks.ps1 -WatchOnly
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-tasks.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$ConfigPath,
  [string[]]$Only,
  [switch]$AtStartup,
  [switch]$WatchOnly,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
# 注意：$PSScriptRoot 在 param 默认值中不可用（PS 5.1 + CmdletBinding），只能在脚本体内解析。
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot '..\relay.config.json' }

# PS 5.1 默认按 ANSI 读文件，中文注释会变乱码并破坏 JSON 解析，必须显式 UTF-8。
$cfg = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $ConfigPath), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$endpoints = $cfg.endpoints
if ($Only) { $endpoints = $endpoints | Where-Object { $Only -contains $_.name } }

$repoRoot = Split-Path -Parent $PSScriptRoot
$supervisor = Join-Path $PSScriptRoot 'supervise-endpoint.ps1'
$ensure = Join-Path $PSScriptRoot 'ensure-proxy.ps1'
$taskPrefix = 'codex-relay'
$watchTaskName = "$taskPrefix-watch"

# 注册计划任务在多数 Windows 配置下需要提权（实测非提权时 Register-ScheduledTask 报 0x80070005）。
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $Uninstall -and -not $elevated) {
  Write-Warning '当前不是管理员会话：注册计划任务多半会被拒绝（拒绝访问 / 0x80070005）。'
  Write-Warning '请在“以管理员身份运行”的 PowerShell 里重跑本脚本；或改用 SessionStart hook + 启动器 ensure 两层（见 docs/deploy.md）。'
}

$shell = (Get-Command powershell).Source

if ($Uninstall) {
  foreach ($ep in $endpoints) {
    $taskName = "$taskPrefix-$($ep.name)"
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
      Write-Host "已卸载计划任务 $taskName"
    } else {
      Write-Host "计划任务 $taskName 不存在，跳过"
    }
  }
  if (Get-ScheduledTask -TaskName $watchTaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $watchTaskName -Confirm:$false
    Write-Host "已卸载计划任务 $watchTaskName"
  } else {
    Write-Host "计划任务 $watchTaskName 不存在，跳过"
  }
  return
}

# 看护任务：每 5 分钟跑一次 ensure。监督进程可能被各种外部原因杀掉
# （实测：控制台关闭事件会连带终止它，此后无人接管，relay 成了孤儿），
# 而端点任务只在登录时触发，兜不住这种情况——一个定时执行的幂等 ensure
# 就能在几分钟内自愈。
function Register-WatchTask {
  $action = New-ScheduledTaskAction -Execute $shell `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $ensure) `
    -WorkingDirectory $repoRoot
  $triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650))
  )
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -Hidden
  Register-ScheduledTask -TaskName $watchTaskName -Action $action -Trigger $triggers -Settings $settings `
    -Description 'codex-relay 看护：每 5 分钟检查一次各端点代理与监督进程，缺失则补齐（幂等，健康时无副作用）' -Force | Out-Null
  Write-Host "已注册计划任务 $watchTaskName（登录时 + 每 5 分钟，幂等 ensure）"
}

if ($WatchOnly) { Register-WatchTask; return }

foreach ($ep in $endpoints) {
  $taskName = "$taskPrefix-$($ep.name)"

  if (-not (Test-Path -LiteralPath $supervisor)) { throw "找不到 $supervisor" }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw 'PATH 中找不到 node（需要 Node.js >= 18）' }

  $action = New-ScheduledTaskAction -Execute $shell `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Name {1}' -f $supervisor, $ep.name) `
    -WorkingDirectory $repoRoot

  $trigger = if ($AtStartup) { New-ScheduledTaskTrigger -AtStartup } else { New-ScheduledTaskTrigger -AtLogOn }

  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden

  $description = "codex-relay 常驻代理（$($ep.name) → 127.0.0.1:$($ep.port) → $($ep.upstream)），由 supervise-endpoint.ps1 监督"

  try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
      -Description $description -Force | Out-Null
    Write-Host "已注册计划任务 $taskName（登录时启动，失败每分钟重启，时长不限）"
  } catch {
    Write-Error ("注册计划任务 $taskName 失败：{0}`n请在管理员 PowerShell 中重跑；若仍失败，改用 SessionStart hook + 启动器 ensure（docs/deploy.md）。" -f $_.Exception.Message)
    exit 1
  }
}

Register-WatchTask

Write-Host ''
Write-Host '提示：任务在下次登录时自动生效；现在可执行以下命令立即拉起并检查：'
Write-Host '  powershell -NoProfile -File deploy\ensure-proxy.ps1 -Status'
