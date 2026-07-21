import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Diff,
  FileCode2,
  GitBranch,
  ListChecks,
  Loader2,
  RefreshCw,
  Search,
  TerminalSquare,
} from "lucide-react";
import { useAppStore, type WorkspacePanel as Panel } from "@grok-gui/core";
import { cn } from "./lib/utils";
import { t } from "./i18n";

/** A single lazily-loaded directory level, as returned by `workspace_list_dir`. */
interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  path: string;
}

/** A single content match, as returned by `workspace_search`. */
interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

const LARGE_DIFF_LINES = 2000;
const LARGE_DIFF_BYTES = 1024 * 1024;
const SEARCH_DEBOUNCE_MS = 300;
const MAX_SEARCH_RESULTS = 100;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

async function invokeTauri<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const tauri = await import("@tauri-apps/api/core");
  return tauri.invoke<T>(command, args);
}

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
 * for overview/read/diff/list-dir/search; canonical path checks remain
 * behind that seam.
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
            workspaceRoot={workspace?.root}
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
      {selected && (
        selected.content ? (
          <DiffCodeView title={`${local("差异", "Diff")} · ${selected.path}`} content={selected.content} path={selected.path} language={language} />
        ) : (
          <div className="border-t border-border px-3 py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
            {local("没有未暂存的差异。", "No unstaged diff for this file.")}
          </div>
        )
      )}
    </div>
  );
}

function FilesView({
  workspaceRoot,
  selected,
  onOpen,
  language,
}: {
  workspaceRoot: string | undefined;
  selected: { path: string; content: string } | null;
  onOpen: (path: string) => void;
  language: "zh-CN" | "en-US";
}) {
  const local = (zh: string, en: string) => language === "en-US" ? en : zh;
  const tr = (key: Parameters<typeof t>[1]) => t(language, key);

  // Lazily-loaded directory tree: `nodes[dirPath]` holds the single-level
  // listing for that directory once fetched; `""` is the workspace root.
  const [nodes, setNodes] = useState<Record<string, DirEntry[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [revealLine, setRevealLine] = useState<number | undefined>(undefined);

  const loadDir = (dirPath: string) => {
    if (!workspaceRoot || !isTauriRuntime()) return;
    setLoadingDirs((prev) => {
      if (prev.has(dirPath)) return prev;
      const next = new Set(prev);
      next.add(dirPath);
      return next;
    });
    void invokeTauri<DirEntry[]>("workspace_list_dir", { workspacePath: workspaceRoot, relativeDir: dirPath })
      .then((entries) => setNodes((prev) => ({ ...prev, [dirPath]: entries })))
      .catch(() => setNodes((prev) => ({ ...prev, [dirPath]: [] })))
      .finally(() =>
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        }),
      );
  };

  useEffect(() => {
    setNodes({});
    setExpanded(new Set());
    setFilter("");
    setSearchQuery("");
    setSearchResults(null);
    if (workspaceRoot) loadDir("");
  }, [workspaceRoot]);

  useEffect(() => {
    if (!searchQuery.trim() || !workspaceRoot || !isTauriRuntime()) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(() => {
      invokeTauri<SearchMatch[]>("workspace_search", {
        workspacePath: workspaceRoot,
        query: searchQuery,
        maxResults: MAX_SEARCH_RESULTS,
      })
        .then((results) => setSearchResults(results))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchQuery, workspaceRoot]);

  const toggleDir = (path: string) => {
    const willOpen = !expanded.has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(path); else next.delete(path);
      return next;
    });
    if (willOpen && !nodes[path]) loadDir(path);
  };

  const handleOpen = (path: string, line?: number) => {
    setRevealLine(line);
    onOpen(path);
  };

  const filteredEntries = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return null;
    const matches: DirEntry[] = [];
    for (const entries of Object.values(nodes)) {
      for (const entry of entries) {
        if (!entry.isDir && entry.name.toLowerCase().includes(needle)) matches.push(entry);
      }
    }
    return matches.sort((a, b) => a.path.localeCompare(b.path));
  }, [filter, nodes]);

  const indexedFileCount = useMemo(
    () => Object.values(nodes).reduce((sum, entries) => sum + entries.filter((entry) => !entry.isDir).length, 0),
    [nodes],
  );

  return (
    <div>
      <PanelIntro title={local("文件", "Files")} detail={local(`${indexedFileCount} 个已索引文件`, `${indexedFileCount} indexed files`)} />
      <div className="space-y-1.5 px-3 pb-2">
        <SearchInput value={filter} onChange={setFilter} placeholder={tr("filterFiles")} />
        <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder={tr("searchContent")} />
      </div>

      {filter.trim() ? (
        <div className="border-y border-border/60 py-1">
          {filteredEntries && filteredEntries.length === 0 ? (
            <Empty text={tr("noSearchResults")} />
          ) : (
            (filteredEntries ?? []).map((entry) => (
              <button
                type="button"
                key={entry.path}
                onClick={() => handleOpen(entry.path)}
                className="flex w-full items-center gap-1.5 py-1 pl-3 pr-3 text-left font-mono text-[11px] text-foreground/80 hover:bg-secondary hover:text-foreground"
              >
                <span className="truncate">{entry.path}</span>
              </button>
            ))
          )}
        </div>
      ) : (
        <div className="border-y border-border/60 py-1">
          {(nodes[""] ?? []).map((entry) => (
            <TreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              nodes={nodes}
              expanded={expanded}
              loadingDirs={loadingDirs}
              onToggleDir={toggleDir}
              onOpenFile={handleOpen}
            />
          ))}
          {!nodes[""] && loadingDirs.has("") && <LoadingRow text={tr("loadingFiles")} />}
        </div>
      )}

      {searchQuery.trim() && (
        <div className="border-t border-border/60">
          <div className="px-3 py-2 text-[10px] font-semibold text-muted-foreground">{tr("contentMatches")}</div>
          {searching ? (
            <LoadingRow text={tr("searching")} />
          ) : (searchResults ?? []).length === 0 ? (
            <Empty text={tr("noSearchResults")} />
          ) : (
            <div className="max-h-56 overflow-auto">
              {(searchResults ?? []).map((match, index) => (
                <button
                  type="button"
                  key={`${match.path}-${match.line}-${index}`}
                  onClick={() => handleOpen(match.path, match.line)}
                  className="flex w-full flex-col gap-0.5 border-b border-border/60 px-3 py-1.5 text-left last:border-0 hover:bg-secondary"
                >
                  <span className="truncate font-mono text-[10px] text-foreground/80">{match.path}:{match.line}</span>
                  <span className="truncate font-mono text-[10px] text-muted-foreground">{match.text}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {selected && <CodeView title={selected.path} content={selected.content} path={selected.path} revealLine={revealLine} />}
    </div>
  );
}

function TreeNode({
  entry,
  depth,
  nodes,
  expanded,
  loadingDirs,
  onToggleDir,
  onOpenFile,
}: {
  entry: DirEntry;
  depth: number;
  nodes: Record<string, DirEntry[]>;
  expanded: Set<string>;
  loadingDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const isOpen = entry.isDir && expanded.has(entry.path);
  const isLoading = entry.isDir && loadingDirs.has(entry.path);
  const children = nodes[entry.path];

  return (
    <div>
      <button
        type="button"
        onClick={() => (entry.isDir ? onToggleDir(entry.path) : onOpenFile(entry.path))}
        style={{ paddingLeft: `${12 + depth * 14}px` }}
        className="flex w-full items-center gap-1 py-1 pr-3 text-left font-mono text-[11px] text-foreground/80 hover:bg-secondary hover:text-foreground"
      >
        {entry.isDir ? (
          isLoading ? (
            <Loader2 size={11} className="shrink-0 animate-spin text-muted-foreground" />
          ) : isOpen ? (
            <ChevronDown size={11} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight size={11} className="shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-[11px] shrink-0" />
        )}
        <span className={cn("truncate", entry.isDir && "font-semibold")}>{entry.name}</span>
      </button>
      {isOpen &&
        (children ?? []).map((child) => (
          <TreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            nodes={nodes}
            expanded={expanded}
            loadingDirs={loadingDirs}
            onToggleDir={onToggleDir}
            onOpenFile={onOpenFile}
          />
        ))}
    </div>
  );
}

function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded border border-border bg-background px-2 py-1">
      <Search size={11} className="shrink-0 text-muted-foreground" />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none"
      />
    </div>
  );
}

function LoadingRow({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-muted-foreground">
      <Loader2 size={12} className="animate-spin" /> {text}
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

// --- Monaco (loaded on demand; kept out of the initial bundle) -----------

type MonacoNamespace = typeof import("monaco-editor");

let monacoPromise: Promise<MonacoNamespace> | null = null;

/**
 * `?worker`-style Vite imports need ambient module types this package can't
 * declare (only WorkspacePanel.tsx and i18n.ts are in scope here), so the
 * worker is wired up the portable way instead: a plain `new URL(...,
 * import.meta.url)` handed to `new Worker(...)`. Vite (and electron-vite,
 * which wraps the same renderer pipeline) both resolve that pattern natively
 * with no extra plugin, so this works unmodified in both builds.
 */
function loadMonaco(): Promise<MonacoNamespace> {
  if (!monacoPromise) {
    monacoPromise = import("monaco-editor").then((monaco) => {
      (self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
        getWorker: () =>
          new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" }),
      };
      return monaco;
    });
  }
  return monacoPromise;
}

function monacoTheme(): string {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "vs-dark" : "vs";
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json",
  rs: "rust",
  toml: "ini",
  yaml: "yaml", yml: "yaml",
  md: "markdown", mdx: "markdown",
  py: "python",
  go: "go",
  java: "java",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sh: "shell", bash: "shell", zsh: "shell",
  sql: "sql",
  html: "html", htm: "html",
  css: "css", scss: "scss", less: "less",
  xml: "xml",
  swift: "swift",
  kt: "kotlin", kts: "kotlin",
  lua: "lua",
  graphql: "graphql",
  proto: "protobuf",
};

function languageForPath(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  if (name.toLowerCase() === "dockerfile") return "dockerfile";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return LANGUAGE_BY_EXTENSION[extension] ?? "plaintext";
}

function CodeView({ title, content, path, revealLine }: { title: string; content: string; path: string; revealLine?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let editor: import("monaco-editor").editor.IStandaloneCodeEditor | null = null;
    void loadMonaco().then((monaco) => {
      if (disposed || !containerRef.current) return;
      editor = monaco.editor.create(containerRef.current, {
        value: content,
        language: languageForPath(path),
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        automaticLayout: true,
        fontSize: 11,
        scrollBeyondLastLine: false,
        theme: monacoTheme(),
      });
      if (revealLine) {
        editor.revealLineInCenter(revealLine);
        editor.setPosition({ lineNumber: revealLine, column: 1 });
      }
    });
    return () => {
      disposed = true;
      editor?.dispose();
    };
    // A new editor instance (and model) is the simplest correct way to
    // re-render for a different file, a different reveal target, or content
    // that changed after a background refresh.
  }, [path, content, revealLine]);

  return (
    <div className="border-t border-border">
      <div className="truncate px-3 py-2 font-mono text-[10px] font-medium text-muted-foreground">{title}</div>
      <div ref={containerRef} className="h-[380px] border-t border-border/60" />
    </div>
  );
}

/**
 * Reconstructs `original`/`modified` text from a unified `git diff` for a
 * single file, so Monaco's `DiffEditor` can render it side by side. This is
 * a client-side view over hunk context only (not the full file, which the
 * backend never sends) — that matches what the panel already showed.
 */
function parseUnifiedDiff(diffText: string): { original: string; modified: string } {
  const original: string[] = [];
  const modified: string[] = [];
  for (const line of diffText.split("\n")) {
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to") ||
      line.startsWith("Binary files") ||
      line.startsWith("@@") ||
      line.startsWith("\\ No newline")
    ) {
      continue;
    }
    if (line.startsWith("+")) {
      modified.push(line.slice(1));
    } else if (line.startsWith("-")) {
      original.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      original.push(line.slice(1));
      modified.push(line.slice(1));
    }
  }
  return { original: original.join("\n"), modified: modified.join("\n") };
}

function DiffCodeView({
  title,
  content,
  path,
  language,
}: {
  title: string;
  content: string;
  path: string;
  language: "zh-CN" | "en-US";
}) {
  const tr = (key: Parameters<typeof t>[1]) => t(language, key);
  const containerRef = useRef<HTMLDivElement>(null);
  const lineCount = useMemo(() => content.split("\n").length, [content]);
  const isLarge = lineCount > LARGE_DIFF_LINES || content.length > LARGE_DIFF_BYTES;
  const [forceLoad, setForceLoad] = useState(false);
  const shouldRender = !isLarge || forceLoad;

  useEffect(() => {
    setForceLoad(false);
  }, [path, content]);

  useEffect(() => {
    if (!shouldRender) return;
    let disposed = false;
    let diffEditor: import("monaco-editor").editor.IStandaloneDiffEditor | null = null;
    let originalModel: import("monaco-editor").editor.ITextModel | null = null;
    let modifiedModel: import("monaco-editor").editor.ITextModel | null = null;
    void loadMonaco().then((monaco) => {
      if (disposed || !containerRef.current) return;
      const { original, modified } = parseUnifiedDiff(content);
      const lang = languageForPath(path);
      originalModel = monaco.editor.createModel(original, lang);
      modifiedModel = monaco.editor.createModel(modified, lang);
      diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
        readOnly: true,
        renderSideBySide: true,
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 11,
        scrollBeyondLastLine: false,
        theme: monacoTheme(),
      });
      diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    });
    return () => {
      disposed = true;
      diffEditor?.dispose();
      originalModel?.dispose();
      modifiedModel?.dispose();
    };
  }, [shouldRender, path, content]);

  return (
    <div className="border-t border-border">
      <div className="truncate px-3 py-2 font-mono text-[10px] font-medium text-muted-foreground">{title}</div>
      {shouldRender ? (
        <div ref={containerRef} className="h-[380px] border-t border-border/60" />
      ) : (
        <button
          type="button"
          onClick={() => setForceLoad(true)}
          className="flex w-full flex-col items-center gap-1 border-t border-border/60 bg-secondary/40 px-3 py-8 text-center hover:bg-secondary"
        >
          <span className="text-[12px] font-medium text-foreground/90">{tr("loadLargeDiff")}</span>
          <span className="text-[10px] text-muted-foreground">{lineCount} {tr("lines")} · {tr("loadLargeDiffDetail")}</span>
        </button>
      )}
    </div>
  );
}
