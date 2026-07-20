import { PanelRightOpen, PanelRightClose, PanelLeftOpen, Plus } from "lucide-react";
import { useAppStore } from "@grok-gui/core";
import { cn } from "./lib/utils";
import { t } from "./i18n";

export function TopBar() {
  const session = useAppStore((s) => s.session);
  const workbenchVisible = useAppStore((s) => s.workbenchVisible);
  const setWorkbenchVisible = useAppStore((s) => s.setWorkbenchVisible);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const connection = useAppStore((s) => s.connection);
  const setScreen = useAppStore((s) => s.setScreen);
  const newTask = useAppStore((s) => s.newTask);
  const language = useAppStore((s) => s.settings.language);
  const tr = (key: Parameters<typeof t>[1]) => t(language, key);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-4">
      {sidebarCollapsed && (
        <button
          type="button"
          title={`${tr("expandSidebar")} (⌘B)`}
          onClick={() => setSidebarCollapsed(false)}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <PanelLeftOpen size={15} />
        </button>
      )}
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="truncate text-[13px] font-semibold text-foreground">
          {session?.title || tr("newTask")}
        </h2>
        {session?.workspace && session.workspace !== "~" && (
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            · {session.workspace}
          </span>
        )}
      </div>
      <div className="ml-auto flex items-center gap-1">
        <span
          title={
            connection.state === "connected"
              ? tr("agentConnected")
              : connection.state === "connecting"
                ? tr("agentConnecting")
                : (connection.detail ?? tr("agentDisconnected"))
          }
          className="mr-1 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[10px] text-muted-foreground"
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              connection.state === "connected" && "bg-emerald-500",
              connection.state === "connecting" && "animate-pulse bg-amber-500",
              (connection.state === "disconnected" || connection.state === "error") && "bg-red-500",
              connection.state === "idle" && "bg-muted-foreground",
            )}
          />
          {connection.state === "connected" ? tr("connected") : connection.state === "connecting" ? tr("connecting") : tr("disconnected")}
        </span>
        <button
          type="button"
          title={`${tr("newTask")} (⌘N)`}
          onClick={() => {
            setScreen("chat");
            void newTask(session?.workspace);
          }}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Plus size={16} />
        </button>
        <button
          type="button"
          aria-pressed={workbenchVisible}
          title={`${workbenchVisible ? tr("hideWorkbench") : tr("showWorkbench")} (⌘⇧W)`}
          onClick={() => setWorkbenchVisible(!workbenchVisible)}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          {workbenchVisible ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </button>
      </div>
    </header>
  );
}
