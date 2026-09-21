// Observer-only report audit. Includes failed tool calls and sealed delivery
// metadata; host run.text can contain only the opening progress message.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function auditParameterRun(result, events, { negative = false } = {}) {
  const calls = new Map();
  for (const [index, event] of events.entries()) if (['agent.tool.completed', 'agent.tool.failed'].includes(event.event)) {
    const detail = event.details;
    calls.set(detail.toolCallId ?? `event-${index}`, { ...detail, timestampMs: event.timestampMs, terminalEvent: event.event });
  }
  const deliveryRecord = events.findLast(event => event.event === 'task.delivery.saved')?.details?.checkpoint ?? null;
  const audited = { ...result, calls: [...calls.values()], deliveryRecord };
  audited.toolCount = audited.calls.length;
  audited.errors = audited.calls.filter(call => call.terminalEvent === 'agent.tool.failed' || call.error || call.output?.status === 'error');
  audited.writerEvidenceSeen = audited.calls.some(call => {
    const output = JSON.stringify(call.output);
    return output?.includes('VoidShardACDeathGripDamageDummy') && output.includes('script-output');
  });
  if (negative) {
    const text = JSON.stringify(deliveryRecord);
    audited.controlsPass = result.initialCoreHash === result.finalCoreHash && Boolean(result.finalCoreHash);
    audited.pass = audited.controlsPass && audited.writerEvidenceSeen && /脚本|触发器|运行时/.test(text)
      && /覆盖|写入|计算/.test(text) && /不能|无法|不支持|未修改|没有修改/.test(text);
  }
  return audited;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directories = process.argv.slice(2).map(p => path.resolve(p));
  if (!directories.length) throw Error('Supply result directories; corrected observer-only reruns come last.');
  const runs = new Map(), sources = [];
  for (const directory of directories) {
    const data = JSON.parse(await fs.readFile(path.join(directory, 'results.json'), 'utf8'));
    sources.push({ directory, model: data.model, provenance: data.provenance });
    for (const result of data.results) {
      const key = result.profile + '/' + result.id;
      if (!result.tracePath) { if (!runs.has(key)) runs.set(key, result); continue; }
      const events = (await fs.readFile(result.tracePath, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
      runs.set(key, auditParameterRun(result, events, { negative: result.id === 'runtime-output' }));
    }
  }
  const results = [...runs.values()];
  const totals = Object.fromEntries(['workflow', 'parameters'].map(profile => {
    const positive = results.filter(r => r.profile === profile && r.id !== 'runtime-output');
    return [profile, { pass: positive.filter(r => r.pass).length, count: positive.length,
      elapsedMs: positive.reduce((sum, r) => sum + (r.elapsedMs ?? 0), 0),
      tools: positive.reduce((sum, r) => sum + (r.toolCount ?? 0), 0),
      tokens: positive.every(r => typeof r.usage?.recordedTotals?.total === 'number') ? positive.reduce((sum, r) => sum + r.usage.recordedTotals.total, 0) : null }];
  }));
  const output = directories[0];
  await fs.writeFile(path.join(output, 'acceptance.json'), JSON.stringify({ sources, totals, results }, null, 2));
  const rows = results.map(r => `| ${r.id} | ${r.profile} | ${r.pass ? '通过' : '未通过'} | ${r.elapsedMs == null ? '—' : (r.elapsedMs / 1000).toFixed(1)} | ${r.toolCount ?? '—'} | ${r.errors?.length ?? '—'} | ${r.usage?.recordedTotals?.total ?? '—'} |`);
  await fs.writeFile(path.join(output, 'comparison.md'), `# 参数接口对照验收\n\n模型：${sources[0].model}。每项每种配置各一次，未启动游戏。\n\n| 样本 | 配置 | 静态结果 | 秒 | 工具调用（含失败） | 失败调用 | 总 token（含缓存） |\n| --- | --- | --- | ---: | ---: | ---: | ---: |\n${rows.join('\n')}\n\n5 个修改样本合计：旧入口 ${totals.workflow.elapsedMs / 1000} 秒、${totals.workflow.tools} 次工具调用、${totals.workflow.tokens} token；参数入口 ${totals.parameters.elapsedMs / 1000} 秒、${totals.parameters.tools} 次、${totals.parameters.tokens} token。\n\n原始首批负例在调用模型前被观察者错误要求“可编辑”而挡住，保留在 results.json；修正只读负例验收后单独补跑。负例要求核心哈希不变、模型实际读到 script-output 证据、交付记录说明具体缺口；不计为成功修改公式。\n\n工具数包含失败调用并按 call ID 去重。交付判断读取 task.delivery.saved 的结构化记录；run.text 可能只有开场进度，不能当作完整最终答复。原始轨迹与原始结果不覆盖。代码、数据库和初始工程指纹见 acceptance.json.sources。\n\n收益主要体现在协议与 token 成本；冷却样本的新入口更慢且导航出错更多，不能宣称所有请求都会加速。当前比较是整体实验配置替换，包含提示与工具变化；单次样本不足以证明稳定性能改善。Receipt 和独立工程字段断言只证明静态写入，未做游戏验证。\n`);
  console.log(JSON.stringify({ output, totals, results: results.map(r => ({ id: r.id, profile: r.profile, pass: r.pass })) }));
}
