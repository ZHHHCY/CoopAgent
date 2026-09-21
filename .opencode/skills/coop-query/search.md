# 共用查询速查

按当前缺口查阅，不要求顺序执行或读完全部入口。

| 所需事实 | 查询方式 |
| --- | --- |
| 对象身份 | 复用名册/会话；缺少时 entity.resolve 或 commander.get，带已知 commanderId/catalog |
| 参数或关联入口 | 普通 entity.get；objectCard.groups 为目录，entries 为当前页 |
| 当前字段值 | entity.get + 精确 path；已知多个字段用 search_batch |
| 尚未解释的字段 | objectCard.fieldsQuery（topic=fields），或该对象的已知 fieldPrefix |
| 有关的修正 | 字段的 influenceSummary / fieldInfluences；所选威望保留 prestigeUpgrade |
| 引用或消费者 | include relationships，限定方向、范围与深度 |
| 解锁条件 | requirement.explain + 已知 Requirement ID |
| 脚本中的具体疑点 | galaxy.context + 已知对象 ID 或函数名，只读查证 |
| 连续编辑 | editState；缺少历史时 patches.for_target |

## 对象卡片与精确字段

```json
{"operation":"entity.get","commanderId":"ConfirmedCommanderId","catalog":"Abil","objectId":"ConfirmedAbilityId","limit":15}
```

objectCard.entries 的 onThisObject 是本对象参数，continueVia 是关联入口，conditions 是条件。依据 meaning/fieldMeaning 选择所问参数；沿有关的 nextQuery 前进。commanderEntries 或解锁列表中的多个对象表示关联，不自动构成同一数值的多个来源。面板表确认命令入口，最终数值仍以执行关系为依据。

卡片和 commander officialFacts 提供官方基线。精确读取的 editState 提供当前工程值、可用操作和前置条件；effectiveField 补充继承与合并证据。引用来源由 sourceIndex 指向本页 objectCard.sources，alsoVia 保留其他入口。

```json
{"operation":"entity.get","commanderId":"ConfirmedCommanderId","catalog":"Unit","objectId":"ConfirmedUnitId","path":"CostResource[Minerals]","include":["effectiveField"]}
```

上例读取单位费用字段；实际生产支付价需要生产命令证据。精确 path 使用返回的完整地址和下标，不能用字典模板 []。Upgrade 操作数使用 EffectArray[n].@Value，并核对同项 Reference/Operation。available=false 限制的是所列写入操作；只读回答仍可使用已明确的事实，未解析值或冲突值不当作已确定值。

## 参数组合与分页

- 生产命令使用返回的真实 commandIndex；它筛选 InfoArray 槽位及公共字段，不提供写入隔离。default/parameters/fields 支持此筛选；分页保留 commandIndex，精确 nextQuery 已含槽位路径，不再附加它。不要从数字编号猜 TrainN/ResearchN。
- topic 不与 path、fieldPrefix、include 混用；只有 topic=influences 支持与 path 同用。group 用于普通/parameters 卡片，不与 fields、path、fieldPrefix、include 或关系图参数组合。
- nextQuery 保留规范地址和分页条件。只在所需事实尚未返回时续页；search_batch 的 shared 适用于各条结果，complete=false 表示有未交付项，按需取回。response-too-large 未交付完整证据，应缩小到相关字段/分组。
- 精确读取不加 full。fieldPrefix、显式 include 与 full 用于具体排障，旧专用视图无需与对象卡片并行遍历。

## 条件、用途与证据边界

```json
{"operation":"entity.get","commanderId":"ConfirmedCommanderId","catalog":"Unit","objectId":"ConfirmedUnitId","include":["relationships"],"direction":"incoming","relationFamily":"all","maxDepth":1,"limit":10}
```

commander.get 默认提供分组目录；需要哪组就用 topic=units / prestiges / masteries 等。只有目录条目 ID 时，用 commanderId + objectId、不填 catalog 恢复导航。P1/P2/P3 使用 primaryUpgrade；requiredUpgrades、挂载或条件引用均不证明已经激活。

influenceSummary / fieldInfluences 是相关修正证据，activation 分类不等于当前运行状态。已知会影响所问结果的条目才继续查证，不默认枚举所有候选。Upgrade 的 upgradeContext/modifierContext 区分加成量、上限与尚未求值的等级/叠加结果。

usageEvidence 区分脚本输入、脚本输出与未识别；operandUsageEvidence 描述升级操作数自身，targetUsageEvidence 描述目标字段。presentation、DisplayEffect 是展示证据；实际效果需要执行关系。reviewedRules 受 note 和版本校验约束，guard-failed 不沿用旧结论。

unknown、空列表、missing/stale/not-indexed、scanComplete=false 或覆盖不完整都不能证明不存在效果；它们本身也不要求继续查询。只有缺少本题必需事实时才沿 fieldsQuery、精确字段、有限关系或脚本回退。回答范围与证据范围一致即可，无需证明全部消费者不存在。
