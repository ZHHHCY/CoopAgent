# 数据库重构：原始索引 + 引擎基线 + 当前工程

状态：2026-09-06，第一阶段已实现并接入本机数据库。**这是分层查询和增量导入的落地，不是全库引擎导出已完成。**

## 现在的职责分配

| 层 | 负责什么 | 当前实现 |
| --- | --- | --- |
| CASC 原始索引 | XML 定义、来源、依赖顺序、本地化、Galaxy；保留追溯和编辑依据 | 原表保留；旧字段解释是未观察部分的兼容来源 |
| SC2 引擎基线 | 官方依赖实际加载后的字段、数组和字段类型描述 | 独立探针采集到本地，再事务导入 SQLite |
| 当前 Game A | 本地覆盖、克隆对象、已应用计划、指挥官 Upgrade | 在引擎/兼容基线上叠加现有当前工程投影 |

查询优先级是：**当前 Game A 修改 > 引擎观察到的基线字段 > 旧解析器解释的未观察字段**。这不是把三个 JSON 简单合并：完整数组观察需要去掉被引擎删除的旧槽位，引用边也要同步替换。

UI 和 Agent 仍走现有共享查询层，不新增一个要求模型自行选择的 MCP 工具。构建/刷新缓存需要本机 SC2；读取已导入的数据库不需要 SC2 或编辑器运行。当前构建入口不会自动启动探针，采集和导入通过下述命令显式进行。

## 落地形式

`scripts/lib/engine-catalog-store.mjs` 提供统一导入与读取适配器。原数据库 `schemaVersion=2` 保持兼容，新增 `engineCatalogVersion=1` 扩展：

- `engine_snapshots`：采集上下文、来源指纹、运行日志和快照身份。
- `engine_queries`：当前生效的字段/数组观察范围及原生结果。
- `engine_schema_fields`：SC2 返回的字段类型描述。
- `engine_objects`：有引擎字段观察的对象清单。
- `engine_resolved_fields`、`engine_resolved_references`：观察值与未观察旧字段组合成的可重建读索引。

读取时用连接级 TEMP view 统一提供基线，再叠加 Game A；不修改原始表。MCP 查询、UI 单位详情、当前工程制品读取、静态 review 和改动摘要共用这条读取路径。每次查询持有数据库读事务，避免一次查询拼出导入前后两个版本。

已覆盖字段会标识 `valueSource=sc2-engine` 和 `snapshotId`；当前工程字段标识 `game-a-projection`，兼容字段标识 `legacy-interpreted`。数据库元数据还报告 `coverage=partial`、已观察对象/字段数量以及未观察部分的来源。

引擎返回的是加载结果，不是原始 XML 的作者位置。兼容表里的 `origin_object_id` 和 `inheritance_depth` 不能作为引擎值的原始继承证据；精确查询明确返回 `inheritanceKnown=false`，来源解释为 `sc2-loaded-catalog`。

导入在一个事务里更新快照、覆盖范围、字段与引用；失败整批回滚。同一身份和内容重复导入是幂等的，同一身份却不同内容会拒绝。已观察数组不能用后续单个标量观察悄悄替换，需重新采集完整数组。

引用优先通过引擎 schema 中明确的 CatalogLink 类型解析；Requirements 等原生包装类型使用少量显式适配，并验证目标对象存在。未知类型不靠子串猜成引用。未采集到的引用和指挥官归属仍可能来自旧索引，不宣称已重建完整关系图。

## 如何使用

以下命令在仓库根目录用 PowerShell 运行。默认数据库位置在本机 AppData，不在仓库里。

### 1. 采集

```powershell
.\.tools\node\node.exe scripts/sc2-catalog-probe.mjs run
```

默认仍是实验中的小批量样本。可用 `--sc2 "D:\StarCraft II"` 指定安装目录，用 `--queries "C:\local\queries.json"` 指定查询数组，例如：

```json
[
  { "id": "wraith-weapons", "kind": "array", "catalog": "Unit", "entry": "Wraith", "field": "WeaponArray", "member": "Link" },
  { "id": "blink-cooldown", "kind": "value", "catalog": "Abil", "entry": "Blink", "field": "Cost[0].Cooldown.TimeUse" },
  { "id": "blink-schema", "kind": "schema", "catalog": "Abil", "entry": "Blink" }
]
```

仅指定查询路径，不包含分发的官方导出数据。目前每批 1–512 个查询；数组最多 256 项，单层 schema 最多 1024 字段，超限不能作为完整快照导入。已支持 Unit、Abil、Weapon、Effect、Behavior、Upgrade、Requirement、Validator、Actor、Model、Button 这几类查询入口；**不等于这些类型的所有字段都已验证**。

探针只采官方依赖、玩家 0、未初始化任务/指挥官、未加载 Game A 的基线。它会拒绝干扰已有游戏；成功后只结束自己启动的探针游戏。

### 2. 导入已有数据库

建议重要数据库先保留一致性备份。将 `<run-id>` 换成采集命令输出的 ID：

```powershell
$dbFile = "$env:LOCALAPPDATA\CoopAgent\database\B97579\coop.sqlite"
$cacheFile = "$env:LOCALAPPDATA\CoopAgent\catalog-probe\<run-id>\cache.json"
.\.tools\node\node.exe scripts/casc-database.mjs import-engine $dbFile $cacheFile
.\.tools\node\node.exe scripts/casc-database.mjs engine-status $dbFile
```

可连续传入多个缓存文件；每个文件各自事务提交，不保证多个文件共同全有或全无。快照必须与数据库 CASC 来源/build 匹配，运行日志不得有 error，并且所有查询完整返回。不同安装/运行上下文不能混入同一引擎基线。

### 3. 随新数据库构建导入

```powershell
.\.tools\node\node.exe scripts/casc-database.mjs build --engine-cache $cacheFile
```

`--engine-cache` 可重复。先在临时数据库建立原始索引，再导入匹配的缓存，通过后才安装构建产物。不带此参数仍构建兼容数据库；重新构建不会隐式保留上次导入的快照，需要显式传入对应缓存。

游戏数据版本变化时重新构建并重新采集。数据库、缓存、Bank、导出文件和备份全部只留本机，不纳入 Git 或发行包。

## 本机实测结果

导入快照 `f5939714-4617-4177-b1d0-59eefe3f661f`：

- 5 个对象、11 个字段/数组查询、23 个实际字段值。
- 另外 3 个 schema 查询，覆盖 4 个 scope、344 个字段描述。**344 不是已验证的游戏数值数量。**
- 幽灵战机：两把武器 `WraithA`、`WraithG`；四个技能 `stop`、`attack`、`move`、`WraithCloak`。补回旧投影遗漏的数组项及对应引用。
- 闪现：冷却字段 `Cost[0].Cooldown.TimeUse` 唯一解析为引擎值 `8`，不再同时保留旧投影中的冲突候选。
- 另外覆盖 `StukovInfestedBacklashRockets`、`ZealotPurifierReviveCorpse`、`CorsairMPDisruptionWeb` 的指定样本字段。

实际客户端版本为 `5.0.15.97579 / B97579`；安装与旧库元数据的版本字符串是 `5.0.16.97579`。两者分别记录。原实验的 10 条依赖警告保存在快照日志，不因导入而隐去。

本机导入前使用 SQLite 一致性备份保存到：

`%LOCALAPPDATA%\CoopAgent\database-backups\B97579-before-engine-20260906.sqlite`

导入后 `quick_check=ok`。原定义 157,930 条、原字段 5,697,656 条、原引用 604,418 条、来源文件 2,066 条，数量均与备份相同；5 个覆盖对象的原字段与备份双向比较无差异。没有更改 Game A 内容。

回归验证：MCP/Agent、当前工程叠加、UI 数据辅助函数、导入、数据库、探针、执行器和事务测试合计 97 项通过。其中包括空数组删除、上下文错配回滚、重复导入、引擎/执行器不一致、Game A 直接覆盖，以及父对象修改时的保护。测试使用合成数据，不随测试分发提取的官方数据。这些不是新一轮真实模型任务或游戏试玩验收。

## 尚未完成的边界

1. **全库/常用对象批量采集器**：当前支持自定义批次，但尚未实现安全递归枚举、自动分批、吞吐量验证与覆盖率面板。不能删掉旧解析器。
2. **执行器编辑语义对齐**：`merged/GameData` 仍是旧的作者侧 XML 解释，不是引擎导出的可编辑 XML。引擎读值和执行器解释不一致时，不生成虚假的 `expect`，而是令编辑入口不可用。例如当前 Blink 冷却能正确读到 8，但该路径的执行器前置值仍未解决，不能据此声称已可安全修改。
   字段/数组上的旧 `patchable` 标志只表示路径和槽位格式可用于补丁，不是执行许可；是否已有可执行前置值必须看 `editState.edit.available` / `catalogEdit.available`，最后仍需执行器预演校验。
3. **本地继承变化**：直接字段覆盖可以叠加；若 Game A 改了某个已观察对象的父对象/default，无法仅凭基线快照证明传播后的值。当前会警告并阻止受影响对象生成编辑操作，不能把旧快照当作新工程的确定值。
4. **动态上下文**：不包含指挥官初始化、等级、威望、精通、研究、Buff 后的完整实际值，也未替代 Galaxy 机制分析、Actor 运行态或完整本地化读取。
5. **派生搜索与归属索引**：全文搜索、指挥官目录/归属还保留旧派生来源；目前替换的是字段和对应引用的读取基线，不是所有索引重建。

下一步应先把受限批量导出覆盖到回归任务使用的对象和字段，并解决这些样本的作者侧编辑地址/前置值对齐，再扩展到全体合作模式对象。暂不增加 Agent 工具或让模型承担缓存选择、合并与来源判断。
