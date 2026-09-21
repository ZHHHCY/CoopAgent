# 本机合作模式语义层 v6：统一解释器与对象读模型

发行内容只有解析规则、Schema 和工具，不包含生成的单位资料、技能文本、价格表或预建数据库。数据由用户本机合法安装的 SC2 提取数据库生成，保存在同一个本地 coop.sqlite 的 `coop_semantic_*` 派生表中。Game A 核心、CASC 文件和原始数据库表不被修改。

## 构建与更新

v6 将旧数值/执行引用规则合入统一解释器；MCP 默认返回一张 objectCard，生产槽位也采用同一读模型。旧缓存目录/效果图保留给兼容、派生索引和显式排障，不作为每个对象的默认返回。升级需本机 reindex；字段清单同步为 v2。

此前 v5 新增[通用字段字典](field-vocabulary.md)：全量枚举当前库已出现的字段模板，常见字段附通用说明，未知项不省略。`entity.get(topic=fields)` 按任意对象 ID 读取字段说明与引用入口；精确字段查询附 fieldMeaning。旧目录保留，不把二级当作遍历终点。升级需本地 reindex，不重新提取 CASC。

新数据库的 `casc-database.mjs build` 自动生成语义层。已有数据库无需重新提取 CASC：

```powershell
node scripts/casc-database.mjs reindex-semantics <本机coop.sqlite路径>
node scripts/casc-database.mjs entity-facts <本机coop.sqlite路径> TerranHorner HHRaven production
```

派生表通过单个 SQLite savepoint 原子替换，失败回滚；同一基线和规则版本重复构建产生相同记录。记录独立语义版本和原始 meta 指纹。规则升级需提升 COOP_SEMANTIC_VERSION；官方基线视为不可变，更新应走数据库构建流程，不支持绕过构建直接编辑源表。Game A 修改不影响官方基线缓存。

旧库无索引或版本不匹配时，查询明确返回 missing/stale，不偷偷在查询中写数据库。已有数据库需先运行上述维护命令；初版未添加桌面端自动迁移。

v4 增加真实威望映射、ArmyCategory.Unit 导航及人工核对规则，需重建一次派生索引；仍不重新提取 CASC。v3 的 `coop_semantic_commanders`、v2 的 `coop_semantic_details` 和 Unit directory 保留。构建时也沿显式 Morph 目标生成形态单位目录，Morph 扩展受单个指挥官 128 个单位的边界限制，未覆盖的单位仍可正常读原始字段。

## v4 缺口补充与边界

威望不再把展示 ID 直接当成 Upgrade。解析 `User/PlayerCommanders → PlayerPrestige.PrimaryUpgrade` 及 `PlayerPrestigeUpgradeSupplements` 的真实引用，保留展示 id、primaryUpgrade、来源证据和补充升级的 requiredUpgrades。查询上下文与计划校验只接受实际的主 Upgrade；歧义、缺失映射不得退回展示别名。补充升级的关联不证明研究已完成或运行时叠加已经求解。

`scripts/lib/coop-reviewed-links.mjs` 保存 50 条人工核对的等级导航规则，只包含 ID、关系和解释，不包含提取的数值、技能文案或数据库。规则绑定指挥官、等级条目及 B97579；检查展示对象与目标存在性，指定命令的规则还核对实际 Upgrade/Unit 关联。其他版本或校验失败标记 guard-failed，不应用这些补充链接。存在性校验不是完整语义证明，因此成功也仅标记 applied-partial，note 说明具体覆盖的子机制。另由真实 ArmyCategory.Unit 字段补充 7 个等级条目的单位入口。

新增复活能力 BaseInfo 时间/资源、命令充能数量、Behavior 队列参数的数值定位。例如斯台特曼 15 级相关 Behavior 是被等级条件移除的队列限制，保留 RemoveValidator 条件和方向说明，不能理解为升级后新增限制。混合多个效果的 Upgrade 只提供候选字段，不授权整包修改。

2026-09-11 本机 B97579 重建后：18 个指挥官目录、430 条 Unit/形态/施法者记录、2,121 份对象详情。以下是静态入口覆盖，不是机制正确率：

| 分组 | 条目数 | 至少一个预解析效果入口 | 全部显式效果入口已有详情 |
| --- | ---: | ---: | ---: |
| 等级解锁 | 270 | 270 | 222 |
| 威望 | 54 | 54 | 54 |
| 精通 | 108 | 108 | 108 |
| 面板能力 | 76 | 76 | 76 |
| 面板展示特性 | 54 | 0 | 0 |
| 默认升级 | 51 | 50 | 50 |
| 研究命令候选 | 1,033 | 1,033 | 1,024 |

原先无入口的 57 个等级条目和 13 个威望均已接上至少一个效果入口；等级条目仍可能只覆盖一个子效果，48 项仍有显式缺失或未支持目标。54 个面板展示特性和缺失的 HHSuperRadar 默认 Upgrade 保持未解析，不伪造替代对象。完整运行时解析数仍为 0。

146 项自动测试通过，覆盖 typed UserData 映射、人工规则版本/对象/命令校验、幂等、威望上下文及计划保护和原有查询/提交回归。本机另外检查 1,164 个等级/威望/精通目标查询，验证雷诺实际威望主 Upgrade 下的字段读取、斯台特曼队列移除条件与泰凯斯复活参数。数据库 quick_check=ok，Game A 核心哈希未变。未运行新的真实 LLM 对照或游戏试玩；重启已连接的 MCP 进程以加载新规则。

## v3 指挥官总目录与逐项覆盖

全部 profile 单位/建筑、等级解锁、威望、精通、面板能力/展示特性/施法者、默认升级成为独立入口，不再以“是否碰巧被某个单位的修正链找到”为前提。额外索引显式 profile Unit 链接和面板施法者。研究候选从这些资料及已索引单位的 CAbilResearch.InfoArray.Upgrade 提取；保留实际命令槽位与 Upgrade 目标，不根据名字推断关联。该候选集含共享研究命令，不是已验证的指挥官可用研究清单。

commander.get.officialFacts 返回分组摘要及 nextQuery，一级不展开所有条目。沿 nextQuery 用 entity.get(catalog=Commander, objectId=真实 Commander ID, commanderId, topic) 分页读取，每项 targets 带原始关联证据、存在状态、是否已有详情、缺口与可执行 nextQuery。topic 可选 units/buildings/forms/levelPerks/prestiges/masteries/panelAbilities/panelTraits/panelCaster/defaultUpgrades/research。已知等级/精通/威望条目 ID 的无 catalog entity.get 也会带回对应覆盖记录。

覆盖分为三个互不替代的指标：

- coverage.navigation：显式效果入口存在情况，resolved/partial/unresolved；展示 Button/Talent 不作为效果入口。
- coverage.allEffectTargetsIndexed：至少一个显式效果入口，且所有显式效果入口都有预建详情；不包括展示对象，不说明参数或运行时正确。
- coverage.status：当前部分结构解析为 partial，没有可预解析效果入口为 unresolved；目前没有任何条目被标成已完整运行时解析的 resolved。coverage.gaps 保留缺失对象、展示替身、未支持类型、参数缺失、默认 Operation、图边界等问题。

profile 数值型 commandIndex 与真实 InfoArray 槽位不是同一概念。目录保留前者作证据，不将 0 猜成 Research1/Execute；只有字段里实际存在的精确字符串键才进入 nextQuery.commandIndex。研究目录由实际字段取槽位，可以直接查询该命令时间/费用，再读取 Upgrade 数值参数。

所有记录在同一重建事务内保存；查询不写库。missing/stale 回退保留，v2 索引不会冒充 v3。Galaxy、指挥官初始化、临时 Buff、默认值和组合效果仍未求解；未知条目完整列出，不会静默删除，也不宣称运行时实体全集已枚举。

## 初版覆盖

- 指挥官 profile 的单位/建筑名册身份和别名；展示替身未解析时明确标记。
- Unit 的费用、人口、生命/护盾上限及初始值、护甲、能量和移动速度等已存在的 Catalog 字段，保留字段地址和下一步查询；未找到的字段不填零。
- Train/WarpTrain 的 InfoArray 命令、显式资源费用、训练时间、单位列表和 Requirement 引用。
- 实际 Unit.AbilArray 生产者关系；不把 TechTreeProducedUnitArray 展示关系当扣费依据。
- Unit → Behavior.InitialEffect → Effect.Set → Effect.CreateUnit 的有限生成链，保留 SpawnCount、来源和未验证的执行次数。
- 单位挂载的 Abil、命令卡名称/入口、直接费用/冷却字段、Effect 和 Requirement 入口；Behavior 单独标注，不假定每个都是玩家技能。
- 武器数组处理显式覆盖与继承序号，目录保留隐藏标记和目标过滤条件，不按名称后缀猜替代武器。技能命令卡、内部能力、被动展示入口及 Behavior 候选分组，不能视为均已解锁。
- 二级 Abil/Weapon/Behavior/Effect 详情沿已支持的 Effect、Impact、Set、Area/Case、Persistent、ApplyBehavior 等结构读取数值 owner。显示用 DisplayEffect 不当执行依据；保留条件引用、缺失节点和边界，不推断总伤害/DPS。每个根限制 64 节点、8 层深度、256 条边，达到边界会标记。
- Upgrade.EffectArray 的目标字段、Operation、Value 参数地址，以及 profile 明确记录的等级/威望/精通关联。Unit 专题仅返回与当前单位、挂载能力/Behavior、生产能力直接相关的候选，不等于完整影响闭包；v3 指挥官目录则独立索引所有明确 profile 效果入口。

## 查询与修改契约

Agent 首先通过 entity.resolve 或 commander.get 确认 catalog + objectId；已有明确 ID 直接复用。预解析层不负责名称匹配或替 Agent 选目标。

统一读取入口为 `search(operation="entity.get", commanderId, catalog="Unit", objectId)`。MCP 返回 objectCard.entries：本体参数、相关对象、条件。单位目录只补充名称和专用入口，融合成同一列表，不并排返回旧属性。字段 nextQuery 精确读取，链接 nextQuery 进入下一张卡片。

武器/技能/行为/升级仍使用同一卡片，不自动返回多跳 effectGraph。分页统一为 objectCard.nextQuery / nextOffset；topic=fields 切换完整字段视图。生产 commandIndex 在两种视图及翻页中保持，仅保留选定槽位与公共字段。内部旧 object-details 仍可读，缓存数值和引用含义来自同一通用解释器。

默认 MCP 在读取之前选择卡片路径，避免生成无关原始字段和子项效果图。UI 和显式 full/include 原始读取保留；精确 path/fieldPrefix 查询不展开目录。旧 Unit topic=production/abilities/modifiers 保留为诊断/扩展入口，不与 path/fieldPrefix/include 合用。officialFacts 始终不替代当前 Game A fields/editState。

已移除独立 semantic.get 操作，内部读取也只接受精确 objectId。officialFacts 不套用 Game A 或引擎观测临时视图；missing/stale/not-indexed 不阻止原有字段/关系读取，不会偷偷替换目标。二级预构建覆盖一级目录关联的对象；未索引的对象回退原始 ID 读取，不增加平行名称查询接口。

费用条目区分“显式生产命令费用”和“Unit 的 Catalog 数值”，不把缺失当零、不擅自假定引擎费用回退规则。生成效果的 SpawnCount 不自动证明每次购买的最终数量。挂载技能不证明已解锁，底层冷却不证明完整冷却机制。

这里是有证据的部分解析，不是所有状态的游戏模拟器。未求解 Galaxy、指挥官初始化、动态 Buff、引擎默认和多修正激活/叠加顺序；未知不是零、无效果或不受影响。Operation 缺失也保留未知，不猜 Add。原始 Tooltip 不是公式求解器。

语义层给出数值 owner 和参数候选，不输出可直接提交的 PatchPlan，不取代作用域/共享隔离判断。需要修改时，用返回地址读取 entity.get/scalar_solve 的当前 Game A 快照，获取真实 expect/条件，再走原有预检和提交。基础值、升级效果和条件下最终值是不同意图，不能默默替用户选择。没有改动 scalar_solve 的计算覆盖范围。

## 验收

合成测试覆盖生产与普通同名对象隔离、批量生成链、能力入口、显式缺失值、Upgrade 参数、分页、旧库/旧版本回退、原子失败和重复构建。真实本机库检查只生成本地派生索引，不将索引导出进仓库。构建/查询成功不等于完整 query 正确率或游戏运行验收。

2026-09-11 初版构建验证：语义层、数据库构建、引擎缓存兼容及现有 MCP 测试合计 106 项通过。本机 B97579 生成 244 条名册实体、568 条生产目标关系、23,403 条 Upgrade 引用（含共享/非合作候选，不是已验收的合作效果数量）。构建约 4～6 秒。另验证语义层 Upgrade 参数可接到 entity.get 的有效编辑地址。数据库 quick_check 为 ok，Game A 核心哈希未变。后续入口调整为上述 ID 优先流程，派生表格式不变，无需为接口调整重建索引。

尚未重跑 20 问真实 Agent 对照，因此暂不宣称 token 或正确率改善。旧版本已连接的 MCP 进程需重新启动后才能加载新查询 Schema。

ID 优先入口回归：108 项测试通过。补充验证 entity.get 自动携带同一 ID 的 officialFacts、精确字段查询不展开、旧库仍可读取，以及独立 semantic.get 被拒绝；本机铁鸦和解放者的 ID 查询保留原有生产事实。

## v2 两级查询验收（2026-09-11）

- 116 项自动测试通过，包括继承武器覆盖、Area 效果覆盖、跨 Behavior 数值定位、显示引用隔离、循环/分页、生产命令选择、形态目录、威望上下文沿 nextQuery 保留，以及旧查询/执行器兼容。
- 本机重建生成 387 条单位/形态记录和 1,170 份对象详情，仍只保存在本机数据库。
- 检查一级目录中 7,259 个可执行查询入口：目标均存在，所有形态目标都有目录。此检查证明导航存在，不证明全部技能可用或条件正确。
- 真实 search 接口走通晋升者 Unit → AscendantWeapon → AscendantWeaponDamage.Amount，并读取到有效的当前字段前置值。一级返回约 8,777 字符，二级约 6,128 字符；不含模型推理/token 对照。
- 本机数据库 quick_check 为 ok，Game A 核心未变。没有运行新的 20 问真实 Agent 对照或启动游戏。

边界仍然存在：目录列出的是有证据的静态关联；隐藏武器可能不是实际输出伤害的武器，继承/研究/初始化/脚本仍可能改变有效对象。官方目录不能作为“当前引用完全未变”的证明。写入前继续读取当前字段、核对作用域和有效引用；没有通过自动改名或猜替代对象消除这些缺口。

## v3 补充验收（2026-09-11）

119 项自动测试通过。增加独立 profile 根、完整条目计数、缺失/展示入口保留、研究槽位隔离、分页、晚期事务回滚、重复构建和 MCP 指挥官 → 分组 → 子项的回归。

本机 B97579 派生索引生成 18 个指挥官总目录、403 条 Unit 记录（包括 16 个面板施法者及形态，不是 403 种兵种）和 1,958 份二级详情。总目录共 2,039 条记录，校验 3,558 个存在的目标查询、1,023 个真实研究槽位查询；所有列出的条目均经过分页读取。缺失目标不返回无效 nextQuery。

| 分组 | 纳入清单 | 有至少一个预解析效果入口 | 全部显式效果入口已有详情 |
| --- | ---: | ---: | ---: |
| 威望 | 54 | 41 | 41 |
| 精通 | 108 | 108 | 108 |
| 等级解锁 | 270 | 213 | 182 |
| 面板能力 | 76 | 76 | 76 |
| 面板展示特性 | 54 | 0 | 0 |
| 默认升级 | 51 | 50 | 50 |
| 研究命令候选 | 1,023 | 1,023 | 1,014 |

以上均非运行时正确率。13 个威望仍缺对应可预解析入口，57 个等级条目无预解析入口；另有部分条目只解析了其中几个目标。54 个面板特性仅有展示入口，不能当成无效果。研究数按指挥官/能力/命令/目标统计，含共享候选，并非独立研究数或确认可用数。

按上一轮“至少一个 Upgrade 详情”的同口径，威望从 25/54 增至 41/54，精通从 41/108 增至 108/108，等级解锁从 38/270 增至 117/270；等级中其他条目可以使用 Abil 等类型入口，不能仅以 Upgrade 缺失判断遗漏。

真实接口验证指挥官目录 → 威望分组 → Upgrade 详情 → 精确 @Value 查询，得到可用的当前 Catalog expect=8。数据库 quick_check=ok，Game A 核心哈希未变。未运行新的真实 LLM 对照或游戏内验收；已连接的 MCP 进程需重启加载新 Schema。
