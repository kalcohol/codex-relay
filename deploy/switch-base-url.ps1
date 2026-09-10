<#
.SYNOPSIS
  切换 / 还原 CODEX_HOME 的 base_url（直连 ↔ 本地代理），带备份与预览。
.DESCRIPTION
  读取 relay.config.json 的 baseUrlOriginal / baseUrlAfter，按端点定位 config.toml 并做
  精确字符串替换（不做正则、不解析 TOML 结构，避免误伤其它 provider）。
  默认只预览（dry-run），加 -Apply 才写入；写入前备份为 config.toml.bak-<时间戳>。
  -CodexHomeRoot 可指向临时目录（验证实验用，不碰真实配置）。
.EXAMPLE
  powershell -NoProfile -File deploy\switch-base-url.ps1                 # 预览切到代理
.EXAMPLE
  powershell -NoProfile -File deploy\switch-base-url.ps1 -Apply          # 实际切到代理
.EXAMPLE
  powershell -NoProfile -File deploy\switch-base-url.ps1 -Mode direct -Apply   # 回退直连
#>
[CmdletBinding()]
param(
  [ValidateSet('proxy', 'direct')][string]$Mode = 'proxy',
  [string]$ConfigPath,
  [string[]]$Only,
  [string]$CodexHomeRoot = $env:USERPROFILE,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
# 注意：$PSScriptRoot 在 param 默认值中不可用（PS 5.1 + CmdletBinding），只能在脚本体内解析。
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot '..\relay.config.json' }

# PS 5.1 默认按 ANSI 读文件，中文注释会变乱码并破坏 JSON 解析，必须显式 UTF-8。
$cfg = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $ConfigPath), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$endpoints = $cfg.endpoints
if ($Only) { $endpoints = $endpoints | Where-Object { $Only -contains $_.name } }

$changed = 0
foreach ($ep in $endpoints) {
  $homeDir = $ep.codexHome -replace '^~', $CodexHomeRoot
  $configFile = Join-Path $homeDir 'config.toml'
  if (-not (Test-Path -LiteralPath $configFile)) {
    Write-Host ("{0,-9} 跳过：找不到 {1}" -f $ep.name, $configFile)
    continue
  }

  $from = if ($Mode -eq 'proxy') { $ep.baseUrlOriginal } else { $ep.baseUrlAfter }
  $to = if ($Mode -eq 'proxy') { $ep.baseUrlAfter } else { $ep.baseUrlOriginal }

  # 按 UTF-8 读写并保留原有 BOM 状态：config.toml 里有中文注释，PS 5.1 的
  # Get-Content/Set-Content 默认编码会改写它们，且会给 TOML 加上 BOM。
  $bytes = [System.IO.File]::ReadAllBytes($configFile)
  $hadBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  $text = [System.Text.Encoding]::UTF8.GetString($bytes)
  if ($hadBom) { $text = $text.Substring(1) }

  if ($text.Contains($to)) {
    Write-Host ("{0,-9} 已是目标状态（{1}）" -f $ep.name, $to)
    continue
  }
  if (-not $text.Contains($from)) {
    Write-Warning ("{0,-9} 未找到 {1}（手动改过？跳过，未做任何修改）" -f $ep.name, $from)
    continue
  }

  $updated = $text.Replace($from, $to)
  Write-Host ("{0,-9} {1} → {2}" -f $ep.name, $from, $to)
  if ($Apply) {
    $backup = "$configFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $configFile -Destination $backup
    $outBytes = [System.Text.Encoding]::UTF8.GetBytes($updated)
    if ($hadBom) { $outBytes = [byte[]](0xEF, 0xBB, 0xBF) + $outBytes }
    [System.IO.File]::WriteAllBytes($configFile, $outBytes)
    Write-Host ("{0,-9} 已写入（备份 {1}）" -f $ep.name, $backup)
  }
  $changed += 1
}

if ($changed -gt 0 -and -not $Apply) {
  Write-Host ''
  Write-Host "预览完成：$changed 个文件待修改。加 -Apply 实际写入。"
}
