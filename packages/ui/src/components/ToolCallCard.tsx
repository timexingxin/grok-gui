import { Check, X, Loader2, FileText, Terminal, Search, Pencil, Globe, Wrench, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { type ToolCallRecord } from "@grok-gui/core";
import { cn } from "../lib/utils";
import { useAppStore } from "@grok-gui/core";

const iconFor = (name: string) => {
  if (/^read|file|get/.test(name)) return FileText;
  if (/write|edit|patch|apply/.test(name)) return Pencil;
  if (/^shell|bash|exec|run|terminal/.test(name)) return Terminal;
  if (/^search|grep|find/.test(name)) return Search;
  if (/web|http|fetch|browse/.test(name)) return Globe;
  return Wrench;
};

const SUMMARY_KEYS = ["path", "file_path", "filePath", "command", "cmd", "query", "pattern", "url", "directory", "cwd"];

function summarizeArgs(args: unknown): string | null {
  if (args == null || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value) {
      return value.length > 100 ? `${value.slice(0, 97)}…` : value;
    }
  }
  return null;
}

function detailFor(call: ToolCallRecord, language: "zh-CN" | "en-US"): string | null {
  const sections: string[] = [];
  if (call.args !== undefined) {
    sections.push(`${language === "en-US" ? "Input" : "输入"}\n${JSON.stringify(call.args, null, 2)}`);
  }
  if (call.output) {
    const output = call.output.length > 4000 ? `${call.output.slice(0, 4000)}\n…` : call.output;
    sections.push(`${language === "en-US" ? "Output" : "输出"}\n${output}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : null;
}

export function ToolCallCard({ call, defaultOpen = false }: { call: ToolCallRecord; defaultOpen?: boolean }) {
  const language = useAppStore((s) => s.settings.language);
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  const Status =
    call.status === "running" ? Loader2
    : call.status === "ok" ? Check
    : X;
  const elapsed = call.finishedAt ? call.finishedAt - call.startedAt : Date.now() - call.startedAt;
  const summary = summarizeArgs(call.args);
  const Icon = iconFor(call.name);
  const detail = detailFor(call, language);

  return (
    <div className="my-1.5" data-testid="tool-row">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-secondary/40"
      >
        <ChevronRight
          size={15}
          className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <Icon size={16} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{call.name}</span>
        {summary && <span className="max-w-[42%] truncate text-xs text-muted-foreground">{summary}</span>}
        <div className="flex shrink-0 items-center gap-2">
          <Status
            size={15}
            className={cn(
              "shrink-0",
              call.status === "running" && "animate-spin text-blue-500",
              call.status === "ok" && "text-emerald-500",
              call.status === "error" && "text-red-500",
            )}
          />
          <span className="text-xs text-muted-foreground">{elapsed}ms</span>
        </div>
      </button>
      {open && detail && (
        <pre className="ml-7 mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
          {detail}
        </pre>
      )}
    </div>
  );
}
