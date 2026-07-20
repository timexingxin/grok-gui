import {
  Plug,
  RefreshCw,
  Trash2,
  Wrench,
  CheckCircle2,
  ArrowLeft,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "@grok-gui/core";
import { t } from "./i18n";

type JsonRecord = Record<string, unknown>;

export function PluginsPanel() {
  const session = useAppStore((s) => s.session);
  const setScreen = useAppStore((s) => s.setScreen);
  const language = useAppStore((s) => s.settings.language);
  const tr = (key: Parameters<typeof t>[1]) => t(language, key);
  const local = (zh: string, en: string) => language === "en-US" ? en : zh;
  const workspace = session?.workspace ?? "~";
  const [mcpServers, setMcpServers] = useState<JsonRecord[]>([]);
  const [skills, setSkills] = useState<JsonRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const [inspect, listed] = await Promise.all([
        invoke<JsonRecord>("inspect_grok_configuration", { workspacePath: workspace }),
        invoke<unknown>("list_mcp_servers", { workspacePath: workspace }),
      ]);
      setSkills(arrayRecords(inspect.skills));
      setMcpServers(arrayRecords(listed));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  useEffect(() => { void refresh(); }, [refresh]);

  const doctorMcp = async (name: string) => {
    setDetail(local("检查中…", "Checking…"));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<unknown>("diagnose_mcp_server", { name, workspacePath: workspace });
      setDetail(JSON.stringify(result, null, 2));
    } catch (e) {
      setDetail(String(e));
    }
  };

  const removeMcp = async (name: string, scope?: string) => {
    if (!window.confirm(local(`移除 MCP “${name}”？这会修改 Grok 的配置。`, `Remove MCP “${name}”? This changes Grok configuration.`))) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("remove_mcp_server", { name, scope, workspacePath: workspace });
      setDetail(null);
      await refresh();
    } catch (e) {
      setDetail(String(e));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
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
            <h2 className="text-lg font-semibold text-foreground">{tr("plugins")}</h2>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-secondary disabled:opacity-50"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
              {tr("refresh")}
            </button>
          </div>
        </div>
        <p className="mt-1 ml-16 text-xs text-muted-foreground">{local("管理 MCP 服务器和 Skills，扩展 Agent 的能力。", "Manage MCP servers and skills to extend the agent.")}</p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {error && (
          <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <section className="mb-6">
          <div className="mb-3 flex items-center gap-2">
            <Plug size={15} className="text-violet-500" />
            <h3 className="text-[15px] font-semibold text-foreground">{tr("mcpServers")}</h3>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-mono text-muted-foreground">{mcpServers.length}</span>
          </div>
          {mcpServers.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-secondary/50 px-6 py-8 text-center">
              <Plug size={28} className="mx-auto text-muted-foreground/50" />
              <p className="mt-2 text-sm font-medium text-muted-foreground">{local("没有配置 MCP 服务器", "No MCP servers configured")}</p>
              <p className="mt-1 text-xs text-muted-foreground/70">{local("添加 MCP 服务器可以扩展 Agent 的工具能力。", "Add an MCP server to extend the agent's tools.")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {mcpServers.map((server, i) => {
                const name = stringAt(server, "name") ?? stringAt(server, "id") ?? `MCP ${i + 1}`;
                const scope = stringAt(server, "scope");
                const transport = stringAt(server, "transport") ?? "stdio";
                const target = stringAt(server, "url") ?? stringAt(server, "command") ?? stringAt(server, "status") ?? local("已配置", "Configured");
                return (
                  <div key={`${name}-${i}`} className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10">
                        <Plug size={14} className="text-violet-500" />
                      </div>
                      <div>
                        <p className="text-[13px] font-medium text-foreground">{name}</p>
                        <p className="text-[11px] text-muted-foreground">{transport} · {target}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void doctorMcp(name)}
                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                        title={local("诊断", "Diagnose")}
                      >
                        <CheckCircle2 size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeMcp(name, scope)}
                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        title={tr("delete")}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {detail && (
          <pre className="mb-6 max-h-56 overflow-auto rounded-xl border border-border bg-secondary p-4 text-xs leading-relaxed text-secondary-foreground">
            {detail}
          </pre>
        )}

        <section>
          <div className="mb-3 flex items-center gap-2">
            <Wrench size={15} className="text-brand" />
            <h3 className="text-[15px] font-semibold text-foreground">Skills</h3>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-mono text-muted-foreground">{skills.length}</span>
          </div>
          {skills.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-secondary/50 px-6 py-8 text-center">
              <Wrench size={28} className="mx-auto text-muted-foreground/50" />
              <p className="mt-2 text-sm font-medium text-muted-foreground">{local("没有发现 Skill", "No skills found")}</p>
              <p className="mt-1 text-xs text-muted-foreground/70">{local("可以将 SKILL.md 放入项目或用户级 Grok skill 目录，然后刷新。", "Put SKILL.md in a project or user-level Grok skills directory, then refresh.")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {skills.map((skill, i) => {
                const name = stringAt(skill, "name") ?? `Skill ${i + 1}`;
                const desc = stringAt(skill, "description") ?? stringAt(recordAt(skill, "source"), "path") ?? local("没有描述", "No description");
                const sourceType = stringAt(recordAt(skill, "source"), "type") ?? local("已发现", "Discovered");
                return (
                   <div key={`${name}-${i}`} className="rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
                     <div className="flex items-start gap-3">
                       <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 shrink-0">
                         <Wrench size={14} className="text-brand" />
                       </div>
                       <div className="min-w-0 flex-1">
                         <div className="flex items-center justify-between gap-3">
                           <p className="text-[13px] font-medium text-foreground truncate">{name}</p>
                           <span className="text-[11px] text-muted-foreground/70 shrink-0">{sourceType}</span>
                         </div>
                         <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">{desc}</p>
                       </div>
                     </div>
                   </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function arrayRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((e): e is JsonRecord => Boolean(e) && typeof e === "object" && !Array.isArray(e))
    : [];
}
function recordAt(r: JsonRecord, key: string): JsonRecord | undefined {
  const v = r[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonRecord) : undefined;
}
function stringAt(r: JsonRecord | undefined, key: string): string | undefined {
  const v = r?.[key];
  return typeof v === "string" ? v : undefined;
}
