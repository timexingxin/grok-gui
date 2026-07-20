import { useState, useRef, useEffect } from "react";
import {
  Plus, Search, Folder, ChevronDown, Settings, Pencil, Trash2, Copy, Check,
  Pin, Archive, Mail, Puzzle, Clock,
  PanelLeftClose, PanelLeftOpen,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { conversationActivityTimestamp, sortConversationRecords, useAppStore, type ConversationRecord } from "@grok-gui/core";
import { cn } from "./lib/utils";
import { relativeTime } from "@grok-gui/core/utils";
import { buildSidebarSessions, splitPinnedSessions } from "./sidebar-sessions";
import { worktreeLabel, worktreeStatus } from "./worktree-labels";
import { contextMenuPosition } from "./context-menu-position";
import { t } from "./i18n";

interface ContextMenuState {
  x: number;
  y: number;
  sessionId: string;
  sessionTitle: string;
}

type NavSection = "plugins" | "scheduled" | "archived";

function navSections(language: "zh-CN" | "en-US"): Array<{ id: NavSection; label: string; icon: typeof Puzzle }> {
  return [
    { id: "plugins", label: t(language, "plugins"), icon: Puzzle },
    { id: "scheduled", label: t(language, "scheduled"), icon: Clock },
    { id: "archived", label: t(language, "archivedTasks"), icon: Archive },
  ];
}

const DAY_MS = 86_400_000;

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

interface SessionGroup {
  label: string;
  entries: ConversationRecord[];
}

function groupSessions(entries: ConversationRecord[], language: "zh-CN" | "en-US"): SessionGroup[] {
  const today = startOfToday();
  const groups: SessionGroup[] = [
    { label: t(language, "today"), entries: [] },
    { label: t(language, "yesterday"), entries: [] },
    { label: t(language, "pastSevenDays"), entries: [] },
    { label: t(language, "earlier"), entries: [] },
  ];
  for (const entry of entries) {
    const activityAt = conversationActivityTimestamp(entry);
    if (activityAt >= today) groups[0].entries.push(entry);
    else if (activityAt >= today - DAY_MS) groups[1].entries.push(entry);
    else if (activityAt >= today - 6 * DAY_MS) groups[2].entries.push(entry);
    else groups[3].entries.push(entry);
  }
  return groups.filter((g) => g.entries.length > 0);
}

export function Sidebar() {
  const session = useAppStore((s) => s.session);
  const workspace = useAppStore((s) => s.workspace);
  const newTask = useAppStore((s) => s.newTask);
  const history = useAppStore((s) => s.history);
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const openConversation = useAppStore((s) => s.openConversation);
  const deleteConversation = useAppStore((s) => s.deleteConversation);
  const renameConversation = useAppStore((s) => s.renameConversation);
  const togglePin = useAppStore((s) => s.togglePin);
  const toggleArchive = useAppStore((s) => s.toggleArchive);
  const markUnread = useAppStore((s) => s.markUnread);
  const screen = useAppStore((s) => s.screen);
  const setScreen = useAppStore((s) => s.setScreen);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const setCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const language = useAppStore((s) => s.settings.language);
  const tr = (key: Parameters<typeof t>[1]) => t(language, key);
  const [projectOpen, setProjectOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [archivedView, setArchivedView] = useState(false);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = (e: MouseEvent) => {
      if (!ctxMenuRef.current?.contains(e.target as Node)) setCtxMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [ctxMenu]);

  // Disable the webview's default context menu everywhere. Our custom
  // session menu keeps working because SessionRow calls preventDefault()
  // first and sets ctxMenu before the browser would have opened its own.
  useEffect(() => {
    const suppress = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest?.("[data-session-row]")) {
        e.preventDefault();
      }
    };
    document.addEventListener("contextmenu", suppress);
    return () => document.removeEventListener("contextmenu", suppress);
  }, []);

  const chooseWorkspace = async () => {
    setWorkspaceError(null);
    try {
      const selected = await open({
        title: tr("chooseWorkspace"),
        directory: true,
        multiple: false,
        defaultPath: session?.workspace,
      });
      if (typeof selected === "string") await newTask(selected);
    } catch (error) {
      console.error("workspace selection failed:", error);
      setWorkspaceError(language === "en-US" ? "Unable to switch workspace" : "无法切换工作区");
    } finally {
      setProjectOpen(false);
    }
  };

  const startNewTask = () => {
    setArchivedView(false);
    setScreen("chat");
    void newTask(session?.workspace);
  };

  const archivedCount = history.filter((entry) => entry.archived).length;
  const sidebarSessions = buildSidebarSessions(history);
  const displayedSessions = archivedView
    ? history.filter((entry) => entry.archived)
    : sidebarSessions.persisted.filter((entry) => !entry.archived);

  const seen = new Set<string>();
  const matchingSessions = displayedSessions
    .filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return !query.trim() || `${entry.title} ${entry.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    });
  const partitionedSessions = splitPinnedSessions(matchingSessions);
  const pinnedSessions = archivedView ? [] : partitionedSessions.pinned;
  const regularSessions = archivedView
    ? sortConversationRecords(matchingSessions)
    : partitionedSessions.regular;
  const groups = groupSessions(regularSessions, language);

  const startRename = (id: string, currentTitle: string) => {
    setRenamingId(id);
    setRenameValue(currentTitle);
    setCtxMenu(null);
  };

  const confirmRename = () => {
    if (renamingId && renameValue.trim()) {
      try {
        renameConversation(renamingId, renameValue.trim());
      } catch (error) {
        console.error("rename failed:", error);
      }
    }
    setRenamingId(null);
    setRenameValue("");
  };

  const handleDelete = (id: string, title: string) => {
    setCtxMenu(null);
    if (window.confirm(`${tr("deleteConversation")}: ${title}\n${tr("deleteConfirm")}`)) {
      deleteConversation(id);
    }
  };

  const copySessionId = async (id: string) => {
    setCtxMenu(null);
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      console.error("clipboard write failed");
    }
  };

  const copyWorkspace = async (workspace: string | undefined) => {
    setCtxMenu(null);
    if (!workspace) return;
    try {
      await navigator.clipboard.writeText(workspace);
      setCopiedId(`ws:${workspace}`);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      console.error("clipboard write failed");
    }
  };

  const showInFinder = async (workspace: string | undefined) => {
    setCtxMenu(null);
    if (!workspace) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("show_in_finder", { path: workspace });
    } catch (error) {
      console.error("show in finder failed:", error);
    }
  };

  const copyLabel = (id: string, label: string, prefix = "") => {
    if (copiedId === prefix + id) return tr("copied");
    return label;
  };

  const renderSessionRow = (entry: ConversationRecord) => (
    <SessionRow
      key={entry.id}
      title={entry.title}
      meta={relativeTime(conversationActivityTimestamp(entry), language)}
      active={!archivedView && entry.id === activeConversationId}
      pinned={entry.pinned}
      unread={entry.unread}
      renaming={renamingId === entry.id}
      renameValue={renameValue}
      onRenameChange={setRenameValue}
      onRenameConfirm={confirmRename}
      onRenameCancel={() => { setRenamingId(null); setRenameValue(""); }}
      onClick={() => {
        setArchivedView(false);
        setScreen("chat");
        if (entry.id !== activeConversationId && history.some((saved) => saved.id === entry.id)) {
          void openConversation(entry.id);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        // The longest menu is deliberately bounded; CSS supplies the same
        // max-height if a translated locale needs more vertical room.
        const position = contextMenuPosition(
          { x: e.clientX, y: e.clientY },
          { width: window.innerWidth, height: window.innerHeight },
          { width: 272, height: 480 },
        );
        setCtxMenu({ ...position, sessionId: entry.id, sessionTitle: entry.title });
      }}
    />
  );

  if (collapsed) {
    return (
      <aside className="flex h-full w-12 flex-col items-center border-r border-sidebar-border bg-sidebar py-2.5">
        <img src="/grok-gui-cover.png" alt="Grok GUI" className="h-6 w-6 rounded-md object-cover" />
        <CollapsedButton title={`${tr("newTask")} (⌘N)`} onClick={startNewTask}>
          <Plus size={16} />
        </CollapsedButton>
        <CollapsedButton
          title={`${tr("expandSidebar")} (⌘B)`}
          onClick={() => {
            setCollapsed(false);
            setTimeout(() => searchRef.current?.focus(), 50);
          }}
        >
          <Search size={15} />
        </CollapsedButton>
        <div className="mt-auto flex flex-col items-center gap-1">
          <CollapsedButton title={`${tr("settings")} (⌘,)`} onClick={() => setScreen("settings")}>
            <Settings size={15} />
          </CollapsedButton>
          <CollapsedButton title={`${tr("expandSidebar")} (⌘B)`} onClick={() => setCollapsed(false)}>
            <PanelLeftOpen size={15} />
          </CollapsedButton>
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-[260px] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {/* Brand */}
      <div className="flex items-center gap-2 px-3.5 pb-1 pt-3.5">
        <img src="/grok-gui-cover.png" alt="Grok GUI" className="h-6 w-6 rounded-md object-cover" />
        <h1 className="text-[13px] font-semibold tracking-tight">Grok GUI</h1>
        <button
          type="button"
          title={`${tr("collapseSidebar")} (⌘B)`}
          onClick={() => setCollapsed(true)}
          className="ml-auto rounded-md p-1.5 text-sidebar-muted transition-colors hover:bg-sidebar-active hover:text-sidebar-foreground"
        >
          <PanelLeftClose size={14} />
        </button>
      </div>

      {/* New task — primary action */}
      <div className="px-3 pt-2">
        <button
          type="button"
          onClick={startNewTask}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-[12px] font-medium text-brand-foreground shadow-sm transition-opacity hover:opacity-90"
        >
          <Plus size={14} /> {tr("newTask")}
        </button>
      </div>

      {/* Project picker */}
      <div className="px-3 pt-2.5">
        <button
          onClick={() => setProjectOpen((o) => !o)}
          className="group flex w-full items-center gap-2 rounded-md border border-sidebar-border bg-background/50 px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-sidebar-active"
        >
          <Folder size={12} className="shrink-0 text-sidebar-muted" />
          <span className="truncate font-mono text-sidebar-foreground/90">
            {session?.workspace || "~"}
          </span>
          <ChevronDown
            size={11}
            className={cn(
              "ml-auto shrink-0 text-sidebar-muted transition-transform",
              projectOpen && "rotate-180",
            )}
          />
        </button>
        {projectOpen && (
          <div className="mt-1.5 rounded-md border border-sidebar-border bg-popover p-1 text-[12px] shadow-lg">
            <ProjectRow label={tr("chooseFolder")} sub={tr("chooseWorkspace")} onClick={() => void chooseWorkspace()} />
            <ProjectRow label={tr("newTask")} sub={tr("currentWorkspace")} onClick={startNewTask} />
            {workspace?.worktrees.length ? (
              <div className="mt-1 border-t border-sidebar-border pt-1">
                <p className="px-2 pb-1 pt-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-sidebar-muted/70">{tr("worktrees")}</p>
                {workspace.worktrees.map((tree) => (
                  <ProjectRow
                    key={tree.path}
                    label={worktreeLabel(tree, language)}
                    sub={worktreeStatus(tree, language)}
                    onClick={() => {
                      if (!tree.isCurrent) void newTask(tree.path);
                      setProjectOpen(false);
                    }}
                  />
                ))}
              </div>
            ) : null}
            {workspaceError && <p className="px-2 py-1 text-[10px] text-destructive">{workspaceError}</p>}
          </div>
        )}
      </div>

      {/* Quick nav */}
      <div className="mt-2.5 px-1.5">
        {navSections(language).map((section) => {
          const Icon = section.icon;
          const isActive =
            (section.id === "plugins" && screen === "plugins") ||
            (section.id === "scheduled" && screen === "scheduled") ||
            (section.id === "archived" && archivedView);
          return (
            <button
              key={section.id}
              type="button"
               onClick={() => {
                 if (section.id === "archived") {
                   setArchivedView((v) => !v);
                   setScreen("chat");
                 } else if (section.id === "plugins") setScreen("plugins");
                 else if (section.id === "scheduled") setScreen("scheduled");
               }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors",
                isActive
                  ? "bg-sidebar-active text-sidebar-foreground"
                  : "text-sidebar-muted hover:bg-sidebar-active hover:text-sidebar-foreground",
              )}
            >
              <Icon size={13} className="shrink-0" />
              <span className="flex-1">{section.label}</span>
              {section.id === "archived" && archivedCount > 0 && (
                <span className="rounded bg-sidebar-active px-1.5 py-0.5 text-[9px] font-mono text-sidebar-muted">
                  {archivedCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div className="px-3 pt-2.5">
        <div className="relative">
          <Search
            size={11}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sidebar-muted"
          />
          <input
            ref={searchRef}
            data-session-search
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`${tr("searchSessions")} (⌘K)`}
            className="w-full rounded-md border border-sidebar-border bg-background/50 py-1 pl-7 pr-2 text-[12px] text-sidebar-foreground placeholder:text-sidebar-muted focus:border-sidebar-muted/50 focus:outline-none"
          />
        </div>
      </div>

      {/* Sessions list, grouped by recency */}
      <div className="mt-2 flex-1 overflow-y-auto px-1.5 pb-2">
        {archivedView && <SectionTitle>{tr("archivedSessions")}</SectionTitle>}
        {!archivedView && pinnedSessions.length > 0 && (
          <div className="mb-2">
            <SectionTitle>{tr("pinned")}</SectionTitle>
            <div className="space-y-0.5">
              {pinnedSessions.map(renderSessionRow)}
            </div>
          </div>
        )}
        {groups.length > 0 ? (
          groups.map((group) => (
            <div key={group.label}>
              <SectionTitle>{group.label}</SectionTitle>
              <div className="space-y-0.5">
                {group.entries.map(renderSessionRow)}
              </div>
            </div>
          ))
        ) : (
          <p className="px-2 py-1 text-[11px] text-sidebar-muted/70">
            {archivedView ? tr("noArchivedSessions") : tr("noMatchingSessions")}
          </p>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-sidebar-border p-2">
        <button
          type="button"
          onClick={() => setScreen("settings")}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-sidebar-muted transition-colors hover:bg-sidebar-active hover:text-sidebar-foreground"
        >
          <Settings size={13} /> {tr("settings")} & {tr("connection")}
        </button>
        <p className="px-2 pt-1.5 text-[9px] text-sidebar-muted/60">Grok GUI · Grok Build agent</p>
      </div>

      {ctxMenu && (() => {
        const record = history.find((entry) => entry.id === ctxMenu.sessionId);
        return (
        <div
          ref={ctxMenuRef}
          className="fixed z-50 min-w-52 overflow-y-auto rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-xl"
          style={{ left: ctxMenu.x, top: ctxMenu.y, maxHeight: "min(480px, calc(100vh - 16px))" }}
        >
          <MenuItem onClick={() => { togglePin(ctxMenu.sessionId); setCtxMenu(null); }}>
            <Pin size={12} className={record?.pinned ? "text-brand" : ""} />
            {record?.pinned ? tr("unpin") : tr("pinTask")}
          </MenuItem>
          <MenuItem onClick={() => startRename(ctxMenu.sessionId, ctxMenu.sessionTitle)}>
            <Pencil size={12} /> {tr("renameTask")}
          </MenuItem>
          <MenuItem onClick={() => { toggleArchive(ctxMenu.sessionId); setCtxMenu(null); }}>
            <Archive size={12} />
            {record?.archived ? tr("unarchive") : tr("archiveTask")}
          </MenuItem>
          <MenuItem onClick={() => { markUnread(ctxMenu.sessionId); setCtxMenu(null); }}>
            <Mail size={12} /> {tr("markUnread")}
          </MenuItem>
          <div className="mx-2 my-1 border-t border-border" />
          {record?.workspace && (
            <MenuItem onClick={() => void showInFinder(record.workspace)}>
              <Folder size={12} /> {tr("showInFinder")}
            </MenuItem>
          )}
          {record?.workspace && (
            <MenuItem onClick={() => void copyWorkspace(record.workspace)}>
              {copiedId === `ws:${record.workspace}` ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
              {copyLabel(record.workspace ?? "", tr("copyWorkingDirectory"), "ws:")}
            </MenuItem>
          )}
          <MenuItem onClick={() => void copySessionId(ctxMenu.sessionId)}>
            {copiedId === ctxMenu.sessionId ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
            {copyLabel(ctxMenu.sessionId, tr("copySessionId"))}
          </MenuItem>
          <div className="mx-2 my-1 border-t border-border" />
          <button
            type="button"
            onClick={() => handleDelete(ctxMenu.sessionId, ctxMenu.sessionTitle)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-destructive transition-colors hover:bg-secondary"
          >
            <Trash2 size={12} /> {tr("deleteConversation")}
          </button>
        </div>
        );
      })()}
    </aside>
  );
}

function CollapsedButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="mt-2.5 flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-muted transition-colors hover:bg-sidebar-active hover:text-sidebar-foreground"
    >
      {children}
    </button>
  );
}

function MenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-popover-foreground transition-colors hover:bg-secondary"
    >
      {children}
    </button>
  );
}

function ProjectRow({ label, sub, onClick }: { label: string; sub: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left transition-colors hover:bg-secondary">
      <span className="font-mono text-popover-foreground">{label}</span>
      <span className="text-[10px] text-muted-foreground">{sub}</span>
    </button>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-sidebar-muted/70">
      {children}
    </div>
  );
}

function SessionRow({
  title,
  meta,
  active,
  pinned,
  unread,
  renaming = false,
  renameValue = "",
  onRenameChange,
  onRenameConfirm,
  onRenameCancel,
  onClick,
  onContextMenu,
}: {
  title: string;
  meta: string;
  active: boolean;
  pinned?: boolean;
  unread?: boolean;
  renaming?: boolean;
  renameValue?: string;
  onRenameChange?: (value: string) => void;
  onRenameConfirm?: () => void;
  onRenameCancel?: () => void;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const renameInputRef = useRef<HTMLInputElement>(null);
  const confirmedRef = useRef(false);

  useEffect(() => {
    if (renaming) {
      confirmedRef.current = false;
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renaming]);

  if (renaming) {
    const confirm = () => {
      if (confirmedRef.current) return;
      confirmedRef.current = true;
      onRenameConfirm?.();
    };
    return (
      <div data-session-row className="flex w-full items-center gap-2 rounded-md bg-sidebar-active px-2 py-1.5 text-left text-[12px]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500/70" />
        <input
          ref={renameInputRef}
          value={renameValue}
          onChange={(e) => onRenameChange?.(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirm();
            if (e.key === "Escape") {
              confirmedRef.current = true;
              onRenameCancel?.();
            }
          }}
          onBlur={confirm}
          className="flex-1 rounded bg-background px-1 py-0.5 text-foreground outline-none ring-1 ring-ring"
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      data-session-row
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors",
        active ? "bg-sidebar-active" : "hover:bg-sidebar-active/70",
      )}
    >
      <span className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        unread ? "bg-brand" : "bg-emerald-500/70",
      )} />
      {pinned && <Pin size={10} className="shrink-0 text-brand" />}
      <span className={cn("flex-1 truncate text-sidebar-foreground", unread && "font-semibold")}>{title}</span>
      <span className="shrink-0 text-[10px] text-sidebar-muted/80">{meta}</span>
    </button>
  );
}
