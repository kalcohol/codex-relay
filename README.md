# codex-relay

> 单文件、零依赖的本地重写代理：让 Codex multi-agent v2（subagents）在 DeepSeek / GLM / Kimi 等
> 第三方 Responses 兼容端点上正常工作。仅监听 `127.0.0.1`，不改 Codex 源码、不改厂商服务，可随时撤除。

**版本** 0.2.0 · **许可** Apache-2.0 · **运行环境** Node.js ≥ 18 · **测试** 47 用例（`npm test`）

---

## 为什么需要它

Codex 0.138+ 的 multi-agent v2 会把父 agent 派发给子 agent 的任务正文装进 `encrypted_content` 槽位
（正文其实是明文，依赖 OpenAI 服务端解密展开），且整条消息以私有 item 类型 `agent_message` 上线。
第三方端点没有这套语义：

| 端点 | 不加代理时的表现 |
|---|---|
| DeepSeek / GLM | 接受请求但静默忽略正文：子 agent 只看到空信封，自述"没收到任务"，空转 |
| Kimi | 直接 HTTP 400（`item type "agent_message" is not supported`），父会话一并被毒化终止 |

受影响范围：`spawn_agent` / `send_message` / `followup_task` / `wait_agent` 全链路，以及读取本地
历史的周边功能（rollout / TUI 回放 / memory / guardian / web-search 上下文）。普通单 agent 会话不受影响。
根因链与源码引证见 [docs/plan.md](docs/plan.md)。

## 特性

- **端到端可用**：三家端点的 subagents 完整跑通（含 Kimi 的类型级拒绝）；子→父的 `FINAL_ANSWER` 回程同样覆盖；
- **存量会话可救**：所有出站请求统一过钩子 A，修复前落盘的旧会话 `resume` 不再 400（Kimi 已实测）；
- **本地可读**：新消息从源头以明文落盘，rollout / TUI / memory / guardian 全部可读，与官方端点形态一致；
- **失败安全**：任何解析或改写失败一律原样透传——不制造坏请求、不破坏流；
- **单进程常驻**：一个进程服务全部端点；计划任务看门狗（每 1 分钟触发）在进程死亡后 ≤60 秒拉起，无守护进程；
- **可观测**：`/healthz` 暴露改写/注入/故障计数；可选逐请求日志与抓包（`Authorization` 脱敏）；
- **零侵入**：不改 Codex、不改厂商；`base_url` 改回原值即恢复直连。

## 工作原理

```
Codex CLI ──POST /responses──▶ codex-relay（127.0.0.1:1878x）
                                │
                                ├─ 钩子 A（请求侧）：input[] 中的 agent_message
                                │   → 可读的 message(user)：信封 + encrypted_content 原文拼接，
                                │     剥离 Codex 私有字段（Kimi 必需，覆盖存量重放）
                                ▼
                            厂商端点
                                │
Codex CLI ◀──SSE────────────────┤ 钩子 B（响应侧）：collaboration 的 spawn_agent/send_message/
                                │ followup_task function_call 注入 "encrypted_function_args": []
                                │ （Codex 由此走自带的明文直发路径，新消息从源头明文落盘）
```

对官方 OpenAI 端点：`base_url` 不指向代理，行为完全不变（旁路）。两个钩子可经
`CODEX_RELAY_HOOKS` 分别开关。设计依据（上游源码行号、实测抓包）见 [docs/plan.md](docs/plan.md)。

## 快速开始

前置：Node.js ≥ 18；Codex CLI ≥ 0.147；模型目录已标 `multi_agent_version = "v2"`
（三家现状与补标记脚本见 [docs/deploy.md §0](docs/deploy.md)）。

```bash
# 1) 安装到全局（在仓库内执行；运行位置与源码仓库解耦）
npm install -g .

# 2) 配置放 Roaming（首次；之后改端口/上游直接编辑它）
mkdir "%APPDATA%\codex-relay"
copy relay.config.json "%APPDATA%\codex-relay\"

# 3) 手动起代理（单进程，监听配置里的全部端点端口）
codex-relay --config "%APPDATA%\codex-relay\relay.config.json"

# 4) 把对应 CODEX_HOME 的 base_url 指向本地端口（预览后 -Apply 写入，自动备份）
powershell -NoProfile -File deploy\switch-base-url.ps1 -Apply

# 5) 常驻（管理员 PowerShell）：注册计划任务看门狗
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-tasks.ps1

# 6) 冒烟
curl.exe http://127.0.0.1:18781/healthz
```

API key 照旧放在原环境变量（`DEEPSEEK_API_KEY` / `GLM_API_KEY` / `KIMI_API_KEY`）——代理只透传，不落盘。

默认端口与上游（在 `relay.config.json` 中可改）：DeepSeek `18781`、GLM `18782`、Kimi `18783`。
Codex 会在 `base_url` 后追加 `/responses`，GLM / Kimi 的路径前缀（`/api/v1`、`/coding/v1`）必须保留。

## 配置参考

### relay.config.json

| 字段 | 消费方 | 说明 |
|---|---|---|
| `endpoints[].name` | 代理 + 脚本 | 端点名（日志前缀、`--Only` 过滤、计划任务描述） |
| `endpoints[].port` | 代理 | 本机监听端口（建议 `127.0.0.1` 专用段，默认 18781-18783） |
| `endpoints[].upstream` | 代理 | 上游 origin（如 `https://api.deepseek.com`）；Codex 请求的路径前缀原样转发 |
| `endpoints[].codexHome` | 切换/探针脚本 | 对应的 `CODEX_HOME`（`~/.codex-<name>`） |
| `endpoints[].baseUrlOriginal` / `baseUrlAfter` | 切换脚本 | 直连与代理两种 `base_url`，供一键切换 |
| `endpoints[].envKey` | 探针脚本 | 该端点的 API key 环境变量名 |

### 命令行

```
codex-relay --config <path> [--host 127.0.0.1] [--log-file <path>]   # 多端口单进程（推荐常驻）
node relay.js <port> <upstream-origin> [--host] [--name <label>]      # 单端点（兼容旧用法）
```

任一端口绑定失败即整体退出（fail-fast，看门狗会重试）。未捕获异常被记录后继续服务。

### 环境变量（全部可选）

| 变量 | 作用 |
|---|---|
| `CODEX_RELAY_HOOKS` | 钩子开关，默认 `A,B`；设为 `A` 则只开请求侧 |
| `CODEX_RELAY_LOG=1` | 逐请求输出状态 / 耗时 / 改写命中计数（升级 Codex 后的回归观测手段） |
| `CODEX_RELAY_LOGFILE=<path>` | 日志落盘（追加，5MB 轮转 `.1`）；也可用 `--log-file`。计划任务抓不到 stdout，常驻模式靠它 |
| `CODEX_RELAY_CAPTURE=<dir>` | 抓包落盘 `req-*.json` / `res-*.sse`，`Authorization` 脱敏；含全量 prompt，仅排障时短时开启 |

### GET /healthz

不触上游。`counters` 语义：`requests`（数据面请求数，探活不计）、`a_rewrites` / `b_injections`（钩子命中）、
`b_skipped`（响应被压缩等未注入）、`errors`（客户端仍在等而上游失败——**唯一需要排查的**）、
`client_aborts` / `completed_aborts`（正常断连）、`recovered_errors`（被吞掉的未捕获异常，非零应查日志）。

## 常驻部署 / 升级

三层（详见 [docs/deploy.md](docs/deploy.md)）：

1. **计划任务看门狗（保底）**：`deploy\install-tasks.ps1`（管理员）注册一个任务直接运行全局安装的 relay；登录时 + 每 1 分钟重复触发，进程死亡 ≤60 秒自愈；
2. **SessionStart hook（兜底）**：`deploy\config-hooks.snippet.toml` 合并进各 `CODEX_HOME` 的 `config.toml`，首次需确认信任；
3. **启动器 ensure（第二道保险）**：`codex-*.ps1` 启动器内先跑 `deploy\ensure-proxy.ps1`。

```bash
# 升级（源码仓库内）
git pull && npm install -g .
powershell -NoProfile -File deploy\ensure-proxy.ps1 -Restart   # 秒级切到新版
```

崩溃恢复的取舍：看门狗形态恢复 ≤60 秒（旧监督进程形态 1–3 秒但需多守护一层）。会话中途若恰逢崩溃，
该轮可能需重发；未捕获异常会被记录后继续服务，真正的崩溃是罕见事件。

## 验证

```powershell
# 自动化：临时 CODEX_HOME 跑真实 spawn_agent，核对探针四项断言（不碰真实配置）
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\probe-subagent.ps1 -Vendor kimi

# 或按 docs/manual-test.md 在交互式 Codex 里粘贴一段 prompt 手工验证
```

断言判据与实测记录见 [docs/verify.md](docs/verify.md)。**升级 Codex 后重跑**——上游若改变 item / SSE
形态，DeepSeek / GLM 上的失配是静默的（退回原始 bug、无报错），`/healthz` 的 A / B 计数是最快的回归探针。

## 回退与卸载

```powershell
# 临时回退：一条命令恢复直连（代理可继续留着）
powershell -NoProfile -File deploy\switch-base-url.ps1 -Mode direct -Apply

# 彻底卸载：任务与进程 → 全局包 → 配置 → 各 config.toml 的 hook 片段 → 仓库目录
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-tasks.ps1 -Uninstall
npm uninstall -g codex-relay
```

代理不写任何 Codex 状态，撤除后行为完全回到现状。

## 安全与隐私

- 仅监听 `127.0.0.1`，不对外暴露；
- API key 仅透传、不落盘；默认零持久化；
- 抓包与日志均 opt-in，`Authorization` 一律脱敏（抓包含全量 prompt，用完即删）。

## 已知限制

- 不修 v1 路径在 Kimi 上的 `tool_search` 拒绝（Kimi 统一走 v2 + 钩子 A）；
- 仅开钩子 A（无 B）时线上功能正常，但本地 rollout 仍是空信封形态（TUI 回放不可读）；
- 修复依赖上游线格式（`agent_message` item、SSE 事件形态、`encrypted_function_args` 标记语义），大版本升级需按"验证"一节复验；
- 部署脚本与计划任务为 Windows 编写（PowerShell 5.1 / 计划任务看门狗）；代理本体 `relay.js` 不依赖平台特性。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/plan.md](docs/plan.md) | 设计方案：根因链、上游源码引证、方案与风险、上游 issue 草稿 |
| [docs/deploy.md](docs/deploy.md) | 部署运维：前置检查、切换、计划任务、观测排障、事故记录、回退 |
| [docs/verify.md](docs/verify.md) | 验收回归：探针用法、断言判据、实测记录 |
| [docs/manual-test.md](docs/manual-test.md) | 手工速测：可粘贴的 prompt 与判读 |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 版本演进 |

## 许可证

[Apache-2.0](LICENSE)
