# Codex 多 Agent 消息投递修复 —— 需求与方案

| 项 | 内容 |
|---|---|
| 文档日期 | 2026-09-10 |
| 实测基线 | Codex CLI 0.153.4（Windows） |
| 复核基线 | 上游 main `94697375cb`（2026-09-10）/ rust-v0.154.0（问题未修，见 §1.4） |
| 状态 | **已实现并验证**：M1–M4 完成，三家真实端点全断言通过（见 `docs/verify.md`）；M5 上游 issue 待提交 |
| 证据目录 | `_investigation/`（抓包、临时 CODEX_HOME、会话 rollout） |
| 目标读者 | 本机使用者 / 后续实现者 |
| 修订 | 2026-09-11：独立复核全部源码论断（均证实），强化 B 的 SSE 分帧与压缩防御、A 的边界保护、进程韧性与可观测性，详见 §11 |

---

## 1. 背景

### 1.1 问题现象

在第三方 Responses 兼容端点上使用 Codex 的 multi-agent v2（subagents）时，**父 agent 发给子 agent 的任务正文不可读**：

- 子 agent 只看到空信封（`Message Type: NEW_TASK / Task name / Sender / Payload:` 后为空），自述"没有收到任务"；
- **DeepSeek / GLM**：端点接受该消息但静默忽略正文（无报错，表现为子 agent 空转）；
- **Kimi**：端点直接拒绝，HTTP 400（`input.10: item type "agent_message" is not supported`），且**父子会话双双报错终止**；
- 子→父的 `FINAL_ANSWER` 汇报**始终正常**（明文），失败与消息类型强相关、与长度无关（生产会话 91 条统计：NEW_TASK 53/53、MESSAGE 36/36 走加密通道；FINAL_ANSWER 2/2 明文）。

### 1.2 影响面

- subagents（spawn / send_message / followup_task / wait_agent）在第三方端点上**不可用**；
- Kimi 上更严重：一次 spawn 会毒化父会话（硬 400）；
- 读取本地历史的周边功能（rollout/TUI 展示、memory、guardian、web-search 上下文等）对这些消息**不可读**；
- 普通编码（单 agent）会话不受影响。

### 1.3 根因（源码级结论）

成因链（结论均已源码验证；行号为上游 main `94697375cb`）：

1. **发送侧编码选择**：`codex-rs/core/src/tools/handlers/multi_agents_v2.rs:58-85` `communication_from_tool_message()` —— 仅当 `ToolCallSource::DirectPlaintextMessage` 时走明文，否则 `InterAgentCommunication::new_encrypted()`（`protocol.rs:850`，`content` 留空、正文写入 `encrypted_content`）。
2. **判定条件**：`codex-rs/core/src/tools/router.rs:45-60` `ToolCall::direct_source()` —— 要求提供商回包显式返回 `encrypted_function_args: []` 才走明文。官方 OpenAI 端点在"明文直发"时会返回该空数组；**第三方端点从不返回该字段**（`None`）→ 恒走加密通道。
3. **线格式**：`codex-rs/protocol/src/protocol.rs:889` `to_model_input_item()` → `content = [InputText(空信封), EncryptedContent(正文)]`。**客户端并未加密**——正文就是明文放在加密槽位里，依赖 OpenAI 服务端解密展开（第三方端点无此语义）。
4. **收件侧无兜底**：`codex-rs/core/src/session/mod.rs:3799` `record_inter_agent_communication()` 直接把结果写入子线程历史与 rollout，无解析/降级分支；恢复重建同样原样。
5. **能力检测缺口**：`codex-rs/core/src/client.rs:833-844` 的 `if !is_openai` 清洗块只清 `FunctionCall.encrypted_function_args`，**漏掉了 `agent_message` 的 `EncryptedContent`**（说明是疏忽而非有意设计）。
6. **回程正常的原因**：`codex-rs/core/src/agent/control.rs:678` + `codex-rs/core/src/session_prefix.rs:19` 的完成通知走 `InterAgentCommunication::new()`（明文），从不使用 `new_encrypted`。

**引入版本**：`#26210`（2026-06-05，首见于 v0.138.0）；`#35845`（v0.147.0）加入的明文逃生门依赖端点返回 `encrypted_function_args: []`，对第三方端点形同虚设。

### 1.4 上游状态（2026-09-10 复核）

- 本地仓库已同步上游 main `94697375cb`（+147 提交）；新 release **rust-v0.154.0**（2026-09-09），npm `latest` 亦为 0.154.0。
- 复核结论：**问题未修**。`new_encrypted` / `DirectPlaintextMessage` 在 147 个提交中零改动；`multi_agents_v2.rs`、`router.rs::direct_source()`、`protocol.rs::new_encrypted/to_model_input_item`、`client.rs` 的 `!is_openai` 块均未变。
- 相关信号：0.154 新增 `filter_tool_result_metadata`（`client.rs`），按**实际目标 URL**（https + `api.openai.com`/允许的 ChatGPT host）剥离 tool-result metadata——同类"OpenAI 私有语义外泄第三方端点"问题的又一实例，其处理范式可为我方上游 issue 提供建议模板（§9）。

---

## 2. 需求

### 2.1 功能性需求

| 编号 | 需求 | 验收要点 |
|---|---|---|
| **R1** | 三家（DeepSeek / GLM / Kimi）在 v2 下 subagents 端到端可用 | 新会话 + 1 次 spawn + 唯一 token：子 agent 能读到任务正文并按内容回显；父 agent 能读到子 agent 的汇报 |
| **R2** | 本地可观测性与周边功能恢复 | rollout/TUI 中 agent 消息正文可读；memory / guardian / web-search 等读取本地历史的消费方可正常读取 |
| **R3** | 存量会话可恢复 | 修复前落盘的旧会话（含 encrypted 形态 item）在 resume 后仍可用（Kimi 不再 400，DS/GLM 正文可读） |
| **R4** | 使用体验无感 | 无需手动拉起中间件；对 CLI / IDE / 其它入口一致生效；失败时可快速回退到直连 |
| **R5** | 零侵入 | 不改 Codex 源码、不改厂商服务、可随时撤除，撤除后行为回到现状 |

### 2.2 非功能性需求

| 编号 | 需求 | 说明 |
|---|---|---|
| **N1** | 安全 | 中间件仅监听 `127.0.0.1`；API key 仅透传不落盘；请求/响应默认不持久化（抓包/日志 opt-in） |
| **N2** | 健壮 | 任何解析/改写失败必须**原样透传**，不得制造坏请求或破坏流 |
| **N3** | 低开销 | 单进程、常驻内存 < 100MB；对首 token 延迟影响可忽略（纯本地转发） |
| **N4** | 可维护 | 上游行为变化（item 形态、SSE 事件）时，改动局部化、有清晰失败点 |

### 2.3 非目标

- 不修复 v1 路径在 Kimi 上的 `tool_search` 拒绝（Kimi 统一走 v2 + §4.2 手段 A）；
- 不改变官方 OpenAI 端点行为（原本正常，且中间件对其旁路）；
- 不追求"零中间件进程"（该目标只能通过自编译 Codex 达成，见 §5.1 形态对比，非本期范围）；
- 不依赖三家厂商修改服务端（前提约束）。

---

## 3. 现状事实（实验结论，均已实测）

### 3.1 三家端点兼容矩阵

| 端点 | v1（tool_search 工具面） | v2 父请求 | v2 子方向（NEW_TASK/MESSAGE） | v2 回程（FINAL_ANSWER） | 端点性格 |
|---|---|---|---|---|---|
| DeepSeek `api.deepseek.com` | ✅ 端到端（实验 B 回显成功） | ✅ | ⚠️ 接受 `agent_message` 但忽略正文（静默） | ✅ 明文可达 | 宽松 |
| GLM `open.bigmodel.cn/api/v1` | 端点接受 `tool_search`，但 glm-5.3 不主动用它发现工具（两轮失败） | ✅ | ⚠️ 静默丢正文（子 agent 原话已留证） | ✅ | 宽松 |
| Kimi `api.kimi.com/coding/v1` | ❌ 首个请求即 400（`tools.8 tool_search`） | ✅（须目录标 `multi_agent_version: "v2"`） | ❌ 400（`input.10 agent_message`，类型级拒绝） | ❌ 400（同为 agent_message） | 严格 |

**Kimi 端点完整接受/拒绝矩阵**（抓包实测，3 个正常请求全 200）：

- ✅ item 类型：`message`（developer/user/assistant）、`reasoning`（**含 Kimi 自产 `encrypted_content`，回灌成功**）、`function_call`、`function_call_output`
- ✅ 工具类型：`function`、`custom`、`namespace`（collaboration）、`web_search`
- ❌ item 类型：`agent_message`（与内容无关，纯明文也拒）
- ❌ 工具类型：`tool_search`

> 关键推论：Kimi 服务端**自身实现了不透明加密块机制**（reasoning 项），但不支持 `agent_message` 类型；因此 Kimi 的修复必须做**类型级降级**（手段 A），且回程同理。

**Kimi 目录要求**：`multi_agent_version` 未标 → 落 v1 → 每个请求都带 `tool_search` → 每请求 400（已为 `~/.codex-kimi/models.json` 补上 `"multi_agent_version": "v2"`，普通编码会话恢复可用，实测 200）。

### 3.2 关键源码事实（供实现引用）

| 事实 | 位置 |
|---|---|
| 编码选择点 | `core/src/tools/handlers/multi_agents_v2.rs:58` |
| 明文判定（依赖回包字段） | `core/src/tools/router.rs:45` |
| 加密构造（content 置空） | `protocol/src/protocol.rs:850` |
| 线格式（信封 + EncryptedContent） | `protocol/src/protocol.rs:889` |
| 收件组装（无降级） | `core/src/session/mod.rs:3799` |
| 非 OpenAI 清洗块（漏 agent_message） | `core/src/client.rs:833` |
| 回程明文通路 | `core/src/agent/control.rs:678`、`core/src/session_prefix.rs:19` |
| SSE 事件 → ResponseItem 反序列化（手段 B 注入点） | `codex-api/src/sse/responses.rs:357` |
| 明文可读判定助手 | `protocol/src/models.rs:903` `plaintext_agent_message_content()` |
| v2 版本解析链 | `core/src/config/mod.rs:1552` / `:1562` |

以下为 2026-09-11 独立复核新增（均已源码验证，直接支撑 §4 实现）：

| 事实 | 位置 |
|---|---|
| `direct_source()` 同时要求 namespace == "collaboration" | `core/src/tools/router.rs:45` |
| send_message / followup_task 共用提交路径 → COLLAB 集合无遗漏 | `core/src/tools/handlers/multi_agents_v2/message_tool.rs:52` |
| `"encrypted_function_args": []` → `Some([])`，有专门测试锁定该语义 | `protocol/src/models.rs:3233` |
| `output_item.added` 与 `.done` 均反序列化为 ResponseItem；`response.completed` 仅取 usage、不重建 items | `codex-api/src/sse/responses.rs:509` / `:483` |
| SSE 事件类型取自 data JSON 的 `type` 字段；`event:` 行不被消费（客户端仅转发 `data:`） | `codex-api/src/sse/responses.rs:169`、`codex-client/src/sse.rs:9` |
| `is_openai()` 按 provider 名判定（与 base_url 无关，挂代理不改变任何清洗行为） | `model-provider-info/src/lib.rs:526` |
| zstd 请求压缩仅官方 codex 后端 + OpenAI provider 启用 → 第三方请求体恒为明文 JSON | `core/src/client.rs:1450` |
| WebSocket 传输仅 `supports_websockets` provider（自定义 provider 默认 false，HTTP 代理无 WS 旁路） | `model-provider-info/src/lib.rs:150` |

### 3.3 已完成实验与证据索引

见 §10 附录 B。

---

## 4. 方案设计

### 4.1 总体架构

在 Codex CLI 与厂商端点之间加一个**本地重写代理**（单进程、仅监听 127.0.0.1），内含两个独立钩子：

```
Codex CLI ──[请求]──▶ 代理·钩子A（改写 input[] 的 agent_message）──▶ 厂商端点
Codex CLI ◀──[SSE]─── 代理·钩子B（给 collaboration function_call 注入明文字段）◀── 厂商端点
```

- 对官方 OpenAI 端点：`base_url` 不指向代理，行为完全不变（旁路）。
- A 与 B 相互独立、可分别开关；实现为一个 Node 单文件 + 三份端口配置（实际 `relay.js` 约 670 行——方案初稿估的 150–250 行只算了骨架，落地时失败安全、SSE 正规分帧、抓包、计数与中断归因都计入其中）。

### 4.2 手段 A：请求侧降级（必做）

**作用层**：出口。改写 `POST /responses` 请求体 JSON 的 `input[]`。

**规则**（对每个 `type == "agent_message"` 的 item）：

```
Before:
{ "type": "agent_message", "id": "amsg_…", "author": "/root", "recipient": "/root/probe",
  "content": [
    { "type": "input_text", "text": "Message Type: NEW_TASK\nTask name: /root/probe\nSender: /root\nPayload:\n" },
    { "type": "encrypted_content", "encrypted_content": "ZXQ-…payload 原文" } ] }

After:
{ "type": "message", "role": "user",
  "content": [ { "type": "input_text",
    "text": "Message Type: NEW_TASK\nTask name: /root/probe\nSender: /root\nPayload:\nZXQ-…payload 原文" } ] }
```

1. `type` → `message`，补 `role: "user"`（与 v1 语义一致：v1 下子 agent 即把任务当 user 消息收）；
2. `content` 数组中 `encrypted_content` 块 → `input_text`（文本原文拼接，与官方明文路径 `InterAgentMessage::render()` 产物一致）；
3. 剥离 Codex 私有字段：`id` / `author` / `recipient` / `internal_chat_message_metadata_passthrough`。

**伪代码**：

```js
function rewriteAgentMessages(body) {
  if (!Array.isArray(body.input)) return body;
  for (const item of body.input) {
    if (item.type !== 'agent_message') continue;
    const text = (item.content ?? [])
      .map(p => p.type === 'input_text' ? p.text
              : p.type === 'encrypted_content' ? p.encrypted_content : '')
      .join('');
    if (!text) continue;   // 空正文：原样透传，避免向严格端点制造空 user message
    for (const k of Object.keys(item)) delete item[k];
    Object.assign(item, { type: 'message', role: 'user',
                          content: [{ type: 'input_text', text }] });
  }
  return body;
}
```

**覆盖面**：所有出站请求（父→子、子→父、**存量重放**、压缩/记忆/guardian 等辅助请求），这是 R3 的唯一保障，也是 Kimi 过类型校验的唯一手段。

**不碰**：`tools`、其它 item 类型、响应流、本地文件、Codex 源码、厂商。

**失败安全**：JSON 解析失败 → 原样透传；改写后重算 `Content-Length`；仅匹配顶层 `input[]` 的 `agent_message`（不误伤 reasoning 的 `encrypted_content`）；拼接结果为空 → 原样透传（见伪代码）。传输前提（2026-09-11 核实）：第三方请求体恒为明文 JSON——zstd 请求压缩仅对官方 codex 后端 + OpenAI provider 启用（`client.rs:1450` 三条件门控），请求也实测不带 `Accept-Encoding`；若未来出现带 `Content-Encoding` 的请求体 → 原样透传。

**副作用**：模型看到的是 user message（等价 v1）；本地 rollout 内容不变（仍为空信封形态）。

### 4.3 手段 B：响应侧注入（根治项）

**作用层**：入口。改写厂商 SSE 流中的事件数据。

**注入点**（已验证）：`codex-api/src/sse/responses.rs:357` 将 `response.output_item.done` 事件的 `item` 直接反序列化为 `ResponseItem`。

**规则**：对 `response.output_item.added` / `.done` 事件中 `type == "function_call"` 且 `name ∈ {spawn_agent, send_message, followup_task}` 的 item，注入一个字段：

```
"encrypted_function_args": []
```

**效果链**：`ToolCall::direct_source()`（`router.rs:45`）读到 `Some([])` → `DirectPlaintextMessage` → Codex 改用明文信封（正文内联于 `Payload:` 之后）→ 该消息从源头起：本地 rollout / TUI / 周边功能 / 出站请求全部可读（与官方端点明文形态一致）。

**伪代码**：

```js
const COLLAB = new Set(['spawn_agent', 'send_message', 'followup_task']);

// —— 分帧：跨 chunk 缓冲，按空行切帧（兼容 \r\n）——
function feed(state, chunk, emit) {
  state.buf += state.decoder.write(chunk);   // string_decoder 处理 UTF-8 多字节跨界
  let m;
  while ((m = state.buf.match(/\r?\n\r?\n/))) {
    const frame = state.buf.slice(0, m.index);
    state.buf = state.buf.slice(m.index + m[0].length);
    emit(patchSseFrame(frame) + m[0]);
  }
}                                            // 流结束时剩余 buf 原样冲出

// —— 改帧：帧内多行 data: 拼接后解析（与 eventsource_stream 语义对齐）——
function patchSseFrame(frame) {
  const data = frame.split(/\r?\n/)
    .filter(l => l.startsWith('data:'))
    .map(l => l.replace(/^data:\s?/, '')).join('\n');
  if (!data) return frame;
  let obj; try { obj = JSON.parse(data); } catch { return frame; }
  const item = obj?.item;
  if ((obj.type === 'response.output_item.added' || obj.type === 'response.output_item.done')
      && item?.type === 'function_call' && item.namespace === 'collaboration'
      && COLLAB.has(item.name)
      && !Array.isArray(item.encrypted_function_args)) {
    item.encrypted_function_args = [];
    return 'data: ' + JSON.stringify(obj) + '\n\n';  // event: 行 Codex 不消费，仅重发 data 即可
  }
  return frame;
}
```

**实现注意**（2026-09-11 复核后强化）：

1. **正规 SSE 分帧**：按空行（`\n\n`，兼容 `\r\n\r\n`）切帧 + 跨 TCP chunk 缓冲；**帧内多行 `data:` 必须拼接后再解析**——Codex 自身走 `eventsource_stream` 标准解析（`codex-client/src/sse.rs:9`），单行正则是弱化实现，厂商一旦拆行，注入就会静默失效；
2. **压缩防御（强制项，不再是备选）**：转发时强制改写 `Accept-Encoding: identity`。Codex 侧 reqwest 未启用压缩特性、抓包证实请求本就不带该头，但 HTTP 允许服务器主动压缩，改写一行即消除整个问题域；若响应仍带非 identity 的 `Content-Encoding` → 该连接跳过注入、原样透传（B 降级为关闭，A 不受影响）；
3. 事件类型判定依据 **data JSON 的 `type` 字段**（`responses.rs:169` `#[serde(rename = "type")]`）；`event:` 行 Codex 不消费，改写后仅重发 `data:` 行即可；
4. 注入幂等；`namespace === 'collaboration'` 与 COLLAB 名单双重匹配（`direct_source()` 源码同样要求 namespace，抓包实值已确认）；任何解析失败原样透传；
5. 注入字段随后落入本地 rollout，但重放时会被 `client.rs:833` 的 `!is_openai` 块清除——**不外泄厂商、无副作用**（`[]` → `Some([])` 的语义有专门测试锁定，`models.rs:3233`）。

**覆盖面**：仅新产生的 spawn/send/followup 调用；**存量历史不受影响**（由 A 覆盖）。

### 4.4 三家处方

| 厂商 | 处方 | 理由 |
|---|---|---|
| **DeepSeek** | **B**（根治；A 可选用于存量） | 端点宽松、接受 `agent_message`；B 即可让新消息全链路干净 |
| **GLM** | **B**（同上） | 同 DeepSeek |
| **Kimi** | **A 必须**（+ B 加分） | 端点拒绝 `agent_message` 类型：只有 A 能过校验且覆盖存量；B 让本地态也可读 |

**统一实现建议**：三家启用 A + B（A 覆盖存量与 Kimi 类型，B 覆盖新消息源头），一次实现、三处部署。

### 4.5 本地态与周边功能影响

| 场景 | 仅 A | A + B |
|---|---|---|
| 子 agent 读任务正文 | ✅ | ✅ |
| 父 agent 读回程汇报 | ✅ | ✅ |
| rollout/TUI 可读 | ❌（仍空信封） | ✅ |
| memory / guardian / web-search 等 | ❌（`plaintext_agent_message_content` 返回 None 跳过） | ✅ |
| 存量旧会话（resume） | ✅ | ✅ |

---

## 5. 部署与运维

### 5.1 形态对比

| 形态 | 免手动拉起 | 免额外进程 | 成本 | 备注 |
|---|---|---|---|---|
| `.ps1` 启动器内 ensure | ✅（仅覆盖用脚本启动的场景） | ❌ | 低 | 现有 `codex-*.ps1` 加 3–5 行 |
| 常驻服务（登录自启/计划任务） | ✅（全入口） | ❌ | 低 | 最稳，无竞态 |
| 插件 + SessionStart hook 兜底 | ✅（全入口） | ❌ | 中 | Codex 插件清单仅支持 skills/mcp_servers/apps/hooks，**无网络扩展点**，hook 只能负责"确保代理在跑"（`SessionStart` 早于首个模型请求，`core/src/session/turn.rs:287`）；hook 首次需信任 |
| 自编译 Codex（patch `client.rs:833`） | ✅ | ✅ | 高 | 唯一零额外进程路径；需自维护 fork，非本期范围 |

### 5.2 推荐组合

**常驻服务（保底）+ SessionStart hook（兜底）+ `.ps1` ensure（第三道保险）**，一次安装、长期无感。hook 声明形式（`config/src/hooks_tests.rs` 样例）：

```toml
# 可选：写进三套 config.toml 的 [hooks]，或打包为本地插件
[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = "powershell -NoProfile -File <路径>/ensure-proxy.ps1"
timeout = 10
```

### 5.3 配置变更清单

| CODEX_HOME | `base_url` 现值 | 改为（代理端口示例） |
|---|---|---|
| `~/.codex-deepseek` | `https://api.deepseek.com/` | `http://127.0.0.1:18781/` |
| `~/.codex-glm` | `https://open.bigmodel.cn/api/v1` | `http://127.0.0.1:18782/api/v1` |
| `~/.codex-kimi` | `https://api.kimi.com/coding/v1` | `http://127.0.0.1:18783/coding/v1` |

> 注意：Codex 会在 `base_url` 后追加 `/responses`，**GLM/Kimi 的路径前缀必须保留**（代理按前缀转发）。
> 另注意：不要在家目录运行 codex——项目级 `.codex/config.toml` 会覆盖 `model` 选择（已实测的坑）。

### 5.4 进程韧性（2026-09-11 新增）

三层 ensure（服务 / hook / `.ps1`）都只在**会话启动时**触发，覆盖不了会话中途崩溃：在途 SSE 断开后 Codex 会按 `stream_max_retries` 重试，但重试窗口内若无人拉起代理，该轮仍会失败。因此：

1. **常驻服务必须配置失败自动重启**（Windows 服务"恢复"选项：每次失败即重启；或计划任务循环拉起）——这是会话中途崩溃的唯一恢复路径；
2. 代理暴露 `GET /healthz`（返回 200、不触上游），供 ensure 脚本与服务监视复用；
3. Windows 下 hook 可改用 schema 支持的 `command_windows` 字段（`config/src/hook_config.rs`），避免通用 command 走错解释器。

---

## 6. 验证计划（验收标准）

### 6.1 验收用例（每家各跑一轮）

前置：新会话、`--sandbox read-only`、唯一 token。

1. 指令父 agent：`spawn_agent(task_name="probe", message="ZXQ-<VENDOR>-TRACER payload: reply with exactly ECHO-ZXQ-<VENDOR>-TRACER")` → 再 `wait_agent` → 复述子 agent 行为；
2. 断言一（R1）：父 agent 能复述子 agent **确实按 token 回显**（而非"没收到任务"）；
3. 断言二（R2，仅 A+B）：子线程 rollout 中该消息为**明文**（无 `encrypted_content`）、`Payload:` 后带正文；
4. 断言三（R1/R5 回归）：全过程无 4xx；同会话中的普通工具调用、非 collab 会话不受影响；
5. 断言四（R3）：对修复前产生的旧会话执行 `resume`，子/父消息可读且无 400（重点 Kimi）；
6. 断言五（可观测性，A+B 轮）：开启 opt-in 改写计数日志，确认本会话 A 改写计数与 B 注入计数均 > 0——这也是升级 Codex 后的快速回归手段（DS/GLM 改形失配是静默的，无 4xx）；
7. 断言六（韧性，M4 后加测）：会话进行中 kill 代理进程 → 服务自动重启 → Codex 重试恢复会话（若实测不满足，记录实际行为并决定是否接受）。

### 6.2 执行顺序

1. 实现代理骨架 + 手段 A；
2. 三家跑 §6.1（Kimi 为关键项）；
3. 叠加手段 B（正规 SSE 分帧 + 强制 `Accept-Encoding: identity`），复跑 §6.1 并补断言二、五；
4. 在 **0.153.4** 与 **0.154.0**（升级后）各跑一遍基线（版本变更需复验）。

### 6.3 已有基线（0.153.4 实测，作为对照）

- 无代理：DeepSeek/GLM 子 agent 空信封；Kimi 双向 400（证据见 §10）。
- 无代理 + v1（DeepSeek）：端到端可用（回显成功）——说明降级到"普通消息"后功能完全正常，支持手段 A 的语义等价性。

---

## 7. 风险与回退

| 风险 | 影响 | 缓解 |
|---|---|---|
| 代理故障/未运行 | 会话请求全部失败 | `.ps1`/hook/服务三层 ensure；代理内置健康自检；**保留直连配置**，改回 `base_url` 一键回退 |
| 上游 item/SSE 形态变化 | 改写失效或破坏流 | 全部改写"失败即透传"（N2）；升级 Codex 后复跑 §6.1 |
| Kimi 其它 v2 专有 item 触发严格校验 | 未知的后续 400 | §6.1 覆盖真实链路；一旦发现按同法纳入降级名单 |
| 代理可见全量 prompt 与 key | 隐私 | 仅 `127.0.0.1`；默认零落盘；日志/抓包显式开启并脱敏 |
| Hook 信任提示 / 版本兼容 | 首次需确认 | 文档说明；或不使用 hook、仅用常驻服务 |
| 厂商无视请求头、主动 gzip 响应 | B 注入失效（A 不受影响） | 转发强制 `Accept-Encoding: identity`（§4.3）；响应仍压缩则该连接跳过注入、原样透传 |
| 会话中途代理崩溃 | 在途流中断、该轮可能失败 | 服务失败自重启（§5.4）+ Codex `stream_max_retries` 重试窗口；验收含 kill 测试（断言六） |
| 升级后改写失配（DS/GLM） | 静默退回原 bug（子 agent 空转、无报错） | 改写命中计数（opt-in 日志，断言五）；升级后跑一轮确认计数 > 0 |

---

## 8. 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | 代理骨架 + 手段 A（含失败安全与空正文保护） | ✅ 完成（`relay.js`） |
| M2 | 三家验证实验（§6.1） | ✅ 完成：DeepSeek / GLM / Kimi 各一轮真实 `spawn_agent`，断言一/二/三/五全过（`docs/verify.md` §3） |
| M3 | 手段 B（正规 SSE 分帧 + 压缩防御）+ 复验（含本地态/计数断言） | ✅ 完成（复验与 M2 同轮，钩子 A+B 全开） |
| M4 | 托管形态（常驻服务自重启 + hook/`.ps1` ensure + `/healthz`）+ kill 韧性测试 + 文档 | ✅ 完成：监督进程 kill 后 1 秒级恢复（`deploy/`） |
| M5（可选） | 上游 issue 提交（§9）与跟进 | ⏳ 待提交（草稿见 §9） |

> 实现期补充（与本文档的差异，均为等价或更强）：
> 1. 常驻形态用「计划任务（登录启动、不限时长、失败重启）+ 监督脚本（进程退出秒级拉起）」组合——会话中途崩溃的恢复比"服务失败即重启"更快；
> 2. `/healthz` 除状态外返回全部计数（`a_rewrites` / `b_injections` / `errors` / `client_aborts` / `completed_aborts`），断言五可直接读计数而不必开日志；
> 3. 中断归因：区分 `client_aborts`（Codex 主动断开）与 `completed_aborts`（收到 `response.completed` 后厂商关连接，Kimi 实测行为）——两者都是正常行为，仅 `errors` 计为故障，避免把正常断连误判为故障（实测中 Kimi 每轮都会出现后者）；
> 4. GLM 的模型目录需自行补 `"multi_agent_version": "v2"`（实测缺失会落 v1），已写入 README 与部署文档；

---

## 9. 附录 A：上游 issue 草稿（英文，可直接提交）

**Title:** Multi-agent v2 parent→child payloads unreadable on third-party Responses-compatible endpoints (payload placed in `encrypted_content`, empty `input_text` envelope); Kimi rejects `agent_message` outright

**Environment:** Codex CLI 0.153.4 and current main `94697375cb` / rust-v0.154.0 (still present), Windows 11; provider: third-party Responses-compatible endpoint (`wire_api="responses"`, model catalog `multi_agent_version="v2"`).

**Repro** (fresh session, one spawn, one unique token):
1. Point the provider `base_url` at a local logging proxy (or inspect the child rollout JSONL).
2. `codex exec "Call spawn_agent once with task_name=probe and message=ZXQ-7742-TRACER payload: reply with exactly ECHO-ZXQ-7742-TRACER, then say DONE."`
3. Inspect the child's first request body.

**Observed:**
- Child request contains `{"type":"agent_message","content":[{"type":"input_text","text":"Message Type: NEW_TASK\n…Payload:\n"},{"type":"encrypted_content","encrypted_content":"ZXQ-7742-TRACER payload: …"}]}` — the payload is **plaintext inside the `encrypted_content` slot**, and the endpoint does not expand it, so the child only sees the empty envelope. On a strict endpoint (Kimi) the request is rejected outright: `input.10: item type "agent_message" is not supported`.
- `FINAL_ANSWER` (child→parent) always arrives as plaintext `input_text`; failure is one-directional and type-correlated (production session: NEW_TASK 53/53, MESSAGE 36/36 encrypted; FINAL_ANSWER 2/2 plaintext).

**Root cause:** `communication_from_tool_message` (`codex-rs/core/src/tools/handlers/multi_agents_v2.rs:58`) selects `new_encrypted` unless `ToolCall::direct_source()` (`codex-rs/core/src/tools/router.rs:45`) sees `encrypted_function_args: []` on the provider's function-call item. Third-party endpoints never emit that marker. The destination-aware scrubbing in `build_responses_request` (`codex-rs/core/src/client.rs:833`, `if !is_openai`) clears `encrypted_function_args` on replayed calls but leaves `agent_message` `EncryptedContent` untouched.

**Expected:** On providers without the encrypted-content capability, deliver the payload readably (plaintext `content`, or locally expand the `EncryptedContent` part to `InputText` at request-build time).

**Suggested fix:** In the `!is_openai` branch (or preferably via the destination-host check used by the new `filter_tool_result_metadata`, which already gates on `api.openai.com`/allowed ChatGPT hosts), rewrite `agent_message` `EncryptedContent` parts as `InputText`; note that strict endpoints also reject the `agent_message` item type itself, so a model-catalog capability flag (e.g. `supports_encrypted_agent_messages`, default true for OpenAI) would allow the harness to emit a plain `message` instead.

---

## 10. 附录 B：证据索引

**抓包（`_investigation/`）**

| 文件 | 内容 |
|---|---|
| `captures-a/req-0002.json` | DeepSeek v2 子请求：`agent_message` + 空信封 + `encrypted_content`（正文原文） |
| `captures-a/req-0003.json` | 父请求复播的 `function_call`：**无** `encrypted_function_args` → 走加密通道的直接证据 |
| `captures-b/req-0004.json` | DeepSeek v1 子请求：明文 user 消息（正文完整），子 agent 回显成功 |
| `captures-c/` | 目录无版本字段 → v1 工具面（含 `tool_search`） |
| `captures-glm1/req-0001.json` | GLM v1 请求：工具面含 `tool_search`，端点 200（宽松） |
| `captures-kimi/req-0001..0004.json` | Kimi 兼容矩阵：`message`/`reasoning`（含自产 encrypted_content）/`function_call`/`namespace`/`web_search` 全 200；`tool_search`、`agent_message` 被拒 |

**会话 rollout**

| 路径 | 内容 |
|---|---|
| `exp-glm-v2/home/sessions/2026/09/10/rollout-*.jsonl` | GLM v2：子 agent 原话"only the environment context… no task message" |
| `exp-kimi-v2/home/sessions/2026/09/10/rollout-…-01a08baa-e75f…jsonl`（父） | Kimi v2：spawn 成功 → 回程 FINAL_ANSWER（**纯明文**）仍被 400 → 父 turn 终止 |
| `exp-kimi-v2/home/sessions/2026/09/10/rollout-…-01a08bab-16da…jsonl`（子） | Kimi v2：子历史含 NEW_TASK `agent_message`，请求 400 |
| `%USERPROFILE%\.codex-deepseek\sessions\2026\09\10\rollout-*.jsonl` | 生产证据：91 条消息（NEW_TASK 53/53、MESSAGE 36/36 加密；FINAL_ANSWER 2/2 明文） |

**生产日志**：`%USERPROFILE%\.codex-deepseek\logs_2.sqlite`（`codex_core::session::handlers:537` Submission dump，`InterAgentCommunication` 形态）。

**上游提交（codex 仓库）**

| 提交 | 内容 | 首个版本 |
|---|---|---|
| `5f4d06ef18`（2026-06-05，#26210） | 引入 encrypted relay（问题起点） | v0.138.0 |
| `03edf16f0b`（2026-07-28，#35845） | 明文逃生门（依赖回包字段，第三方不触发） | v0.147.0 |
| `94697375cb`（2026-09-10） | 复核基线：问题未修 | main |
| `94697375cb`（2026-09-11 独立复核） | 全部方案论断逐条证实；本修订的依据 | main |

---

## 11. 修订记录

**2026-09-11（独立源码复核后的强化修订）**

复核范围：§1.3 / §3.2 全部源码论断（本地仓库 HEAD `94697375cb` 逐条核对）+ `_investigation/` 抓包与会话 rollout 抽查（含 `captures-a/req-0002、0003`、`captures-kimi/req-0001..0004`、Kimi 父/子 rollout 的 400 现场）。结论：**论断全部证实、方案架构不变**。本次修订内容：

1. **§3.2 新增 8 条复核事实**：`direct_source()` 的 namespace 条件、send_message/followup_task 共用路径（COLLAB 无遗漏）、`[]`→`Some([])` 有测试锁定、added/done/completed 三类事件的反序列化语义、事件类型取自 data JSON `type` 字段且 `event:` 行不消费、`is_openai()` 按 provider 名判定、zstd 请求压缩门控、WebSocket 传输门控；
2. **§4.3 手段 B 强化**：SSE 处理从单行正则升级为**正规分帧**（空行切帧、帧内多行 `data:` 拼接、CRLF 兼容、流尾冲刷）；压缩防御从"或解压重压"备选升级为**强制 `Accept-Encoding: identity` + 非 identity 响应跳过注入透传**；伪代码补 `namespace === 'collaboration'` 检查；补充"注入字段不外泄"与"`event:` 行不消费"两条复核结论；
3. **§4.2 手段 A 强化**：伪代码补**空正文保护**（拼接为空则原样透传）；失败安全补"第三方请求体恒为明文 JSON"的传输前提；
4. **§5.4 新增进程韧性小节**：服务失败自重启（会话中崩溃的唯一恢复路径）、`/healthz`、`command_windows`；
5. **§6.1 新增断言五（改写命中计数）与断言六（kill 韧性测试）**，§6.2 执行顺序同步更新；
6. **§7 新增 3 项风险**：厂商主动压缩、会话中途崩溃、升级后静默失配（含各自缓解）；
7. §8 里程碑对应更新（预估不变）。
