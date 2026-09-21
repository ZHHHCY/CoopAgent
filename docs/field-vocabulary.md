# 通用字段词典 v2 与统一对象卡片

## 职责

- 本机 SQLite 保存可重建的 Catalog 对象、字段、继承、引用、来源及派生清单。
- field-vocabulary.mjs 是通用字段解释的唯一规则源：类型、标签、单位、引用角色。旧缓存详情与对象视图共用 describeField / referenceTarget，不再各维护数值和执行引用正则。
- object-parameters.mjs 只是该解释器的筛选视图；单位专用目录补充技能名称、形态、生产与已知升级入口，不承担另一套字段解释。
- 当前值、作用域、计算和写入许可仍由精确查询、scalar_solve 和执行器负责。

清单按 Catalog + 具体类 + 路径模板归类；[] 只用于清单键，真实读取保留下标和大小写属性。未知字段仍标 unknown，documented 不证明完整运行时行为。CEffectUserData.Amount 不再沿用旧规则的“伤害”解释。

## Agent 接口

普通 entity.get 与 topic=parameters 返回一个 objectCard，不再并排返回 officialFacts、parameterGuide、fieldGuide。

```json
{"operation":"entity.get","catalog":"Unit","objectId":"HHRaven","commanderId":"TerranHorner","limit":30}
```

objectCard.entries 按 section 区分本体参数 onThisObject、相关对象 continueVia、条件 conditions。字段候选保留 baselineValue、meaning、准确 path/sourcePath、来源和精确 nextQuery；来源按本页 sources 去重，sourceIndex 指向完整来源记录；链接保留 typed target、名称、角色、证据及一个规范 nextQuery。单位专用生产、形态、升级入口合入同一列表，不重复附送数值属性或预展开效果图。

topic=fields 是同一卡片的完整字段视图（mode=fields），entries 包含未知字段、原始 value、meaning、来源、准确地址与引用目标。两种视图均用 total / offset / nextOffset / nextQuery 分页。指挥官分组与明确请求的旧专用视图保留兼容。

生产 commandIndex 同时支持默认、parameters、fields；保留选定 InfoArray 槽位和公共字段，排除其他槽位。翻页保留条件与命令；精确 nextQuery 的 path 已包含槽位，不再携带 commandIndex。公共字段仍可能影响其他命令，选择槽位不是写入隔离。

精确 path 查询不展开卡片，返回 fieldMeaning 和当前 editState。官方基线、引擎/工程覆盖不混为一个值。数组继承的显式覆盖替代同槽位旧序号引用；##id## 在引用目标中按当前对象展开，不猜缺失对象。

## 查询成本与边界

参数视图一次读取最多 5,000 个轻量字段，解释并筛选后，只对当前输出页补充来源、名称和目标查证；不再每 100 个字段构造一份完整 fieldGuide。Upgrade 同槽位 Reference / Operation 使用路径索引，不逐字段重复全表扫描。

单位挂载与多个命令卡指向同一个 Abil 时，只返回一个目标查询，alsoVia 保留其他命令、路径和来源，生产 commandIndex 不跨槽位合并。

没有跨查询隐藏缓存；每次读取仍受来源/版本检查。超界时 scanComplete=false，fieldsQuery 指向余下字段；空列表不表示没有可改值。缺失/过期索引明确报告并提供原始字段回退，读取不会写数据库。源字段分页和参数分页分别计数，不可混用 offset。

整库统计留在状态/维护入口，不随普通对象返回。原始 SQL、旧效果详情和兼容视图不删除，但不再是默认 Agent 浏览路径。prepare / submit 的真实前置条件、原子性与重新校验不因精简而放松。

## 构建与维护

语义索引 v6、字段清单 v2；升级后需本机重建派生索引，然后重启 MCP。仅重建派生数据，不修改原始 Catalog 或 Game A。

```powershell
node scripts/casc-database.mjs reindex-semantics <本机coop.sqlite>
node scripts/casc-database.mjs field-vocabulary <本机coop.sqlite> Unit 0 30
```

规则、解析器和结构可以打包；提取值、对象清单和预建数据库不进仓库或发行包。语义/词典构建使用原子事务，独立词典重建有 savepoint，失败恢复旧清单。

历史 v1 在 B97579 枚举 6,784 个模板、解释 602 个。v2 补充明确的区域半径、行为修正、属性变化等规则，同时保留类不匹配的 unknown；最新数量由本机清单生成，不将旧数量当作当前覆盖率。
