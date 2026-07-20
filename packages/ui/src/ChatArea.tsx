import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { BrainCircuit, Check, Copy, CornerUpRight, FolderSearch, Bug, Sparkles, FlaskConical, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { useAppStore, type AgentAction, type Message, type ThoughtRecord, type ToolCallRecord } from "@grok-gui/core";
import { ToolCallCard } from "./components/ToolCallCard";
import { formatCost, formatTokens, relativeTime } from "@grok-gui/core/utils";
import { canCopyMessage, copyableMessageText } from "./message-copy";
import { normalizeGrokMarkdown } from "./message-markdown";
import { shouldShowStreamingCaret } from "./streaming-presentation";
import { convertFileSrc } from "@tauri-apps/api/core";
import { imagePreviewUrl } from "./image-preview";
import { ImageLightbox } from "./ImageLightbox";
import { t } from "./i18n";

export function ChatArea() {
  const messages = useAppStore((s) => s.messages);
  const streaming = useAppStore((s) => s.streaming);
  const switching = useAppStore((s) => s.switching);
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const language = useAppStore((s) => s.settings.language);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followStreamRef = useRef(true);

  useEffect(() => {
    followStreamRef.current = true;
  }, [activeConversationId]);

  useEffect(() => {
    if (followStreamRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, streaming]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    followStreamRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  if (messages.length === 0 && !streaming) {
    return <EmptyState />;
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto"
      data-tauri-drag-region={false}
    >
      <div
        className="mx-auto flex flex-col gap-6 px-6 py-6"
        style={{ maxWidth: "var(--chat-max-width, 960px)" }}
      >
        {switching && (
          <p className="-mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="h-3 w-3 animate-spin rounded-full border border-muted-foreground/40 border-t-foreground" />
            {t(language, "restoreAgent")}
          </p>
        )}
        {messages.map((m) => (
          <MessageRow key={m.id} message={m} />
        ))}
        {streaming && <StreamingBubble />}
        <div className="h-4" />
      </div>
    </div>
  );
}

function suggestions(language: "zh-CN" | "en-US") {
  if (language === "en-US") {
    return [
      { icon: FolderSearch, title: "Explain this project", prompt: "Read the current workspace and explain its architecture and key modules." },
      { icon: Bug, title: "Find and fix a bug", prompt: "Inspect this project, find a real bug, explain the root cause, and fix it." },
      { icon: Sparkles, title: "Build a feature", prompt: "Implement one useful feature for this project. Give a plan before changing code." },
      { icon: FlaskConical, title: "Add tests", prompt: "Add unit tests for the module in this project with the weakest test coverage." },
    ];
  }
  return [
    { icon: FolderSearch, title: "解释这个项目", prompt: "阅读当前工作区，解释这个项目的架构和关键模块。" },
    { icon: Bug, title: "找一个 bug 并修复", prompt: "检查当前项目，找出一个真实的 bug，给出根因分析并修复它。" },
    { icon: Sparkles, title: "实现一个功能", prompt: "帮我给这个项目实现一个实用的小功能，先给计划再动手。" },
    { icon: FlaskConical, title: "补充测试", prompt: "为这个项目中最缺乏测试覆盖的模块补充单元测试。" },
  ];
}

function EmptyState() {
  const history = useAppStore((s) => s.history);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const streaming = useAppStore((s) => s.streaming);
  const language = useAppStore((s) => s.settings.language);
  const tr = (key: Parameters<typeof t>[1]) => t(language, key);

  const stats = useMemo(() => {
    const messages = history.reduce((n, c) => n + c.messages.length, 0);
    const input = history.reduce((n, c) => n + (c.usage?.inputTokens ?? 0), 0);
    const output = history.reduce((n, c) => n + (c.usage?.outputTokens ?? 0), 0);
    const cost = history.reduce((n, c) => n + (c.usage?.costUsd ?? 0), 0);
    const activeDays = new Set(history.map((c) => new Date(c.updatedAt).toDateString())).size;
    return { sessions: history.length, messages, tokens: input + output, cost, activeDays };
  }, [history]);

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-8">
      <div className="flex w-full max-w-2xl flex-col items-center">
        <img src="/grok-gui-cover.png" alt="Grok GUI" className="h-14 w-14 rounded-2xl object-cover" />
        <h2 className="mt-4 text-xl font-semibold tracking-tight">{tr("buildWhat")}</h2>
        <p className="mt-2 max-w-md text-center text-sm leading-relaxed text-muted-foreground">
          {tr("buildPrompt")}
        </p>

        <div className="mt-6 grid w-full grid-cols-2 gap-2.5">
          {suggestions(language).map((s) => (
            <button
              key={s.title}
              type="button"
              disabled={Boolean(streaming)}
              onClick={() => void sendMessage(s.prompt)}
              className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-3 text-left text-[12.5px] font-medium text-card-foreground shadow-sm transition-colors hover:bg-secondary disabled:opacity-50"
            >
              <s.icon size={15} className="shrink-0 text-muted-foreground" />
              {s.title}
            </button>
          ))}
        </div>

        {stats.sessions > 0 && (
          <div className="mt-8 w-full">
            <p className="mb-2 text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
              {tr("localUsage")}
            </p>
            <div className="grid grid-cols-5 gap-2">
              <StatCard label={tr("conversations")} value={String(stats.sessions)} />
              <StatCard label={tr("messages")} value={String(stats.messages)} />
              <StatCard label={tr("totalTokens")} value={formatTokens(stats.tokens)} />
              <StatCard label={tr("cost")} value={formatCost(stats.cost)} />
              <StatCard label={tr("activeDays")} value={String(stats.activeDays)} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5 text-center shadow-sm">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-[13px] font-semibold text-card-foreground">{value}</p>
    </div>
  );
}

function MessageRow({ message }: { message: Message }) {
  const language = useAppStore((s) => s.settings.language);
  const tr = (key: Parameters<typeof t>[1]) => t(language, key);
  const local = (zh: string, en: string) => language === "en-US" ? en : zh;
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [viewingImage, setViewingImage] = useState<{ path: string; alt: string } | null>(null);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const deleteMessage = useAppStore((s) => s.deleteMessage);
  const guideMessage = useAppStore((s) => s.guideMessage);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const copy = async () => {
    if (!canCopyMessage(message)) return;
    try {
      await navigator.clipboard.writeText(copyableMessageText(message));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      console.error("clipboard write failed");
    }
  };

  if (isUser) {
    // 从消息中提取图片附件路径
    const text = message.parts.find(p => p.type === "text")?.text || "";
    const imagePaths: string[] = [];
    const lines = text.split("\n");
    let inFileList = false;
    for (const line of lines) {
      if (line.startsWith("Attached files:")) {
        inFileList = true;
        continue;
      }
      if (inFileList && line.startsWith("- ")) {
        const path = line.slice(2);
        const ext = path.split(".").pop()?.toLowerCase() || "";
        if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif", "ico"].includes(ext)) {
          imagePaths.push(path);
        }
      } else if (inFileList && line.trim() === "") {
        // 文件列表结束
        break;
      }
    }
    
    return (
      <article className="group flex flex-col items-end">
        <div className="max-w-[78%] rounded-2xl bg-secondary px-3.5 py-2 text-[13px] leading-6 text-secondary-foreground">
          {imagePaths.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {imagePaths.map((path, i) => (
                <MessageImagePreview
                  key={i}
                  path={path}
                  alt={path.split("/").pop() || local("图片", "Image")}
                  viewLabel={tr("viewImage")}
                  onOpen={() => setViewingImage({ path, alt: path.split("/").pop() || local("图片", "Image") })}
                />
              ))}
            </div>
          )}
          <p className="whitespace-pre-wrap">{copyableMessageText(message)}</p>
        </div>
        {editing && (
          <div className="mt-2 w-full max-w-[78%] rounded-xl border border-border bg-card p-2 shadow-sm">
            <textarea
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={3}
              className="w-full resize-none bg-transparent text-[12px] leading-5 text-foreground outline-none"
            />
            <div className="mt-1.5 flex justify-end gap-1.5">
              <button type="button" onClick={() => setEditing(false)} className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-secondary">{tr("cancel")}</button>
              <button
                type="button"
                disabled={!draft.trim()}
                onClick={() => {
                  void sendMessage(draft);
                  setEditing(false);
                }}
                className="rounded bg-brand px-2 py-1 text-[11px] font-medium text-brand-foreground disabled:opacity-40"
              >
                {tr("resend")}
              </button>
            </div>
          </div>
        )}
        <div className="mt-1 flex items-center gap-1.5 pr-1 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <span>{relativeTime(message.createdAt, language)}</span>
          <button
            type="button"
            onClick={() => void copy()}
            title={tr("copy")}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
          </button>
          <button
            type="button"
            onClick={() => void guideMessage(message.id)}
            title={tr("guideNext")}
            className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <CornerUpRight size={11} />
            {tr("guide")}
          </button>
          <button
            type="button"
            onClick={() => deleteMessage(message.id)}
            title={tr("delete")}
            className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 size={11} />
          </button>
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-label={local("更多操作", "More actions")}
              title={local("更多操作", "More actions")}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <MoreVertical size={11} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-5 z-30 w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl">
                <button
                  type="button"
                  onClick={() => {
                    setDraft(copyableMessageText(message));
                    setEditing(true);
                    setMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[11px] hover:bg-secondary"
                >
                  <Pencil size={12} className="text-muted-foreground" />
                  {tr("quoteResend")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void guideMessage(message.id);
                    setMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[11px] hover:bg-secondary"
                >
                  <CornerUpRight size={12} className="text-muted-foreground" />
                  {tr("guideNext")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    deleteMessage(message.id);
                    setMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-destructive hover:bg-destructive/10"
                >
                  <Trash2 size={12} />
                  {tr("delete")}
                </button>
              </div>
            )}
          </div>
        </div>
        <ImageLightbox
          src={viewingImage ? imagePreviewUrl(viewingImage.path, convertFileSrc) : null}
          alt={viewingImage?.alt ?? tr("viewImage")}
          closeLabel={tr("closeImage")}
          onClose={() => setViewingImage(null)}
        />
      </article>
    );
  }

  return (
    <article className="group w-full">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground/80">Grok</span>
        <span>· {relativeTime(message.createdAt, language)}</span>
        <button
          type="button"
          onClick={() => void copy()}
          title={tr("copy")}
          className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
        >
          {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
        </button>
      </div>

      <div className="text-[15px] leading-relaxed text-foreground/90">
        {message.parts.map((part, i) => {
          if (part.type === "reasoning") {
            return <ThoughtBlock key={i} thought={part.thought} />;
          }
          if (part.type === "text") {
            return (
              <div
                key={i}
                className="prose prose-sm max-w-none dark:prose-invert prose-pre:bg-secondary prose-pre:text-foreground"
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore" }]]}
                >
                  {normalizeGrokMarkdown(part.text)}
                </ReactMarkdown>
              </div>
            );
          }
          if (part.type === "tool_call") {
            return (
              <div key={i} className="my-2">
                <ConfiguredToolCall call={part.call} />
              </div>
            );
          }
          return null;
        })}
      </div>
    </article>
  );
}

function MessageImagePreview({ path, alt, viewLabel, onOpen }: { path: string; alt: string; viewLabel: string; onOpen: () => void }) {
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    let current = true;
    const authorize = async () => {
      if (!(window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
        setAuthorized(true);
        return;
      }
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("allow_image_preview", { path });
        if (current) setAuthorized(true);
      } catch (error) {
        console.error("message image preview authorization failed:", error);
      }
    };
    void authorize();
    return () => { current = false; };
  }, [path]);

  if (!authorized) {
    return <div aria-label={alt} className="h-24 w-36 animate-pulse rounded-lg bg-muted" />;
  }

  return (
    <button type="button" aria-label={`${alt} — ${viewLabel}`} title={viewLabel} onClick={onOpen} className="block max-w-full cursor-zoom-in">
      <img
        src={imagePreviewUrl(path, convertFileSrc)}
        alt={alt}
        className="max-h-80 max-w-full rounded-lg bg-background/30 object-contain"
      />
    </button>
  );
}

function StreamingBubble() {
  const streaming = useAppStore((s) => s.streaming);
  const language = useAppStore((s) => s.settings.language);
  const local = (zh: string, en: string) => language === "en-US" ? en : zh;
  if (!streaming) return null;

  const busy = !streaming.text;

  return (
    <article className="w-full">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <BrainCircuit size={12} />
        <span className="font-medium text-foreground/80">Grok</span>
        <span>· {local("正在工作", "Working")}</span>
      </div>
      <ActivityTimeline
        actions={streaming.actions}
      />
      <div className="text-[13px] leading-7 text-foreground/90">
        {streaming.parts.map((part, index) => {
          if (part.type === "reasoning") return <ThoughtBlock key={part.thought.id} thought={part.thought} live />;
          if (part.type === "tool_call") return <ConfiguredToolCall key={part.call.id} call={part.call} />;
          const isLatest = index === streaming.parts.length - 1;
          return (
            <div key={`${part.type}-${index}`} className="prose prose-sm max-w-none dark:prose-invert prose-pre:bg-secondary prose-pre:text-foreground">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
              {shouldShowStreamingCaret(part.text, isLatest) && <span className="streaming-caret" />}
            </div>
          );
        })}
        {streaming.parts.length === 0 && (
          <span className="flex items-center gap-1 py-1 text-muted-foreground">
            <span className="typing-dot h-1.5 w-1.5 rounded-full bg-current" />
            <span className="typing-dot h-1.5 w-1.5 rounded-full bg-current" />
            <span className="typing-dot h-1.5 w-1.5 rounded-full bg-current" />
          </span>
        )}
      </div>
      {busy && streaming.actions.length === 0 && streaming.parts.length === 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground/70">{local("启动 Agent…", "Starting agent…")}</p>
      )}
    </article>
  );
}

function ActivityTimeline({
  actions,
}: {
  actions: AgentAction[];
}) {
  const language = useAppStore((s) => s.settings.language);
  const local = (zh: string, en: string) => language === "en-US" ? en : zh;
  const activeCount = actions.filter((action) => action.outcome === "announced").length;
  if (activeCount === 0) return null;

  return (
    <p className="mb-1 px-1 text-xs text-muted-foreground">
      {local("正在执行", "Running")} · {activeCount} {local("项操作", "actions")}
    </p>
  );
}

function ConfiguredToolCall({ call }: { call: ToolCallRecord }) {
  const settings = useAppStore((s) => s.settings);
  const defaultOpen = /^shell|bash|exec|run|terminal/i.test(call.name)
    ? settings.expandShellToolParts
    : /write|edit|patch|apply/i.test(call.name)
      ? settings.expandEditToolParts
      : false;
  return <ToolCallCard call={call} defaultOpen={defaultOpen} />;
}

function formatThoughtDuration(startedAt: number, finishedAt?: number) {
  const milliseconds = Math.max(100, (finishedAt ?? Date.now()) - startedAt);
  return `${(milliseconds / 1000).toFixed(milliseconds < 1_000 ? 1 : 0)}s`;
}

function ThoughtBlock({ thought, live = false }: { thought: ThoughtRecord; live?: boolean }) {
  const [now, setNow] = useState(Date.now());
  const showReasoning = useAppStore((s) => s.settings.showReasoningSummary);
  const active = live && !thought.finishedAt;

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [active]);

  const duration = formatThoughtDuration(thought.startedAt, thought.finishedAt ?? now);
  if (!showReasoning || !thought.text) return null;
  return (
    <details data-testid="thought-row" open={active} className="mb-1.5 px-1 py-0.5 text-[12px] text-muted-foreground">
      <summary className="cursor-pointer select-none font-medium marker:content-none">
        {active ? `Thinking · ${duration}` : `Thought · ${duration}`}
      </summary>
      <p className="mt-1 whitespace-pre-wrap leading-relaxed">{thought.text}</p>
    </details>
  );
}
