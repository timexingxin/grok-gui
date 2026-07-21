import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft, CheckCircle2, CircleAlert, Cpu, Gauge,
  Plug, Plus, RefreshCw, ShieldCheck, SlidersHorizontal, Trash2, UserCircle2, Wrench, Zap,
  Hand, Eye, AlertTriangle, Unlock, Lock, Shield,
  Hand as HandIcon,
} from "lucide-react";
import {
  useAppStore,
  type PermissionLevel,
  type UiLanguage,
  modeForLevel,
} from "@grok-gui/core";
import { formatCost, formatTokens } from "@grok-gui/core/utils";
import { t, uiLanguageOptions } from "./i18n";

type Nav = "general" | "auth" | "connection" | "permissions" | "usage" | "skills" | "mcp" | "model";
type JsonRecord = Record<string, unknown>;

interface McpFormState {
  name: string;
  transport: "stdio" | "http" | "sse";
  commandOrUrl: string;
  args: string;
  scope: "user" | "project";
}

const emptyMcpForm: McpFormState = {
  name: "", transport: "stdio", commandOrUrl: "", args: "", scope: "user",
};

function permissionLevels(language: UiLanguage): Array<{ id: PermissionLevel; label: string; detail: string }> {
  const english = language === "en-US";
  return [
    { id: "always_ask", label: english ? "Always ask" : "永远询问", detail: english ? "Ask before every tool call; safest." : "每次工具调用都询问；最安全" },
    { id: "read_only", label: english ? "Read only" : "仅读取", detail: english ? "Read actions run automatically; writes and commands ask." : "读取类工具自动执行；写入和命令会询问" },
    { id: "sensitive_ask", label: english ? "Ask for sensitive actions" : "敏感询问", detail: english ? "Routine reads run automatically; sensitive actions ask." : "普通读取自动执行；敏感操作先询问" },
    { id: "ask_write", label: english ? "Ask before workspace writes" : "询问写工作区", detail: english ? "Ask before workspace edits; outside writes and host commands are blocked." : "修改工作区文件前会询问；工作区外写入和主机命令会被阻止" },
    { id: "trust_workspace", label: english ? "Trust workspace" : "信任工作区", detail: english ? "Workspace edits run without prompts; outside writes and host commands stay blocked." : "工作区内文件修改不再询问；工作区外写入和主机命令仍被阻止" },
    { id: "full_access", label: english ? "Full access" : "完全访问", detail: english ? "No prompts; can access the network and any local file." : "不询问且拥有完整权限，访问网络和任何文件" },
  ];
}

const permissionIcons: Record<PermissionLevel, typeof HandIcon> = {
  always_ask: Hand,
  read_only: Eye,
  sensitive_ask: AlertTriangle,
  ask_write: Unlock,
  trust_workspace: Shield,
  full_access: Lock,
};

const permissionTints: Record<PermissionLevel, { bg: string; border: string; icon: string }> = {
  always_ask:       { bg: "bg-slate-500/10",      border: "border-slate-500/30",    icon: "text-slate-500" },
  read_only:        { bg: "bg-emerald-500/10",    border: "border-emerald-500/30",  icon: "text-emerald-500" },
  sensitive_ask:    { bg: "bg-amber-500/10",      border: "border-amber-500/30",    icon: "text-amber-500" },
  ask_write:        { bg: "bg-sky-500/10",        border: "border-sky-500/30",      icon: "text-sky-500" },
  trust_workspace:  { bg: "bg-indigo-500/10",     border: "border-indigo-500/30",   icon: "text-indigo-500" },
  full_access:      { bg: "bg-orange-500/10",     border: "border-orange-500/40",   icon: "text-orange-500" },
};

export function SettingsPage() {
  const [section, setSection] = useState<Nav>("general");
  const [integrationsLoading, setIntegrationsLoading] = useState(false);
  const [integrationsError, setIntegrationsError] = useState<string | null>(null);
  const [skills, setSkills] = useState<JsonRecord[]>([]);
  const [mcpServers, setMcpServers] = useState<JsonRecord[]>([]);
  const [mcpForm, setMcpForm] = useState<McpFormState>(emptyMcpForm);
  const [mcpSaving, setMcpSaving] = useState(false);
  const [mcpDetail, setMcpDetail] = useState<string | null>(null);
  const [modeSaving, setModeSaving] = useState(false);
  const [updateState, setUpdateState] = useState<string | null>(null);

  const setScreen = useAppStore((s) => s.setScreen);
  const workbenchVisible = useAppStore((s) => s.workbenchVisible);
  const setWorkbenchVisible = useAppStore((s) => s.setWorkbenchVisible);
  const permissionLevel = useAppStore((s) => s.permissionLevel);
  const setPermissionLevel = useAppStore((s) => s.setPermissionLevel);
  const autoApprove = useAppStore((s) => s.autoApprove);
  const setAutoApprove = useAppStore((s) => s.setAutoApprove);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const session = useAppStore((s) => s.session);
  const model = useAppStore((s) => s.activeModel);
  const providers = useAppStore((s) => s.providers);
  const history = useAppStore((s) => s.history);
  const connection = useAppStore((s) => s.connection);
  const checkConnection = useAppStore((s) => s.checkConnection);
  const reconnect = useAppStore((s) => s.reconnect);
  const contextTokens = useAppStore((s) => s.contextTokens);
  const language = settings.language;
  const tr = (key: Parameters<typeof t>[1]) => t(language, key);
  const local = (zh: string, en: string) => language === "en-US" ? en : zh;
  const levels = permissionLevels(language);

  const workspace = session?.workspace ?? "~";
  const usage = useMemo(() => {
    const saved = history.map((entry) => entry.usage).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    return saved.reduce((total, entry) => ({
      input: total.input + entry.inputTokens,
      output: total.output + entry.outputTokens,
      cost: total.cost + entry.costUsd,
      turns: total.turns + entry.turns,
    }), { input: 0, output: 0, cost: 0, turns: 0 });
  }, [history]);

  const refreshIntegrations = useCallback(async () => {
    setIntegrationsLoading(true);
    setIntegrationsError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const [inspect, listed] = await Promise.all([
        invoke<JsonRecord>("inspect_grok_configuration", { workspacePath: workspace }),
        invoke<unknown>("list_mcp_servers", { workspacePath: workspace }),
      ]);
      setSkills(arrayRecords(inspect.skills));
      setMcpServers(arrayRecords(listed));
    } catch (error) {
      setIntegrationsError(String(error));
    } finally {
      setIntegrationsLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    if (section === "skills" || section === "mcp") void refreshIntegrations();
  }, [section, refreshIntegrations]);

  const checkForUpdates = async () => {
    setUpdateState(local("正在检查…", "Checking…"));
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update?.available) {
        setUpdateState(local(`发现新版本 ${update.version}，正在下载安装…`, `Version ${update.version} found; downloading and installing…`));
        await update.downloadAndInstall();
        setUpdateState(local(`v${update.version} 已安装，重启应用后生效。`, `v${update.version} installed. Restart the app to apply it.`));
      } else {
        setUpdateState(local("已是最新版本。", "You are up to date."));
      }
    } catch (error) {
      setUpdateState(`${local("检查失败", "Check failed")}: ${String(error)}`);
    }
  };

  const changeLevel = async (next: PermissionLevel) => {
    if (next === permissionLevel || modeSaving) return;
    setModeSaving(true);
    setIntegrationsError(null);
    try {
      await setPermissionLevel(next);
    } catch (error) {
      setIntegrationsError(String(error));
    } finally {
      setModeSaving(false);
    }
  };

  const addMcp = async () => {
    if (mcpSaving) return;
    setMcpSaving(true);
    setMcpDetail(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("upsert_mcp_server", {
        workspacePath: workspace,
        input: {
          name: mcpForm.name.trim(),
          transport: mcpForm.transport,
          command_or_url: mcpForm.commandOrUrl.trim(),
          args: splitArgs(mcpForm.args),
          scope: mcpForm.scope,
        },
      });
      setMcpForm(emptyMcpForm);
      await refreshIntegrations();
    } catch (error) {
      setMcpDetail(String(error));
    } finally {
      setMcpSaving(false);
    }
  };

  const doctorMcp = async (name: string) => {
    setMcpDetail(local("检查中…", "Checking…"));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<unknown>("diagnose_mcp_server", { name, workspacePath: workspace });
      setMcpDetail(JSON.stringify(result, null, 2));
    } catch (error) {
      setMcpDetail(String(error));
    }
  };

  const removeMcp = async (name: string, scope?: string) => {
    if (!window.confirm(local(`移除 MCP “${name}”？这会修改 Grok 的配置。`, `Remove MCP “${name}”? This changes Grok configuration.`))) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("remove_mcp_server", { name, scope, workspacePath: workspace });
      await refreshIntegrations();
    } catch (error) {
      setMcpDetail(String(error));
    }
  };

  return (
    <div data-testid="settings-shell" className="flex h-full min-h-0 w-full overflow-hidden bg-background text-foreground">
      <aside className="w-60 shrink-0 overflow-y-auto border-r border-border bg-secondary/40 p-3">
        <button
          type="button"
          onClick={() => setScreen("chat")}
          className="mb-5 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <ArrowLeft size={13} /> {tr("returnToTask")}
        </button>
        <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">{tr("settings")}</p>
        <SettingsNav active={section === "general"} onClick={() => setSection("general")} icon={<SlidersHorizontal size={14} />} label={tr("general")} />
        <SettingsNav active={section === "auth"} onClick={() => setSection("auth")} icon={<UserCircle2 size={14} />} label={tr("auth")} />
        <SettingsNav active={section === "connection"} onClick={() => setSection("connection")} icon={<Zap size={14} />} label={tr("connection")} />
        <SettingsNav active={section === "permissions"} onClick={() => setSection("permissions")} icon={<ShieldCheck size={14} />} label={tr("permissions")} />
        <SettingsNav active={section === "usage"} onClick={() => setSection("usage")} icon={<Gauge size={14} />} label={tr("usage")} />
        <p className="mt-4 px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">{tr("extensions")}</p>
        <SettingsNav active={section === "skills"} onClick={() => setSection("skills")} icon={<Wrench size={14} />} label={tr("skills")} />
        <SettingsNav active={section === "mcp"} onClick={() => setSection("mcp")} icon={<Plug size={14} />} label={tr("mcpServers")} />
        <SettingsNav active={section === "model"} onClick={() => setSection("model")} icon={<Cpu size={14} />} label={tr("modelProvider")} />
      </aside>
      <main className="min-h-0 flex-1 overflow-y-auto px-10 py-8 lg:px-16">
        <div className="mx-auto w-full">
          <h2 className="text-2xl font-semibold tracking-tight">{navTitle(section, language)}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{navDetail(section, language)}</p>

          {section === "general" && <>
            <section className="mt-6"><SectionTitle title={language === "en-US" ? "Appearance" : "外观"} />
              <Card>
                <SettingRow title={tr("theme")} detail={language === "en-US" ? "Choose Light, Dark, or System. Applies immediately." : "切换浅色/深色/跟随系统。更改后立即生效。"} control={
                  <select value={settings.theme} onChange={(e) => updateSettings({ theme: e.target.value as typeof settings.theme })} className="rounded-lg border border-border bg-card px-2 py-1.5 text-xs text-foreground/80 focus:border-foreground/40 focus:outline-none">
                    <option value="light">{tr("light")}</option>
                    <option value="dark">{tr("dark")}</option>
                    <option value="system">{tr("system")}</option>
                  </select>
                } />
                <SettingRow title={tr("language")} detail={tr("languageDetail")} control={
                  <select value={language} onChange={(e) => updateSettings({ language: e.target.value as typeof language })} className="rounded-lg border border-border bg-card px-2 py-1.5 text-xs text-foreground/80 focus:border-foreground/40 focus:outline-none">
                    {uiLanguageOptions.map((option) => <option key={option.value} value={option.value}>{option.value === "zh-CN" ? tr("chinese") : tr("english")}</option>)}
                  </select>
                } />
                <SettingRow title={local("主题颜色", "Accent color")} detail={local("更改强调色，影响选中态、进度条、按钮等元素。", "Changes selected states, progress indicators, buttons, and other accents.")} control={
                  <div className="flex gap-1.5">
                    {(["blue","orange","violet","emerald","rose","sky"] as const).map((c) => (
                      <button key={c} type="button" onClick={() => updateSettings({ accent: c })}
                        className={`h-6 w-6 rounded-full transition-all ${settings.accent === c ? "ring-2 ring-offset-2 ring-brand/50 scale-110" : ""}`}
                        style={{ backgroundColor: { blue:"#3b82f6", orange:"#f97316", violet:"#8b5cf6", emerald:"#10b981", rose:"#f43f5e", sky:"#0ea5e9" }[c] }}
                      />
                    ))}
                  </div>
                } />
                <SettingRow title={local("字体大小", "Font size")} detail={local(`聊天区文字大小（当前 ${settings.fontSize}px）。`, `Chat text size (currently ${settings.fontSize}px).`)} control={
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">12</span>
                    <input type="range" min={12} max={18} value={settings.fontSize} onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })} className="w-24 accent-[var(--brand)]" />
                    <span className="text-xs text-muted-foreground">18</span>
                    <span className="w-6 font-mono text-xs text-foreground/80">{settings.fontSize}</span>
                  </div>
                } />
                <SettingRow title={local("对话文字宽度", "Chat width")} detail={local(`聊天内容区域最大宽度（当前 ${settings.chatMaxWidth}px）。`, `Maximum chat content width (currently ${settings.chatMaxWidth}px).`)} control={
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">640</span>
                    <input type="range" min={640} max={1200} step={80} value={settings.chatMaxWidth} onChange={(e) => updateSettings({ chatMaxWidth: Number(e.target.value) })} className="w-24 accent-[var(--brand)]" />
                    <span className="text-xs text-muted-foreground">1200</span>
                    <span className="w-10 font-mono text-xs text-foreground/80">{settings.chatMaxWidth}</span>
                  </div>
                } />
                <SettingRow title={local("交互特效", "Interactive effects")} detail={local("悬停时元素高亮、点击波纹等视觉反馈。", "Highlights on hover and other visual feedback.")} control={<Toggle checked={settings.interactiveEffects} onChange={(c) => updateSettings({ interactiveEffects: c })} />} />
                <SettingRow title={local("显示 Token 用量", "Show token usage")} detail={local("在底栏和状态区实时显示 token 用量和成本。", "Shows token usage and cost in the status area.")} control={<Toggle checked={settings.showTokenUsage} onChange={(c) => updateSettings({ showTokenUsage: c })} />} />
              </Card>
            </section>
            <section className="mt-6"><SectionTitle title={local("行为", "Behavior")} />
              <Card>
                <SettingRow title={local("显示工作台", "Show workbench")} detail={local("开启后右侧显示项目文件、变更、终端和计划面板；关闭后聊天区域占据全部空间。可随时从顶栏切换。", "Shows project files, changes, terminal, and plan panels. Turn it off for a full-width chat view.")} control={<Toggle checked={workbenchVisible} onChange={setWorkbenchVisible} />} />
                <SettingRow title={local("自动批准工具调用", "Auto-approve tool calls")} detail={local("开启后工具调用无需手动确认（构建模式默认行为）。关闭则每次工具调用会弹出权限请求。", "Runs tool calls without manual confirmation. Turn it off to request approval for each call.")} control={<Toggle checked={autoApprove} onChange={(c) => void setAutoApprove(c)} />} />
                <SettingRow title={local("发送时自动清除错误消息", "Clear errors when sending")} detail={local("开启后发送新消息会自动清除聊天中的「Agent 错误」消息。", "Clears previous agent-error messages when sending a new message.")} control={<Toggle checked={settings.clearErrorOnSend} onChange={(c) => updateSettings({ clearErrorOnSend: c })} />} />
                <SettingRow title={local("显示推理摘要", "Show reasoning summaries")} detail={local("在时间线中显示模型推理摘要。", "Shows model reasoning summaries in the activity timeline.")} control={<Toggle checked={settings.showReasoningSummary} onChange={(c) => updateSettings({ showReasoningSummary: c })} />} />
                <SettingRow title={local("展开 shell 工具部分", "Expand shell tool details")} detail={local("默认在时间线中展开 shell 工具部分。", "Expands shell and terminal tool details by default.")} control={<Toggle checked={settings.expandShellToolParts} onChange={(c) => updateSettings({ expandShellToolParts: c })} />} />
                <SettingRow title={local("展开编辑工具部分", "Expand edit tool details")} detail={local("默认在时间线中展开 edit、write 和 patch 工具部分。", "Expands edit, write, and patch tool details by default.")} control={<Toggle checked={settings.expandEditToolParts} onChange={(c) => updateSettings({ expandEditToolParts: c })} />} />
              </Card>
            </section>
            <section className="mt-6"><SectionTitle title={local("文件与路径", "Files and paths")} />
              <Card>
                <SettingRow title={local("默认工作目录", "Default workspace")} detail={local("新任务的默认工作区路径。", "Default workspace path for new tasks.")} control={
                  <input value={settings.defaultWorkspace} onChange={(e) => updateSettings({ defaultWorkspace: e.target.value })} placeholder="~" className="w-48 rounded-lg border border-border bg-card px-2 py-1 text-xs text-foreground/80 focus:border-foreground/40 focus:outline-none" />
                } />
                <SettingRow title={local("对话记录目录", "Conversation directory")} detail={local("会话历史文件的保存位置。", "Where conversation history files are saved.")} control={
                  <input value={settings.defaultConversationDir} onChange={(e) => updateSettings({ defaultConversationDir: e.target.value })} className="w-48 rounded-lg border border-border bg-card px-2 py-1 text-xs text-foreground/80 focus:border-foreground/40 focus:outline-none" />
                } />
              </Card>
            </section>
            <section className="mt-6"><SectionTitle title={local("应用更新", "App updates")} />
              <Card>
                <SettingRow title={local("检查更新", "Check for updates")} detail={updateState ?? local("从更新服务器获取最新版本。未配置服务器时会检查失败。", "Fetches the latest version from the update server. It will fail until a server is configured.")} control={
                  <button type="button" onClick={() => void checkForUpdates()} disabled={updateState === local("正在检查…", "Checking…") || updateState?.startsWith(local("发现新版本", "Version"))} className="button-secondary">
                    <RefreshCw size={updateState === local("正在检查…", "Checking…") ? "mr-1 inline animate-spin" : "mr-1 inline"} />{local("检查更新", "Check for updates")}
                  </button>
                } />
              </Card>
            </section>
          </>}

          {section === "auth" && <AuthSection language={language} />}
          {section === "connection" && <section className="mt-6"><SectionTitle title={local("本地 Grok Build CLI", "Local Grok Build CLI")} detail={local("检查会验证子进程仍存活，并向活动 ACP session 发送实际请求；不会发送提示词或写入文件。", "Checks the child process and makes a real request to the active ACP session; it never sends a prompt or writes files.")} />
            <Card>
              <SettingRow title={local("连接状态", "Connection status")} detail={connection.detail ?? connectionDescription(connection.state, language)} control={<ConnectionBadge state={connection.state} language={language} />} />
              <SettingRow title={local("活动会话", "Active session")} detail={session?.id ? `${session.id.slice(0, 8)} · ${workspace}` : local("尚未建立会话", "No active session")} control={<button type="button" onClick={() => void checkConnection()} disabled={connection.state === "connecting"} className="button-secondary"><RefreshCw size={13} className={connection.state === "connecting" ? "mr-1 inline animate-spin" : "mr-1 inline"} />{local("检查连接", "Check connection")}</button>} />
              <SettingRow title={local("重新连接", "Reconnect")} detail={local("恢复当前 Grok session；可用于断线、CLI 更新或健康检查失败后。", "Restores the current Grok session after a disconnect, CLI update, or failed health check.")} control={<button type="button" onClick={() => void reconnect()} disabled={connection.state === "connecting"} className="button-primary">{local("重新连接", "Reconnect")}</button>} />
            </Card>
          </section>}

          {section === "permissions" && <section className="mt-6"><SectionTitle title={local("工作区权限级别", "Workspace permission level")} detail={local("级别会映射到底层 Grok sandbox（ask/plan/build）。切换后会自动重新连接 Agent。", "Levels map to Grok's ask, plan, and build sandboxes. Changing a level reconnects the agent.")} />
            {integrationsError && <ErrorText text={integrationsError} />}
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {levels.map((entry) => {
                const Icon = permissionIcons[entry.id];
                const tint = permissionTints[entry.id];
                const selected = entry.id === permissionLevel;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    disabled={modeSaving}
                    onClick={() => void changeLevel(entry.id)}
                    className={`group relative rounded-xl border p-4 text-left transition-all ${
                      selected
                        ? `${tint.bg} ${tint.border} ring-1 ring-current/20 shadow-sm`
                        : "border-border bg-card hover:border-muted-foreground/30 hover:shadow-sm"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                        selected ? "bg-card" : tint.bg
                      }`}>
                        <Icon size={16} className={tint.icon} />
                      </div>
                      {selected && <CheckCircle2 size={16} className={tint.icon} />}
                    </div>
                    <p className={`mt-3 text-sm font-semibold ${selected ? "text-foreground" : "text-foreground/90"}`}>{entry.label}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{entry.detail}</p>
                    <p className="mt-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70">→ {modeForLevel(entry.id)}</p>
                  </button>
                );
              })}
            </div>
          </section>}

          {section === "usage" && <section className="mt-6"><SectionTitle title={local("本次会话", "This session")} detail={local("实时 usage 由 Grok ACP 上报（累计计费口径）；上下文占用为 agent 实时上报的窗口占用。", "Live usage comes from Grok ACP; context occupancy is reported by the agent.")} />
            <div className="grid gap-3 sm:grid-cols-4"><Metric label={local("输入", "Input")} value={formatTokens(session?.inputTokens ?? 0)} /><Metric label={local("输出", "Output")} value={formatTokens(session?.outputTokens ?? 0)} /><Metric label={local("成本", "Cost")} value={formatCost(session?.costUsd ?? 0)} /><Metric label={local("上下文占用", "Context used")} value={`${formatTokens(contextTokens)}${model?.contextWindow ? ` / ${formatTokens(model.contextWindow)}` : ""}`} /></div>
            <SectionTitle title={local("自动压缩上下文", "Automatic context compaction")} detail={local("上下文窗口占用超过阈值后，自动让 Agent 执行 /compact 压缩历史（5 分钟内不重复触发）。关闭则完全手动。", "When context use exceeds the threshold, the agent runs /compact. It will not repeat within five minutes.")} extraClass="mt-8" />
            <Card><SettingRow title={local("压缩阈值", "Compaction threshold")} detail={local(`当前：${settings.autoCompactThreshold > 0 ? `超过 ${Math.round(settings.autoCompactThreshold * 100)}% 时自动压缩` : "已关闭"}`, `Current: ${settings.autoCompactThreshold > 0 ? `compact above ${Math.round(settings.autoCompactThreshold * 100)}%` : "off"}`)} control={
              <select
                value={String(settings.autoCompactThreshold)}
                onChange={(e) => updateSettings({ autoCompactThreshold: Number(e.target.value) })}
                className="rounded-lg border border-border bg-card px-2 py-1.5 text-xs text-foreground/80 focus:border-foreground/40 focus:outline-none"
              >
                <option value="0">{local("关闭", "Off")}</option>
                <option value="0.35">{local("超过 35%", "Above 35%")}</option>
                <option value="0.5">{local("超过 50%", "Above 50%")}</option>
                <option value="0.7">{local("超过 70%", "Above 70%")}</option>
                <option value="0.85">{local("超过 85%", "Above 85%")}</option>
              </select>
            } /></Card>
            <SectionTitle title={local("已保存会话累计", "Saved conversation totals")} detail={local("会话完成后会随历史记录保存；用于本地查看而非账单结算。", "Saved after completed conversations for local reference; not a billing record.")} extraClass="mt-8" />
            <Card><SettingRow title={local("历史会话", "Saved conversations")} detail={local(`${history.length} 个已保存会话`, `${history.length} saved conversations`)} control={<span className="text-sm font-semibold">{history.length}</span>} /><SettingRow title={local("累计 tokens", "Total tokens")} detail={local(`${formatTokens(usage.input)} 输入 · ${formatTokens(usage.output)} 输出`, `${formatTokens(usage.input)} input · ${formatTokens(usage.output)} output`)} control={<span className="text-sm font-semibold">{formatTokens(usage.input + usage.output)}</span>} /><SettingRow title={local("累计成本", "Total cost")} detail={local(`${usage.turns} 个已保存回合`, `${usage.turns} saved turns`)} control={<span className="text-sm font-semibold">{formatCost(usage.cost)}</span>} /></Card>
          </section>}

          {section === "skills" && <section className="mt-6"><SectionTitle title={local("已发现 Skills", "Discovered skills")} detail={local("读取 grok inspect 的真实发现结果；Skills 由项目 .grok、用户目录、插件与兼容目录提供。", "Shows the results reported by grok inspect. Skills may come from the project, user, plugin, or compatible directories.")} />
            <RefreshButton loading={integrationsLoading} onClick={refreshIntegrations} language={language} />
            {integrationsError && <ErrorText text={integrationsError} />}
            <Card>{skills.length === 0 ? <EmptyState title={local("没有发现 Skill", "No skills found")} detail={local("可以将 SKILL.md 放入项目或用户级 Grok skill 目录，然后刷新。", "Put SKILL.md in a project or user-level Grok skills directory, then refresh.")} /> : skills.map((skill, index) => <SettingRow key={`${stringAt(skill, "name") ?? "skill"}-${index}`} title={stringAt(skill, "name") ?? local("未命名 Skill", "Unnamed skill")} detail={stringAt(skill, "description") ?? stringAt(recordAt(skill, "source"), "path") ?? local("没有描述", "No description")} control={<span className="text-[11px] text-muted-foreground">{stringAt(recordAt(skill, "source"), "type") ?? local("已发现", "Discovered")}</span>} />)}</Card>
          </section>}

          {section === "mcp" && <section className="mt-6"><SectionTitle title={local("MCP 服务器", "MCP servers")} detail={local("直接调用 grok mcp list / add / remove / doctor。凭据应放在环境变量或 Grok 配置中，不会复制到本应用。", "Calls grok mcp list, add, remove, and doctor directly. Credentials stay in environment variables or Grok configuration.")} />
            <RefreshButton loading={integrationsLoading} onClick={refreshIntegrations} language={language} />
            {integrationsError && <ErrorText text={integrationsError} />}
            <Card>{mcpServers.length === 0 ? <EmptyState title={local("没有配置 MCP 服务器", "No MCP servers configured")} detail={local("添加后会写入 Grok 的 user 或 project scope；重连后新 session 才会加载新工具。", "Adding a server writes to Grok's user or project scope. Reconnect before a new session can load its tools.")} /> : mcpServers.map((server, index) => { const name = stringAt(server, "name") ?? stringAt(server, "id") ?? `MCP ${index + 1}`; const scope = stringAt(server, "scope"); return <SettingRow key={`${scope ?? "unknown"}-${name}`} title={name} detail={mcpDescription(server, language)} control={<div className="flex gap-2"><button type="button" onClick={() => void doctorMcp(name)} className="button-secondary">{local("诊断", "Diagnose")}</button><button type="button" onClick={() => void removeMcp(name, scope)} className="rounded-lg border border-destructive/40 px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10" aria-label={`${local("移除", "Remove")} ${name}`}><Trash2 size={13} /></button></div>} />; })}</Card>
            <SectionTitle title={local("添加或更新 MCP", "Add or update MCP")} detail={local("stdio 使用命令和参数；HTTP/SSE 使用 URL。保存会修改 Grok 的配置。", "Use a command and arguments for stdio, or a URL for HTTP/SSE. Saving changes Grok configuration.")} extraClass="mt-8" />
            <Card><div className="grid gap-3 p-5 md:grid-cols-2"><Field label={local("名称", "Name")}><input value={mcpForm.name} onChange={(event) => setMcpForm({ ...mcpForm, name: event.target.value })} placeholder="filesystem" className="field" /></Field><Field label={local("范围", "Scope")}><select value={mcpForm.scope} onChange={(event) => setMcpForm({ ...mcpForm, scope: event.target.value as McpFormState["scope"] })} className="field"><option value="user">{local("用户（所有项目）", "User (all projects)")}</option><option value="project">{local("项目（当前工作区）", "Project (current workspace)")}</option></select></Field><Field label={local("传输", "Transport")}><select value={mcpForm.transport} onChange={(event) => setMcpForm({ ...mcpForm, transport: event.target.value as McpFormState["transport"] })} className="field"><option value="stdio">stdio</option><option value="http">HTTP</option><option value="sse">SSE</option></select></Field><Field label={mcpForm.transport === "stdio" ? local("命令", "Command") : "URL"}><input value={mcpForm.commandOrUrl} onChange={(event) => setMcpForm({ ...mcpForm, commandOrUrl: event.target.value })} placeholder={mcpForm.transport === "stdio" ? "npx" : "https://example.com/mcp"} className="field" /></Field>{mcpForm.transport === "stdio" && <Field label={local("参数（空格分隔）", "Arguments (space separated)")}><input value={mcpForm.args} onChange={(event) => setMcpForm({ ...mcpForm, args: event.target.value })} placeholder="-y @modelcontextprotocol/server-filesystem /path" className="field" /></Field>}</div><div className="flex items-center justify-between border-t border-border/60 px-5 py-3"><span className="text-xs text-muted-foreground">{local("修改后请重新连接当前 Agent。", "Reconnect the current agent after saving.")}</span><button type="button" onClick={() => void addMcp()} disabled={mcpSaving || !mcpForm.name.trim() || !mcpForm.commandOrUrl.trim()} className="button-primary disabled:opacity-50"><Plus size={13} className="mr-1 inline" />{mcpSaving ? local("保存中…", "Saving…") : local("保存 MCP", "Save MCP")}</button></div></Card>
            {mcpDetail && <pre className="mt-3 max-h-56 overflow-auto rounded-xl border border-border bg-secondary p-4 text-xs leading-relaxed text-foreground/80">{mcpDetail}</pre>}
          </section>}

          {section === "model" && <section className="mt-6"><SectionTitle title={local("当前运行模型", "Current model")} detail={local("模型切换仍在聊天顶栏完成；这里展示 Agent 当前使用的 Provider 与能力边界。", "Switch models from the chat bar. This page shows the active provider and capability boundaries.")} />
            <Card><SettingRow title={local("当前模型", "Current model")} detail={model?.id ?? local("未选择", "Not selected")} control={<span className="text-sm font-semibold">{model?.label ?? "—"}</span>} /><SettingRow title={local("上下文窗口", "Context window")} detail={local("来自 Grok ACP 初始化握手", "Reported by the Grok ACP initialization handshake")} control={<span className="text-sm font-semibold">{model?.contextWindow ? formatTokens(model.contextWindow) : "—"}</span>} /><SettingRow title={local("可用 Provider", "Available providers")} detail={local("本 GUI 仅公开经 ACP 验证的模型，避免显示无法实际调用的条目。", "Only ACP-verified models are shown, avoiding entries that cannot be called.")} control={<span className="text-sm font-semibold">{providers.length}</span>} /></Card>
          </section>}
        </div>
      </main>
    </div>
  );
}

function SettingsNav({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
        active
          ? "bg-background font-medium text-foreground shadow-sm"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
      }`}
    >
      {icon}<span>{label}</span>
    </button>
  );
}
function SectionTitle({ title, detail, extraClass = "" }: { title: string; detail?: string; extraClass?: string }) {
  return (
    <div className={`mb-3 ${extraClass}`}>
      <h3 className="text-[15px] font-semibold text-foreground">{title}</h3>
      {detail && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</p>}
    </div>
  );
}
function Card({ children }: { children: React.ReactNode }) {
  return <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">{children}</div>;
}
function SettingRow({ title, detail, control }: { title: string; detail: string; control: React.ReactNode }) {
  return (
    <div className="flex items-center gap-6 border-b border-border/60 px-5 py-4 last:border-0">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
function Toggle({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-brand" : "bg-muted-foreground/40"}`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-card shadow transition-transform ${
          checked ? "translate-x-6" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
function ConnectionBadge({ state, language }: { state: ReturnType<typeof useAppStore.getState>["connection"]["state"]; language: UiLanguage }) {
  const local = (zh: string, en: string) => language === "en-US" ? en : zh;
  if (state === "connected") return <span className="inline-flex items-center gap-1.5 text-xs text-emerald-500"><CheckCircle2 size={14} /> {local("已验证", "Verified")}</span>;
  if (state === "connecting") return <span className="inline-flex items-center gap-1.5 text-xs text-brand"><RefreshCw size={13} className="animate-spin" /> {local("检查中", "Checking")}</span>;
  if (state === "disconnected" || state === "error") return <span className="inline-flex items-center gap-1.5 text-xs text-destructive"><CircleAlert size={14} /> {local("未连接", "Disconnected")}</span>;
  return <span className="text-xs text-muted-foreground/70">{local("尚未检查", "Not checked")}</span>;
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 font-mono text-lg font-semibold text-foreground">{value}</p>
    </div>
  );
}
function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="px-5 py-8 text-center"><p className="text-sm font-medium text-foreground/80">{title}</p><p className="mx-auto mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">{detail}</p></div>;
}
function RefreshButton({ loading, onClick, language }: { loading: boolean; onClick: () => void; language: UiLanguage }) {
  return <button type="button" onClick={onClick} disabled={loading} className="button-secondary mb-3"><RefreshCw size={13} className={loading ? "mr-1 inline animate-spin" : "mr-1 inline"} />{loading ? (language === "en-US" ? "Refreshing…" : "刷新中…") : (language === "en-US" ? "Refresh" : "刷新")}</button>;
}
function ErrorText({ text }: { text: string }) {
  return <p className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{text}</p>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-xs font-medium text-foreground/80">{label}<div className="mt-1.5">{children}</div></label>;
}

function navTitle(section: Nav, language: "zh-CN" | "en-US") {
  if (language === "en-US") return ({ general: "Settings", auth: "Account & API key", connection: "Agent connection", permissions: "Permissions & sandbox", usage: "Usage & context", skills: "Skills", mcp: "MCP servers", model: "Models & providers" } as const)[section];
  return ({
    general: "设置", auth: "账户与 API Key", connection: "Agent 连接", permissions: "权限与沙箱",
    usage: "用量与上下文", skills: "Skills", mcp: "MCP 服务器", model: "模型与 Provider",
  } as const)[section];
}
function navDetail(section: Nav, language: "zh-CN" | "en-US") {
  if (language === "en-US") return ({
    general: "Manage display preferences, default behavior, and workspace permissions.",
    auth: "Switch between grok.com account login and an xAI API key. The key unlocks the full xAI model catalog.",
    connection: "Verify the local Grok Build process and active ACP session.",
    permissions: "Control the agent's access to files, terminals, and the network.",
    usage: "Live token usage, cost, and stored conversation totals.",
    skills: "Skills supplied by project, user, plugin, and compatible directories.",
    mcp: "View, add, diagnose, and remove MCP servers.",
    model: "The active provider, model, and context window.",
  } as const)[section];
  return ({
    general: "管理界面偏好、默认行为和工作区权限级别。",
    auth: "切换 grok.com 账户登录与 xAI API Key。Key 模式可解锁完整 xAI 模型目录。",
    connection: "验证本地 Grok Build 子进程和活动 ACP session。",
    permissions: "工作区权限级别控制 Agent 对文件、终端和网络的访问范围。",
    usage: "实时 token 用量、成本和已保存会话累计。",
    skills: "由项目 .grok、用户目录、插件与兼容目录提供的 Skill。",
    mcp: "MCP 服务器列表、添加、诊断与删除。",
    model: "当前激活的 Provider、模型与上下文窗口。",
  } as const)[section];
}
function connectionDescription(state: string, language: UiLanguage) {
  if (language === "en-US") return ({
    idle: "Connection has not been checked.", connecting: "Checking the local process and ACP response.",
    connected: "The latest connection check passed.", disconnected: "The agent is disconnected; reconnect to restore the session.", error: "The connection check failed.",
  } as Record<string, string>)[state] ?? "Unknown state";
  return ({
    idle: "尚未检查连接。", connecting: "正在验证本地子进程和 ACP 响应。",
    connected: "最后一次检查通过。", disconnected: "Agent 已断开，可重新连接恢复会话。", error: "连接检查失败。",
  } as Record<string, string>)[state] ?? "未知状态";
}
function arrayRecords(value: unknown): JsonRecord[] { return Array.isArray(value) ? value.filter((entry): entry is JsonRecord => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)) : []; }
function recordAt(record: JsonRecord, key: string): JsonRecord | undefined { const value = record[key]; return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined; }
function stringAt(record: JsonRecord | undefined, key: string): string | undefined { const value = record?.[key]; return typeof value === "string" ? value : undefined; }
function splitArgs(value: string) { return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? []; }
function mcpDescription(server: JsonRecord, language: UiLanguage) { const transport = stringAt(server, "transport") ?? "stdio"; const target = stringAt(server, "url") ?? stringAt(server, "command") ?? stringAt(server, "status") ?? (language === "en-US" ? "Configured" : "已配置"); return `${transport} · ${target}`; }

function AuthSection({ language }: { language: UiLanguage }) {
  const local = (zh: string, en: string) => language === "en-US" ? en : zh;
  const authMode = useAppStore((s) => s.authMode);
  const providers = useAppStore((s) => s.providers);
  const activeModel = useAppStore((s) => s.activeModel);
  const setActiveModel = useAppStore((s) => s.setActiveModel);
  const refreshAuthMode = useAppStore((s) => s.refreshAuthMode);
  const setAuthMode = useAppStore((s) => s.setAuthMode);
  const reconnect = useAppStore((s) => s.reconnect);
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [loginRunning, setLoginRunning] = useState<"oauth" | "device" | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const isTauri = typeof window !== "undefined" && Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

  const handleSelectMode = async (mode: "oauth" | "apiKey") => {
    setFeedback(null);
    await setAuthMode(mode);
    void refreshAuthMode();
  };

  const handleSaveKey = async () => {
    if (!keyInput.trim()) return;
    setSaving(true);
    setFeedback(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_xai_api_key", { key: keyInput.trim() });
      setFeedback(local("已保存。正在切换到 API Key 模式…", "Saved. Switching to API key mode…"));
      setKeyInput("");
      await setAuthMode("apiKey");
    } catch (error) {
      setFeedback(String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleLogin = async (kind: "oauth" | "device") => {
    setFeedback(null);
    setLoginRunning(kind);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const command = kind === "oauth" ? "login_grok_oauth" : "login_grok_device_code";
      await invoke(command);
      setFeedback(local("登录完成。正在切换到账户模式…", "Login complete. Switching to account mode…"));
      await setAuthMode("oauth");
      void reconnect();
    } catch (error) {
      setFeedback(String(error));
    } finally {
      setLoginRunning(null);
    }
  };

  const oauthLabel = local("grok.com 账户登录", "grok.com account login");
  const apiKeyLabel = local("xAI API Key", "xAI API key");
  const currentLabel = authMode === "apiKey"
    ? local("当前：xAI API Key", "Current: xAI API key")
    : authMode === "none"
      ? local("当前：未配置", "Current: not configured")
      : local("当前：grok.com 账户", "Current: grok.com account");
  const xai = providers.find((p) => p.id === "xai");

  return (
    <section className="mt-6">
      <SectionTitle title={local("账户与认证", "Account & authentication")} detail={local("选择 Grok CLI 使用的认证方式。账户登录体验更轻便，API Key 解锁全部 xAI 模型。", "Pick how Grok CLI authenticates. Account login is lighter; an API key unlocks the full xAI model catalogue.")} />
      <Card>
        <div className="grid gap-3 p-5 md:grid-cols-2">
          <button
            type="button"
            onClick={() => void handleSelectMode("oauth")}
            disabled={loginRunning !== null}
            className={
              "rounded-xl border p-4 text-left text-sm transition-colors " +
              (authMode === "oauth"
                ? "border-brand bg-brand/10"
                : "border-border bg-background hover:bg-secondary")
            }
          >
            <div className="flex items-center gap-2">
              <UserCircle2 size={16} className="text-muted-foreground" />
              <span className="font-semibold">{oauthLabel}</span>
              {authMode === "oauth" && <CheckCircle2 size={14} className="ml-auto text-brand" />}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {local(
                "用 grok.com 账号登录。CLI 启动 ~/.grok/auth.json 后即可使用，无额外计费。模型仅限 Grok 4.5。",
                "Sign in with a grok.com account. The CLI uses ~/.grok/auth.json; no extra metering. Models limited to Grok 4.5.",
              )}
            </p>
            {authMode === "oauth" && <p className="mt-2 text-[11px] font-medium text-brand">{currentLabel}</p>}
            {!isTauri && (
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={(event) => { event.stopPropagation(); void handleLogin("oauth"); }} className="button-secondary" disabled={loginRunning !== null}>
                  {loginRunning === "oauth" ? local("登录中…", "Signing in…") : local("启动 OAuth", "Start OAuth")}
                </button>
                <button type="button" onClick={(event) => { event.stopPropagation(); void handleLogin("device"); }} className="button-secondary" disabled={loginRunning !== null}>
                  {loginRunning === "device" ? local("等待中…", "Waiting…") : local("设备码", "Device code")}
                </button>
              </div>
            )}
          </button>

          <button
            type="button"
            onClick={() => void handleSelectMode("apiKey")}
            disabled={saving}
            className={
              "rounded-xl border p-4 text-left text-sm transition-colors " +
              (authMode === "apiKey"
                ? "border-brand bg-brand/10"
                : "border-border bg-background hover:bg-secondary")
            }
          >
            <div className="flex items-center gap-2">
              <ShieldCheck size={16} className="text-muted-foreground" />
              <span className="font-semibold">{apiKeyLabel}</span>
              {authMode === "apiKey" && <CheckCircle2 size={14} className="ml-auto text-brand" />}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {local(
                "使用 xAI API Key。Key 保存在 macOS 钥匙串，仅用于 CLI 子进程，可解锁全部 xAI 模型（含 Grok 3/4 推理变体）。",
                "Use an xAI API key. Saved to the macOS keychain and only read by the CLI child process; unlocks the full xAI catalogue (Grok 3, Grok 4 variants).",
              )}
            </p>
            {authMode === "apiKey" && <p className="mt-2 text-[11px] font-medium text-brand">{currentLabel}</p>}
            <div className="mt-3">
              <input
                type="password"
                value={keyInput}
                onChange={(event) => setKeyInput(event.target.value)}
                placeholder="xai-…"
                disabled={saving}
                className="field w-full"
                autoComplete="off"
                spellCheck={false}
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">{local("Key 仅写入 macOS 钥匙串。", "Key is only written to the macOS keychain.")}</span>
                <button type="button" onClick={() => void handleSaveKey()} disabled={saving || !keyInput.trim()} className="button-primary disabled:opacity-50">
                  {saving ? local("保存中…", "Saving…") : local("保存并切换", "Save & switch")}
                </button>
              </div>
            </div>
          </button>
        </div>

        {xai && (
          <>
            <div className="border-t border-border/60 px-5 py-3 text-xs uppercase tracking-wide text-muted-foreground">
              {local("可用模型", "Available models")}
            </div>
            <div className="grid gap-2 px-5 pb-5 md:grid-cols-3">
              {(xai.models ?? []).map((model) => (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => void setActiveModel("xai", model.id)}
                  className={
                    "rounded-lg border px-3 py-2 text-left text-[12px] transition-colors " +
                    (activeModel?.id === model.id
                      ? "border-brand bg-brand/10"
                      : "border-border bg-background hover:bg-secondary")
                  }
                >
                  <div className="font-medium text-foreground">{model.label}</div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">{model.id}</div>
                </button>
              ))}
            </div>
          </>
        )}

        {feedback && (
          <div className="border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
            {feedback}
          </div>
        )}
      </Card>
    </section>
  );
}
