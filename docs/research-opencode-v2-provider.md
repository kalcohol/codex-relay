# 调查：OpenCode v2 的 provider 切换机制（fusion Phase 1 的 know-how）

> 调查日期 2026-09-13。对象：`sst/opencode` tag **v2.0.3**（`packages/core` + `packages/ai`），对照 main（1.x 线）。
> 动机：OpenCode 原生支持"同一会话多 provider/模型"，这正是 fusion 想要的能力——先弄清它是怎么做到的，
> 再定 fusion 网关的形态。源码留在 `/tmp/opencode-src`（main）与 `/tmp/opencode-v2`（v2.0.3）供后续查阅。

## 1. 核心结论：两种多 provider 架构的分野

| | Codex | OpenCode v2 |
|---|---|---|
| 消息存储格式 | **就是线格式**（Responses items 原样重放到会话绑定的唯一端点） | 客户端规范格式，按请求经**协议适配器**渲染成目标线格式 |
| provider 绑定 | 会话级（subagent 硬继承父 provider，`multi_agents_common.rs:202`） | 请求级（每条消息生成时按 session 当前 model 解析 route） |
| 多厂商同会话 | 需要外部网关（统一方案 / fusion） | 原生（换模型 = 换 protocol+endpoint+auth 三元组） |
| 跨厂商的 opaque 内容 | 无处理机制（`reasoning.encrypted_content` 照发） | **显式建模**：endpoint 指纹 + 检查点门控（见 §3） |

一句话：OpenCode 能原生多 provider，是因为它把"存储格式"和"线格式"拆开了；Codex 两者是同一个东西，
所以一切 Codex 多厂商方案（网关）本质上都是在客户端外部补这个拆分。

## 2. 关键事实（v2.0.3，file:line）

1. **模型引用是二元组，线上永无命名空间**。模型引用 = `{providerID, modelID}`（`schema/src/model.ts:19` Model.Ref）；
   `provider/model` 形态只存在于 UI/CLI 拼接层。发往厂商的 body `model` 字段是**纯 modelID**。
   → 与我们的实证互证：DeepSeek 对 `deepseek/deepseek-flash` 返回 400 并列出支持的模型名。**fusion 网关必须改写 body.model**。
2. **DeepSeek 适配走 OpenAI Chat Completions，不是 Codex 用的 /responses**。
   `packages/ai/src/providers/deepseek.ts`：`protocol: OpenAIChat.protocol`、`endpoint: /chat/completions @ https://api.deepseek.com/v1`、
   auth = `DEEPSEEK_API_KEY` bearer。同厂商按客户端能力暴露不同协议——厂商侧协议多样性是常态。
3. **传输层 = route 三元组**。每条模型路由 = `protocol`（适配器）+ `endpoint`（baseURL/path/query，`route/endpoint.ts`，
   path 可以是请求体函数——Bedrock/Gemini 式 URL 内嵌模型 id）+ `auth`（`route/auth.ts`：bearer/header 凭据定义，按请求 apply）。
   `protocols/` 下 20+ 个适配器：openai-responses / openai-chat / anthropic-messages / zai-chat / gemini / bedrock-converse…
4. **子代理 = 新 child session + 纯文本任务**（`core/src/tool/plugin/subagent.ts`）：
   - 模型：`const model = agent.model ?? parent.model`（:150）——agent 绑定优先，父模型兜底；
   - 任务注入：`sessions.prompt({ text: "You are a subagent spawned by another session.\n" + input.prompt })`（:176）——
     **纯文本 user 消息**，无加密通道、无历史 fork；
   - 默认全新上下文，可用 `sessionID` 续聊同一个子会话；继续时换 agent 会 `switchModel` 到新 agent 的模型（:140）；
   - **嵌套深度默认 1**（`experimental.subagent_depth`，:94）——与 Codex 允许嵌套是产品选择差异，不是线格式约束；
   - 可用子代理清单通过 tool description 动态拼接（context hook，:240+）——与 Codex"角色清单进工具说明"同思路。
5. **切换 provider 的真正约束在历史侧**（`core/src/session/provider-context.ts` + `history.ts`）：
   - 每条 **native compaction checkpoint** 记录 endpoint 指纹（provenance = providerID/provider/modelID/route/protocol
     + sha256(baseURL+path+query)，provider-context.ts:28）；
   - 历史读取时按**目标模型**的 provenance 决定 checkpoint 是否可重放（`history.ts` 的 `replayable()`）：
     只能重放给同 endpoint 指纹的模型；跨 endpoint 切换时 opaque 内容不可翻译 → 上下文由本地摘要/新检查点替换；
   - `session.switchModel` 本身只是重绑 + 发事件（session.ts:90）——切换的复杂度全部在历史边界，不在切换动作。

## 3. 对 fusion Phase 1 的直接启示

1. **body.model 去命名空间**是行业常规形（OpenCode 从不发带斜杠的 id）→ 网关路由表加一列"线上 id"即可；
2. **钩子 A 的产物与 OpenCode 子代理形态一致**（任务 = 子上下文首条纯文本 user 消息）——我们修 bug 时收敛到的
   形态恰是行业做法，不是权宜之计；
3. **跨厂商 opaque 内容：先例是"不可翻译即丢弃/替换"，不是透传**。fusion 的备选方案
   （跨厂商路由时剥离 `reasoning.encrypted_content`）与 OpenCode 的 checkpoint 门控同一精神；
   Phase 1 先裸跑实测，失败即启用剥离；
4. **网关可以保持很薄**：路由 + model 改写 + key 替换 + 钩子 A/B。不需要协议转换——Codex 客户端只讲
   Responses，三家厂商的 `/responses` 原生存在（OpenCode 选 chat/completions 是它客户端能力使然）；
5. **不改 Codex 客户端的前提下，OpenCode 式"请求级 provider"无法复制**（provider 解析在 Rust 会话层内部），
   网关是唯一路径——统一方案的拓扑判断维持成立。

## 4. 对统一方案文档的修订建议

- §4.1 路由表需补一行：**body `model` 字段改写**（命名空间 slug → 厂商 slug；实证：DeepSeek 400 列出支持模型名）；
- §4.3-6（reasoning 剥离）补充跨厂商场景（DS 父 → Kimi 子）与 OpenCode 先例（丢弃/替换语义）；
- 其余维持（两轮复核的结论我们没有复现出反例）。

## 5. 与 codex-relay 的共存

- 调查产物不改变任何现有部署；OpenCode 本身也可与 Codex 并存（独立工具、独立配置）；
- 若未来引入 OpenCode 作为对照/备选客户端，其 DeepSeek/GLM/Kimi 走各自原生协议，**不经过** codex-relay——
  互不影响。

---

## 6. Subagents：OpenCode v2 与 Codex 的思路对比

| 维度 | Codex multi-agent v2 | OpenCode v2 |
|---|---|---|
| 子代理模型 | 角色可绑 model，但 **provider 硬继承父会话**（跨厂商必须网关） | `agent.model = {providerID, modelID}`，**任意厂商**；`agent.model ?? parent.model`（subagent.ts:150） |
| 任务传递 | InterAgentCommunication 信封（NEW_TASK/MESSAGE/FINAL_ANSWER）；第三方端点需钩子 A/B 修复 | **纯文本 prompt** 作为子会话首条 user 消息，前缀 "You are a subagent spawned by another session."（subagent.ts:176） |
| 上下文继承 | `fork_turns` 可继承父历史（all/none） | 默认**全新上下文**，prompt 要求自带全部背景；无 fork 机制 |
| 持续对话 | 子线程常驻 + send_message / followup_task / wait_agent 邮箱模型 | `sessionID` 续聊（工具输出带子会话 id，再次调用即继续）；可 `switchModel` 换子会话模型（:140） |
| 后台执行 | 子线程后台 + wait_agent 阻塞 | `background=true` 立即返回 + job 完成自动通知（subagent-job.ts） |
| 嵌套 | 允许（4 并发槽） | **默认禁止**（`experimental.subagent_depth` 默认 1，:94） |
| 权限 | 全局 approval / sandbox | **per-agent permission ruleset**（allow/ask/deny，agent.ts Info） |
| 声明方式 | `~/.codex/agents/*.toml` 或 `[agents.*]` | `{agent,agents}/**/*.md`（frontmatter：model/description/permissions/prompt）+ config |
| 线格式风险 | 第三方端点需钩子修复，升级需复验 | 明文，无此风险 |
| 失败隔离 | 线程报错可毒化父会话（Kimi 修复前） | ToolFailure 保留 sessionID 供继续，隔离较好 |

两个哲学差异值得记住：OpenCode 要求 prompt 自带背景（无继承），Codex 提供 fork；OpenCode 默认不嵌套，
Codex 允许。前者让跨厂商天然安全（没有 opaque 内容穿越），后者是产品选择而非线格式约束。

## 7. 是否值得整体切换到 OpenCode v2？

**支持面（对本机需求逐项对照，全绿）**：

- 三家国产全部内置：`deepseek`（OpenAI Chat 协议）、`moonshot`（Kimi：OpenAI Chat / **Anthropic Messages** / **OpenResponses** 三条路由）、`zai` + `zai-coding-plan`（GLM，正是本机在用的 coding plan 端点）；
- **GPT 订阅也原生**：`core/src/plugin/provider/openai.ts` 实现 ChatGPT OAuth（browser/headless，PKCE）直连
  `chatgpt.com/backend-api/codex`，`originator: "opencode"`（不冒充 Codex）、`x-codex-beta-features: remote_compaction_v2`、
  responses WS 能力开启、订阅模型门控与限额对齐 Codex CLI（context 400k / input 272k）——统一方案的全部 FR
  （含 GPT）在这里是**原生能力**，连 Phase 2 都省了；
- 多 provider 单会话、per-agent 模型、跨厂商 spawn：原生；agent 用 Markdown 声明，frontmatter 即配置；
- skills、websearch、MCP、LSP、细粒度 permissions；Windows：install 脚本支持 windows-x64。

**成本与风险**：

- **v2.0.3 发布于 2026-09-12（一天前）**——v2.0.x 早期，坑未暴露完；
- TUI/工作流迁移成本：配置体系、审批模型（permission ask/allow vs Codex 的 approvals + Windows sandbox）、
  status line 等习惯都要重学；AGENTS.md 大体通用但格式有差异；
- Codex 特有资产无对应：guardian、approvals_reviewer、既有 rollout 历史、codex exec 自动化与验收脚本；
- 用 OpenCode 走 ChatGPT 订阅属于"第三方客户端访问订阅"——它用自有 originator 且随上游策略维护模型允许清单
  （2026-08-31 就发生过 gpt-5.4 系进出），存在被策略变化影响的可能；
- subagent 无 fork 继承、嵌套默认禁用——依赖"子代理带父上下文"的用法需要改习惯。

**建议**：

1. **并行试用，不做替换**：安装 v2（windows-x64），ChatGPT 登录 + 三家 key，拿一个非关键项目真实跑一周。
   重点观察：Windows TUI 体验、权限弹窗频率、跨厂商 subagent 的委派质量、长会话稳定性；
2. **判定标准**：试用通过 → 新工作逐步迁到 OpenCode（多厂商协同主力），Codex + relay 保留给存量流程与
   codex exec 自动化（两者共存零冲突）；试用不通过 → 回 Codex，fusion Phase 1 网关设计已就绪可随时启动；
3. **直接完全弃用 Codex 现在不建议**：v2 太新 + 迁移成本 + 订阅策略风险。但无论试用结果如何，
   fusion 网关都可以安全搁置——"多厂商同会话"这个问题已经由另一个客户端在协议层原生解决了。
