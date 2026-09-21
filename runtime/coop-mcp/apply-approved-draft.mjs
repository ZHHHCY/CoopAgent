#!/usr/bin/env node

import { createCoopAgentCore } from "./lib/coop-agent-core.mjs";

const [planPath, approvedPlanSha256] = process.argv.slice(2);
const normalizedPlanPath = planPath?.replaceAll("\\", "/");
const draftPattern = /^game-a\/drafts\/[a-z0-9]+(?:-[a-z0-9]+)*\.patch-plan\.json$/;
const sha256Pattern = /^[0-9a-fA-F]{64}$/;

if (!normalizedPlanPath || !draftPattern.test(normalizedPlanPath)) {
  console.error("Only checked game-a/drafts/<id>.patch-plan.json files can be applied from the desktop UI.");
  process.exit(1);
}
if (!approvedPlanSha256 || !sha256Pattern.test(approvedPlanSha256)) {
  console.error("A valid approved PatchPlan SHA-256 is required.");
  process.exit(1);
}

try {
  const result = await createCoopAgentCore().applyPatchPlan({
    planPath: normalizedPlanPath,
    approvedPlanSha256,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const details = [error?.details?.stderr, error?.details?.stdout]
    .filter(Boolean)
    .join("\n");
  if (/EPERM: operation not permitted, rename .*GameA\.SC2Mod/i.test(details)) {
    console.error("无法替换整个 GameA.SC2Mod 目录；请更新 CoopAgent 后重试。当前执行器不应再使用目录级替换。");
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    if (details) console.error(details);
  }
  process.exit(1);
}
