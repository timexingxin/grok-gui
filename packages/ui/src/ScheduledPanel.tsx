import { useEffect, useState } from "react";
import {
  Plus,
  Play,
  Pause,
  Trash2,
  Clock,
  CheckCircle2,
  AlertCircle,
  Cpu,
  ArrowLeft,
} from "lucide-react";
import { useAppStore, type ScheduledTask } from "@grok-gui/core";
import { cn, relativeTime } from "@grok-gui/core/utils";
import { t } from "./i18n";

const priorityColors: Record<ScheduledTask["priority"], { bg: string; text: string; border: string }> = {
  low: { bg: "bg-emerald-500/10", text: "text-emerald-600 dark:text-emerald-300", border: "border-emerald-500/30" },
  medium: { bg: "bg-amber-500/10", text: "text-amber-600 dark:text-amber-300", border: "border-amber-500/30" },
  high: { bg: "bg-red-500/10", text: "text-red-600 dark:text-red-300", border: "border-red-500/30" },
};

const statusIcons: Record<ScheduledTask["status"], typeof CheckCircle2> = {
  pending: Clock,
  running: Play,
  completed: CheckCircle2,
  paused: Pause,
  failed: AlertCircle,
};

const statusColors: Record<ScheduledTask["status"], string> = {
  pending: "text-muted-foreground",
  running: "text-brand",
  completed: "text-emerald-500",
  paused: "text-amber-500",
  failed: "text-red-500",
};

const KEEP_AWAKE_KEY = "grok-gui-keep-awake";

function formatTrigger(task: ScheduledTask, language: "zh-CN" | "en-US"): string {
  if (task.mode === "once") return language === "en-US" ? "Now" : "立即";
  if (!task.scheduledAt) return "—";
  const when = new Date(task.scheduledAt);
  const base = when.toLocaleString(language, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return task.mode === "branch" ? `${base} · ${language === "en-US" ? "daily" : "每日循环"}` : base;
}

function statusLabel(status: ScheduledTask["status"], language: "zh-CN" | "en-US") {
  const labels = language === "en-US"
    ? { pending: "Pending", running: "Running", completed: "Completed", paused: "Paused", failed: "Failed" }
    : { pending: "待执行", running: "执行中", completed: "已完成", paused: "已暂停", failed: "失败" };
  return labels[status];
}

export function ScheduledPanel() {
  const setScreen = useAppStore((s) => s.setScreen);
  const newChatTask = useAppStore((s) => s.newTask);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const streaming = useAppStore((s) => s.streaming);
  const availableModels = useAppStore((s) => s.availableModels);
  const activeModel = useAppStore((s) => s.activeModel);
  const tasks = useAppStore((s) => s.scheduledTasks);
  const createScheduledTask = useAppStore((s) => s.createScheduledTask);
  const deleteScheduledTask = useAppStore((s) => s.deleteScheduledTask);
  const toggleScheduledTaskPause = useAppStore((s) => s.toggleScheduledTaskPause);
  const language = useAppStore((s) => s.settings.language);
  const tr = (key: Parameters<typeof t>[1]) => t(language, key);
  const local = (zh: string, en: string) => language === "en-US" ? en : zh;

  const models = availableModels.length > 0
    ? availableModels.map((m) => ({ id: m.id, label: m.label }))
    : [{ id: activeModel?.id ?? "grok-4.5", label: activeModel?.label ?? "Grok 4.5" }];

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<{
    title: string;
    content: string;
    priority: ScheduledTask["priority"];
    mode: ScheduledTask["mode"];
    model: string;
    scheduledDate: string;
  }>({
    title: "",
    content: "",
    priority: "medium",
    mode: "once",
    model: models[0]?.id ?? "grok-4.5",
    scheduledDate: "",
  });
  const [keepAwake, setKeepAwake] = useState(() => localStorage.getItem(KEEP_AWAKE_KEY) === "1");
  const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

  useEffect(() => {
    localStorage.setItem(KEEP_AWAKE_KEY, keepAwake ? "1" : "0");
    if (!isTauri) return;
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("set_keep_awake", { enabled: keepAwake }).catch((e) => console.error("keep awake failed:", e)),
    );
  }, [keepAwake, isTauri]);

  const handleCreate = async () => {
    if (!form.title.trim()) return;
    const scheduledAt = form.mode === "once" || !form.scheduledDate
      ? undefined
      : new Date(form.scheduledDate).getTime();
    createScheduledTask({
      title: form.title.trim(),
      content: form.content.trim(),
      priority: form.priority,
      mode: form.mode,
      model: form.model,
      scheduledAt,
    });
    const fireNow = form.mode === "once";
    const prompt = form.content.trim() || form.title.trim();
    setForm({ title: "", content: "", priority: "medium", mode: "once", model: models[0]?.id ?? "grok-4.5", scheduledDate: "" });
    setShowCreate(false);
    if (fireNow && !streaming) {
      await newChatTask();
      await sendMessage(prompt);
      setScreen("chat");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setScreen("chat")}
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <ArrowLeft size={13} /> {tr("returnToChat")}
            </button>
            <h2 className="text-lg font-semibold text-foreground">{tr("scheduled")}</h2>
          </div>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-[13px] font-medium text-brand-foreground transition-opacity hover:opacity-90"
          >
            <Plus size={14} /> {tr("newTask")}
          </button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{local("按计划运行任务，或在需要时随时启动。到期任务会自动创建会话并执行。", "Run tasks on a schedule or start them when needed. Due tasks create a conversation and run automatically.")}</p>
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          <Clock size={13} />
          <span>{local("定时任务仅在电脑唤醒状态下运行。", "Scheduled tasks run only while this Mac is awake.")}</span>
          <label className="ml-auto flex items-center gap-1.5">
            <span>{local("保持唤醒", "Keep awake")}</span>
            <input
              type="checkbox"
              checked={keepAwake}
              onChange={(e) => setKeepAwake(e.target.checked)}
              className="accent-[var(--brand)]"
            />
          </label>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {showCreate && (
          <section className="mb-6">
            <h3 className="mb-3 text-[15px] font-semibold text-foreground">{tr("newTask")}</h3>
            <div className="overflow-hidden rounded-xl border border-border bg-card p-5 shadow-sm">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="text-xs font-medium text-foreground/80">{local("标题", "Title")}</label>
                  <input
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    placeholder={local("任务标题", "Task title")}
                    className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-foreground/80">{local("优先级", "Priority")}</label>
                  <div className="mt-1 flex gap-2">
                    {(["low", "medium", "high"] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setForm({ ...form, priority: p })}
                        className={cn(
                          "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                          form.priority === p
                            ? `${priorityColors[p].bg} ${priorityColors[p].text} ${priorityColors[p].border}`
                            : "border-border text-muted-foreground hover:border-muted-foreground/40"
                        )}
                      >
                        {p === "low" ? tr("low") : p === "medium" ? tr("medium") : tr("high")}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-foreground/80">{tr("model")}</label>
                  <select
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-foreground/80">{local("执行模式", "Run mode")}</label>
                  <div className="mt-1 flex gap-2">
                    {([
                      { id: "once", label: local("单次执行", "Run once") },
                      { id: "scheduled", label: local("定时任务", "Scheduled") },
                      { id: "branch", label: local("每日循环", "Daily") },
                    ] as const).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setForm({ ...form, mode: m.id })}
                        className={cn(
                          "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                          form.mode === m.id
                            ? "border-brand/40 bg-brand/10 text-brand"
                            : "border-border text-muted-foreground hover:border-muted-foreground/40"
                        )}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
                {form.mode !== "once" && (
                  <div>
                    <label className="text-xs font-medium text-foreground/80">
                      {form.mode === "branch" ? local("首次执行时间（之后每天同一时间）", "First run time (then daily at this time)") : local("预定时间", "Scheduled time")}
                    </label>
                    <input
                      type="datetime-local"
                      value={form.scheduledDate}
                      onChange={(e) => setForm({ ...form, scheduledDate: e.target.value })}
                      className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
                    />
                  </div>
                )}
              </div>
              <div className="mt-4">
                <label className="text-xs font-medium text-foreground/80">{local("任务内容", "Task instructions")}</label>
                <textarea
                  rows={4}
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                  placeholder={local("输入任务描述，到点后会自动创建会话并发送给 Agent 执行…", "Describe the task. At the scheduled time, a conversation will be created and sent to the agent…")}
                  className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
                />
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary"
                >
                  {tr("cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={!form.title.trim() || (form.mode !== "once" && !form.scheduledDate)}
                  className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {local("创建任务", "Create task")}
                </button>
              </div>
            </div>
          </section>
        )}

        <section>
          <h3 className="mb-3 text-[15px] font-semibold text-foreground">
            {local("任务列表", "Tasks")}
            <span className="ml-2 text-xs font-normal text-muted-foreground">{local(`${tasks.length} 个任务`, `${tasks.length} task${tasks.length === 1 ? "" : "s"}`)}</span>
          </h3>
          {tasks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-secondary/50 px-6 py-12 text-center">
              <Clock size={32} className="mx-auto text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium text-muted-foreground">{local("暂无定时任务", "No scheduled tasks")}</p>
              <p className="mt-1 text-xs text-muted-foreground/70">{local("点击「新建任务」创建第一个定时任务。", "Choose New task to create the first scheduled task.")}</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-border/60 bg-secondary/50">
                    <th className="px-4 py-2.5 font-medium text-muted-foreground">{local("任务名称", "Task")}</th>
                    <th className="px-4 py-2.5 font-medium text-muted-foreground">{local("优先级", "Priority")}</th>
                    <th className="px-4 py-2.5 font-medium text-muted-foreground">{local("状态", "Status")}</th>
                    <th className="px-4 py-2.5 font-medium text-muted-foreground">{local("触发时间", "Run time")}</th>
                    <th className="px-4 py-2.5 font-medium text-muted-foreground">{local("操作", "Actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => {
                    const StatusIcon = statusIcons[task.status];
                    const pColor = priorityColors[task.priority];
                    return (
                      <tr key={task.id} className="border-b border-border/40 last:border-0 hover:bg-secondary/50">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Cpu size={14} className="text-muted-foreground" />
                            <div className="min-w-0">
                              <span className="block truncate font-medium text-foreground">{task.title}</span>
                              {task.lastRunAt && (
                                <span className="block text-[10px] text-muted-foreground">
                                  {local("上次执行", "Last run")} {relativeTime(task.lastRunAt, language)}
                                </span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className={cn("rounded-md border px-2 py-0.5 text-[11px] font-medium", pColor.bg, pColor.text, pColor.border)}>
                            {task.priority === "low" ? tr("low") : task.priority === "medium" ? tr("medium") : tr("high")}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <StatusIcon size={13} className={statusColors[task.status]} />
                            <span className="text-foreground/80">{statusLabel(task.status, language)}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                          {formatTrigger(task, language)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => toggleScheduledTaskPause(task.id)}
                              disabled={task.status === "running" || task.status === "completed"}
                              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
                              title={task.status === "paused" ? local("恢复", "Resume") : local("暂停", "Pause")}
                            >
                              {task.status === "paused" ? <Play size={13} /> : <Pause size={13} />}
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteScheduledTask(task.id)}
                              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                              title={tr("delete")}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
