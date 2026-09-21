# 合作模式数据库 v2

合作模式数据库是 CASC 只读输入与 PatchPlan 之间的查询层。底层保存通用 SC2 对象图；指挥官只是面向 Agent 的投影视图，不是物理存储的顶层结构。

## 构建与输出

双击仓库根目录的 `构建合作模式数据库.cmd`，或运行：

```bat
scripts\casc-database.cmd build
```

默认输出到 `%LOCALAPPDATA%\CoopAgent\database\<SC2 build>`：

```text
coop.sqlite          通用对象图和 Agent 查询数据
merged/GameData      PatchPlan 执行器兼容的合并 Catalog
manifest.json        SC2 build、来源哈希和依赖顺序
build-report.json    统计、警告和雷诺/休伯利安验收结果
```

构建采用临时目录，全部成功后才替换同 build 的旧数据库。Coop MCP 会按照 Game A 的 SC2 build 自动发现该目录；`COOPAGENT_CATALOG_ROOT` 仍可显式覆盖。

当前构建规则记录 `catalogProjectionVersion=3` 和 `packageProfile=official-coop-expansions-v2`。旧数据库需要重新构建才能使用新规则；SQLite 结构版本仍为 2。合作模式使用扩展/战役数据包，不再把 LibertyMulti、SwarmMulti、VoidMulti 对战分支拼进同一基线。包顺序是内置的合作模式配置，`dependency_basis` 如实记录其来源，不冒称完整解析了官方 DocumentInfo 依赖图。

Upgrade 的 EffectArray 在扁平化前先解析父数组布局：显式 index 覆盖对应槽位，没有 index 的记录从继承数组末尾追加。查询表和 `merged/GameData` 使用一致的实际下标，字段仍保留各自的来源和继承关系。移除项保留在直接 XML 中，避免丢失对父项的删除声明。不能把旧数据库下标机械地搬到新计划中，应重新按 Reference 定位并核对 expect。

同一标量字段在不同依赖中使用属性和 `<字段 value="..."/>` 两种写法时，后加载的写法覆盖旧写法；同一定义内同时出现的冲突保留为未解析，不能猜值。已有引擎回归覆盖 5 个 Upgrade 的完整数组及护盾字段，其他字段仍属于解释式投影，不因此获得全库引擎验证。

## SQLite 结构

| 表 | 用途 |
|---|---|
| `packages` | 官方依赖包及加载顺序 |
| `source_files` | 输入文件、大小和 SHA-256 |
| `catalog_definitions` | 每次原始对象定义和覆盖 |
| `catalog_objects` | 按依赖顺序合并后的直接对象 |
| `catalog_fields` | 处理类默认值和 parent 继承后的有效字段，附来源证据 |
| `object_references` | Unit、Abil、Effect、Behavior、Weapon 等对象引用 |
| `localized_text` | 按依赖顺序合并后的本地化键值 |
| `galaxy_files` / `galaxy_symbols` | Galaxy 源文件和函数符号索引 |
| `commanders` | `CCommander` 到 `PlayerCommanders` 的 Agent 入口 |
| `commander_profiles` | 按建筑/单位、15级特性、威望、精通和面板组织的指挥官语义档案 |
| `commander_membership` | 指挥官关联对象及证据、图距离 |
| `search_index` | 对象与指挥官全文检索 |

同一对象的有效字段同时记录 `source_file`、`origin_object_id` 和 `inheritance_depth`，因此 Agent 可以解释某个值来自哪个依赖、哪个父对象，而不只返回最终数字。

## 查询入口

```bat
scripts\casc-database.cmd commander "%LOCALAPPDATA%\CoopAgent\database\B97579\coop.sqlite" TerranRaynor
scripts\casc-database.cmd object "%LOCALAPPDATA%\CoopAgent\database\B97579\coop.sqlite" Unit HyperionVoidCoop
scripts\casc-database.cmd search "%LOCALAPPDATA%\CoopAgent\database\B97579\coop.sqlite" Hyperion
```

仓库诊断层仍保留 `commanders_for_unit`：输入精确的 Unit Catalog ID，可以检查将该单位
列入语义阵容的指挥官、英雄/建筑/普通阵容关系及证据。它不再作为 Agent 的平级选择；
日常制作先通过 `commander.get` 确认阵容，再用 `impact.analyze` 判断共享影响。

Agent 使用 `entity.get` 在同一张通用对象图上获取对象字段和受限关系，不为 Train、Weapon
或 Effect 分别建立专用工具。输入精确的 `catalog` 与 `objectId`，再用 `direction`、`maxDepth`、
`minConfidence` 和 `limit` 控制范围；`relationFamily` 可选 `all`、`creation`、`abilities`、
`combat`、`behaviors`、`upgrades` 或 `visuals`。返回内容包括：

- 带 class、parent 和来源文件的节点；
- 保留原始字段路径与置信证据、并标注 `trains`、`uses_ability`、`uses_weapon`、
  `runs_effect` 等语义的边；
- 从起点出发的无环证据路径；
- 可选的指挥官直接/依赖归属证据；
- `includeFields: true` 时，引用所在结构的有效相邻字段及继承来源。

例如从 `Unit/SCV` 以 `creation`、`incoming`、深度 2 查询，可以同时得到
`SCV <- CommandCenterTrain <- CommandCenter`，并在 `InfoArray[Train1]` 的上下文中得到
制造时间字段；从任意 Unit 以 `combat`、`outgoing` 查询则沿 Weapon 和 Effect 继续追踪。

面向 Agent 的第一阶段查询链为：`commander.resolve/get` → `entity.resolve/get` → 按需调用
`impact.analyze` / `requirement.explain` / `galaxy.context` → 写计划前调用 `patches.for_target`。
这些接口分别回答“用户说的是哪个对象”“当前继承后值是什么”“修改会沿哪些 Catalog 引用传播”
“条件结构是什么”“官方 Galaxy 中有哪些定义和源码引用”和“过去哪些计划已经写过同一目标”。`impact.analyze` 只提供 Catalog 证据，
不会把缺少证据误报成“敌人一定不用”；`requirement.explain` 只解释逻辑，不评估某局游戏中
玩家当前是否满足条件；`galaxy.context` 的引用是有界词法命中，不冒充完整调用图。

引用构建器会识别 `Effect -> Effect` 链、Requirement wrapper/逻辑节点/Count/Allow 的强类型引用，
以及 Upgrade 中形如 `Unit,Marine,LifeMax` 的数据引用。`object_references.evidence` 对数据引用
保留目标字段路径。无 `index` 的重复 XML 子项仍以 `[#n]` 作为数据库查询序号，
`entity.get` 的精确字段结果会明确标记这类路径不可直接写入 PatchPlan。

## v2 边界

- 合作模式依赖不仅包含 `Mods/*`。数据库还必须按依赖顺序加载
  `Campaigns/LibertyStory.SC2Campaign`、`Liberty.SC2Campaign`、
  `SwarmStory.SC2Campaign`、`Swarm.SC2Campaign`、`VoidStory.SC2Campaign` 和
  `Void.SC2Campaign` 的 Catalog 数据；例如雷诺兵营的 `Train5 -> Medic` 与
  `Train6 -> Firebat` 就定义在这些战役层中。
- 无 `index` 的重复数组项在数据库路径中用 `[#0]`、`[#1]` 表示来源顺序；这是一种查询记号，不直接作为 PatchPlan 路径。
- `commander_profiles` 按 UserData 的值类型解析链接；字段名、数字、文本和图片路径不会通过裸 ID 碰撞建立 Catalog 归属。`commander.get` 默认返回建筑/单位、等级特性、威望、精通和面板的紧凑概览；传入 `detailLevel: "full"` 时复用桌面 UI 的单位投影，补充基础属性、武器、可见技能和指挥官强化，但仍不直接返回无界内部引用链。
- 指挥官概览以官方 `CCommander` 的 `UnitArray`、`TalentTreeArray`、`PrestigeArray`、`MasteryTalentArray` 和 `CommanderAbilArray` 为主结构，再用 UserData 补实际游戏单位 ID、施法单位与面板命令；这也覆盖不使用经典 `TechUnit`/`CampaignPerk` 布局的后期指挥官。
- `commander_membership` 以语义档案中的类型化 Catalog 链接作为强证据种子，再沿高置信度引用图扩展；对象 ID 中仅包含指挥官英文名不能建立归属关系。依赖对象不进入 `commander.get` 概览，Agent 在调查具体机制时再按需查询。
- Galaxy 索引保存官方文件与函数符号；`galaxy.context` 可返回受限定义片段、词法引用和片段中
  实际出现的 Catalog ID。脚本控制流与运行时语义分析仍留到后续阶段。
- 依赖顺序以 Allied Commanders 的 StarCoop 直接依赖和编辑器中的资料片依赖链为依据，并写入 manifest；发现新的官方依赖时必须更新构建器，而不是静默猜测。
- 蒙斯克与斯台特曼的数据位于 `Mods/StarCoop/Commanders` 下的独立包；数据库在 StarCoop 之后、Allied Commanders 之前加载这些包。

每次构建都会用 `TerranRaynor`、`HyperionVoidCoop` 和 `VoidCoopSummonHyperion` 做真实数据验收，结果记录在 `build-report.json`。
