import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RightPanel } from "./RightPanel";
import type { AgentController } from "../../features/agent/useAgentController";
import type { Sc2EnvironmentController } from "../../features/environment/useSc2Environment";
import type { AppliedChangeSummary } from "../commander/types";

vi.mock("./GameActions", () => ({ GameActions: () => null }));

let root: Root;
let container: HTMLDivElement;
let agent: AgentController;
const change = (
  id: string,
  text: string,
  appliedAt: string,
  values?: Pick<AppliedChangeSummary, "before" | "after" | "targets">,
): AppliedChangeSummary => ({
  id, text, kind: "patch-plan", before: values?.before ?? null, after: values?.after ?? null, field: null,
  opIds: ["array-set", "clone-weapon", "relink-unit"], targets: values?.targets ?? [], status: "changed", verified: true,
  plan: { id, title: "内部标题", path: "plan.json", receiptPath: "receipt.json", appliedAt, sha256: "hash" },
});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  agent = {
    isThinking: false, pendingPlan: null, applyPendingPlan: vi.fn(),
  } as unknown as AgentController;
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

function render(changes: AppliedChangeSummary[] = [], changeError = "") {
  act(() => root.render(<RightPanel agent={agent} changeError={changeError} changes={changes}
    environment={{} as Sc2EnvironmentController} />));
}

test("keeps all applied changes visible from oldest to newest with useful details", () => {
  render([
    change("new", "允许怨灵战机移动的时候攻击。", "2026-09-09T10:30:00+08:00"),
    change("old", "将陆战队员生命值改为 60。", "2026-09-08T09:20:00+08:00", {
      before: 45,
      after: 60,
      targets: [{
        kind: "unit", id: "Marine", label: "陆战队员", commanderId: "TerranRaynor",
      }],
    }),
  ]);
  expect(container.textContent).toContain("全部改动");
  const items = [...container.querySelectorAll(".detail-change-list > li")];
  expect(items).toHaveLength(2);
  expect(items[0]?.textContent).toContain("将陆战队员生命值改为 60。");
  expect(items[0]?.textContent).toContain("45 → 60");
  expect(items[1]?.textContent).toContain("允许怨灵战机移动的时候攻击。");
  expect(container.textContent).not.toContain("单位 · 陆战队员");
  for (const internal of ["array-set", "clone-weapon", "relink-unit", "receipt.json", "内部标题", "未试玩"])
    expect(container.textContent).not.toContain(internal);
});

test("does not use a drawer or duplicate applied-history trigger", () => {
  render([change("saved", "已写入生命值修改。", "2026-09-08T09:20:00+08:00")]);
  expect(container.querySelector(".plan-drawer-trigger")).toBeNull();
  expect(container.textContent).not.toContain("查看已写入的改动");
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("已写入生命值修改。");
  expect(container.textContent).not.toContain("数据详情");
  expect(container.textContent).not.toContain("选择一个等级升级、单位或面板技能");
});

test("failed submissions remain retryable but are not applied history", () => {
  agent.pendingPlan = { status: "error", error: "校验失败", summaryItems: ["未写入的候选"], operationCount: 99 } as AgentController["pendingPlan"];
  render();
  expect(container.querySelectorAll(".detail-change-list > li")).toHaveLength(0);
  expect(container.textContent).not.toContain("未写入的候选");
  expect(container.textContent).toContain("校验失败");
  act(() => container.querySelector<HTMLButtonElement>(".apply-button")!.click());
  expect(agent.applyPendingPlan).toHaveBeenCalledOnce();
});

test("read failures are not presented as empty successful history", () => {
  render([], "数据库未就绪");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("数据库未就绪");
  expect(container.querySelector(".detail-change-empty")).toBeNull();
});
