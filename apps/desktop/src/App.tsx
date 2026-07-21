import { useEffect, useState } from "react";
import { Sidebar, TopBar, ChatArea, InputBar, WorkspacePanel, SettingsPage, PluginsPanel, ScheduledPanel, OnboardingPage, appIconUrl } from "@grok-gui/ui";
import { useAppStore } from "@grok-gui/core";
import type { OnboardingStage } from "@grok-gui/ui";

const accentColors: Record<string, string> = {
  blue: "#3b82f6", orange: "#f97316", violet: "#8b5cf6",
  emerald: "#10b981", rose: "#f43f5e", sky: "#0ea5e9",
};

function applyTheme(s: { theme: string; accent: string; fontSize: number; chatMaxWidth: number }) {
  const root = document.documentElement;
  root.style.setProperty("--brand", accentColors[s.accent] ?? "#3b82f6");
  root.style.setProperty("--font-size-base", `${s.fontSize}px`);
  root.style.setProperty("--chat-max-width", `${s.chatMaxWidth}px`);
  if (s.theme === "dark") {
    root.classList.add("dark");
    root.classList.remove("light");
  } else if (s.theme === "light") {
    root.classList.add("light");
    root.classList.remove("dark");
  } else {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.toggle("dark", prefersDark);
    root.classList.toggle("light", !prefersDark);
  }
}

export default function App() {
  const [bootState, setBootState] = useState<"booting" | "onboarding" | "error" | "ready">("booting");
  const [bootError, setBootError] = useState<string | null>(null);
  const [onboardingStage, setOnboardingStage] = useState<OnboardingStage>("missing-cli");
  const screen = useAppStore((s) => s.screen);
  const workbenchVisible = useAppStore((s) => s.workbenchVisible);
  const settings = useAppStore((s) => s.settings);
  const english = settings.language === "en-US";

  useEffect(() => {
    applyTheme(settings);
    if (settings.theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(useAppStore.getState().settings);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [settings.theme, settings.accent, settings.fontSize, settings.chatMaxWidth]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const store = useAppStore.getState();
      if (event.key === "n" || event.key === "N") {
        event.preventDefault();
        store.setScreen("chat");
        void store.newTask(store.session?.workspace);
      } else if (event.key === ",") {
        event.preventDefault();
        store.setScreen(store.screen === "settings" ? "chat" : "settings");
      } else if (event.key === "b" || event.key === "B") {
        event.preventDefault();
        store.setSidebarCollapsed(!store.sidebarCollapsed);
      } else if ((event.key === "w" || event.key === "W") && event.shiftKey) {
        event.preventDefault();
        store.setWorkbenchVisible(!store.workbenchVisible);
      } else if (event.key === "k" || event.key === "K") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>("[data-session-search]")?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      void useAppStore.getState().checkScheduledTasks();
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  const boot = async () => {
    setBootState("booting");
    setBootError(null);
    try {
      const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
      if (isTauri) {
        const { invoke } = await import("@tauri-apps/api/core");
        const cli = await invoke<{ installed: boolean }>("detect_grok_cli");
        if (!cli.installed) {
          setOnboardingStage("missing-cli");
          setBootState("onboarding");
          return;
        }
      }
      const store = useAppStore.getState();
      await store.init();
      const params = new URLSearchParams(window.location.search);
      const deepLinked = params.get("session");
      if (deepLinked && store.history.some((entry) => entry.id === deepLinked)) {
        await useAppStore.getState().openConversation(deepLinked);
      } else {
        const workspace = useAppStore.getState().settings.defaultWorkspace || "~";
        const language = useAppStore.getState().settings.language;
        try {
          await useAppStore.getState().startSession(workspace, undefined, language);
        } catch (startErr) {
          console.warn("Failed to start session, checking CLI again:", startErr);
          if (isTauri) {
            const { invoke } = await import("@tauri-apps/api/core");
            const cli = await invoke<{ installed: boolean }>("detect_grok_cli");
            if (!cli.installed) {
              setOnboardingStage("missing-cli");
              setBootState("onboarding");
              return;
            }
          }
          setOnboardingStage("authenticate");
          setBootError(String(startErr));
          setBootState("onboarding");
          return;
        }
      }
      setBootState("ready");
    } catch (err) {
      setBootError(String(err));
      setBootState("error");
    }
  };

  useEffect(() => {
    void boot();
  }, []);

  if (bootState === "onboarding") {
    const invokeSetup = async (command: string, key?: string) => {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke(command, key == null ? undefined : { key });
      await boot();
    };
    return <OnboardingPage
      stage={onboardingStage}
      detail={bootError}
      onInstall={() => invokeSetup("install_official_grok_cli")}
      onOAuthLogin={() => invokeSetup("login_grok_oauth")}
      onDeviceLogin={() => invokeSetup("login_grok_device_code")}
      onSaveApiKey={(key) => invokeSetup("save_xai_api_key", key)}
      onRetry={boot}
    />;
  }

  if (bootState === "error") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background p-8">
        <div className="max-w-md text-center">
          <p className="text-base font-semibold text-destructive">{english ? `${__APP_NAME__} could not start the agent` : `${__APP_NAME__} 无法启动智能体`}</p>
          <p className="mt-2 text-sm text-muted-foreground">{bootError}</p>
          <p className="mt-2 text-xs text-muted-foreground/80">
            {english ? `Grok Build CLI was found but a session could not be started. Complete CLI sign-in and try again; ${__APP_NAME__} never fakes a connection.` : `已找到 Grok Build CLI，但未能建立会话。请完成 CLI 登录后重试；${__APP_NAME__} 不会伪造连接状态。`}
          </p>
          <button
            type="button"
            onClick={() => void boot()}
            className="mt-5 rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background"
          >
            {english ? "Retry connection" : "重试连接"}
          </button>
        </div>
      </div>
    );
  }

  if (bootState !== "ready") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-foreground" />
          <p className="text-sm text-muted-foreground">{english ? `Starting ${__APP_NAME__}…` : `正在启动 ${__APP_NAME__}…`}</p>
        </div>
      </div>
    );
  }

  if (!settings.languageChosen) {
    return <LanguagePicker />;
  }

  if (screen === "settings") {
    return <div className="h-full w-full"><SettingsPage /></div>;
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {screen === "plugins" ? (
            <PluginsPanel />
          ) : screen === "scheduled" ? (
            <ScheduledPanel />
          ) : (
            <>
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <ChatArea />
                <InputBar />
              </div>
              {workbenchVisible && <WorkspacePanel />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function LanguagePicker() {
  const updateSettings = useAppStore((s) => s.updateSettings);
  const initialLang = useAppStore((s) => s.settings.language);
  const [picked, setPicked] = useState<"en-US" | "zh-CN">(
    initialLang === "zh-CN" ? "zh-CN" : "en-US",
  );

  const choose = (lang: "en-US" | "zh-CN") => {
    setPicked(lang);
  };

  const confirm = () => {
    updateSettings({ language: picked, languageChosen: true });
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-background px-6">
      <div className="flex w-full max-w-md flex-col items-center">
        <img src={appIconUrl} alt={__APP_NAME__} className="h-16 w-16 rounded-2xl object-cover" />
        <h1 className="mt-5 text-2xl font-bold tracking-tight text-foreground">{__APP_NAME__}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose your language / 选择你的语言
        </p>

        <div className="mt-7 flex w-full flex-col gap-2.5">
          <button
            type="button"
            onClick={() => choose("en-US")}
            className={
              "flex items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm font-medium transition-colors " +
              (picked === "en-US"
                ? "border-brand bg-brand/10 text-foreground"
                : "border-border bg-card text-card-foreground hover:bg-secondary")
            }
          >
            <span className="text-xl">🇺🇸</span>
            English
          </button>
          <button
            type="button"
            onClick={() => choose("zh-CN")}
            className={
              "flex items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm font-medium transition-colors " +
              (picked === "zh-CN"
                ? "border-brand bg-brand/10 text-foreground"
                : "border-border bg-card text-card-foreground hover:bg-secondary")
            }
          >
            <span className="text-xl">🇨🇳</span>
            简体中文
          </button>
        </div>

        <button
          type="button"
          onClick={confirm}
          className="mt-6 w-full rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-brand-foreground transition-opacity hover:opacity-90"
        >
          {picked === "zh-CN" ? "开始使用" : "Get started"}
        </button>
      </div>
    </div>
  );
}
