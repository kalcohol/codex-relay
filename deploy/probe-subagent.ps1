<#
.SYNOPSIS
  §6.1 验收探针：在临时 CODEX_HOME 里跑一次真实 spawn_agent，验证端到端可读。
.DESCRIPTION
  不碰真实配置：把 ~/.codex-<vendor> 的 config.toml / models.json 复制到临时目录，
  只改临时副本的 base_url（指向本地代理）与模型目录（补 multi_agent_version=v2），
  然后 codex exec 执行一次 spawn_agent + wait_agent，最后核对：
    断言一  R1 父 agent 复述子 agent 按 token 回显；
    断言二  R2 子线程 rollout 中任务消息为明文（无 encrypted_content）；
    断言三  R1/R5 无上游错误（healthz errors 计数为 0）；
    断言五  可观测性 A 改写计数与 B 注入计数均 > 0。
  会发起真实 API 调用（消耗额度）。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\probe-subagent.ps1 -Vendor deepseek
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('deepseek', 'glm', 'kimi')][string]$Vendor,
  [string]$ConfigPath,
  [string]$Token,
  [string]$WorkRoot = (Join-Path $env:LOCALAPPDATA 'codex-relay\verify'),
  [int]$TimeoutSec = 420,
  [switch]$KeepHome
)

$ErrorActionPreference = 'Stop'
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot '..\relay.config.json' }
if (-not $Token) { $Token = 'ZXQ-{0}-TRACER' -f (Get-Random -Minimum 1000 -Maximum 9999) }

$repoRoot = Split-Path -Parent $PSScriptRoot
$cfg = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $ConfigPath), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$ep = $cfg.endpoints | Where-Object { $_.name -eq $Vendor } | Select-Object -First 1
if (-not $ep) { throw "relay.config.json 中找不到端点 $Vendor" }

$realHome = $ep.codexHome -replace '^~', $env:USERPROFILE
$probeHome = Join-Path $WorkRoot "$Vendor\home"
$scratch = Join-Path $WorkRoot "$Vendor\scratch"
$report = Join-Path $WorkRoot "$Vendor\report.txt"

function Write-Step([string]$m) {
  Write-Host $m
  Add-Content -LiteralPath $report -Value $m
}

Remove-Item -Recurse -Force $probeHome, $scratch -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $probeHome, $scratch | Out-Null
Set-Content -LiteralPath $report -Value "vendor=$Vendor token=$Token time=$(Get-Date -Format o)" -Encoding utf8

# --- 1) 临时 CODEX_HOME：改 base_url、模型目录路径，并补 v2 标记 -----------------
$config = [System.IO.File]::ReadAllText((Join-Path $realHome 'config.toml'), [System.Text.Encoding]::UTF8)
if (-not $config.Contains($ep.baseUrlOriginal)) {
  throw "config.toml 里找不到 $($ep.baseUrlOriginal)（手动改过？）"
}
$config = $config.Replace($ep.baseUrlOriginal, $ep.baseUrlAfter)

$model = ([regex]::Match($config, 'model\s*=\s*"([^"]+)"')).Groups[1].Value
Write-Step "model=$model base_url→$($ep.baseUrlAfter)"

Copy-Item -LiteralPath (Join-Path $realHome 'models.json') -Destination (Join-Path $probeHome 'models.json')
$catalogPath = Join-Path $probeHome 'models.json'
$catalog = [System.IO.File]::ReadAllText($catalogPath, [System.Text.Encoding]::UTF8)
$catalog = $catalog.Replace((Join-Path $realHome 'models.json').Replace('\', '/'), $catalogPath.Replace('\', '/'))
# config.toml 里 model_catalog_json 可能写成正斜杠或反斜杠，两种都替换一遍。
$catalog = $catalog.Replace($realHome, $probeHome)
$config = $config.Replace($realHome, $probeHome)
$config = $config.Replace((Join-Path $realHome 'models.json'), $catalogPath)
$config = $config.Replace((Join-Path $realHome 'models.json').Replace('\', '/'), $catalogPath.Replace('\', '/'))

$slugPattern = '"slug"\s*:\s*"' + [regex]::Escape($model) + '"'
if (-not $catalog.Contains('"multi_agent_version"')) {
  $slugMatch = [regex]::Match($catalog, $slugPattern)
  if (-not $slugMatch.Success) { throw "模型目录里找不到 slug=$model" }
  $insertAt = $slugMatch.Index + $slugMatch.Length
  if ($catalog[$insertAt] -eq ',') { $insertAt += 1 }
  $catalog = $catalog.Insert($insertAt, "`n    `"multi_agent_version`": `"v2`",")
  Write-Step "catalog: 为 $model 补上 multi_agent_version=v2"
} else {
  Write-Step "catalog: 已含 multi_agent_version 标记，无需改写"
}
[System.IO.File]::WriteAllText($catalogPath, $catalog, (New-Object System.Text.UTF8Encoding($false)))

if ($config -notmatch [regex]::Escape($scratch.Replace('\', '\\'))) {
  $config += "`n[projects.'$($scratch.Replace('\', '\\'))']`ntrust_level = `"trusted`"`n"
}
[System.IO.File]::WriteAllText((Join-Path $probeHome 'config.toml'), $config, (New-Object System.Text.UTF8Encoding($false)))

# --- 2) 确保代理在跑 -----------------------------------------------------------
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'ensure-proxy.ps1') -Only $Vendor -Strict
if ($LASTEXITCODE -ne 0) { throw "端点 $Vendor 的代理未就绪" }

function Get-Counters {
  (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($ep.port)/healthz" -TimeoutSec 3).Content | ConvertFrom-Json
}
$before = Get-Counters

# --- 3) 跑一次真实 spawn_agent -------------------------------------------------
$prompt = @"
Call spawn_agent exactly once with task_name="probe" and message="$Token payload: reply with exactly ECHO-$Token".
Then call wait_agent for it, and FINALLY echo the sub-agent's exact reply text as your last line.
Do not call any other tools.
"@
$codex = (Get-Command codex).Source
# 提示词含引号与换行，不能走命令行参数（Start-Process 会拆错）；codex exec 无 PROMPT 参数时读 stdin。
$argString = "exec --sandbox read-only --skip-git-repo-check --color never -C `"$scratch`""

$env:CODEX_HOME = $probeHome
$keyName = if ($ep.envKey) { $ep.envKey } else { "$($Vendor.ToUpper())_API_KEY" }
$keyValue = [Environment]::GetEnvironmentVariable($keyName, 'User')
if (-not $keyValue) { throw "环境变量 $keyName 未在用户作用域设置" }
Set-Item -Path "Env:$keyName" -Value $keyValue

Write-Step "运行 codex exec（超时 ${TimeoutSec}s）..."
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $codex
$psi.Arguments = $argString
$psi.WorkingDirectory = $scratch
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

$proc = [System.Diagnostics.Process]::Start($psi)
$outTask = $proc.StandardOutput.ReadToEndAsync()
$errTask = $proc.StandardError.ReadToEndAsync()
$proc.StandardInput.Write($prompt)
$proc.StandardInput.Close()

$timedOut = -not $proc.WaitForExit($TimeoutSec * 1000)
if ($timedOut) { $proc.Kill() }
$stdout = $outTask.Result
$stderr = $errTask.Result
[System.IO.File]::WriteAllText((Join-Path $WorkRoot "$Vendor\codex.out.txt"), $stdout, (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $WorkRoot "$Vendor\codex.err.txt"), $stderr, (New-Object System.Text.UTF8Encoding($false)))
if ($timedOut) { Write-Step 'codex exec 超时（已终止）' } else { Write-Step "codex 退出码 $($proc.ExitCode)" }
Add-Content -LiteralPath $report -Value "`n--- codex stdout ---`n$stdout`n--- codex stderr ---`n$stderr"

$after = Get-Counters
$dA = $after.counters.a_rewrites - $before.counters.a_rewrites
$dB = $after.counters.b_injections - $before.counters.b_injections
$dErr = $after.counters.errors - $before.counters.errors
$dClientAbort = $after.counters.client_aborts - $before.counters.client_aborts
$dCompletedAbort = $after.counters.completed_aborts - $before.counters.completed_aborts
$dSkip = $after.counters.b_skipped - $before.counters.b_skipped
Write-Step "计数增量: A=$dA B=$dB errors=$dErr client_aborts=$dClientAbort completed_aborts=$dCompletedAbort b_skipped=$dSkip"
Write-Step "计数总计: $($after.counters | ConvertTo-Json -Compress)"

# --- 4) 断言 ------------------------------------------------------------------
$echoOk = $stdout -match [regex]::Escape("ECHO-$Token")
$childMessage = $null
$rollout = Get-ChildItem -Path (Join-Path $probeHome 'sessions') -Recurse -Filter 'rollout-*.jsonl' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending
foreach ($file in $rollout) {
  $hit = Get-Content -LiteralPath $file.FullName | Where-Object { $_ -match [regex]::Escape($Token) -and $_ -match 'agent_message' } |
    Select-Object -First 1
  if ($hit) {
    $childMessage = $hit
    Write-Step "rollout 命中: $($file.Name)"
    break
  }
}
$encryptedLeft = if ($childMessage) { [bool]($childMessage -match 'encrypted_content') } else { $null }
Write-Step "任务/汇报消息含 encrypted_content: $encryptedLeft（null = 未找到，可能被本地历史压缩）"

$pass = @()
$pass += if ($echoOk) { 'PASS 断言一：父 agent 复述了子 agent 的 token 回显' } else { 'FAIL 断言一：未见 ECHO token' }
$pass += if ($encryptedLeft -eq $false) { 'PASS 断言二：任务消息以明文落盘（无 encrypted_content）' } else { 'FAIL 断言二：rollout 中仍是 encrypted_content（仅 A 生效或 B 未命中）' }
$pass += if ($dErr -eq 0) { "PASS 断言三：无真实上游故障（正常中断：client_aborts=$dClientAbort completed_aborts=$dCompletedAbort）" } else { "FAIL 断言三：上游故障 $dErr 次" }
$pass += if ($dA -gt 0) { "PASS 断言五a：钩子 A 改写 $dA 次" } else { 'FAIL 断言五a：钩子 A 未命中（升级后形态失配？）' }
$pass += if ($dB -gt 0) { "PASS 断言五b：钩子 B 注入 $dB 次" } else { 'FAIL 断言五b：钩子 B 未命中' }
$pass | ForEach-Object { Write-Step $_ }

if (-not $KeepHome) {
  Write-Step "临时目录保留在 $($probeHome -replace '\\home$', '')（如需清理请手动删除）"
}
Write-Host ''
Write-Host "报告: $report"
