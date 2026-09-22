# 项目工作区

每个 CoopAgent 项目拥有独立的可写地图运行层核心、会话、任务、计划、Receipt、构建输出和界面状态。多个会话可以共同编辑同一个项目；切换项目不会带入其他项目的修改或后台操作。

## 使用方式

顶部项目选择器支持新建、打开目录、最近项目切换和重命名。新项目默认保存到当前程序目录的 `projects/名称`，也可以指定其他新目录。已有目录通过“打开项目”读取，不能被“新建”覆盖。

当前项目和最近项目记录保存在当前程序目录的 `.coopagent/projects.json`。不同源码副本各自管理自己的项目与活动 Agent，不共享系统级项目注册表；模型配置、凭据和 SC2 安装路径仍是用户级配置。

- 新建项目从版本化干净模板创建，修改记录与会话为空。
- 打开项目恢复其当前工程和会话，不重新复制模板。
- 新建会话只清空对话上下文，继续使用该项目已有修改。
- 删除会话不会删除计划、Receipt 或工程修改。
- 首次启动显示项目首页，引导新建或打开独立项目；只有源码目录已有兼容项目标记时才恢复该工程。
- 项目列表格式损坏时先保留备份，再显示项目首页；重新打开目录即可恢复项目中的会话和修改。

OpenCode 会话仍记录创建时的目录。移动项目后，项目 ID、工程和 Receipt 可以继续使用，旧会话需要显式重新关联。

## 文件布局

```text
我的合作模式/
  coop-project.json
  game-a/
    core/GameA.SC2Mod/
    patches/
    drafts/
    runtime/
    build/
  .coopagent/
    opencode/
    traces/
    ui.json
```

`coop-project.json` 保存稳定 projectId、名称、模板 ID/版本/哈希、SC2 数据构建号和运行契约。路径不是项目身份，目录移动后 projectId 保持不变。

程序、Skill、MCP、数据库和固定湮灭快车任务地图由应用共享。项目只物化自己的可编辑地图运行层核心，不重复复制数据库和任务地图。构建输出属于项目，可以删除并重建。

## 隔离契约

- `scripts/lib/project-context.mjs` 区分应用目录和项目目录。查询、任务、预检、提交、修改记录和构建使用项目目录；程序与 Schema 来自应用目录。
- 模型进程、MCP 和 worker 在启动时绑定固定项目。项目切换不能改变已经运行的任务归属。
- 前端请求和模型事件携带 projectId 与 contextGeneration，旧项目的延迟响应会被拒绝。
- 项目任务、preparation、Receipt 和 OpenCode data/state 分别保存在项目内。
- 凭据保存在应用级配置中，不复制进项目或导出包。
- 模板使用普通文件复制，不使用可写硬链接。
- 后台有活动模型或提交任务时阻止项目切换；重启后恢复已选定的提交状态。

## 默认模板

当前模板为 `game-a/templates/coop-default-v1/7`。它保留本地运行、指挥官准备界面、难度、威望摘要和默认关闭的测试模式，不包含用户数值覆盖、自定义单位或历史实验玩法。

| 内容 | 模板规则 |
| --- | --- |
| GameACore、GameAIntegration | 保留本地启动和官方任务接入 |
| CommanderPreparation、PreparationOptions、MutatorSelection | 保留准备界面与用户配置 |
| TestMode | 保留，默认关闭 |
| Catalog XML | 保持无用户覆盖的默认状态 |
| Generated 修改模块 | 不随新项目继承 |
| 本地化 | 只保留当前准备界面所需文本 |
| 官方数据库和 CASC 提取文件 | 不进入模板 |

`template.json` 记录模板文件和共享宿主哈希。新建和打开项目都验证清单。桌面端打开受支持的旧版内置模板时，会先执行有前置条件和回滚保护的无损迁移，再验证当前模板；项目 core 中的数值覆盖、计划和 Receipt 会保留。开发时也可用 `scripts/project-workspaces.mjs migrate <项目目录>` 显式执行同一迁移。

## 验证

```powershell
pnpm test:projects
pnpm test:projects:local
pnpm test:ui
pnpm build
```

自动测试覆盖独立文件、A/B 连续编辑、跨项目任务与 preparation、重命名、目录移动、模板不兼容、OpenCode 会话隔离和不同工程构建。`test:projects:local` 使用本机构建数据库执行真实提交与地图构建；字段断言仍是工程值，不自动证明游戏内最终效果。

首版不包含项目删除、复制、导出、云同步或多项目同时试玩。
