# 搜索默认提供字段影响证据

`search(entity.get)` 在已有对象/字段查询中自动附带反向影响证据。Agent 仍先确定 ID，再沿参数和关联入口查询；不增加工具或必经预检步骤，也不要求 Agent 逐个反查全部 Upgrade。

## 默认返回

- 对象参数卡片、字段卡片和原始字段页：数值项附 `influenceSummary`，包含分类数量、最多两个非研究参考候选、条件线索及 `nextQuery`。`researchReferenceCount` 单列研究参考数量，不挤占默认预览；总数和续查仍包含研究。对象卡片还提供对象级 `influencesQuery`。
- 精确字段查询：自动附 `fieldInfluences`，默认最多四项。给出目标字段、影响来源、运算声明、参数、源文件/继承来源、参数查询地址、研究入口和条件证据。
- 候选较多时，通过同一 `entity.get(topic: "influences", path: "LifeMax")` 分页；可以省略 path 浏览该对象已索引的影响。续页保留目标、指挥官、威望和字段上下文。返回体过大时缩小真实分页，不裁掉前置条件或 JSON。

卡片中的 `baselineValue` 仍是**官方基线**；`influenceSummary` 来自**当前工程 Catalog 投影**。二者不能直接相加得出游戏值，精确读取的 `editState` 才提供对应编辑层的当前参数与前置条件。`valueContext` 明确标注这个区别。

例如：

```json
{"operation":"entity.get","catalog":"Unit","objectId":"ScienceVessel","commanderId":"TerranSwann","path":"LifeMax"}
```

本机 B97579 数据中可返回 `SwannCommanderVehicleHealth` 的参数 `40`、斯旺 15 级“机械专业”关联，以及 `Upgrade/SwannCommanderVehicleHealth/EffectArray[38].@Value` 的继续查询入口。XML 没有显式声明 Operation 时返回 `null` / `default-unverified`，不凭命名或参数正负推断运算。

这表示“需要考虑这个修正”，不是“当前游戏中已经激活”或“最终生命值一定等于基础值加 40”。尤其是 Upgrade `Set` 可能覆盖此前加成：单独创建 Upgrade 或改变授予顺序都不等于保留原机制。

## 开局与玩家研究的任务边界

每个候选的 `activation` 解释授予入口；`activationCounts` 按影响记录（不是去重 Upgrade 数）统计分类，省略数量为零的分类。排序优先开局上下文，其次未知/条件入口，最后研究参考。精确结果保留 `activationVerified: false` 和 `exclusive: false`；卡片只展示分类/任务角色和紧凑条件，完整授予证据通过 nextQuery 获取。

| kind | 依据与含义 | 单位修改默认角色 |
| --- | --- | --- |
| startup-automatic | 默认升级、明确的等级/精通 Upgrade 授予字段、威望主/次级自动授予，或已应用工程生成配置的开局意图 | startup-context；核对开局数值，条件尚未求值 |
| player-research | 当前 CAbilResearch 命令指向该 Upgrade，或模板直接子级有此入口 | reference-only；默认保留，不要求适配研究后结果 |
| mixed | 同时发现相关自动授予和研究入口 | 保留两类证据，不认定只能研究获得 |
| conditional-automatic | 威望补充效果还依赖其他 Upgrade | unresolved-context；不能直接算作开局已激活 |
| unknown | 只有名字、导航关联、挂载 Behavior 或未覆盖来源 | unresolved-context；不猜时机、不强迫遍历全图 |

**用户修改单位时，默认验收指定指挥官/威望下开局、未进行局内研究的数值。** 玩家主动研究是另一个可感知对象，默认保留原样；研究后联动可以作为后续“改升级”任务。研究里即使有 Set，也只是参考，不形成额外提交障碍。用户明确要求研究后效果或联动修改时，才纳入本次范围。

授予识别不是对所有等级天赋链接的一刀切：`CampaignPerk.Upgrade` 会授予科技，而 `AbilityCommand` 是允许研究/技能命令，人工 `reviewed-partial-mechanism` 也只是导航；后两者不能证明开局自动升级。`UpgradeOff` 不当作授予。主威望及 `SecondaryUpgradesSelf/Shared` 与需要前置科技的 supplements 分开，Shared 保留可能影响盟友的证据。

自动规则经本机 B97579 `libCOOC_gf_CC_ApplyTech`、`ApplyCommanderTech`、`EnableDisableCampaignPerk`、`ApplyMasteryTech`、`PlayerPrestigeEnable` 路径核对，受数据 build 限制；其他 build 不复用该时机判断。规则不执行脚本，不证明当前 Game A 一定成功调用、所选等级/精通/威望已满足。工程计划只证明生成配置的意图，不能掩盖已经发现的威望启动时序问题。

研究入口使用当前字段再次核对并要求对象类为 `CAbilResearch`，清空/重定向的入口不沿用旧引用。不同指挥官的 self-only 自动授予不用于把当前指挥官的研究归为自动，盟友共享授予则仍保留。模板只看有界直接子级；继承组合和授予来源排他性依旧未证明。

## 数据来源与边界

读取现有 SQLite 的反向引用索引，并用同一连接上的当前 Game A 字段再次核对引用和参数。删除、改写、重新定向后不沿用旧引用值；不需要重建数据库。历史计划仅补充生成 Upgrade 的作用域和来源，不作为当前参数值的依据。

初版覆盖：

- Upgrade `EffectArray.Reference` 对精确 Catalog / ID / 字段的直接引用。仅有 `AffectedUnitArray` 的展示关联不算字段修正。
- 指挥官档案已解析的等级、威望、精通关联及当前工程已应用计划的条件。保留未知和其他指挥官候选，不把传入 commanderId / prestigeUpgrade 当作激活证明。
- Unit 已挂载 Behavior 中生命、护盾、能量上限/回复的部分 Vital 修正字段。
- Upgrade 模板与直接子级的区分；提供具体研究命令入口，避免把模板 ID 当作可以直接授予的升级。

明确**不覆盖完整运行时求值**：外部光环/动态 Buff、Galaxy 脚本、所有继承数组组合、研究状态、激活顺序、Behavior 层数以及所有属性的 Behavior 映射。候选条件也不是完整触发逻辑。返回始终包含未覆盖范围，`runtimeEvaluated: false`、`runtimeValue: null`、`coverage.complete: false`；空列表不证明不存在影响。

候选列表、模板子级和研究入口有界；总数只表示发现的候选，不表示游戏全部机制。反向扫描达到上限时 `totalIsLowerBound: true`；局部条件/研究入口截断也会显式标记。需要进一步证据时沿候选对象的 `nextQuery` 查询，不因此遍历全图。

## 验证范围

离线回归覆盖默认附带、精确字段匹配、模板/研究入口、未知运算、条件非激活、分页、Behavior 覆盖、当前 XML 更新与重定向、连续提交后最新参数以及官方数据库不变。引擎中的 Set/Add 冲突和威望启动时序问题并未在本改动中修复；这层负责提前暴露证据，不替代机制验收。
