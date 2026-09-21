#!/usr/bin/env node

import path from "node:path";

import {
  defaultRepoRoot,
  executePatchPlan,
  PatchPlanError,
} from "./lib/patch-plan-executor.mjs";

function usage() {
  return `Usage:
  pnpm patch-plan <plan.patch-plan.json> [--check] [--catalog-root <GameData>]

Options:
  --check                 Validate and build in a temporary workspace without writing.
  --catalog-root <path>   Merged co-op GameData directory produced from the CASC database.
  --expected-plan-sha256 <hash>  Bind the bytes read under the project lock.
  --json                  Print the result as JSON.
  --help                  Show this help.
`;
}

function parseArguments(argv) {
  const result = { check: false, json: false, catalogRoot: null, planPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check") result.check = true;
    else if (value === "--json") result.json = true;
    else if (value === "--help" || value === "-h") result.help = true;
    else if (value === "--catalog-root") {
      index += 1;
      if (index >= argv.length) throw new PatchPlanError("--catalog-root requires a path");
      result.catalogRoot = argv[index];
    } else if (value === "--expected-plan-sha256") {
      result.expectedPlanSha256 = argv[++index];
      if (!/^[a-f0-9]{64}$/i.test(result.expectedPlanSha256 ?? "")) throw new PatchPlanError("Expected a SHA-256 hash");
    } else if (value.startsWith("-")) {
      throw new PatchPlanError(`Unknown option: ${value}`);
    } else if (result.planPath) {
      throw new PatchPlanError(`Unexpected argument: ${value}`);
    } else result.planPath = value;
  }
  return result;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (!options.planPath) throw new PatchPlanError(`A PatchPlan path is required.\n\n${usage()}`);

  const repoRoot = defaultRepoRoot();
  const report = await executePatchPlan({
    repoRoot,
    planPath: options.planPath,
    check: options.check,
    expectedPlanSha256: options.expectedPlanSha256,
    catalogRoot: options.catalogRoot ? path.resolve(repoRoot, options.catalogRoot) : process.env.COOPAGENT_CATALOG_ROOT,
  });
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    const changed = report.operations.filter((operation) => operation.status === "changed").length;
    const already = report.operations.length - changed;
    console.log(`PatchPlan ${report.mode} passed: ${report.id}`);
    console.log(`Operations: ${report.operations.length} (${changed} changed, ${already} already satisfied)`);
    if (report.changedFiles.length > 0) console.log(`Core files: ${report.changedFiles.join(", ")}`);
    if (report.planRecorded) console.log(`Recorded: ${report.planRecord}`);
    if (report.receiptRecorded) console.log(`Receipt: ${report.receiptRecord}`);
  }
} catch (error) {
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ error: {
    message: error.message, details: error.details ?? [], review: error.review ?? null,
  } })}\n`);
  const prefix = error instanceof PatchPlanError ? "PatchPlan failed" : "Unexpected failure";
  console.error(`${prefix}: ${error.message}`);
  for (const detail of error.details ?? []) if (detail) console.error(`  ${detail}`);
  if (!(error instanceof PatchPlanError) && error.stack) console.error(error.stack);
  process.exit(1);
}
