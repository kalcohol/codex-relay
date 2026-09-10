# codex-relay

> 本地重写代理：修复 Codex multi-agent v2 在第三方 Responses 兼容端点（DeepSeek / GLM / Kimi）上的子代理消息投递，零侵入、可随时撤除。

**状态**：实现完成并通过三家真实端点验证（2026-09-11）。代理主体 + 测试 + 部署脚本已落地；DeepSeek / GLM / Kimi 各跑一轮真实 `spawn_agent`，五项断言全部通过（含 kill 韧性测试），见 [docs/verify.md](docs/verify.md)。设计方案全文：[docs/plan.md](docs/plan.md)。

| 文档 | 内容 |
|---|---|
| [docs/plan.md](docs/plan.md) | 根因链、源码引证、方案设计、风险表、上游 issue 草稿 |
| [docs/deploy.md](docs/deploy.md) | 安装、base_url 切换、常驻任务、观测排障、回退卸载 |
| [docs/verify.md](docs/verify.md) | 验收探针用法、断言判据、实测记录 |

## 它解决什么问题

Codex 0.138+ 的 multi-agent v2（subagents）会把父 agent 派发给子 agent 的任务正文装进 `encrypted_content` 槽位——正文其实是明文，依赖 OpenAI 服务端解密展开——且整条消息以私有 item 类型 `agent_message` 上线。第三方端点没有这套语义：

| 端点 | 表现 |
|---|---|
| DeepSeek / GLM | 接受请求但静默忽略正文：子 agent 只看到空信封（`Payload:` 后为空），自述"没收到任务"，空转 |
| Kimi | 直接 HTTP 400（`item type "agent_message" is not supported`），父会话一并被毒化终止 |

受影响功能：`spawn_agent` / `send_message` / `followup_task` / `wait_agent` 全链路，以及读取本地历史的周边功能（rollout / TUI 回放 / memory / guardian / web-search 上下文）。普通单 agent 编码会话不受影响。

注意：子→父的 `FINAL_ANSWER` 回程本身是明文，但**仍是 `agent_message` 类型**，所以 Kimi 的回程同样被拒——修复必须双向覆盖。

## 工作原理

```
Codex CLI ──[POST /responses]──▶ 钩子 A：改写 input[] 中的 agent_message ──▶ 厂商端点
Codex CLI ◀──[SSE]──────  钩子 B：给 collaboration function_call 注入明文标记 ◀── 厂商端点
```

两个钩子相互独立、可分别开关：

**钩子 A —— 请求侧降级（Kimi 必需，覆盖存量）**

对出站请求体中每个 `type == "agent_message"` 的 item：类型改为 `message`（`role: "user"`，与 v1 语义一致），`encrypted_content` 块展开为 `input_text` 原文，剥离 Codex 私有字段（`id` / `author` / `recipient` 等）。所有出站请求都会过一遍（含 resume 重放、压缩 / 记忆 / guardian 等辅助请求），因此**修复前落盘的旧会话也能恢复**。

**钩子 B —— 响应侧注入（根治新消息）**

对 SSE 流中 `spawn_agent` / `send_message` / `followup_task` 的 function_call item 注入 `"encrypted_function_args": []`。这个空数组是 Codex 官方端点的"明文直发"标记（`ToolCall::direct_source()`），注入后 Codex 走自带的明文路径，新消息从源头就以明文落盘：rollout / TUI / memory / guardian 全部可读，与官方端点行为一致。

**失败安全**：任何解析或改写失败一律原样透传，不制造坏请求、不破坏流。第三方请求体恒为明文 JSON（上游 zstd 压缩仅对官方后端启用）；响应侧强制 `Accept-Encoding: identity`，若厂商仍返回压缩则该连接跳过注入、只转发（B 降级，A 不受影响）。

## 环境要求

- Node.js ≥ 18（零第三方依赖，单文件 `relay.js`）
- Codex CLI ≥ 0.147（v2 明文路径自该版本存在；**本轮验收在 0.154.0 上完成**，0.153.4 亦通过）
- 模型目录标了 `"multi_agent_version": "v2"`：DeepSeek / Kimi 已自带；**GLM 原本缺失，用 `node deploy\patch-catalog-v2.js "$env:USERPROFILE\.codex-glm\models.json" --apply` 补上**——未标会落 v1（v1 请求带 `tool_search`，glm-5.3 不会主动用它发现工具，实测两轮失败）

## 当前状态（本机）

- 三个端点代理已按计划任务常驻（`codex-relay-deepseek` / `-glm` / `-kimi`，登录自启 + 失败重启 + 进程退出秒级拉起）；
- 三份 `CODEX_HOME` 的 `base_url` 已指向本机代理，`config.toml` 备份为 `config.toml.bak-<时间戳>`，另有一份集中备份在 `~/codex-relay-backup-20260911/`；
- 三家已在真实配置下各跑过一轮 `spawn_agent` 验收，五项断言全过，详见 [docs/verify.md](docs/verify.md)。

## 快速开始

```bash
# 1) 起代理（每个端点一个进程；监听 127.0.0.1，端口可自定）
node relay.js 18781 https://api.deepseek.com                  # DeepSeek
node relay.js 18782 https://open.bigmodel.cn                  # GLM（/api/v1 前缀由 base_url 带过来）
node relay.js 18783 https://api.kimi.com                      # Kimi

# 2) 把对应 CODEX_HOME 的 base_url 指向本地端口（也可用脚本，见下）
powershell -NoProfile -File deploy\switch-base-url.ps1 -Apply

# 3) 常驻 + 冒烟
powershell -NoProfile -File deploy\ensure-proxy.ps1
curl.exe http://127.0.0.1:18781/healthz
```

API key 照旧放在原环境变量（`DEEPSEEK_API_KEY` / `GLM_API_KEY` / `KIMI_API_KEY`）——代理只透传，不落盘。

## 配置

三份 `config.toml` 各改一处 `base_url`（`deploy\switch-base-url.ps1` 会自动改并备份）：

| CODEX_HOME | 原值 | 改为 |
|---|---|---|
| `~/.codex-deepseek` | `https://api.deepseek.com/` | `http://127.0.0.1:18781/` |
| `~/.codex-glm` | `https://open.bigmodel.cn/api/v1` | `http://127.0.0.1:18782/api/v1` |
| `~/.codex-kimi` | `https://api.kimi.com/coding/v1` | `http://127.0.0.1:18783/coding/v1` |

> Codex 会在 base_url 后追加 `/responses`，**GLM / Kimi 的路径前缀必须保留**（代理原样转发路径）。
> 另：不要在家目录运行 codex——项目级 `.codex/config.toml` 会覆盖 `model` 选择（实测踩过）。

端口与上游集中在 [relay.config.json](relay.config.json)，部署脚本都读它。

环境变量（全部可选）：

| 变量 | 作用 |
|---|---|
| `CODEX_RELAY_HOOKS` | 钩子开关，默认 `A,B`；如设为 `A` 则只开请求侧 |
| `CODEX_RELAY_LOG=1` | 逐请求输出状态 / 耗时 / 改写命中计数（升级 Codex 后的回归观测手段） |
| `CODEX_RELAY_CAPTURE=<dir>` | 抓包落盘，`Authorization` 脱敏；含全量 prompt，仅排障时短时开启 |

健康检查：`GET /healthz` 返回 200（不触上游），并给出全部计数。

## 常驻部署

推荐三层（详见 [docs/deploy.md](docs/deploy.md)）：

1. **常驻（保底）**：`deploy\install-tasks.ps1`（**需管理员 PowerShell**）注册计划任务，由 `supervise-endpoint.ps1` 监督——进程退出秒级拉起（实测 1–3 秒），任务自身按分钟级重启兜底，执行时长不限。三层 ensure 都只在会话启动时触发，会话中途崩溃后的恢复全靠它 + Codex 自身的流重试；
2. **SessionStart hook（兜底）**：把 [deploy/config-hooks.snippet.toml](deploy/config-hooks.snippet.toml) 合并进三套 `config.toml`，首次需确认信任；
3. **启动器 ensure（第三道保险）**：现有 `codex-*.ps1` 加一行 `ensure-proxy.ps1`，启动前探测 `/healthz`，不在则拉起。

## 验证

```powershell
# 自动化：临时 CODEX_HOME 跑真实 spawn_agent，核对五项断言（不碰真实配置）
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\probe-subagent.ps1 -Vendor kimi
```

手工核对与判据见 [docs/verify.md](docs/verify.md)。**升级 Codex 后重跑本节**——上游若改变 item / SSE 形态，DS / GLM 上的失配是静默的（退回原 bug、无报错），`/healthz` 的 A / B 计数是最快的回归探针。

## 回退与卸载

- 临时回退：`powershell -NoProfile -File deploy\switch-base-url.ps1 -Mode direct -Apply`（或手工把 `base_url` 改回原值），立刻恢复直连；
- 彻底卸载：`install-tasks.ps1 -Uninstall` → 停残留 node 进程 → 还原三份 `config.toml`（去掉 hook 片段）→ 删除本目录。代理不写任何 Codex 状态，撤除后行为完全回到现状。

## 开发

```bash
npm test        # 43 个用例：改写正确性、SSE 分帧（任意字节边界切片）、压缩透传、
                # 坏输入失败安全、计数与中断归因（node:test，无第三方依赖）
```

`/healthz` 的计数是排障的主要手段：`errors` 才是故障，`client_aborts`（Codex 主动断开）与 `completed_aborts`（收到 `response.completed` 后厂商关连接，Kimi 实测如此）都是正常行为。

## 安全与隐私

- 仅监听 `127.0.0.1`，不对外暴露；
- API key 仅透传、不落盘；默认零持久化；
- 抓包与日志均 opt-in，`Authorization` 一律脱敏。

## 已知限制

- 不修 v1 路径在 Kimi 上的 `tool_search` 拒绝（Kimi 统一走 v2 + 钩子 A）；
- 官方 OpenAI 端点不经代理，行为不变；
- 仅开 A（无 B）时线上功能正常，但本地 rollout 仍是空信封形态，TUI 回放不可读；
- 修复依赖上游线格式（`agent_message` item、SSE 事件形态、`encrypted_function_args` 标记语义），大版本升级需复验；
- 会话中途代理崩溃时，靠监督进程秒级拉起 + Codex 的 `stream_max_retries` 重试窗口，个别在途轮次仍可能失败（断言六已实测 1 秒级恢复）。

## 文档

- 设计方案（根因链、源码引证、验收标准、风险表、上游 issue 草稿）：[docs/plan.md](docs/plan.md)
- 部署运维（安装、切换、常驻、排障、回退）：[docs/deploy.md](docs/deploy.md)
- 验收回归（探针用法、断言判据、实测记录）：[docs/verify.md](docs/verify.md)
- 证据目录（抓包 / 实验 rollout）：留在本地 `_investigation/` 未随仓库发布（含真实会话内容，方案 §10 有索引）
