# Agent 命令行测试接口

无需操作窗口，通过命令行启动真实 Agent、接收事件、查询状态、停止任务和检查提交结果。
测试入口与桌面端共用 Rust 后端的模型启动、状态快照、取消、轨迹和提交服务，不是模拟模型或另一套执行器。

需要执行测试集合并持续回答目标确认、处理部分交付时，监督者必须保持客户端运行并继续同一任务；单轮命令结束不等于多轮案例结束。

## 最短用法（Windows PowerShell）

在仓库根目录执行；需要已安装项目开发环境、构建好的本机数据库，以及在 CoopAgent 中配置并选定的模型：

```powershell
# 首次或修改 Rust 后端后编译，无需启动桌面应用。
.tools\node\node.exe scripts\agent-test.mjs build

# 创建测试副本，输出 root（后续 --project 使用这个路径）。
.tools\node\node.exe scripts\agent-test.mjs init

.tools\node\node.exe scripts\agent-test.mjs run --project "上一步的root" --prompt "把阿塔尼斯龙骑士生命改为300，出生时满血。"
```

Node.js 24 / pnpm 已在 PATH 时，上述入口也可以写成 `pnpm agent:test build`、`pnpm agent:test init`、`pnpm agent:test run ...`。

`init` 会复制当前源码与 Game A 到 `.tools/agent-regressions/run-*/project`，只读复用本机数据库，并将副本中龙骑士的测试初态设置为 100。它不会修改正式 Game A；源码变动后应重新 `init`，已有副本不会自动同步。

`run` 使用已配置的真实模型，可能消耗 API 额度。默认新建模型会话，可用 `--session <sessionId>` 继续已有会话。无需打开编辑器或游戏，也不会自动启动它们。

### 不泄露参考答案的测试副本

```powershell
.tools\node\node.exe scripts\agent-test.mjs init --blind
```

`--blind` 仍复制当前 Game A 核心，但不复制任何旧 PatchPlan、Receipt、草稿、任务存档、历史测试报告、人工参考答案、测试实现或案例目录；也不执行龙骑士初态计划。它不是“纯官方游戏基线”，而是没有历史答案的当前核心副本。

只保留运行代码、Schema、通用作者指南和 Skill，模型的外部目录访问被拒绝，运行库链接禁止通过 read 读取；独立 Git 根阻断父项目发现。轨迹插件保留。原文件均保留在正式工程/旧测试副本，不删除。测试需求由外部观察者传入；对照答案和验收报告在副本外保存。请使用新会话，不能传入旧 session 或旧任务的上下文。

这是文件排除与模型工具权限隔离，不是操作系统沙箱。每轮仍需检查原始读取轨迹是否越界；通用工具改进可来源于历史经验，但不能把案例答案注入模型。只读数据库通过 MCP 使用，不放开原始目录访问。

盲测还禁用读取全局 SC2 历史日志的工具；每个副本使用独立的 OpenCode data/state 目录，避免旧会话和旧工具输出混入。已用本机 `opencode debug paths` 核对目录覆盖生效。模型配置仍由宿主从现有配置加载，不复制 API Key 到测试项目。

认证也随 OpenCode data 目录隔离。当前通用 `run` / `createAgentTestClient` 不自动提供主目录凭据；调用方需要在副本旁的 `model-data/opencode/auth.json` 临时准备所选 provider 的认证，并在客户端结束后清理。不要把凭据放入 `project` 或报告；只确认主认证文件非空不能证明隔离模型进程已获得凭据。

## 输出与停止

标准输出为逐行 JSON：启动信息、桌面同源事件，最后是 `result`。结果包含 `run.state`、会话和轨迹路径、提交任务状态及 Receipt 路径。

- `completed` 只代表模型结束；修改成功还要看 `jobs[].state === "applied"`。
- `applied` 证明已写入测试副本，不代表真实游戏效果已验收。
- 本次接口日志：测试副本旁的 `agent-test-*.jsonl`。
- 业务轨迹：输出中的 `tracePath`，与桌面使用同一套轨迹记录器。
- 日志可能含用户提示词、模型文本和本地路径；不要直接公开未检查的日志。

每轮 Token 用量可通过本轮业务轨迹只读查询：

```powershell
.tools\node\node.exe scripts\agent-test-usage.mjs "$env:APPDATA\CoopAgent\traces\<runId>.jsonl"
```

输出包含整轮合计和每次模型请求的 `input`（不含缓存）、`cacheRead`、`cacheWrite`、`output`（不含推理）、`reasoning` 与 `total`。2026-09-06 起优先读取业务轨迹的 `agent.step.started` / `agent.usage`，无需 OpenCode 数据库；旧轨迹才回退到本机消息 usage，按 session ID 和本轮起止时间筛选。不读取正文、隐藏思维文本或 API Key，不重复累加消息与 step-finish，也不修改数据库或业务轨迹。总量优先使用提供方返回值，同时标出各分项是否相符。

`coverage: partial` 表示统计不完整，例如超时打断的最后一次请求尚未返回 usage；已观察到的未完成请求显示 `null`，不当作零消耗。如果连 step 开始都未返回，也无法枚举该次请求，超时轮仍标为 partial，整轮合计仅为已记录部分。缓存读取是输入的一部分，但在这里单列；多次请求重复发送的上下文会累计，不能把整轮合计当成单次上下文长度。旧轨迹回退逻辑依赖 OpenCode 数据库结构，仅用于测试诊断；需要其它数据库位置时，可加第二个位置参数。

按 `Ctrl+C` 请求停止，或自动测试停止：

```powershell
.tools\node\node.exe scripts\agent-test.mjs run --project "测试root" --prompt "修改需求" --stop-after-ms 3000
```

取消会先持久化禁止该轮继续提交的标记，再停止该实例拥有的模型进程；已进入提交的任务以后台最终结果为准，不强杀提交进程。默认没有整个命令的超时限制；显式传入 `--timeout-ms` 才设置观察上限，到期会请求取消仍在运行的模型任务。

默认后端按 [Scalar 产品范围与维护基线](scalar-only.md)执行一轮有界交付；`phase` 事件和 `run.task` 提供预算、checkpoint、模型交付声明与独立后台应用事实。用户确认和提交观察等待不消费有效模型时间。`paused` 表示已保存、待继续，不等于应用失败或成功；已提交但仍在处理也不等于 applied。正常续段复用保存的模型会话、原始需求、草稿和查询证据。

### 迭代 harness 真实模型实验

固定实验清单可先只读查看：

```powershell
pnpm experiment:iterative-harness manifest
```

`smoke` 在四个全新 blind fixture 各跑一次预算组；`compare` 在同一 D 防错基线下，对四个场景分别运行“相同交付策略、预算控制”和“相同交付策略、不限时”各 3 次，共 24 条轨迹：

```powershell
pnpm agent:test build
pnpm experiment:iterative-harness smoke --label 2026-09-13-harness-smoke
pnpm experiment:iterative-harness compare --label 2026-09-13-harness-ab
```

这两个命令调用已配置的真实模型，可能产生费用；每次尝试使用新 blind fixture，不自动启动编辑器或游戏。运行开始冻结并记录模型、数据 SHA-256、Game A 核心树和工具/提示配置摘要；中途变化会中止后续样本。结果写入 `outputs/<label>/`，包括 manifest、逐条原始宿主事件、逐条结果、汇总 JSON/Markdown。汇总分别统计模型 step、工具调用、工具批次结束、收尾提示实际注入、checkpoint、应用完成时间、首个有用结果、停止原因、明确交付结果和第二轮重复查询；错误结果或只因超时结束不会记为通过。诺娃 no-change 出现提交、换指挥官或 global，以及技术缺口场景提交未经运行时证明的方案，均直接失败。

继续同一任务（不能换成新的需求）：

```powershell
.tools\node\node.exe scripts\agent-test.mjs run --project "同一个测试副本root" --task "result.run.task.id"
```

stdio 的 `start` 也接受 `taskId`（`prompt` 可填“继续”，后端以存档原始需求为准）；`task` 方法只读返回最近任务。`agent-test-usage.mjs` 会按阶段统计 Token，并汇总同一运行中的多个会话；中断时未上报的消耗仍标注 unknown/partial，不能当作零。

退出码：`0` 模型完成且本轮提交成功（只读任务可以没有提交）；`1` 错误；`2` 已暂停，需检查任务及反馈；`130` 已取消；`3` 模型已结束但观察截止时提交仍未完成。退出码不代表数值或玩法验收通过。发生观察超时不是任务失败的证明，应查询后台状态，不要据此重复发起修改。

## 脚本 API

从仓库根目录的 `.mjs` 测试脚本导入：

```javascript
import { createAgentTestClient } from "./scripts/lib/agent-test-client.mjs";

const client = await createAgentTestClient({
  projectRoot: "C:/.../.tools/agent-regressions/run-xxx/project",
  onEvent: (event) => console.log(event),
});
try {
  const started = await client.call("start", { prompt: "修改需求" });
  console.log(await client.call("status"));
  // 按测试需要轮询 status/jobs，或取消指定的这轮任务：
  await client.call("stop", { runId: started.run.runId });
  console.log(await client.call("jobs"));
} finally {
  await client.close();
}
```

每个 client 默认是独立的无窗口测试实例，不是连接已打开的桌面窗口。`close()` 会停止该实例尚在运行的模型；不要在想继续运行时关闭它。不要让两个实例同时对同一个测试副本发起修改。

## 可选：带窗口的同源测试

普通模型任务不需要此模式。需要检查页面重载、停止按钮或窗口关闭时，可以给 `run`、`stdio` 加 `--mode desktop`，或给 `createAgentTestClient` 传 `mode: "desktop"`。

```powershell
# 一个终端启动前端开发服务器。
pnpm dev

# 另一个终端启动带 stdio 接口的隔离测试窗口。
pnpm agent:test stdio --project "测试root" --mode desktop
```

该窗口与命令行共享同一个 Rust `AgentState`：命令行发起任务后，窗口可以显示进度、点击停止；不会另起一个后台模型副本。WebView 缓存放在测试副本旁，不使用正式桌面缓存。测试窗口不是已打开的正式 CoopAgent。

桌面模式额外支持 `{"id":"reload","method":"window.reload"}`；`shutdown` 请求正常窗口关闭，走原生关闭时的取消/提交交接逻辑，而不是强杀进程。返回 `requested: true` 只说明请求已发出，关闭完成以子进程退出为准。无窗口模式拒绝 `window.reload`。

提交窗口交接的开发测试还可使用 `scripts/agent-desktop-handoff.mjs`：先 `prepare <测试root>`，再 `hold <测试root> <preparationId>`。它会在真实事务安装第一个文件后暂停，输入 `resume` 才继续；五分钟未恢复会故意退出，留下可恢复日志。此工具只用于故障测试，不是普通 Agent 入口，也不调用模型。

## 原始 stdio 协议

`pnpm agent:test stdio --project "测试root"` 启动逐行 JSON 协议；也可由其他语言通过子进程管道接入。一次启动保持一个实例，请求 ID 用于配对响应，事件独立发送。

```json
{"id":"1","method":"start","params":{"prompt":"修改需求","sessionId":null}}
{"id":"2","method":"status"}
{"id":"3","method":"stop","params":{"runId":"start返回的runId"}}
{"id":"4","method":"jobs"}
{"id":"5","method":"retry","params":{"preparationId":"已有提交任务的preparationId"}}
{"id":"6","method":"shutdown"}
```

响应为 `{"id":"2","result":...}` 或 `{"id":"2","error":{"message":"..."}}`；事件为 `{"event":{"type":"..."}}`。启动时先发送 `ready: true`，协议版本为 1。`status` 查询当前模型快照，`jobs` 查询该副本的持久提交任务，`retry` 沿用同一个提交凭据，不创建新方案。

正常关闭用 `shutdown` 或关闭 stdin（EOF），后端会清理模型。强制终止进程不等价于安全取消。接口不监听网络端口，也不新增模型可调用的 MCP 工具。

## 边界与验证

- Rust 测试二进制 `coopagent-agent-test` 仅在 `agent-test` feature 的 debug 构建中运行；release 不提供测试入口。正常桌面默认入口不变。
- 客户端与 Rust 后端都只允许本仓库创建、有 `fixture.json` 标记的隔离测试目录，拒绝把正式工程当测试目标。
- 不绕过作用域校验、前置条件、提交锁或 Receipt；不修改正式工程和用户正在运行的桌面实例。
- 此入口用于 Agent/后端端到端测试；不能代替前端渲染、交互或 SC2 试玩验收。

接口自动测试（不调用付费模型；先 build，测试默认自行 init）：

```powershell
.tools\node\node.exe --test scripts\__tests__\agent-test-interface.test.mjs
```

2026-09-05 已通过无窗口真实模型验证：一条龙骑士生命 `300 → 200` 的修改完成 prepare、submit 并生成 Receipt；另一条任务在启动后 2.5 秒取消，无提交任务。正式 Game A 保持不变。

可选桌面模式已经验证：命令行启动真实模型后，点击原生窗口的停止按钮，同一 run 变为 `cancelled`、后端 `busy: false`，页面恢复输入，本轮未提交。
