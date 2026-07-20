import { useEffect, useState } from "react";
import { Check, Copy, Globe, KeyRound, RefreshCw, ShieldCheck, TerminalSquare } from "lucide-react";
import type { OnboardingStage } from "./onboarding-flow";
import { useAppStore } from "@grok-gui/core";

const INSTALL_COMMAND = "curl -fsSL https://x.ai/cli/install.sh | bash";

interface OnboardingPageProps {
  stage: OnboardingStage;
  detail?: string | null;
  onInstall: () => Promise<void>;
  onOAuthLogin: () => Promise<void>;
  onDeviceLogin: () => Promise<void>;
  onSaveApiKey: (key: string) => Promise<void>;
  onRetry: () => Promise<void>;
}

export function OnboardingPage({
  stage, detail, onInstall, onOAuthLogin, onDeviceLogin, onSaveApiKey, onRetry,
}: OnboardingPageProps) {
  const [copied, setCopied] = useState(false);
  const [working, setWorking] = useState<"install" | "oauth" | "device" | "api-key" | "retry" | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deviceMessages, setDeviceMessages] = useState<string[]>([]);
  const english = useAppStore((s) => s.settings.language) === "en-US";

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__) return;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ message?: string }>("grok:device-auth", (event) => {
        const message = event.payload?.message?.trim();
        if (!message) return;
        setDeviceMessages((messages) => [...messages, message].slice(-8));
      }).then((stop) => { unlisten = stop; }),
    );
    return () => unlisten?.();
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      console.error("clipboard write failed");
    }
  };

  const run = async (kind: NonNullable<typeof working>, action: () => Promise<void>) => {
    if (working) return;
    setWorking(kind);
    setActionError(null);
    if (kind === "device") setDeviceMessages([]);
    try {
      await action();
    } catch (error) {
      setActionError(String(error));
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-8">
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <img src="/grok-gui-cover.png" alt="Grok GUI" className="h-16 w-16 rounded-2xl object-cover" />
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-foreground">
          {english ? "Welcome to Grok GUI" : "欢迎使用 Grok GUI"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {stage === "missing-cli"
            ? <>{english ? "Grok GUI needs the official Grok Build CLI. Installing runs the official xAI installer." : "Grok GUI 需要官方 Grok Build CLI。点击安装后会运行 xAI 官方安装器。"}</>
            : <>{english ? "Grok Build is installed. Sign in with Grok or use your xAI API key." : "Grok Build 已安装。请用官方 Grok 登录，或使用你的 xAI API Key。"}</>}
        </p>

        <div className="mt-6 w-full rounded-xl border border-border bg-card p-4 text-left shadow-sm">
          {stage === "missing-cli" ? <>
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"><TerminalSquare size={12} /> {english ? "Official install command" : "官方安装命令"}</p>
            <div className="mt-2 flex items-center gap-2 rounded-lg bg-secondary px-3 py-2.5">
              <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-secondary-foreground">{INSTALL_COMMAND}</code>
              <button type="button" onClick={() => void copy()} title={english ? "Copy install command" : "复制安装命令"} className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
              </button>
            </div>
            <button type="button" onClick={() => void run("install", onInstall)} disabled={!!working} className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-3 py-2.5 text-[13px] font-medium text-brand-foreground disabled:opacity-60">
              <TerminalSquare size={14} /> {working === "install" ? (english ? "Installing official CLI…" : "正在安装官方 CLI…") : (english ? "Install official Grok Build" : "安装官方 Grok Build")}
            </button>
          </> : <>
            <button type="button" onClick={() => void run("oauth", onOAuthLogin)} disabled={!!working} className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-3 py-2.5 text-[13px] font-medium text-brand-foreground disabled:opacity-60">
              <Globe size={14} /> {working === "oauth" ? (english ? "Waiting for browser authorization…" : "等待浏览器授权…") : (english ? "Sign in with Grok" : "使用 Grok 账号登录")}
            </button>
            <p className="mt-2 text-center text-[10px] text-muted-foreground">{english ? "Official Grok Build opens the browser sign-in page; Grok GUI never handles your password." : "将由官方 Grok Build 打开浏览器登录页；Grok GUI 不接触密码。"}</p>
            <button type="button" onClick={() => setShowApiKey((value) => !value)} disabled={!!working} className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-[12px] font-medium text-foreground hover:bg-secondary disabled:opacity-60">
              <KeyRound size={13} /> {english ? "Use an xAI API key" : "使用 xAI API Key"}
            </button>
            {showApiKey && <form className="mt-2" onSubmit={(event) => { event.preventDefault(); void run("api-key", async () => { await onSaveApiKey(apiKey); setApiKey(""); }); }}>
              <input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="xai-…" className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[12px] outline-none focus:ring-1 focus:ring-ring" />
              <button type="submit" disabled={!!working || !apiKey.trim()} className="mt-2 flex w-full items-center justify-center gap-2 rounded-md bg-secondary px-3 py-2 text-[12px] font-medium text-foreground disabled:opacity-60"><ShieldCheck size={13} /> {working === "api-key" ? (english ? "Saving securely and verifying…" : "正在安全保存并验证…") : (english ? "Save to macOS Keychain and connect" : "保存到 macOS 钥匙串并连接")}</button>
            </form>}
            <button type="button" onClick={() => void run("device", onDeviceLogin)} disabled={!!working} className="mt-2 w-full text-center text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-60">{english ? "No browser? Sign in with a device code" : "无浏览器？使用设备代码登录"}</button>
            {deviceMessages.length > 0 && <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-secondary px-2.5 py-2 font-mono text-[11px] leading-relaxed text-secondary-foreground">{deviceMessages.join("\n")}</pre>}
          </>}
          <button type="button" onClick={() => void run("retry", onRetry)} disabled={!!working} className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-[12px] font-medium text-foreground hover:bg-secondary disabled:opacity-60"><RefreshCw size={13} className={working === "retry" ? "animate-spin" : ""} />{english ? "Check again and continue" : "重新检测并继续"}</button>
          {(actionError || detail) && <p className="mt-3 rounded-md bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-destructive">{actionError || detail}</p>}
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground/80">
          {english ? <>The CLI defaults to <span className="font-mono">~/.grok/bin/grok</span>; API keys are stored only in macOS Keychain.</> : <>CLI 默认位于 <span className="font-mono">~/.grok/bin/grok</span>；API Key 仅存于 macOS 钥匙串。</>}
        </p>
      </div>
    </div>
  );
}
