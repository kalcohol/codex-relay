# 部署与运维

面向本机使用者。设计方案见 [plan.md](plan.md) §5；验收流程见 [verify.md](verify.md)。

## 本机当前状态（2026-09-11 部署完成）

| 项 | 状态 |
|---|---|
| 代理进程 | 三个端点各一个，由计划任务 `codex-relay-<端点>` 监督（登录自启、失败每分钟重启、进程退出秒级拉起） |
| `base_url` | 三份 `CODEX_HOME` 已指向本机代理；原值见下表，配置文件原样备份为 `config.toml.bak-<时间戳>`，另有一份集中备份 `~/codex-relay-backup-20260911/` |
| 模型目录 | 三家均已标 `multi_agent_version = "v2"`（GLM 由 `patch-catalog-v2.js` 补，备份 `models.json.bak-*`） |
| 验收 | 真实配置下三家各跑一轮 `spawn_agent`，五项断言全过；存量会话（Kimi）resume 复验通过（[verify.md](verify.md) §3） |
| Codex 版本 | 0.154.0 |

回退见 §7（一条命令恢复直连）。以下为各部分的操作细节。

三层的分工（缺一不可）：

| 层 | 作用 | 覆盖时机 |
|---|---|---|
| 常驻（计划任务 + 监督进程） | 保底：登录即起，进程退出立刻重启 | 全入口、全时段 |
| SessionStart hook | 兜底：会话开始前探测并拉起 | 会话启动 |
| 启动器 ensure（可选） | 第三道保险：`.ps1` 启动器内先 ensure | 手动启动 |

> 三层都只在**会话启动时**触发。会话中途崩溃的恢复靠监督进程（1 秒级重启）与 Codex 自身的 `stream_max_retries`，所以常驻层不要省。

## 0. 前置检查

```powershell
node --version              # >= 18
codex --version             # >= 0.147（实测 0.153.4）
curl.exe http://127.0.0.1:18781/healthz   # 未部署时应连接失败
```

模型目录要求 `multi_agent_version = "v2"`（否则落 v1）：

| 端点 | 现状（2026-09-11 实测） |
|---|---|
| DeepSeek | `~/.codex-deepseek/models.json` 各条目已带 `"multi_agent_version": "v2"` |
| Kimi | `~/.codex-kimi/models.json` 的 `k3` / `k3-256k` 已带 |
| GLM | **原本缺失，已用脚本补上**：`glm-5.3` / `glm-5-turbo` 均补了 `"multi_agent_version": "v2"`（写入前已备份） |

补标记用脚本（先预览，`--apply` 才写入，自动备份并校验仍是合法 JSON）：

```powershell
node deploy\patch-catalog-v2.js "$env:USERPROFILE\.codex-glm\models.json"            # 预览
node deploy\patch-catalog-v2.js "$env:USERPROFILE\.codex-glm\models.json" --apply    # 写入
```

不带 slug 时处理目录中所有缺该字段的模型；重复执行是幂等的。

GLM 不补这一行会落 v1：v1 请求带 `tool_search` 工具面，而 glm-5.3 不会主动用它发现工具（plan §3.1 实测两轮失败）。

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
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-tasks.ps1              # 注册（登录时启动）
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-tasks.ps1 -Only kimi    # 只注册一个
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-tasks.ps1 -Uninstall    # 卸载
```

任务参数（`install-tasks.ps1` 内固定）：`ExecutionTimeLimit = 0`（不限时长，否则代理会被默认 3 天限制杀掉）、`RestartCount = 999` + `RestartInterval = 1 分钟`（监督进程自身崩溃也能被拉起）、`MultipleInstances = IgnoreNew`、`-AtLogOn`（任务在用户会话内运行，无需存密码；需要未登录也运行时加 `-AtStartup`）。

## 4. SessionStart hook（可选兜底）

把 [deploy/config-hooks.snippet.toml](../deploy/config-hooks.snippet.toml) 的内容合并进三份 `config.toml`（替换 `<仓库路径>`）。首次触发时 Codex 会请求信任该 hook。不想确认信任就跳过这一层，只用常驻 + 启动器。

## 5. 冒烟与验收

```powershell
# 3 秒冒烟：健康 + 计数
curl.exe http://127.0.0.1:18781/healthz

# 完整验收（真实 spawn_agent，消耗额度；用临时 CODEX_HOME，不碰真实配置）
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\probe-subagent.ps1 -Vendor kimi
```

`probe-subagent.ps1` 会把 `~/.codex-<vendor>` 复制到 `%LOCALAPPDATA%\codex-relay\verify\<vendor>\home`，只改副本的 `base_url` 与模型目录（GLM 顺带补 v2 标记），跑完输出五项断言结论；报告与 rollout 都留在该目录便于复查。详见 [verify.md](verify.md)。

## 6. 观测与排障

| 手段 | 用法 |
|---|---|
| 健康 + 计数 | `GET /healthz`：`a_rewrites` / `b_injections` / `errors` / `client_aborts` / `completed_aborts` |
| 逐请求日志 | 起代理时设 `CODEX_RELAY_LOG=1`，输出 `#序号 状态 耗时 A=改写数` 与命中行 |
| 抓包 | 起代理时设 `CODEX_RELAY_CAPTURE=<目录>`，落 `req-*.json` / `res-*.sse`，`Authorization` 脱敏；含全量 prompt，用完即删 |

**计数含义**（`errors` 之外的计数都表示正常行为，不作为故障判据）：

- `client_aborts`：Codex 收齐/主动取消后断开连接；
- `completed_aborts`：已收到 `response.completed` 后厂商关闭连接（Kimi 实测如此，属正常）；
- `errors`：客户端仍在等而上游失败——**只有这个需要排查**。

日志位置：`%LOCALAPPDATA%\codex-relay\logs\`
（`<端点>-supervisor.log` 监督记录、`<端点>-<时间戳>.out.log` 代理输出、`<端点>-ensure.*.log` ensure 输出）。

**升级 Codex 后必做**：跑一次 `probe-subagent.ps1`，确认 `A` 与 `B` 计数仍 > 0。DS / GLM 端点的形态失配是静默的——退回原始 bug，不会有任何报错。

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
