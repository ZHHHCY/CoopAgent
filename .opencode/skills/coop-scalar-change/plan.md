# 数值计划速查

字段、条件与作用范围明确后，把 PatchPlan v2 直接传给 plan_prepare.plan，无需写文件。复杂配套或具体诊断按 docs/patch-plan.md 与对应 Schema 处理。

## 计划形状

以下仅示意结构，占位内容均需替换；operations 使用 scalar_solve 返回的操作：

```json
{"formatVersion":2,"id":"descriptive-plan-id","title":"用户要求的数值变化","target":"game-a.core","compatibility":{"sc2DataBuild":"BUILD_FROM_QUERY","runtimeContract":2},"userSummary":{"text":"旧值到新值及范围"},"scope":{"kind":"commander","commanderId":"CONFIRMED_ID"},"isolation":{"strategy":"player-upgrade"},"dependsOn":[],"conflictsWith":[],"operations":[]}
```

id 使用唯一 kebab-case；operations 非空，各项 opId 唯一。保留工具返回的操作内容、commanderId/prestigeUpgrade 与真实 expect。dependsOn 合并所有 requiredDependsOn 并去重。

## 作用范围

| 实现 | scope/isolation |
| --- | --- |
| 全部操作为 commander.stat.set | 声明实际 commander scope；可用 player-upgrade |
| 直接改私有 Catalog 字段 | 根据消费者证据声明范围，direct-private 的 owner 为真实 catalog/object |
| 混合或局部隔离 | 按完整契约描述直接改动及配套，各 commander.stat.set 保留自身条件；不套用仅适用于全玩家操作的策略 |

commanderId 不自动隔离 Catalog。必要的隔离、引用和条件配套放在同一原子计划，不为凑策略更换目标或漏交操作。

## 提交与连续编辑

每个交付轮只选定一份最终计划，提交前可预检修订。独立要求可先交付自洽子集，其他项记录为遗漏。plan_prepare 的 prepared 表示准备完成；将最终 preparationId 交给 plan_submit 后，以后台状态判断是否 applied。

预检失败按具体诊断修正目标、条件或语法。request-binding-mismatch 要回到原请求核对指挥官、对地/对空条件及明确的激活时序，不能换成 global 或其他目标规避。后续用户反馈开启新轮，从当前工程继续并依赖先前应用结果。

核对本轮应用结果；结果缺失或矛盾才重读有关字段。只有全部请求项均已满足时才整体交付 no_change。Receipt 证明源文件应用，静态及游戏验证分别记录。
