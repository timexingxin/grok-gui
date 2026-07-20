import { Diff, FileCode2, ListChecks, TerminalSquare, GitBranch, RefreshCw } from "lucide-react";
import { useAppStore, type WorkspacePanel as Panel } from "@grok-gui/core";
import { cn } from "./lib/utils";
import { t } from "./i18n";

function tabs(language: "zh-CN" | "en-US"): Array<{ id: Panel; label: string; icon: typeof Diff }> {
  const local = (zh: string, en: string) => language === "en-US" ? en : zh;
  return [
    { id: "changes", label: local("变更", "Changes"), icon: Diff },
    { id: "files", label: local("文件", "Files"), icon: FileCode2 },
    { id: "terminal", label: local("终端", "Terminal"), icon: TerminalSquare },
    { id: "plan", label: local("计划", "Plan"), icon: ListChecks },
  ];
}

/**
 * Project workbench backed by project-scoped Rust commands. The UI only asks
 * for overview/read/diff; canonical path checks remain behind that seam.
 */
export function WorkspacePanel() {
  const setWorkbenchVisible = useAppStore((s) => s.setWorkbenchVisible);
  const panel = useAppStore((s) => s.panel);
  const setPanel = useAppStore((s) => s.setPanel);
  const workspace = useAppStore((s) => s.workspace);
  const selectedFile = useAppStore((s) => s.selectedFile);
  const selectedDiff = useAppStore((s) => s.selectedDiff);
  const activity = useAppStore((s) => s.activity);
  const planSteps = useAppStore((s) => s.planSteps);
  const refreshWorkspace = useAppStore((s) => s.refreshWorkspace);
  const openWorkspaceFile = useAppStore((s) => s.openWorkspaceFile);
  const openWorkspaceDiff = useAppStore((s) => s.openWorkspaceDiff);
  const language = useAppStore((s) => s.settings.language);
  const tr = (key: Parameters<typeof t>[1]) => t(language, key);
  const local = (zh: string, en: string) => language === "en-US" ? en : zh;
  const currentWorktree = workspace?.worktrees.find((tree) => tree.isCurrent);

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-card">
      <div className="flex h-12 items-center border-b border-border px-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-semibold text-foreground/90">{workspace?.name ?? local("项目", "Project")}</p>
          <p className="mt-0.5 flex items-center gap-1 truncate font-mono text-[10px] text-muted-foreground">
            <GitBranch size={10} /> {workspace?.branch ?? local("未检测到 Git", "Not a Git repository")}
          </p>
          {workspace && workspace.worktrees.length > 1 && currentWorktree && (
            <p className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground/80" title={currentWorktree.path}>
              {tr("worktrees")} · {currentWorktree.path.split("/").at(-1)}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void refreshWorkspace()}
          title={local("刷新项目", "Refresh project")}
          className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          onClick={() => setWorkbenchVisible(false)}
          aria-label={tr("hideWorkbench")}
          className="ml-1 rounded px-1.5 py-1 text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          ×
        </button>
      </div>

      <nav className="flex border-b border-border px-2" aria-label="Workspace views">
        {tabs(language).map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setPanel(tab.id)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1 border-b-2 px-1 py-2 text-[10px] font-medium",
                panel === tab.id
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground/90",
              )}
            >
              <Icon size={11} /> {tab.label}
            </button>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {panel === "changes" && (
          <ChangesView
            changes={workspace?.changes ?? []}
            selected={selectedDiff}
            onOpen={(path) => void openWorkspaceDiff(path)}
            language={language}
          />
        )}
        {panel === "files" && (
          <FilesView
            files={workspace?.files ?? []}
            selected={selectedFile}
            onOpen={(path) => void openWorkspaceFile(path)}
            language={language}
          />
        )}
        {panel === "terminal" && <TerminalView activity={activity} language={language} />}
        {panel === "plan" && <PlanView steps={planSteps} language={language} />}
      </div>
    </aside>
  );
}

function ChangesView({
  changes,
  selected,
  onOpen,
  language,
}: {
  changes: Array<{ path: string; indexStatus: string; worktreeStatus: string }>;
  selected: { path: string; content: string } | null;
  onOpen: (path: string) => void;
  language: "zh-CN" | "en-US";
}) {
  const local = (zh: string, en: string) => language === "en-US" ? en : zh;
  return (
    <div>
      <PanelIntro title={local("变更", "Changes")} detail={local(`${changes.length} 个变更文件`, `${changes.length} changed file${changes.length === 1 ? "" : "s"}`)} />
      {changes.length === 0 ? (
        <Empty text={local("工作树没有变更。", "Working tree is clean.")} />
      ) : (
        <div className="border-y border-border/60">
          {changes.map((change) => (
            <button
              type="button"
              key={change.path}
              onClick={() => onOpen(change.path)}
              className="flex w-full items-center gap-2 border-b border-border/60 px-3 py-2 text-left last:border-0 hover:bg-secondary"
            >
              <span className={cn("font-mono text-[11px]", change.indexStatus === "?" ? "text-emerald-500" : "text-amber-600")}>
                {change.indexStatus}{change.worktreeStatus}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/80">{change.path}</span>
            </button>
          ))}
        </div>
      )}
      {selected && <CodeView title={`${local("差异", "Diff")} · ${selected.path}`} content={selected.content || local("没有未暂存的差异。", "No unstaged diff for this file.")} />}
    </div>
  );
}

function FilesView({
  files,
  selected,
  onOpen,
  language,
}: {
  files: Array<{ path: string; depth: number; isDir: boolean }>;
  selected: { path: string; content: string } | null;
  onOpen: (path: string) => void;
  language: "zh-CN" | "en-US";
}) {
  const local = (zh: string, en: string) => language === "en-US" ? en : zh;
  return (
    <div>
      <PanelIntro title={local("文件", "Files")} detail={local(`${files.filter((file) => !file.isDir).length} 个已索引文件`, `${files.filter((file) => !file.isDir).length} indexed files`)} />
      <div className="border-y border-border/60 py-1">
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            disabled={file.isDir}
            onClick={() => !file.isDir && onOpen(file.path)}
            style={{ paddingLeft: `${12 + file.depth * 14}px` }}
            className={cn(
              "flex w-full items-center gap-1.5 py-1 pr-3 text-left font-mono text-[11px]",
              file.isDir ? "cursor-default font-semibold text-muted-foreground" : "text-foreground/80 hover:bg-secondary hover:text-foreground",
            )}
          >
            <span className="truncate">{file.path.split("/").at(-1)}</span>
          </button>
        ))}
      </div>
      {selected && <CodeView title={selected.path} content={selected.content} />}
    </div>
  );
}

function TerminalView({ activity, language }: { activity: Array<{ id: string; name: string; output?: string; status: string }>; language: "zh-CN" | "en-US" }) {
  const local = (zh: string, en: string) => language === "en-US" ? en : zh;
  return (
    <div>
      <PanelIntro title={local("终端活动", "Terminal activity")} detail={local("仅显示 Agent 上报的命令", "Only commands reported by the agent")} />
      {activity.length === 0 ? <Empty text={local("Grok 工作时，命令输出会显示在这里。", "Command output will appear here while Grok works.")} /> : (
        <div className="divide-y divide-border/60">
          {[...activity].reverse().map((entry) => (
            <div key={entry.id} className="px-3 py-2.5">
              <div className="flex items-center gap-2 text-[11px]">
                <span className={cn("h-1.5 w-1.5 rounded-full", entry.status === "error" ? "bg-destructive" : entry.status === "ok" ? "bg-emerald-500" : "bg-amber-500 animate-pulse")} />
                <span className="font-medium text-foreground/90">{entry.name}</span>
              </div>
              {entry.output && <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-muted-foreground">{entry.output}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PlanView({ steps, language }: { steps: string[]; language: "zh-CN" | "en-US" }) {
  const local = (zh: string, en: string) => language === "en-US" ? en : zh;
  return (
    <div>
      <PanelIntro title={local("计划", "Plan")} detail={local("来自当前 Grok 会话", "From the current Grok conversation")} />
      {steps.length === 0 ? <Empty text={local("切换到计划模式，或让 Grok 制定一个计划。", "Switch to plan mode, or ask Grok to make a plan.")} /> : (
        <ol className="space-y-2 px-3 py-3">
          {steps.map((step, index) => (
            <li key={`${index}-${step}`} className="flex gap-2 text-[12px] leading-relaxed text-foreground/80">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-[10px] text-muted-foreground">{index + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function PanelIntro({ title, detail }: { title: string; detail: string }) {
  return <div className="px-3 py-3"><h3 className="text-[12px] font-semibold text-foreground/90">{title}</h3><p className="mt-0.5 text-[10px] text-muted-foreground">{detail}</p></div>;
}

function Empty({ text }: { text: string }) {
  return <p className="px-3 py-6 text-center text-[11px] leading-relaxed text-muted-foreground">{text}</p>;
}

function CodeView({ title, content }: { title: string; content: string }) {
  return <div className="border-t border-border"><div className="truncate px-3 py-2 font-mono text-[10px] font-medium text-muted-foreground">{title}</div><pre className="max-h-[380px] overflow-auto border-t border-border/60 bg-secondary p-3 font-mono text-[10px] leading-relaxed text-foreground/80">{content}</pre></div>;
}
