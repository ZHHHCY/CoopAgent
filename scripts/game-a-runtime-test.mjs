#!/usr/bin/env node

import { createCoopAgentCore } from "../runtime/coop-mcp/lib/coop-agent-core.mjs";

function parseArguments(values) {
  const parsed = { command: "start", hostId: undefined, runId: undefined, startupTimeoutMs: 30_000 };
  const args = [...values];
  if (args[0] === "start" || args[0] === "status") parsed.command = args.shift();
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--host") parsed.hostId = args.shift();
    else if (flag === "--run") parsed.runId = args.shift();
    else if (flag === "--timeout") parsed.startupTimeoutMs = Number(args.shift());
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!Number.isInteger(parsed.startupTimeoutMs) || parsed.startupTimeoutMs < 5_000 || parsed.startupTimeoutMs > 60_000) {
    throw new Error("--timeout must be an integer from 5000 to 60000 milliseconds.");
  }
  return parsed;
}

try {
  const input = parseArguments(process.argv.slice(2));
  const core = createCoopAgentCore();
  const result = input.command === "status"
    ? await core.runtimeTestStatus({ runId: input.runId })
    : await core.startRuntimeTest({ hostId: input.hostId, startupTimeoutMs: input.startupTimeoutMs });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (error?.details && Object.keys(error.details).length > 0) {
    process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
  }
  process.exitCode = 1;
}
