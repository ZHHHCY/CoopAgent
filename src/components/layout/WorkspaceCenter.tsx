import { Database, MessageSquareText } from "lucide-react";
import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { AgentController } from "../../features/agent/useAgentController";
import type { Sc2EnvironmentController } from "../../features/environment/useSc2Environment";
import type { ChangeIndicatorSnapshot } from "../../changeIndicators";
import type { CommanderInspectionSelection } from "../commander/types";
import { CommanderDetailInspector } from "../commander/CommanderDetailInspector";
import { CommanderWorkspace } from "../commander/CommanderWorkspace";
import { ChatPanel } from "../chat/ChatPanel";
import "./WorkspaceCenter.css";

type Props = {
  agent: AgentController;
  changeIndicators: ChangeIndicatorSnapshot;
  environment: Sc2EnvironmentController;
};

type WorkspaceView = "agent" | "database";
const MIN_DATABASE_SPLIT = 25;
const MAX_DATABASE_SPLIT = 75;

function clampDatabaseSplit(value: number) {
  return Math.min(MAX_DATABASE_SPLIT, Math.max(MIN_DATABASE_SPLIT, value));
}

export function WorkspaceCenter({ agent, changeIndicators, environment }: Props) {
  const [view, setView] = useState<WorkspaceView>("agent");
  const [inspection, setInspection] = useState<CommanderInspectionSelection>(null);
  const [databaseSplit, setDatabaseSplit] = useState(55);
  const databaseWorkspaceRef = useRef<HTMLDivElement>(null);
  const draggingSplitRef = useRef(false);

  function resizeDatabaseFromPointer(event: PointerEvent<HTMLButtonElement>) {
    if (!draggingSplitRef.current || !databaseWorkspaceRef.current) return;
    const bounds = databaseWorkspaceRef.current.getBoundingClientRect();
    if (bounds.height <= 0) return;
    setDatabaseSplit(clampDatabaseSplit(((event.clientY - bounds.top) / bounds.height) * 100));
  }

  function handleSplitKey(event: KeyboardEvent<HTMLButtonElement>) {
    const delta = event.shiftKey ? 10 : 3;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setDatabaseSplit((current) => clampDatabaseSplit(current - delta));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setDatabaseSplit((current) => clampDatabaseSplit(current + delta));
    } else if (event.key === "Home") {
      event.preventDefault();
      setDatabaseSplit(MIN_DATABASE_SPLIT);
    } else if (event.key === "End") {
      event.preventDefault();
      setDatabaseSplit(MAX_DATABASE_SPLIT);
    }
  }

  return (
    <section className="workspace">
      <nav aria-label="工作区" className="workspace-tabs" role="tablist">
        <button
          aria-controls="workspace-agent-panel"
          aria-selected={view === "agent"}
          className={view === "agent" ? "is-active" : ""}
          id="workspace-agent-tab"
          onClick={() => setView("agent")}
          role="tab"
          type="button"
        >
          <MessageSquareText size={14} />
          CoopAgent
        </button>
        <button
          aria-controls="workspace-database-panel"
          aria-selected={view === "database"}
          className={view === "database" ? "is-active" : ""}
          id="workspace-database-tab"
          onClick={() => setView("database")}
          role="tab"
          type="button"
        >
          <Database size={14} />
          数据库
        </button>
      </nav>

      <div
        aria-labelledby="workspace-agent-tab"
        className="workspace-view"
        hidden={view !== "agent"}
        id="workspace-agent-panel"
        role="tabpanel"
      >
        <ChatPanel active={view === "agent"} agent={agent} environment={environment} />
      </div>

      <div
        aria-labelledby="workspace-database-tab"
        className="workspace-view"
        hidden={view !== "database"}
        id="workspace-database-panel"
        role="tabpanel"
      >
        <div
          className="database-workspace"
          ref={databaseWorkspaceRef}
          style={{ "--database-upper": `${databaseSplit}%` } as CSSProperties}
        >
          <div className="database-workspace-browser">
            <CommanderWorkspace
              agentReady={environment.agentReady}
              projectRevision={agent.projectRevision}
              changeIndicators={changeIndicators}
              onInspectSelection={setInspection}
              sc2RootPath={environment.status?.rootPath}
            />
          </div>
          <button
            aria-label="调整数据库列表与对象详情的高度"
            aria-orientation="horizontal"
            aria-valuemax={MAX_DATABASE_SPLIT}
            aria-valuemin={MIN_DATABASE_SPLIT}
            aria-valuenow={Math.round(databaseSplit)}
            className="database-workspace-splitter"
            onKeyDown={handleSplitKey}
            onLostPointerCapture={() => { draggingSplitRef.current = false; }}
            onPointerDown={(event) => {
              draggingSplitRef.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              resizeDatabaseFromPointer(event);
            }}
            onPointerMove={resizeDatabaseFromPointer}
            onPointerUp={(event) => {
              resizeDatabaseFromPointer(event);
              draggingSplitRef.current = false;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
            role="separator"
            type="button"
          ><span /></button>
          <section aria-label="对象详细信息" className="database-workspace-detail">
            <CommanderDetailInspector selection={inspection} />
          </section>
        </div>
      </div>
    </section>
  );
}
