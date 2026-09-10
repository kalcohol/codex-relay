# 手工速测（subagents 是否修好）

用于自己开交互式 Codex 跑一轮，肉眼确认 `spawn_agent` / `followup_task` 的正文能被子代理读到。
自动化版本见 [verify.md](verify.md)（`deploy\probe-subagent.ps1`）。

## 0. 前置（确认代理在跑）

```powershell
curl.exe -s http://127.0.0.1:18781/healthz    # deepseek
curl.exe -s http://127.0.0.1:18782/healthz    # glm
curl.exe -s http://127.0.0.1:18783/healthz    # kimi
```

期望 `"status":"ok"`。若连不上：`powershell -NoProfile -File deploy\ensure-proxy.ps1`。

## 1. 打开对应厂商的 Codex

`CODEX_HOME` 决定用哪套配置（`base_url` 已指向本机代理）：

```powershell
cd $env:TEMP; mkdir codex-probe -Force | Out-Null; cd codex-probe   # 干净工作目录，避免项目级 .codex/config.toml 干扰

$env:CODEX_HOME="$env:USERPROFILE\.codex-deepseek"; codex   # DeepSeek
$env:CODEX_HOME="$env:USERPROFILE\.codex-glm";      codex   # GLM
$env:CODEX_HOME="$env:USERPROFILE\.codex-kimi";     codex   # Kimi
```

## 2. 粘贴这段 prompt（三家通用，已实测）

```
You have collaboration tools available: spawn_agent, wait_agent, followup_task, send_message.
Use ONLY those tools (no shell, no filesystem, no other tools).

Do exactly this, in order:

1. spawn_agent(task_name="probe", message="Reply with exactly this string and nothing else: GOT-ZXQ-7742")
2. wait_agent for that agent.
3. followup_task to the same agent: "Reply with exactly this string and nothing else: GOT-KX9-31"
4. wait_agent for that agent again.
5. Print both replies VERBATIM, one per line, prefixed "SUBAGENT-1:" and "SUBAGENT-2:".

Do not do anything else.
```

> 两个不同的 token 分别走 `spawn_agent`（首次任务）与 `followup_task`（追加任务），因此一轮就覆盖了"父→子"的两条投递路径。刻意不做"翻转字符串 / 算字符数"之类的变换：实测模型会把 `ZXQ` 反转成 `QZX`，制造无法区分的噪声，而"子代理到底有没有读到正文"用最直白的原样回显就足以判定。

## 3. 判读

期望输出（结尾应有这两行）：

```
SUBAGENT-1:GOT-ZXQ-7742
SUBAGENT-2:GOT-KX9-31
```

| 现象 | 结论 |
|---|---|
| 上面两行原样出现 | ✅ 修好了（子代理读到了任务正文） |
| 子代理回复类似"我没有收到任何任务 / no task message / no payload" | ❌ 正文没传过去（钩子 A 未生效，或 base_url 没指向代理） |
| 父会话直接报错、父 turn 终止 | ❌ 端点拒绝了请求（Kimi 修复前即如此：`item type "agent_message" is not supported`） |
| 父 agent 自己编了答案、实际没调工具 | 看是否有 `collab: Wait` 之类痕迹；用下面的计数客观核对 |

客观旁证（三个都看更稳）：

```powershell
# 1) 计数：一轮下来 a_rewrites 与 b_injections 都应 > 0，errors 保持 0
#    （client_aborts / completed_aborts 是正常断连，不算问题）
curl.exe -s http://127.0.0.1:18783/healthz

# 2) 子线程 rollout：Payload: 之后应直接是正文，且没有 encrypted_content
Select-String -Path "$env:USERPROFILE\.codex-kimi\sessions\*\*\*\*.jsonl" -Pattern 'agent_message' |
  Select-Object -Last 2
```

## 4. 附：最小版（只想快速看一眼）

```
Call spawn_agent(task_name="probe", message="Reply with exactly: GOT-ZXQ-7742") then wait_agent, and print the sub-agent's reply verbatim.
```

子代理回 `GOT-ZXQ-7742` 即为通过；回"没收到任务"即为未修复。

## 5. 备注

- 本页 prompt 已实测（2026-09-11，`codex exec` 非交互跑法）：DeepSeek / GLM / Kimi 三家均回出上面两行，计数增量一致为 `a_rewrites=7, b_injections=4, errors=0`；
- `send_message` 与 `followup_task` 走同一条投递路径（同一个 `direct_source()` 判定 + 同一批工具名单），所以测 `spawn_agent` + `followup_task` 已覆盖三个工具；
- 测试会话会写进对应 `CODEX_HOME` 的历史，不想要就删掉那个 session；
- 三家都建议各跑一轮：Kimi 是最严格的一家（类型级拒绝），它过了其余两家基本不会挂。
