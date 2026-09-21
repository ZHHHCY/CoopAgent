import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AgentController } from "../../features/agent/useAgentController";
import type { Sc2EnvironmentController } from "../../features/environment/useSc2Environment";
import { WorkspaceCenter } from "./WorkspaceCenter";
import type { CommanderInspectionSelection } from "../commander/types";

vi.mock("../chat/ChatPanel", () => ({
  ChatPanel: ({ active }: { active: boolean }) => <div data-active={String(active)}>对话内容</div>,
}));
vi.mock("../commander/CommanderWorkspace", () => ({
  CommanderWorkspace: ({ onInspectSelection }: {
    onInspectSelection: (selection: CommanderInspectionSelection) => void;
  }) => <button onClick={() => onInspectSelection({ kind: "unit", unit: {} } as CommanderInspectionSelection)}>
    数据库内容
  </button>,
}));
vi.mock("../commander/CommanderDetailInspector", () => ({
  CommanderDetailInspector: ({ selection }: { selection: CommanderInspectionSelection }) => (
    selection ? <div data-testid="database-detail">单位详细信息</div> : null
  ),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(
    <WorkspaceCenter
      agent={{ projectRevision: 0 } as AgentController}
      changeIndicators={{} as never}
      environment={{ agentReady: true } as Sc2EnvironmentController}
    />,
  ));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("the center workspace switches between full chat and database panels", async () => {
  const [agentTab, databaseTab] = [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")];
  const agentPanel = container.querySelector<HTMLElement>("#workspace-agent-panel")!;
  const databasePanel = container.querySelector<HTMLElement>("#workspace-database-panel")!;

  expect(agentTab.ariaSelected).toBe("true");
  expect(agentPanel.hidden).toBe(false);
  expect(databasePanel.hidden).toBe(true);
  expect(agentPanel.firstElementChild?.getAttribute("data-active")).toBe("true");

  await act(async () => databaseTab.click());
  expect(databaseTab.ariaSelected).toBe("true");
  expect(agentPanel.hidden).toBe(true);
  expect(databasePanel.hidden).toBe(false);
  expect(agentPanel.firstElementChild?.getAttribute("data-active")).toBe("false");

  expect(databasePanel.querySelector(".database-workspace-detail")).not.toBeNull();
  const splitter = databasePanel.querySelector<HTMLButtonElement>('[role="separator"]')!;
  expect(splitter.getAttribute("aria-valuenow")).toBe("55");
  await act(async () => splitter.dispatchEvent(new KeyboardEvent("keydown", {
    bubbles: true,
    key: "ArrowDown",
  })));
  expect(splitter.getAttribute("aria-valuenow")).toBe("58");
  expect(databasePanel.querySelector<HTMLElement>(".database-workspace")?.style
    .getPropertyValue("--database-upper")).toBe("58%");
  expect(container.textContent).not.toContain("单位详细信息");
  await act(async () => databasePanel.querySelector<HTMLButtonElement>(".database-workspace-browser button")!.click());
  expect(databasePanel.querySelector('[data-testid="database-detail"]')?.textContent).toBe("单位详细信息");
});
