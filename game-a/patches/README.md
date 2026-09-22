# Map Runtime Patch Plans

用户确认并由执行器应用的 PatchPlan 保存在此目录，文件名为 `<id>.patch-plan.json`。

- 格式遵循 [`docs/patch-plan.md`](../../docs/patch-plan.md)。
- 新计划使用 [`patch-plan-v2.schema.json`](../../docs/schemas/patch-plan-v2.schema.json)；执行器继续接受冻结的 v1 Schema。
- 计划与其生成到 `core/GameA.SC2Mod` 的可运行源码一同进入 Git。
- 正式应用同时生成 `<id>.receipt.json`，记录计划、操作目标和核心文件前后哈希。
- 新计划把一条用户级改动摘要写在 `userSummary.text`；不能改变哈希的历史计划由 `user-summaries.json` 按 `planId` 关联人工摘要。
- 示例只放在 `docs/examples`，不能当作已应用计划。

当前休伯利安修改早于 PatchPlan 执行器，仍属于手工生成的稳定基线；完成完整等价计划和回归测试前，不在此伪造一份“已应用”记录。

执行入口：

```bat
scripts\patch-plan.cmd path\to\change.patch-plan.json --check
scripts\patch-plan.cmd path\to\change.patch-plan.json
```
