#!/usr/bin/env node
import path from "node:path";
import { defaultRepoRoot } from "./lib/patch-plan-executor.mjs";
import { createPlanSubmissionService } from "./lib/plan-submission.mjs";

const [operation, value, root] = process.argv.slice(2);
const service = createPlanSubmissionService({ repoRoot: root ? path.resolve(root) : defaultRepoRoot() });
try {
  let result;
  if (operation === "status") result = service.status();
  else if (operation === "recover") result = await service.recover();
  else if (operation === "cancel-run") result = service.cancelRun(value);
  else if (operation === "submit") {
    // This worker can outlive the model/UI process. A competing worker may
    // already own the same project; do not treat a busy lock as job failure.
    const deadline = Date.now() + 180000;
    while (true) {
      try { result = await service.submit({ preparationId: value, retryOnly: true }); break; }
      catch (error) {
        if (error.code !== "project-busy" || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  } else throw new Error("Usage: plan-submission.mjs status|recover|submit|cancel-run [id] [repoRoot]");
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message, code: error.code ?? "failed", details: error.submissionDetails ?? {} })}\n`);
  process.exitCode = 1;
}
