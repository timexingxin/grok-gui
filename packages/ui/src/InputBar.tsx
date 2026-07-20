import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send,
  ShieldAlert,
  Check,
  ChevronDown,
  Square,
  Plus,
  X,
  FileText,
  Image as ImageIcon,
  File,
  Shield,
  Eye,
  AlertTriangle,
  Unlock,
  Lock,
  Hand,
  Cpu,
  Brain,
  FolderGit2,
  GitBranch,
  ListPlus,
  MoreVertical,
  CornerUpRight,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  useAppStore,
  type PermissionLevel,
  type ReasoningEffort,
  type UiLanguage,
} from "@grok-gui/core";
import { cn, formatTokens } from "@grok-gui/core/utils";
import { convertFileSrc } from "@tauri-apps/api/core";
import { shouldSubmitOnEnter } from "./composition-input";
import { imagePreviewUrl } from "./image-preview";
import { ImageLightbox } from "./ImageLightbox";
import { t } from "./i18n";

interface PermissionLevelOption {
  id: PermissionLevel;
  label: string;
  detail: string;
}

function permissionLevels(language: UiLanguage): PermissionLevelOption[] {
  const english = language === "en-US";
  return [
    { id: "always_ask", label: english ? "Always ask" : "永远询问", detail: english ? "Ask before every tool call; safest." : "每次工具调用都询问；最安全" },
    { id: "read_only", label: english ? "Read only" : "仅读取", detail: english ? "Read actions run automatically; writes and commands ask." : "读取类工具自动执行；写入和命令会询问" },
    { id: "sensitive_ask", label: english ? "Ask for sensitive actions" : "敏感询问", detail: english ? "Routine reads run automatically; sensitive actions ask." : "普通读取自动执行；敏感操作先询问" },
    { id: "ask_write", label: english ? "Ask before workspace writes" : "询问写工作区", detail: english ? "Ask before workspace edits; host commands and outside writes are blocked." : "修改工作区文件前会询问；工作区外写入和主机命令会被阻止" },
    { id: "trust_workspace", label: english ? "Trust workspace" : "信任工作区", detail: english ? "Workspace edits run without prompts; outside writes and host commands stay blocked." : "工作区内文件修改不再询问；工作区外写入和主机命令仍被阻止" },
    { id: "full_access", label: english ? "Full access" : "完全访问", detail: english ? "No prompts; can access the network and any local file." : "不询问且拥有完整权限，访问网络和任何文件" },
  ];
}

const permissionIcons: Record<PermissionLevel, typeof Hand> = {
  always_ask: Hand,
  read_only: Eye,
  sensitive_ask: AlertTriangle,
  ask_write: Unlock,
  trust_workspace: Shield,
  full_access: Lock,
};

const permissionTints: Record<PermissionLevel, { chip: string; iconColor: string; text: string }> = {
  always_ask:      { chip: "bg-slate-500/15",    iconColor: "text-slate-500",    text: "text-slate-600 dark:text-slate-300" },
  read_only:       { chip: "bg-emerald-500/15",  iconColor: "text-emerald-500",  text: "text-emerald-600 dark:text-emerald-300" },
  sensitive_ask:   { chip: "bg-amber-500/15",    iconColor: "text-amber-500",    text: "text-amber-600 dark:text-amber-300" },
  ask_write:       { chip: "bg-sky-500/15",      iconColor: "text-sky-500",      text: "text-sky-600 dark:text-sky-300" },
  trust_workspace: { chip: "bg-indigo-500/15",   iconColor: "text-indigo-500",   text: "text-indigo-600 dark:text-indigo-300" },
  full_access:     { chip: "bg-orange-500/15",   iconColor: "text-orange-500",   text: "text-orange-600 dark:text-orange-300" },
};

function effortOptions(language: "zh-CN" | "en-US"): Array<{ id: ReasoningEffort; label: string }> {
  return [
    { id: "low", label: t(language, "low") },
    { id: "medium", label: t(language, "medium") },
    { id: "high", label: t(language, "high") },
  ];
}

interface Attachment {
  path: string;
  name: string;
  kind: "text" | "image" | "pdf" | "binary";
}

const TEXT_EXTS = ["txt","md","py","ts","tsx","js","jsx","json","yaml","yml","toml","rs","go","sh","bash","css","html","xml","csv","sql","java","c","cpp","h","rb","php","swift","kt","dart","lua","vim","diff","log","env","gitignore","dockerfile","makefile"];
const IMAGE_EXTS = ["png","jpg","jpeg","gif","webp","bmp","svg","heic","heif","ico"];
const PDF_EXTS = ["pdf"];

function classifyFile(name: string): Attachment["kind"] {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (TEXT_EXTS.includes(ext)) return "text";
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (PDF_EXTS.includes(ext)) return "pdf";
  return "binary";
}

function attachmentIcon(kind: Attachment["kind"]) {
  if (kind === "image") return ImageIcon;
  if (kind === "pdf") return File;
  return FileText;
}

export function InputBar() {
  const [text, setText] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [levelOpen, setLevelOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [queueDraft, setQueueDraft] = useState("");
  const [queueMenuId, setQueueMenuId] = useState<string | null>(null);
  const queueMenuRef = useRef<HTMLDivElement>(null);
  const [viewingAttachment, setViewingAttachment] = useState<Attachment | null>(null);
  const send = useAppStore((s) => s.sendMessage);
  const activeModel = useAppStore((s) => s.activeModel);
  const setActiveModel = useAppStore((s) => s.setActiveModel);
  const providers = useAppStore((s) => s.providers);
  const availableModels = useAppStore((s) => s.availableModels);
  const session = useAppStore((s) => s.session);
  const workspace = useAppStore((s) => s.workspace);
  const streaming = useAppStore((s) => s.streaming);
  const switching = useAppStore((s) => s.switching);
  const queuedCount = useAppStore((s) => s.queuedMessages.length);
  const queuedMessages = useAppStore((s) => s.queuedMessages);
  const deleteQueuedMessage = useAppStore((s) => s.deleteQueuedMessage);
  const editQueuedMessage = useAppStore((s) => s.editQueuedMessage);
  const guideQueuedMessage = useAppStore((s) => s.guideQueuedMessage);
  const cancelPending = useAppStore((s) => s.cancelPending);
  const stopGenerating = useAppStore((s) => s.stopGenerating);
  const permissionLevel = useAppStore((s) => s.permissionLevel);
  const setPermissionLevel = useAppStore((s) => s.setPermissionLevel);
  const reasoningEffort = useAppStore((s) => s.reasoningEffort);
  const setReasoningEffort = useAppStore((s) => s.setReasoningEffort);
  const permission = useAppStore((s) => s.permissionRequest);
  const respondPermission = useAppStore((s) => s.respondPermission);
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const showTokenUsage = useAppStore((s) => s.settings.showTokenUsage);
  const language = useAppStore((s) => s.settings.language);
  const tr = (key: Parameters<typeof t>[1]) => t(language, key);
  const local = (zh: string, en: string) => language === "en-US" ? en : zh;
  const contextTokens = useAppStore((s) => s.contextTokens);
  const compacting = useAppStore((s) => s.compacting);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const effortRef = useRef<HTMLDivElement>(null);
  const levelRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const supportsOfficialEffort = activeModel?.providerId === "xai" && activeModel.id === "grok-4.5";

  const contextWindow = activeModel?.contextWindow ?? 0;
  // Prefer the agent's live occupancy (`_meta.totalTokens`); cumulative turn
  // usage is a billing metric and wildly overstates the window.
  const contextUsed = contextTokens > 0
    ? contextTokens
    : (session?.inputTokens ?? 0) + (session?.outputTokens ?? 0);
  const contextPercent = contextWindow > 0
    ? Math.min(100, Math.round((contextUsed / contextWindow) * 100))
    : 0;

  const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (!queueMenuId) return;
    const close = (e: MouseEvent) => {
      if (!queueMenuRef.current?.contains(e.target as Node)) setQueueMenuId(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [queueMenuId]);

  useEffect(() => {
    if (!modelOpen) return;
    const close = (e: MouseEvent) => {
      if (!modelRef.current?.contains(e.target as Node)) setModelOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [modelOpen]);

  useEffect(() => {
    if (!contextOpen) return;
    const close = (e: MouseEvent) => {
      if (!contextRef.current?.contains(e.target as Node)) setContextOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [contextOpen]);

  const handleSelectModel = useCallback(async (providerId: string, modelId: string) => {
    setModelError(null);
    try {
      await setActiveModel(providerId, modelId);
      setModelOpen(false);
    } catch (error) {
      setModelError(String(error));
    }
  }, [setActiveModel]);

  useEffect(() => {
    setText("");
    setAttachments([]);
    setEditingQueueId(null);
    setQueueDraft("");
    setQueueMenuId(null);
  }, [activeConversationId]);

  const addAttachments = useCallback(async (newAttachments: Attachment[]) => {
    if (isTauri) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await Promise.all(newAttachments
          .filter((attachment) => attachment.kind === "image")
          .map((attachment) => invoke("allow_image_preview", { path: attachment.path })));
      } catch (error) {
        // Keep the attachment sendable even when its preview cannot be shown.
        console.error("image preview authorization failed:", error);
      }
    }
    setAttachments((previous) => [...previous, ...newAttachments]);
  }, [isTauri]);

  useEffect(() => {
    if (!isTauri) return;
    let unlistenDrop: (() => void) | null = null;
    let unlistenEnter: (() => void) | null = null;
    let unlistenLeave: (() => void) | null = null;

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenEnter = await listen("tauri://drag-enter", () => setDragOver(true));
      unlistenLeave = await listen("tauri://drag-leave", () => setDragOver(false));
      unlistenDrop = await listen<{ paths: string[] }>("tauri://drag-drop", (event) => {
        setDragOver(false);
        const newAttachments: Attachment[] = event.payload.paths.map((p) => {
          const name = p.split("/").pop() ?? p;
          return { path: p, name, kind: classifyFile(name) };
        });
        void addAttachments(newAttachments);
      });
    })();

    return () => {
      unlistenEnter?.();
      unlistenLeave?.();
      unlistenDrop?.();
    };
  }, [addAttachments, isTauri]);

  const pickFiles = useCallback(async () => {
    if (!isTauri) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ multiple: true, directory: false });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const newAttachments: Attachment[] = paths.map((p: string) => {
        const name = p.split("/").pop() ?? p;
        return { path: p, name, kind: classifyFile(name) };
      });
      await addAttachments(newAttachments);
    } catch (error) {
      console.error("file picker failed:", error);
    }
  }, [addAttachments, isTauri]);

  const removeAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  }, []);

  useEffect(() => {
    taRef.current?.focus();
  }, []);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }, [text]);

  useEffect(() => {
    if (!effortOpen) return;
    const closeIfOutside = (event: MouseEvent) => {
      if (!effortRef.current?.contains(event.target as Node)) setEffortOpen(false);
    };
    document.addEventListener("mousedown", closeIfOutside);
    return () => document.removeEventListener("mousedown", closeIfOutside);
  }, [effortOpen]);

  useEffect(() => {
    if (!levelOpen) return;
    const closeIfOutside = (event: MouseEvent) => {
      if (!levelRef.current?.contains(event.target as Node)) setLevelOpen(false);
    };
    document.addEventListener("mousedown", closeIfOutside);
    return () => document.removeEventListener("mousedown", closeIfOutside);
  }, [levelOpen]);

  const handleSetLevel = useCallback(async (id: PermissionLevel) => {
    setModeError(null);
    try {
      await setPermissionLevel(id);
    } catch (error) {
      setModeError(String(error));
    }
  }, [setPermissionLevel]);

  const handleSetEffort = useCallback(async (id: ReasoningEffort) => {
    setModeError(null);
    try {
      await setReasoningEffort(id);
    } catch (error) {
      setModeError(String(error));
    }
  }, [setReasoningEffort]);

  const submit = useCallback(async () => {
    const value = text.trim();
    if (!value && attachments.length === 0) return;
    // Keep the draft visible while a permission-level restart is in progress.
    // The store deliberately ignores sends during this transition as well.
    if (switching) return;
    let message = value;
    if (attachments.length > 0) {
      const fileList = attachments.map((a) => `- ${a.path}`).join("\n");
      const imageNote = attachments.some((a) => a.kind === "image")
        ? local("\n\n注意：包含图片文件。请使用工具读取或查看图片路径。", "\n\nNote: image files are attached. Use a tool to read or view their paths.")
        : "";
      const prefix = message ? `${message}\n\n` : "";
      message = `${prefix}Attached files:\n${fileList}${imageNote}`;
    }
    setText("");
    setAttachments([]);
    await send(message);
  }, [text, attachments, send, switching, local]);

  const levels = permissionLevels(language);
  const currentLevel = levels.find((entry) => entry.id === permissionLevel) ?? levels[4];
  const currentTint = permissionTints[currentLevel.id];
  const CurrentPermissionIcon = permissionIcons[currentLevel.id];
  const efforts = effortOptions(language);

  return (
    <div className="shrink-0 bg-background px-4 pb-2 pt-1">
      <div className="mx-auto" style={{ maxWidth: "var(--chat-max-width, 960px)" }}>
        {modeError && (
          <div className="mb-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            {local("模式切换失败：", "Permission change failed: ")}{modeError}
          </div>
        )}

        {permission && (
          <div className="mb-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
            <div className="flex items-start gap-2">
              <ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">{permission.title}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300/80">{permission.detail}</p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                {permission.options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => void respondPermission(option.id)}
                    className={cn(
                      "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                      /deny|reject|cancel/i.test(option.id)
                        ? "border border-amber-500/50 text-amber-900 hover:bg-amber-500/20 dark:text-amber-200"
                        : "bg-foreground text-background hover:opacity-85",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {queuedMessages.length > 0 && (
          <div className="mb-2 rounded-2xl border border-brand/30 bg-brand/5 p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[11px] font-medium text-brand">
              <ListPlus size={12} />
              {local(`排队中 ${queuedMessages.length} 条`, `${queuedMessages.length} queued`)}
            </div>
            <div className="flex flex-col gap-1.5">
              {queuedMessages.map((message, index) => (
                <div
                  key={message.id}
                  className="group flex items-start gap-2 rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5"
                >
                  <span className="mt-0.5 inline-flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-full bg-brand/15 px-1 text-[10px] font-medium text-brand">
                    {index + 1}
                  </span>
                  {editingQueueId === message.id ? (
                    <div className="min-w-0 flex-1">
                      <textarea
                        autoFocus
                        value={queueDraft}
                        onChange={(e) => setQueueDraft(e.target.value)}
                        rows={2}
                        className="w-full resize-none rounded-md border border-border bg-background px-2 py-1 text-[12px] leading-5 outline-none focus:border-brand/50"
                      />
                      <div className="mt-1 flex justify-end gap-1.5">
                        <button type="button" onClick={() => setEditingQueueId(null)} className="rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary">{tr("cancel")}</button>
                        <button
                          type="button"
                          disabled={!queueDraft.trim()}
                          onClick={() => {
                            editQueuedMessage(message.id, queueDraft);
                            setEditingQueueId(null);
                          }}
                          className="rounded bg-brand px-2 py-0.5 text-[10px] font-medium text-brand-foreground disabled:opacity-40"
                        >
                          {tr("save")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-foreground">
                        {message.text}
                      </p>
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={() => guideQueuedMessage(message.id)}
                          title={tr("guideNext")}
                          className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
                        >
                          <CornerUpRight size={11} />
                          {tr("guide")}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setQueueDraft(message.text);
                            setEditingQueueId(message.id);
                          }}
                          title={tr("edit")}
                          className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteQueuedMessage(message.id)}
                          title={tr("delete")}
                          className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 size={11} />
                        </button>
                        <div className="relative" ref={queueMenuId === message.id ? queueMenuRef : undefined}>
                          <button
                            type="button"
                            onClick={() => setQueueMenuId((cur) => cur === message.id ? null : message.id)}
                            aria-label={local("更多操作", "More actions")}
                            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                          >
                            <MoreVertical size={11} />
                          </button>
                          {queueMenuId === message.id && (
                            <div className="absolute right-0 top-5 z-30 w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl">
                              <button
                                type="button"
                                onClick={() => {
                                  setQueueDraft(message.text);
                                  setEditingQueueId(message.id);
                                  setQueueMenuId(null);
                                }}
                                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[11px] hover:bg-secondary"
                              >
                                <Pencil size={12} className="text-muted-foreground" />
                                {tr("edit")}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  guideQueuedMessage(message.id);
                                  setQueueMenuId(null);
                                }}
                                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[11px] hover:bg-secondary"
                              >
                                <CornerUpRight size={12} className="text-muted-foreground" />
                                {tr("guideNext")}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  deleteQueuedMessage(message.id);
                                  setQueueMenuId(null);
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
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className={cn(
          "rounded-2xl border bg-card shadow-sm transition-colors focus-within:border-brand/50 focus-within:ring-2 focus-within:ring-brand/15",
          dragOver ? "border-brand ring-2 ring-brand/20" : "border-border",
        )}>
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b border-border px-3 pt-2.5 pb-1">
              {attachments.map((att) => {
                const Icon = attachmentIcon(att.kind);
                if (att.kind === "image") {
                  return (
                    <span key={att.path} className="group relative block h-24 w-36 overflow-hidden rounded-lg border border-border bg-secondary text-[11px] text-secondary-foreground shadow-sm">
                      <button
                        type="button"
                        aria-label={`${tr("viewImage")}: ${att.name}`}
                        title={tr("viewImage")}
                        onClick={() => setViewingAttachment(att)}
                        className="block h-full w-full"
                      >
                        <img
                          src={imagePreviewUrl(att.path, convertFileSrc)}
                          alt={att.name}
                          className="h-full w-full object-contain"
                        />
                      </button>
                      <span className="absolute inset-x-0 bottom-0 truncate bg-background/85 px-1.5 py-1 text-[10px] backdrop-blur-sm">
                        {att.name}
                      </span>
                      <button type="button" aria-label={`${local("移除", "Remove")} ${att.name}`} onClick={() => removeAttachment(att.path)} className="absolute right-1 top-1 rounded-full bg-background/90 p-1 text-muted-foreground opacity-100 shadow-sm hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100">
                        <X size={11} />
                      </button>
                    </span>
                  );
                }
                return (
                  <span key={att.path} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary px-2 py-1 text-[11px] text-secondary-foreground">
                    <Icon size={12} className="shrink-0 text-muted-foreground" />
                    <span className="max-w-40 truncate">{att.name}</span>
                    <button type="button" onClick={() => removeAttachment(att.path)} className="text-muted-foreground hover:text-destructive">
                      <X size={11} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          <textarea
            ref={taRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            onKeyDown={(event) => {
              if (shouldSubmitOnEnter(event.nativeEvent, isComposing)) {
                event.preventDefault();
                void submit();
              }
            }}
            onPaste={(event) => {
              const items = event.clipboardData?.items;
              if (!items) return;
              const imageFiles: File[] = [];
              for (let i = 0; i < items.length; i++) {
                if (items[i].kind === "file") {
                  const file = items[i].getAsFile();
                  if (file && file.type.startsWith("image/")) {
                    imageFiles.push(file);
                  }
                }
              }
              if (imageFiles.length === 0) return;
              event.preventDefault();
              for (const file of imageFiles) {
                const reader = new FileReader();
                reader.onload = async () => {
                  try {
                    const { invoke } = await import("@tauri-apps/api/core");
                    const ts = Date.now().toString(36);
                    const ext = file.type.split("/")[1] === "jpeg" ? "jpg" : (file.type.split("/")[1] ?? "png");
                    const filename = `clipboard-${ts}.${ext}`;
                    const dataUrl = reader.result as string;
                    const base64 = dataUrl.split(",")[1] ?? dataUrl;
                    const workspace = session?.workspace ?? "~";
                    // The backend expands ~ and returns the absolute path the
                    // agent can actually read; never reassemble it client-side.
                    const savedPath = await invoke<string>("save_clipboard_image", { workspacePath: workspace, filename, base64 });
                    await addAttachments([{ path: savedPath, name: filename, kind: "image" }]);
                  } catch (error) {
                    console.error("clipboard image save failed:", error);
                  }
                };
                reader.readAsDataURL(file);
              }
            }}
            placeholder={tr("promptPlaceholder")}
            rows={1}
            className="block w-full resize-none bg-transparent px-4 py-3 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <div className="flex items-center gap-1.5 px-2.5 pb-2">
            <button
              type="button"
              aria-label={tr("addFiles")}
              title={tr("addFileDetail")}
              onClick={() => void pickFiles()}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-secondary text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Plus size={16} />
            </button>
            <div className="relative" ref={levelRef}>
              <button
                type="button"
                aria-expanded={levelOpen}
                aria-label={tr("permissionLevel")}
                title={currentLevel.detail}
                disabled={Boolean(streaming) || switching}
                onClick={() => setLevelOpen((open) => !open)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1 text-[11px] font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45",
                  currentTint.text,
                )}
              >
                <CurrentPermissionIcon size={12} className={currentTint.iconColor} />
                {currentLevel.label}
                <ChevronDown size={11} className="opacity-60" />
              </button>
              {levelOpen && (
                <div className="absolute bottom-9 left-0 z-30 w-72 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl">
                  <p className="px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{tr("workspacePermissions")}</p>
                  {levels.map((entry) => {
                    const Icon = permissionIcons[entry.id];
                    const selected = entry.id === permissionLevel;
                    const tint = permissionTints[entry.id];
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => {
                          setLevelOpen(false);
                          void handleSetLevel(entry.id);
                        }}
                        className={cn(
                          "flex w-full items-start gap-2 rounded-lg border px-2 py-1.5 text-left text-[12px] transition-colors",
                          selected
                            ? "border-brand/40 bg-brand/5"
                            : "border-transparent hover:bg-secondary",
                        )}
                      >
                        <span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md", tint.chip)}>
                          <Icon size={14} className={tint.iconColor} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-1.5">
                            <span className="font-medium text-popover-foreground">{entry.label}</span>
                            {selected && <Check size={12} className="text-brand" />}
                          </span>
                          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{entry.detail}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              {/* Context capacity ring */}
              <div className="relative" ref={contextRef}>
                <button
                  type="button"
                  aria-label={tr("contextCapacity")}
                  title={tr("contextCapacityDetail")}
                  onClick={() => setContextOpen((open) => !open)}
                  className="relative flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-secondary"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5 -rotate-90">
                    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="2.5" />
                    <circle
                      cx="12" cy="12" r="9" fill="none"
                      stroke={contextPercent >= 85 ? "#f59e0b" : "var(--brand)"}
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeDasharray={`${(contextPercent / 100) * 56.55} 56.55`}
                    />
                  </svg>
                </button>
                {contextOpen && (
                  <div className="absolute bottom-9 right-0 z-30 w-64 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl">
                    <div className="flex items-baseline justify-between">
                      <p className="text-[11px] font-medium text-muted-foreground">{tr("contextCapacity")}</p>
                      <p className="font-mono text-[11px] text-popover-foreground">
                        {formatTokens(contextUsed)} / {formatTokens(contextWindow)} · {contextPercent}%
                      </p>
                    </div>
                    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-secondary">
                      <div
                        className={cn("h-full rounded-full", contextPercent >= 85 ? "bg-amber-500" : "bg-brand")}
                        style={{ width: `${Math.max(contextPercent, contextUsed > 0 ? 2 : 0)}%` }}
                      />
                    </div>
                    <div className="mt-3 space-y-1.5 text-[11px]">
                      <ContextRow color="bg-blue-400" label={local("系统工具", "System tools")} value={Math.round(contextUsed * 0.2)} />
                      <ContextRow color="bg-violet-400" label={local("系统提示词", "System prompt")} value={Math.round(contextUsed * 0.08)} />
                      <ContextRow color="bg-emerald-500" label={local("技能", "Skills")} value={Math.round(contextUsed * 0.04)} />
                      <ContextRow color="bg-orange-400" label={local("消息", "Messages")} value={Math.max(0, contextUsed - Math.round(contextUsed * 0.32))} />
                      <ContextRow color="bg-zinc-400/40" label={local("空闲", "Available")} value={Math.max(0, contextWindow - contextUsed)} />
                    </div>
                    <p className="mt-2 text-[10px] text-muted-foreground">
                      {local("当前上下文实时占用（来自 agent 上报），分类占比为估算。", "Live context use reported by the agent; category shares are estimates.")}
                    </p>
                  </div>
                )}
              </div>

              {/* Model selector */}
              <div className="relative" ref={modelRef}>
                <button
                  type="button"
                  aria-label={tr("model")}
                  aria-expanded={modelOpen}
                  disabled={Boolean(streaming) || switching}
                  onClick={() => { setModelError(null); setModelOpen((open) => !open); }}
                  className="flex items-center gap-1.5 rounded-md border border-brand/25 bg-brand/10 px-2 py-1 text-[12px] font-medium text-brand transition-colors hover:bg-brand/15 disabled:opacity-50"
                >
                  <span className="flex h-4 w-4 items-center justify-center rounded bg-brand/20">
                    <Cpu size={9} />
                  </span>
                  {activeModel?.label ?? tr("model")}
                  <ChevronDown size={11} className="opacity-60" />
                </button>
                {modelOpen && (
                  <div className="absolute bottom-9 right-0 z-30 w-72 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl">
                    <p className="px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {availableModels.length > 0 ? local("Agent 提供的模型", "Models provided by agent") : tr("model")}
                    </p>
                    {modelError && (
                      <div className="mx-1 mb-1 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
                        {local("切换失败：", "Switch failed: ")}{modelError}
                      </div>
                    )}
                    {availableModels.length > 0 ? (
                      availableModels.map((m) => {
                        const selected = activeModel?.id === m.id;
                        return (
                          <button
                            key={m.id}
                            type="button"
                            disabled={Boolean(streaming) || switching}
                            onClick={() => void handleSelectModel(activeModel?.providerId ?? "xai", m.id)}
                            className={cn(
                              "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-secondary disabled:opacity-50",
                              selected ? "text-brand" : "text-popover-foreground",
                            )}
                          >
                            <span>{m.label}</span>
                            <div className="flex items-center gap-1.5">
                              {m.contextWindow && <span className="text-[10px] text-muted-foreground">{formatTokens(m.contextWindow)}</span>}
                              {selected && <Check size={12} className="text-brand" />}
                            </div>
                          </button>
                        );
                      })
                    ) : providers.length === 0 ? (
                      <div className="px-2 py-1.5 text-[11px] text-muted-foreground">{local("无可用模型", "No models available")}</div>
                    ) : (
                      providers.map((p) => (
                        <div key={p.id}>
                          <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{p.name}</div>
                          {p.models.map((m) => (
                            <button
                              key={`${p.id}:${m.id}`}
                              type="button"
                              disabled={Boolean(streaming) || switching}
                              onClick={() => void handleSelectModel(p.id, m.id)}
                              className={cn(
                                "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-secondary disabled:opacity-50",
                                activeModel?.id === m.id && activeModel.providerId === p.id ? "text-brand" : "text-popover-foreground",
                              )}
                            >
                              <span>{m.label}</span>
                              <div className="flex items-center gap-1.5">
                                {m.context && <span className="text-[10px] text-muted-foreground">{formatTokens(m.context)}</span>}
                                {activeModel?.id === m.id && activeModel.providerId === p.id && <Check size={12} className="text-brand" />}
                              </div>
                            </button>
                          ))}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Reasoning effort (Grok 4.5 only) */}
              {supportsOfficialEffort && (
                <div className="relative" ref={effortRef}>
                  <button
                    type="button"
                    aria-expanded={effortOpen}
                    aria-label={local("Grok 4.5 官方推理强度", "Grok 4.5 reasoning effort")}
                    title={local("Grok 4.5 官方推理强度。切换后会重新连接 Agent，并从下一条消息生效。", "Grok 4.5 reasoning effort. Changing it reconnects the agent and applies from the next message.")}
                    disabled={Boolean(streaming) || switching}
                    onClick={() => setEffortOpen((open) => !open)}
                    className="flex items-center gap-1.5 rounded-md border border-violet-500/25 bg-violet-500/10 px-2 py-1 text-[12px] font-medium text-violet-600 transition-colors hover:bg-violet-500/15 disabled:opacity-50 dark:text-violet-300"
                  >
                    <span className="flex h-4 w-4 items-center justify-center rounded bg-violet-500/20">
                      <Brain size={9} />
                    </span>
                    {efforts.find((option) => option.id === reasoningEffort)?.label}
                    <ChevronDown size={11} className="opacity-60" />
                  </button>
                  {effortOpen && (
                    <div className="absolute bottom-9 right-0 z-30 w-36 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl">
                      <p className="px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{local("Grok 4.5 官方档位", "Grok 4.5 official levels")}</p>
                      {efforts.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => { setEffortOpen(false); void handleSetEffort(option.id); }}
                          className={cn(
                            "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] transition-colors",
                            reasoningEffort === option.id ? "text-brand" : "text-popover-foreground hover:bg-secondary",
                          )}
                        >
                          {option.label}
                          {reasoningEffort === option.id && <Check size={13} className="text-brand" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Send / Stop */}
              {switching ? (
                <button
                  type="button"
                  aria-label={tr("applyingPermissions")}
                  title={tr("applyingPermissions")}
                  disabled
                  className="flex h-7 items-center gap-1.5 rounded-md bg-secondary px-2 text-[11px] font-medium text-muted-foreground"
                >
                  <span className="h-3 w-3 animate-spin rounded-full border border-muted-foreground/40 border-t-foreground" />
                  {tr("applyingPermissions")}
                </button>
              ) : streaming ? (
                <>
                  <button
                    type="button"
                    aria-label={tr("send")}
                    title={queuedCount > 0 ? `${tr("send")} (${queuedCount})` : tr("send")}
                    onClick={() => void submit()}
                    disabled={!text.trim() && attachments.length === 0}
                    className={cn(
                      "flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-all",
                      text.trim() || attachments.length > 0
                        ? "bg-brand text-brand-foreground hover:opacity-90"
                        : "bg-secondary text-muted-foreground",
                    )}
                  >
                    <Send size={12} /> {tr("send")}
                  </button>
                  {streaming && (
                    <button
                      type="button"
                      aria-label={tr("stop")}
                      title={tr("stop")}
                      onClick={() => void stopGenerating()}
                      disabled={cancelPending}
                      className="flex h-7 w-7 items-center justify-center rounded-md bg-red-500 text-white transition-colors hover:bg-red-600 disabled:bg-red-300"
                    >
                      <Square size={11} fill="currentColor" />
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  aria-label={tr("send")}
                  onClick={() => void submit()}
                  disabled={!text.trim() && attachments.length === 0}
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-md transition-all",
                    text.trim() || attachments.length > 0
                      ? "bg-brand text-brand-foreground hover:opacity-90"
                      : "bg-secondary text-muted-foreground",
                  )}
                >
                  <Send size={13} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Status strip: workspace · git · usage */}
        <div className="flex items-center gap-2 px-2 pt-1.5 text-[10px] text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1">
            <FolderGit2 size={10} className="shrink-0" />
            <span className="truncate font-mono">{session?.workspace ?? "~"}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <GitBranch size={10} />
            {workspace?.branch ?? local("未检测到 Git", "Git not detected")}
          </span>
          {showTokenUsage && (
            <span className="ml-auto shrink-0 font-mono">
              {compacting ? local("正在压缩上下文…", "Compacting context…") : contextUsed > 0 ? `${formatTokens(contextUsed)} tokens` : local("暂无用量", "No usage yet")}
            </span>
          )}
        </div>
        <ImageLightbox
          src={viewingAttachment ? imagePreviewUrl(viewingAttachment.path, convertFileSrc) : null}
          alt={viewingAttachment?.name ?? tr("viewImage")}
          closeLabel={tr("closeImage")}
          onClose={() => setViewingAttachment(null)}
        />
      </div>
    </div>
  );
}

function ContextRow({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", color)} />
      <span className="flex-1 text-muted-foreground">{label}</span>
      <span className="font-mono text-popover-foreground">{formatTokens(value)}</span>
    </div>
  );
}
