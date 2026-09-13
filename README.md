# SoL-ClaudeCode

**简体中文** | [English](./README.en.md)

把 NVIDIA [SoL-Pi](https://github.com/NVlabs/SoL-Pi) 的上下文与工具效率机制，移植到
[Claude Code](https://claude.com/claude-code) 的**「线路网关 + 配套插件」**组合。

> 状态：核心机制 **ObservationPack** 已在真实 Claude Code 流量下端到端验证；
> **Evidence-Preserving Reducer / Trajectory Inspector / Action Fusion** 已实现并有单元测试；
> **Online Context Compact** 经评估**不可忠实移植**（原因见下）。改造类机制默认关闭（opt-in）。

## 为什么是两个部件，而不是一个插件

SoL-Pi 是 Pi 的**进程内扩展**，直接挂在它的 `context` 事件上改写"投影给模型的上下文"。Claude Code 没有等价的上下文投影扩展点，于是拆成两侧，各补一半：

- **网关（wire 层）** —— 本地 MITM 代理 `api.anthropic.com`，改写发往模型的 `/v1/messages` 请求体。
  保持 host 仍是 `api.anthropic.com`，所以 first-party 功能身份不掉。**只有网关能改写"发给模型的上下文"。**
- **插件（harness 层）** —— Claude Code 插件，提供 `obs_recall` 工具与 hooks。**只有插件能真正执行工具。**

两侧靠一份**内容寻址的共享归档**对接：网关写入，插件读取，不需要 session 关联。

## 目录结构

```
shared/      两侧共用的契约（ObservationPack / Reducer 核心逻辑，单一真源）
gateway/     MITM 网关：HTTP/1.1 解析、投影、归档、记账、轨迹
plugin/      Claude Code 插件（自包含）：obs_recall MCP、hooks、命令
scripts/     vendor 同步 / 记账报告 / 归档 GC
tests/       node:test（20 条）
bin/solpi    极简启动器
install.sh   一键安装
```

## 环境要求

- Node.js 22 或更高
- Claude Code（原生二进制；已在 2.1.x 验证）
- macOS 或 Linux（Windows 未验证）

## 安装（一键）

```bash
./install.sh        # 生成 CA + 注册 marketplace + 安装插件
./bin/solpi         # 最小启动：网关没起就自动拉起，再跑 claude
./bin/solpi -p "…"  # 一次性
```

把 `bin/` 加进 `PATH`，就能一个词启动（`solpi`）。卸载：

```bash
claude plugin uninstall sol-pi@sol-pi
claude plugin marketplace remove sol-pi
```

## 机制

| 机制 | 位置 | 状态 | 说明 |
|---|---|---|---|
| **ObservationPack** | 网关 + 插件 | ✅ | 超过 10 KB 的 tool_result，在发送 `FULL_SENDS`（默认 2）次后转为 `obs_<24hex>` 句柄；原文进内容寻址归档，可按页 / 按原文精确召回。 |
| **Evidence-Preserving Reducer** | 网关 | ✅ 默认关 | 诊断类命令的长日志交 reducer 模型压成**可逐字节校验**的回执；引文在原文中找不到就原样放行。 |
| **Trajectory Inspector** | 网关 | ✅ | 只记元数据的 JSONL（模型、字节、打包/归约计数）。 |
| **Action Fusion** | 插件 | ✅ 默认关 | Edit/Write 后按配置跑一条跟命令，输出作为上下文回注。 |
| **Online Context Compact** | — | ⛔ | 不可忠实移植，见下。 |

### 为什么 Online Context Compact 没做

SoL-Pi 在计划边界调用 Pi 内部的 `ExtensionContext.compact()`。而 Claude Code 的压缩发生在**客户端**，网关看不到任何压缩信号，也没有可挂的钩子；在网关侧改写会话历史又有破坏 `tool_use` / `tool_result` 配对的风险。因此**主动不做**——上下文削减改由 ObservationPack 承担（旧的大结果塌缩成句柄）。

## 实测

真实 Claude Code（请求体里的 `model` 为 `claude-opus-5`）、经公司代理链路测得。

### 打包（真实会话）

| 请求原 body | 打包后 | 省 |
|---|---|---|
| 105,132 B | 77,973 B | −27,159 |
| 136,190 B | 82,436 B | −53,754 |
| 164,856 B | 84,835 B | −80,021 |

每个命中的大结果，约省 **26–27 KB（≈6,800 tokens）/ 次请求**，且在其后每一次请求都持续省。

### 记账（一次 6 请求的会话）

```
响应真实 usage   input 12 | output 53 | cache read 181,505 | cache write 24,491
请求侧削减       saved 77,319 B ≈ 19,332 tokens，packed 3
```

| 成本口径 | 实际 | 未打包 | 省 |
|---|---|---|---|
| 按实际缓存计价 | $0.7356 | $1.0256 | **$0.29（28.3%）** |
| 假设全价（无缓存） | $3.0941 | $3.3841 | $0.29（8.6%） |

（按**示例单价** $15/百万输入、$75/百万输出计算；这只是示例，不是你的真实账单。）

**要点：省下的绝对金额与缓存无关——都是那 19,332 tokens；变的只是分母。** 缓存不会稀释你省的绝对金额，只会让"省的比例"看起来更小。这也说明：token 减少 ≠ 等额省钱，**要实测别假设**。

### 测试

```
npm test  →  20/20 通过
```

覆盖：HTTP/1.1 解析、ObservationPack 打包 / 召回、Reducer 逐字节回执校验、
**同 session 并发串行化**、usage 扫描、fail-open。

## 并发 / fork / subagent / 多开

| 场景 | 行为 |
|---|---|
| 同时开很多 claude | 一个网关全接；计数器按 `X-Claude-Code-Session-Id` 分桶，互不干扰 |
| 并发启动 | 只有一只绑得上端口；输的 `EADDRINUSE` 干净退出，启动器复用已在跑的那个 |
| fork / 分支 | fork 是新 session id，宽限期重算；继承来的占位符照常可召回（归档是全局内容寻址） |
| subagent / agent teams | 各自带 session id；若与父会话共享 id 且并行，投影按 session **串行化**，计数不竞态 |
| 长期运行 | 计数 LRU 上限；`npm run gc` 清 14 天前的归档 |

## 安全

- 网关对上游请求**归一 `Accept-Encoding: identity`**（否则 `/v1/messages` 是 gzip 的 SSE，读不到 usage）。想保留压缩：`SOLPI_KEEP_ENCODING=1`。
- 日志里 `Authorization` / `x-api-key` / `Cookie` **一律脱敏**，绝不落盘。
- CA 本地生成、经 `NODE_EXTRA_CA_CERTS` 传入、**从不进系统信任库**；收工 `rm -rf gateway/ca` 即撤销。
- 归档含工具原文，`0600` 权限、放在 `~/.sol-pi`，别进版本库。

## 已知边界

- 归档的是**客户端截断后**的字节（Claude Code 的 Read 会先自行截断），网关只能打包它实际收到的。
- 召回单页约 16 KB，大文件需要多次翻页。
- Reducer 的 `anthropic` provider 会**复用拦截到的订阅令牌**做嵌套模型调用——默认关闭，需显式启用（`SOLPI_REDUCER_PROVIDER=anthropic`）。

## 开发

```bash
npm test                          # node --test tests/*.test.mjs
npm run vendor                    # 把 shared/ 同步进 plugin/vendor/
npm run gc                        # 清理 14 天前的归档
node scripts/token-report.mjs     # 生成记账报告（可传 SOLPI_PRICE_* 单价）
```

## 社区

本项目认可并链接 [LINUX DO](https://linux.do) 社区。

## 许可证

MIT。上游机制来自 NVIDIA [SoL-Pi](https://github.com/NVlabs/SoL-Pi)（MIT）。
