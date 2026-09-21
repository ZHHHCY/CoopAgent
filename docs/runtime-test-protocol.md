# Game A 自动测试协议

Game A 自动测试协议在不驱动银河编辑器 UI 的情况下，复现编辑器“测试文档”的运行路径：构建已登记宿主、暂存固定测试地图、通过 `SC2Switcher` 启动 SC2，并把进程与本次运行后产生的日志绑定到同一个 run。

实现借鉴了 [`sc2-map-editor-mcp`](https://github.com/erivgout/sc2-map-editor-mcp) 对编辑器测试协议的实测记录，但在 CoopAgent 内按 Game A 的固定边界独立实现，没有引入其通用地图 Workspace 或源码。

## 固定流程

```text
game-a/core + registered host
        ↓ build-game-a.ps1
game-a/build/versions/<host>/...SC2Map
        ↓ fixed staging
<StarCraft II>/Maps/Test/CoopAgentTest.SC2Map
        +
<StarCraft II>/Maps/Test/CoopAgentTest.SC2TestConfig
        ↓
SC2Switcher_x64.exe -run Test\CoopAgentTest.SC2Map ...
        ↓
SC2_x64.exe + run-scoped GameLogs
```

启动前必须不存在正在运行的 `SC2_x64.exe`。否则无法证明随后出现的 PID 和日志属于当前测试，协议会拒绝启动。

每次运行记录：

- `runId`、宿主 ID 和开始时间；
- 构建地图与固定暂存地图；
- SC2Switcher PID 和识别出的 SC2 PID；
- 启动前 `GameLogs` 文件快照；
- 进程状态以及退出观测时间。

本地状态保存在 `%LOCALAPPDATA%\CoopAgent\runtime-tests`，不进入仓库。

## 日志关联

状态查询只读取启动后新建或发生变化的 `ScriptError.txt` 与 `Alerts.txt`，不会把更早的日志当成本次证据。输出有大小和数量上限。

验证状态：

| 状态 | 含义 |
| --- | --- |
| `pending` | 游戏正在运行，尚未发现本次日志。 |
| `clean-so-far` | 游戏正在运行，已有本次日志且暂未发现阻断错误。 |
| `failed` | 本次日志包含 Galaxy 编译、脚本加载或未豁免的 Trigger 错误。 |
| `log-clean` | 游戏已退出，本次日志未发现已知阻断错误。 |
| `inconclusive` | 游戏已退出，但没有形成可归属的日志。 |

`log-clean` 只证明“该构建被 SC2 加载且已检查日志”，不证明单位机制、任务胜负或用户预期在玩法层面正确。完整验收仍需运行时断言或人工试玩证据。

官方离线合作测试中，`libCOOC`/`libCOMI` 对 `StatEvent` 或 Achievement 服务的无权限调用记录为已知警告，不当作 Game A 脚本失败；其他 Trigger 错误仍然阻断。

## 入口

桌面端原有“启动 Game A”按钮使用该协议。命令行入口：

```bat
game-a\自动测试GameA.cmd
```

查询上一次运行：

```bat
node scripts\game-a-runtime-test.mjs status
```

MCP 提供：

- `runtime_test_start`：构建、暂存、启动并建立 run；
- `runtime_test_status`：查询指定 run 或最近一次 run 的进程和日志证据。

`coop-planner` 默认不能调用启动工具，避免模型在没有用户动作时弹出游戏；它可以读取状态。桌面端或显式命令行入口负责启动。
