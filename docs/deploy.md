# 部署与运维

面向本机使用者。设计方案见 [plan.md](plan.md) §5；验收流程见 [verify.md](verify.md)。

## 本机当前状态（2026-09-13 更新）

| 项 | 状态 |
|---|---|
| 代理进程 | 三个端点各一个 relay + 一个监督进程（`ensure` 已于 09-13 08:56 恢复并接管孤儿 relay） |
| `base_url` | 三份 `CODEX_HOME` 已指向本机代理；原值见下表，配置文件原样备份为 `config.toml.bak-<时间戳>`，另有一份集中备份 `~/codex-relay-backup-20260911/` |
| 模型目录 | 三家均已标 `multi_agent_version = "v2"`（GLM 由 `patch-catalog-v2.js` 补；DeepSeek 2026-09-11 换模型时用官方新目录，自带 v2，见 §0） |
| 验收 | 真实配置下三家各跑一轮 `spawn_agent`，探针四项断言（一/二/三/五）全过；断言四（存量会话 resume）与断言六（kill 韧性）手工实测通过（[verify.md](verify.md) §3） |
| Codex 版本 | 0.154.0 |
| **待办** | 需以**管理员**身份执行一次 `install-tasks.ps1 -WatchOnly` 注册看护任务（见 §6.1），否则"监督进程被杀"仍会静默失守 |

回退见 §7（一条命令恢复直连）。以下为各部分的操作细节。

四层的分工（前两层是必需的）：

| 层 | 作用 | 覆盖时机 |
|---|---|---|
| 常驻（计划任务 + 监督进程） | 保底：登录即起，进程退出立刻重启 | 全入口、登录后全时段 |
| **看护任务（每 5 分钟 ensure）** | 兜底：**监督进程**被外部杀掉后自动补齐 | 登录后全时段，不依赖登录事件 |
| SessionStart hook | 兜底：会话开始前探测并拉起 | 会话启动 |
| 启动器 ensure（可选） | 第三道保险：`.ps1` 启动器内先 ensure | 手动启动 |

> 端点任务与 hook 都只在**会话/登录启动时**触发；会话中途 relay 崩溃由监督进程 1 秒级拉起，而"监督进程自己被杀"只有看护任务能兜住（实测事故见 §6.1）。

## 0. 前置检查

```powershell
node --version              # >= 18
codex --version             # >= 0.147（实测 0.154.0）
curl.exe http://127.0.0.1:18781/healthz   # 未部署时应连接失败
```

模型目录要求 `multi_agent_version = "v2"`（否则落 v1）：

| 端点 | 现状（2026-09-11 实测） |
|---|---|
| DeepSeek | 官方目录自带：`deepseek-flash` / `deepseek-v4-pro` 均带 `"multi_agent_version": "v2"` |
| Kimi | `~/.codex-kimi/models.json` 的 `k3` / `k3-256k` 已带 |
| GLM | **原本缺失，已用脚本补上**：`glm-5.3` / `glm-5-turbo` 均补了 `"multi_agent_version": "v2"`（写入前已备份） |

补标记用脚本（先预览，`--apply` 才写入，自动备份并校验仍是合法 JSON）：

```powershell
node deploy\patch-catalog-v2.js "$env:USERPROFILE\.codex-glm\models.json"            # 预览
node deploy\patch-catalog-v2.js "$env:USERPROFILE\.codex-glm\models.json" --apply    # 写入
```

不带 slug 时处理目录中所有缺该字段的模型；重复执行是幂等的。

GLM 不补这一行会落 v1：v1 请求带 `tool_search` 工具面，而 glm-5.3 不会主动用它发现工具（plan §3.1 实测两轮失败）。

### 厂商更新模型时（以 DeepSeek 2026-09-11 为例）

厂商会下架旧 slug、新增新 slug。**在这个仓库的部署方式下，不要运行厂商的一键配置脚本**——DeepSeek 官方脚本的两条写入路径都会重建 `[model_providers.deepseek]` 段并把 `base_url` 写死为官方直连地址、把 key 写进配置文件，等于**静默旁路掉本地代理**（修复失效、退回原始 bug，且没有报错）。它的"只改 model"快路径要求脚本自己的备份存在，而我们这份 `CODEX_HOME` 从没跑过它。

正确做法（只动两处，代理配置保持不变）：

1. 从官方脚本内嵌的 here-string 里取出新目录，替换 `models.json`；
2. 改 `config.toml` 里顶层 `model =` 为新 slug（DeepSeek 新默认是 `deepseek-flash`；`deepseek-v4-pro` 于 9 月 14 日下线）；
3. 验证：`powershell -NoProfile -ExecutionPolicy Bypass -File deploy\probe-subagent.ps1 -Vendor deepseek -RealHome`，探针四项断言应全过。

这次实际改动（2026-09-11）与保留项：

| 项 | 处理 |
|---|---|
| `model` | `deepseek-v4.1-flash-expires-on-0910`（已下架）→ `deepseek-flash` |
| `models.json` | 换成官方新目录（2 个条目，均自带 v2）；旧目录备份为 `models.json.bak-<时间戳>` |
| 按官方新增 | `preferred_auth_method = "apikey"`、`forced_login_method = "api"`（跳过 ChatGPT 登录）、`web_search = "disabled"`（官方明确：DeepSeek 模型下禁用内置联网搜索） |
| **保留不动** | `base_url = http://127.0.0.1:18781/`（代理）、`env_key`（密钥仍走环境变量，不落盘）、`model_reasoning_effort = "max"`（新目录支持 low/high/max）、`model_catalog_json`、`approvals_reviewer`、`service_tier`、`[projects]` 信任项、`[windows]`、`[tui]` |

## 1. 拉起代理

```powershell
# 全部端点（幂等，已在跑则跳过）
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\ensure-proxy.ps1

# 单端点 / 只看状态 / 强制重启
... -Only kimi
... -Status
... -Only kimi -Restart
```

端口与上游由 [relay.config.json](../relay.config.json) 决定，改端口只改这一处。

## 2. 切换 base_url

先预览，确认无误再 `-Apply`（写入前自动备份 `config.toml.bak-<时间戳>`）：

```powershell
powershell -NoProfile -File deploy\switch-base-url.ps1                  # 预览：直连 → 代理
powershell -NoProfile -File deploy\switch-base-url.ps1 -Apply           # 写入
powershell -NoProfile -File deploy\switch-base-url.ps1 -Mode direct -Apply   # 回退直连
```

脚本按 UTF-8 读写并保留原 BOM，不会破坏 config.toml 里的中文注释（已做逐字节往返验证）。

| CODEX_HOME | 原值 | 代理值 |
|---|---|---|
| `~/.codex-deepseek` | `https://api.deepseek.com/` | `http://127.0.0.1:18781/` |
| `~/.codex-glm` | `https://open.bigmodel.cn/api/v1` | `http://127.0.0.1:18782/api/v1` |
| `~/.codex-kimi` | `https://api.kimi.com/coding/v1` | `http://127.0.0.1:18783/coding/v1` |

> Codex 会在 `base_url` 后追加 `/responses`，GLM / Kimi 的路径前缀必须保留（代理按原样转发路径）。

## 3. 常驻计划任务

> **需要管理员权限**：注册计划任务在非提权会话中会被拒绝（`0x80070005`，实测如此）。请在"以管理员身份运行"的 PowerShell 中执行。没有管理员权限时，用 §4 的 hook + §1 的 ensure 两层即可（少了"重启后自动拉起"，需要每次登录后跑一次 ensure）——脚本会先检查并提示。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-tasks.ps1              # 注册端点任务 + 看护任务
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-tasks.ps1 -Only kimi    # 只注册一个端点任务
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-tasks.ps1 -WatchOnly    # 只补看护任务（不动已有端点任务）
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-tasks.ps1 -Uninstall    # 卸载（含看护任务）
```

任务参数（`install-tasks.ps1` 内固定）：

- 端点任务 `codex-relay-<端点>`：`ExecutionTimeLimit = 0`（不限时长，否则代理会被默认 3 天限制杀掉）、`RestartCount = 999` + `RestartInterval = 1 分钟`、`MultipleInstances = IgnoreNew`、`-AtLogOn`（任务在用户会话内运行，无需存密码；需要未登录也运行时加 `-AtStartup`）。
- 看护任务 `codex-relay-watch`：登录时 + 每 5 分钟执行 `ensure-proxy.ps1`（幂等：健康时只做一次探活），用来兜住"监督进程被外部杀掉"——实测任务级 `RestartCount` 对"进程已启动后被终止"并不生效（见 §6.1）。

## 4. SessionStart hook（可选兜底）

把 [deploy/config-hooks.snippet.toml](../deploy/config-hooks.snippet.toml) 的内容合并进三份 `config.toml`（替换 `<仓库路径>`）。首次触发时 Codex 会请求信任该 hook。不想确认信任就跳过这一层，只用常驻 + 启动器。

## 5. 冒烟与验收

```powershell
# 3 秒冒烟：健康 + 计数
curl.exe http://127.0.0.1:18781/healthz

# 完整验收（真实 spawn_agent，消耗额度；用临时 CODEX_HOME，不碰真实配置）
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\probe-subagent.ps1 -Vendor kimi
```

`probe-subagent.ps1` 会把 `~/.codex-<vendor>` 复制到 `%LOCALAPPDATA%\codex-relay\verify\<vendor>\home`，只改副本的 `base_url` 与模型目录（GLM 顺带补 v2 标记），跑完输出探针四项断言（一/二/三/五）的结论；报告与 rollout 都留在该目录便于复查。详见 [verify.md](verify.md)。

## 6. 观测与排障

| 手段 | 用法 |
|---|---|
| 健康 + 计数 | `GET /healthz`：`requests` / `a_rewrites` / `b_injections` / `b_skipped` / `errors` / `client_aborts` / `completed_aborts` |
| 逐请求日志 | 起代理时设 `CODEX_RELAY_LOG=1`，输出 `#序号 状态 耗时 A=改写数` 与命中行 |
| 抓包 | 起代理时设 `CODEX_RELAY_CAPTURE=<目录>`，落 `req-*.json` / `res-*.sse`，`Authorization` 脱敏；含全量 prompt，用完即删 |

**计数含义**（`errors` 之外的计数都表示正常行为，不作为故障判据）：

- `requests`：**只统计数据面**（`/healthz` 探活与监督脚本的探测不计入），等于"实际打给端点的模型请求数"；
- `client_aborts`：Codex 收齐/主动取消后断开连接；
- `completed_aborts`：已收到 `response.completed` 后厂商关闭连接（Kimi 实测如此，属正常）；
- `errors`：客户端仍在等而上游失败——**只有这个需要排查**。

一次连接的中断只记一次：客户端断开与随之而来的上游断开是因果关系，代理内部归口到单一计数点（`abortCounted`），不会重复计数。

日志位置：`%LOCALAPPDATA%\codex-relay\logs\`
（`<端点>-supervisor.log` 监督记录、`<端点>-<时间戳>.out.log` 代理输出、`<端点>-ensure.*.log` ensure 输出）。
每个端点的 `<时间戳>.out/.err.log` 只保留最近 20 对（崩溃循环时自动清理最旧的）；`-supervisor.log` 持续追加、不轮转。

**重载代理（改完代码/想重启进程）** 用 `ensure-proxy.ps1 -Restart`：它停掉监听进程，由现任监督进程拉起新进程（等待窗口覆盖一个退避周期）。**不要**手工去 kill 监督进程，也不要另起一个监督进程——同一端点同时只应有一个监督进程，重复拉起会被锁挡住并在日志里留下记录。

**升级 Codex 后必做**：跑一次 `probe-subagent.ps1`，确认 `A` 与 `B` 计数仍 > 0。DS / GLM 端点的形态失配是静默的——退回原始 bug，不会有任何报错。

### 6.1 事故记录：2026-09-13 只有 DeepSeek 不可达

**现象**：`curl http://127.0.0.1:18781/healthz` 无响应，18782 / 18783 正常；用户当时正在跑的 DeepSeek 会话在 02:22 断在半途（rollout 有 340 行正常工具调用、3.17M token，然后就没了）。

**定位过程**（这套顺序在下次出问题时照抄即可）：

```powershell
# 1) 端口是否在听、relay 进程还在不在、监督进程还有没有
Get-NetTCPConnection -LocalPort 18781,18782,18783 -State Listen | Select LocalPort, OwningProcess
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -match 'relay\.js' }
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | ? { $_.CommandLine -match 'supervise-endpoint' -and $_.Cmdline -match '-Name \w' }

# 2) 日志目录里最新的文件时间 → 判断"最后一次重启尝试"发生在什么时候
Get-ChildItem $env:LOCALAPPDATA\codex-relay\logs | Sort LastWriteTime -Desc | Select -First 5

# 3) 任务状态：LastTaskResult 0xC000013A = 进程被"控制台关闭/Ctrl+C"式终止
Get-ScheduledTask -TaskName 'codex-relay-*' | Get-ScheduledTaskInfo | Select TaskName, LastRunTime, LastTaskResult
```

**根因**：**监督进程在 09-11 03:34 就被外部终止了**（三个任务的 `LastTaskResult` 全是 `0xC000013A`，即控制台关闭/Ctrl+C 类终止；日志里此后没有任何记录）。三个 relay 作为独立进程活了下来，成了无人接管的"孤儿"，继续正常服务了两天。09-13 02:22 DeepSeek 的孤儿 relay 自己死掉（out/err 日志里没有崩溃痕迹，属外部终止），而没有任何机制去拉起它——端点任务只在登录时触发，任务级"失败重启"对这种进程退出并未生效。GLM / Kimi 的孤儿 relay 恰好还活着，所以只有 18781 挂了。

**修复**（两层，均已落地）：

1. `supervise-endpoint.ps1` 新增**守望模式**：监督进程拿到锁后发现端口已被服务（孤儿 relay），不再直接退出，而是每 30 秒探测、一旦不可用立刻接管。注意它**不会**重启健康中的 relay（实测接管前后 pid 不变），只接管后续故障；
2. `ensure-proxy.ps1` 新增"端点在服务但没有监督进程"分支：打一个监督进程上去（进入守望模式）；`-Status` 也如实报告该状态：
   `deepseek  :18781 up（但无监督进程）`；
3. `install-tasks.ps1` 新增**看护任务** `codex-relay-watch`（登录时 + 每 5 分钟跑一次 `ensure-proxy.ps1`）——这才是"监督进程被杀"能自愈的机制。

**待执行（需要管理员）**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-tasks.ps1 -WatchOnly
```

**遗留判断**：`0xC000013A` 说明监督进程是被"控制台被关闭"这类事件带走的，具体触发者（某次会话/工具清理/杀软）无法从现有日志确定。守望模式 + 看护任务的设计不依赖找到它：无论何种原因被杀，最多 5 分钟自愈。

## 7. 回退与卸载

```powershell
# 临时回退（立刻恢复直连；代理可继续留着，不影响）
powershell -NoProfile -File deploy\switch-base-url.ps1 -Mode direct -Apply

# 彻底卸载
powershell -NoProfile -File deploy\install-tasks.ps1 -Uninstall
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'relay\.js' } | Stop-Process -Force"
# 再从 config.toml 移除 hook 片段、删除本目录
```

代理不写任何 Codex 状态，撤除后行为完全回到现状。
