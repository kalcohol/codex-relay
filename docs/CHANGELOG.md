# 更新日志

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.2.0] - 2026-09-13

### 架构

- **单进程多端口**：relay 由"每端点一进程"收敛为一个进程按 `relay.config.json` 监听全部端点（`node relay.js --config <path>`）；每端点仍是独立实例（计数/hooks 独立），任一端口绑定失败整体退出；旧的单端点 CLI 保留兼容。
- **移除监督进程层**：计划任务 `codex-relay` 直接运行全局安装的 relay，触发器 = 登录时 + 每 1 分钟重复（看门狗）——任务实例活着被 `IgnoreNew` 跳过，进程死亡后由下一次触发拉起（恢复 ≤60 秒）。取代原先"3 relay + 3 监督进程 + 看护任务"共 6 个常驻进程的形态。
- **部署与源码解耦**：`npm install -g .` 安装到 `%APPDATA%\npm\node_modules\codex-relay`，配置迁至 `%APPDATA%\codex-relay\`；部署脚本按"全局安装 → 仓库"退回链解析路径——源码仓库只是开发目录，挪动/删除不影响服务。

### 新增

- 崩溃容忍：uncaughtException / unhandledRejection 记录后继续服务；`/healthz` 暴露 `recovered_errors` 与 `pid`。
- 文件日志：`--log-file` / `CODEX_RELAY_LOGFILE`，追加写 + 5MB 轮转（计划任务抓不到 stdout，常驻模式必需）。
- `deploy/patch-catalog-v2.js`：为模型目录补 `multi_agent_version: "v2"`（预览/--apply/备份/幂等）。
- 验收探针 `-RealHome` 模式：真实 CODEX_HOME 下的端到端验收。

### 修复

- `requests` 计数只统计数据面（探活不再计入）；中断计数归口单一防重入点（client_aborts 不再双记）。
- 监督进程锁所有权（未持锁的实例不得删锁）；`ensure -Status -Strict` 退出码；按 slug 判定模型目录 v2 标记；响应日志轮转（保留最近 20 对）。
- PS 5.1 运行时陷阱：`@((if ...) ...)` 解析通过、运行时把 `if` 当命令名（ParseFile 检查无法发现此类问题，需运行时实证）。

### 事件

- 09-13 监督层失守事故：三个监督进程被外部事件终止 → 孤儿 relay 继续服务两天 → DeepSeek 孤儿死亡后无人接管，单端点失守。定位与结构性修复见 [deploy.md §6.1](deploy.md#61-事故记录2026-09-13-只有-deepseek-不可达)。

## [0.1.0] - 2026-09-11

- 初版实现：钩子 A（请求侧 agent_message 降级为可读 user 消息）+ 钩子 B（SSE 注入 `encrypted_function_args: []`）。
- 失败安全全路径：空正文/坏 JSON/压缩响应透传，SSE 正规分帧（跨 chunk、CRLF、多字节跨界、流尾冲刷）。
- 43 个测试（node:test，零依赖）；`/healthz`、抓包（Authorization 脱敏）、命中计数。
- 部署脚本：切换 base_url（UTF-8/BOM 保真）、验收探针、base_url 一键回退。
- 三家真实端点验收全过（DeepSeek / GLM / Kimi，探针四项断言）；存量会话（Kimi，修复前 400 现场）resume 复验通过；kill 韧性实测。
