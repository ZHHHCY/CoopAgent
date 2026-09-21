# scalar_solve 计算速查

模型选择目标、字段含义、条件与范围；工具读取当前工程、计算写入值并求解已支持的修正链。

- changes 最多 32 项；每项传 commanderId、target（catalog/objectId/path）、transform（kind/value），有指定威望时传真实 prestigeUpgrade。
- kind 支持 set/add/subtract/multiply/divide/increase-percent/decrease-percent。例如降低 25% 用 decrease-percent 25。
- basis=current 为默认，采用工具支持的当前工程及所选威望修正；用户明确要求基础字段时用 basis=catalog。basis 不提供共享隔离。
- meaning=number 为普通数值；damage-reduction-percent 表示减伤百分数，bonus-percent 表示已确认的比例加成，supply-cost 表示人口消耗。按字段含义选择，攻速与攻击间隔方向不同。
- 直接修改升级加成时读取 Upgrade 的 EffectArray[n].@Value 及同项 Reference/Operation。条件后的最终值只在工具支持该修正链时反解。
- roundingDecimals 仅用于明确需要舍入的情况；无法精确表达时保留诊断。

复用返回的 operation、expect、value、path、requiredDependsOn 与代入检查，只按需调整 opId。already-at-target 仅免除该项写入；unsupported 是具体表达缺口。未知条件不按零处理，不靠切换 basis、删除 prestigeUpgrade 或改写计算结果使方案通过。题面旧值与当前值不符时说明差异。
