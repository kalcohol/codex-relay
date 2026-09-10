# 验收与回归

对应 [plan.md](plan.md) §6。§1 是自动化探针（推荐），§2 是手工核对步骤与判据，§3 记录 2026-09-11 的实测结果。

## 1. 自动化探针

```powershell
# 前置：代理已在跑（deploy\ensure-proxy.ps1）
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\probe-subagent.ps1 -Vendor deepseek|glm|kimi
```

脚本行为：把 `~/.codex-<vendor>` 复制到临时 CODEX_HOME（`%LOCALAPPDATA%\codex-relay\verify\<vendor>\home`），只改副本的 `base_url` → 本机代理端口，并保证模型目录带 `multi_agent_version = "v2"`；随后以 `--sandbox read-only` 跑一次真实 `spawn_agent` + `wait_agent`，最后逐条核对断言。

产物（全部留在 `%LOCALAPPDATA%\codex-relay\verify\<vendor>\`）：

| 文件 | 内容 |
|---|---|
| `report.txt` | 断言结论 + 计数增量 + codex 原始输出 |
| `codex.out.txt` / `codex.err.txt` | 父 agent 的 stdout / stderr |
| `home/sessions/**/rollout-*.jsonl` | 父、子线程的会话记录（断言二的证据） |

注意：真实 API 调用会消耗额度；`-Token` 可指定唯一 token，`-TimeoutSec` 控制超时。

## 2. 断言与判据

| 断言 | 判据 | 失败含义 |
|---|---|---|
| 一（R1） | 父 agent 复述子 agent「按 token 回显」的原文（输出含 `ECHO-<token>`） | 子 agent 没读到任务正文（A 未生效） |
| 二（R2，A+B） | rollout 中该消息 `Payload:` 后带正文，**无** `encrypted_content` | 仅 A 生效或 B 未命中：线上可用但本地态仍不可读 |
| 三（R1/R5） | `/healthz` 的 `errors` 增量为 0 | 上游失败（4xx/连接中断）；正常中断记为 `client_aborts` / `completed_aborts`，不算故障 |
| 四（R3） | 修复前的旧会话 `codex resume` 可用，重点 Kimi 不再 400 | 存量重放未覆盖（A 未生效） |
| 五（观测） | `a_rewrites` 与 `b_injections` 增量均 > 0 | 上游形态变化导致改写静默失配——升级 Codex 后的快速回归探针 |
| 六（韧性） | 会话进行中 kill 代理 → 监督进程 1 秒级拉起 → Codex 重试恢复 | 见 §3 的实测结论 |

手工核对（需要人看的部分）：断言一、二、四。取证据的方法：

```powershell
# 断言二的证据：子线程收到的任务消息
Select-String -Path "$env:LOCALAPPDATA\codex-relay\verify\<vendor>\home\sessions\*\*\*\*.jsonl" -Pattern 'agent_message'
# 期望：content 里只有 input_text，Payload:\n 之后就是正文；没有 encrypted_content
```

## 3. 实测记录

**环境**：Windows 11，Codex CLI 0.153.4，Node v24.15.0，本机代理（hooks A+B 全开）。

| 端点 | 断言一 | 断言二 | 断言三 | 断言五（A / B） | 备注 |
|---|---|---|---|---|---|
| DeepSeek | ✅ | ✅ | ✅ `errors=0` | ✅ 2 / 2 | 26 秒完成一轮 |
| GLM | ✅ | ✅ | ✅ `errors=0` | ✅ 3 / 2 | 临时目录补了 `multi_agent_version=v2`（真实目录缺，见 [deploy.md](deploy.md) §0） |
| Kimi | ✅ | ✅ | ✅ `errors=0`（2 次 `completed_aborts`） | ✅ 2 / 2 | 关键项：`agent_message` 类型级拒绝由钩子 A 化解 |

子线程 rollout 的原始形态（DeepSeek，摘录）：

```json
{"type":"agent_message","author":"/root","recipient":"/root/probe","content":[
  {"type":"input_text","text":"Message Type: NEW_TASK\nTask name: /root/probe\nSender: /root\nPayload:\nZXQ-4582-TRACER payload: reply with exactly ECHO-ZXQ-4582-TRACER"}]}
```

——`Payload:` 后即正文，没有 `encrypted_content` 槽位，与官方端点明文形态一致（钩子 B 生效）。

**断言六（韧性）**：`ensure-proxy.ps1` 拉起监督进程后 kill 掉 relay 进程，**2.8 秒**内新进程接管同一端口、`/healthz` 恢复 200（实测 PID 40884 → 61352；监督进程退出→重启之间有 1–2 秒退避，连续快速失败时退避到 30 秒封顶）。监督进程自身崩溃由计划任务的 `RestartCount/RestartInterval` 兜底。

同时验证了被强杀后残留锁文件的场景（监督进程与 relay 同时被 `Stop-Process -Force`，finally 不执行 → 锁残留）：新一轮 `ensure` 在 3.8 秒内完成接管并恢复健康（含 PowerShell 启动与健康轮询），与"空锁"（旧版本残留）场景一致。判断依据不依赖锁文件里的 PID，而是"能否重新独占打开锁文件"——进程被强杀时文件句柄由系统释放，能独占打开即持有者已死。

**未覆盖**：断言四（存量会话 resume）需用修复前落盘的旧会话手工执行——Kimi 的旧会话在 `~/.codex-kimi/sessions` 下，可用 `codex resume --last` 复现；本次未跑（涉及真实历史会话）。

## 4. 已知不覆盖

- Kimi 的 v1 路径（`tool_search`）不在修复范围，Kimi 统一走 v2 + 钩子 A；
- 官方 OpenAI 端点不经代理，行为不变；
- 仅开 A（`CODEX_RELAY_HOOKS=A`）时线上功能正常，但本地 rollout 仍是空信封形态（TUI 回放不可读）；
- 上游大版本若改变 item / SSE 形态，改写会静默失效，须按断言五复验。
