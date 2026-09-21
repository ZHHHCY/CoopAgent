import { createAgentObserver } from "../../runtime/coop-mcp/lib/agent-observer.mjs";
import { composeAgentHooks, createAgentHarnessAdapter } from "../../runtime/coop-mcp/lib/agent-harness-adapter.mjs";

export default async function CoopTrace() {
  return composeAgentHooks(createAgentObserver(), createAgentHarnessAdapter());
}
