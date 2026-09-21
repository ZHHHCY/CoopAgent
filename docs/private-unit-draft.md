# 私有单位草稿准备

这是已有 `coop_patch_plan_write` 的一个输入模式，不是新 MCP 工具、PatchPlan v3 或自动应用入口。代码承担可机械确定的编写工作；模型仍负责玩法参数、选择作用域/入口以及特殊兼容设计。

## 输入

以下是虚构 ID；真实调用使用本机数据库确认的对象。

```json
{
  "privateUnit": {
    "id": "private-example-ship",
    "title": "修改示例战舰",
    "summary": "仅修改指定指挥官的示例战舰攻击周期。",
    "commanderId": "ExampleCommander",
    "sourceUnit": "ExampleShip",
    "sourceActor": "ExampleShipActor",
    "redirects": [
      {"catalog": "Abil", "objectId": "ExampleTrain", "path": "InfoArray[Train1].Unit[0]"}
    ],
    "changes": [
      {"catalog": "Weapon", "objectId": "ExampleWeapon", "path": "Period", "value": 0.75}
    ]
  }
}
```

- `redirects` 是模型选定的真实产生入口，来自 `impact.analyze.creationRewires`（位于 isolation.ownerEntrypoints）；不自动接入所有敌方/其他来源。
- `sourceActor` 必须是实际 `CActorUnit`，不是根据 Unit 同名猜测。
- `changes` 可省略：先保存 Unit/Actor/生产替换基础，再补机制研究。字段使用源对象 ID，程序生成私有对象映射。
- 有多条 Unit 到依赖的路径时，返回候选；在该 change 中用 `ownerPath: [{catalog, objectId, path}, ...]` 明确选择一条。不默认取第一条，也不克隆整个图。
- `unitId` / `actorId` 可指定；省略时按计划 ID、指挥官、Catalog 和源 ID 生成稳定名称。
- 已有本地私有单位或目标 ID 冲突时不重复克隆，转为检查/编辑已有方案。

## 产物与后续修改

一次当前工程查询快照内读取前置值和关系，生成普通 PatchPlan v2：

- `commander.unit.clone`：私有 Unit、物化 Actor、名称/模型绑定以及选定的玩家限定生产替换。
- `catalog.clone` / `catalog.set`：处理选定、路径明确且可读取前置条件的变化依赖。
- `dependsOn`、`scope`、`isolation` 和 `unit.clone` 后置条件。

结果包含实际 `plan`、`planPath`、`mapping`、`unresolved` 和 `review.obligations`。立即保存到 `game-a/drafts`，不修改核心、不预检、不生成 Receipt。

后续可用同一 id/root 选项再次调用 `privateUnit`，追加已确认且不冲突的操作；已有操作、标题、额外契约和手写 Galaxy 保留。相同操作幂等，生成操作与已有目标冲突则拒绝，不覆盖设计。改值、删除、重排或更换创建入口时，用 `coop_patch_plan_write({plan: 完整草稿对象})` 明确修订同一文件。

每次 helper 报告对应本次选定变化，不能覆盖前次尚未解决的兼容事项，也不声称分析了所有手写操作。最终检查对象始终是完整草稿。

形成有用的可试玩候选后即可交给 `coop_plan_prepare`，然后显式 `coop_plan_submit`；不要求首版解决所有兼容问题。未完成和待验证项继续保留并如实说明，后续根据用户反馈迭代。编写辅助不改变执行器语义或强制校验，也不授权自动启动游戏。

## 检查边界

`review.obligations` 按改变的对象身份列出未处理引用：升级、条件、表现事件和其他消费者。私有消费者自身仍可能带有旧 ID，不能因为它也被克隆就忽略。共享且未变的对象不用重复检查所有属性，但其对旧身份的引用仍需处理。

关系按消费者分组，最多返回 32 组，每组最多 4 个路径，超出则标记截断；具体缺口用 `impact.analyze` 展开。Actor 的 On/Macro 表达式可能不在引用图中，所以另保留针对变化身份的 `specialChecks`，不能把空图当成“没有事件兼容问题”。它不自动证明所有升级、动态 Galaxy、英雄生命周期或游戏效果保持一致，也不自动创建升级镜像。行为请求中，字段写入成功不代表行为已实现。

依赖链跨到另一个 Unit 或额外的 CActorUnit 时不会只克隆数据而遗漏它的独立表现/生命周期，改为返回明确缺口，交由显式配套计划处理。

克隆 Ability 时另返回命令卡绑定检查：`AbilCmd` 是含命令名的复合字符串，不能仅换 AbilArray 就声称技能按钮已接通。当前 helper 不自动完成这类配套。

不可读字段或路径歧义保留为 `unresolved`，不会编造 expect。核心创建入口或源 Actor 不成立则停止准备。`draftOnly` 永远不是完成证明。
