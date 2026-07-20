import { cn } from "../lib/utils";

const kindColor: Record<string, string> = {
  xai: "bg-amber-500/10 text-amber-700 ring-amber-500/20",
  openai: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20",
  anthropic: "bg-orange-500/10 text-orange-700 ring-orange-500/20",
  google: "bg-blue-500/10 text-blue-700 ring-blue-500/20",
  openai_compat: "bg-violet-500/10 text-violet-700 ring-violet-500/20",
};

export function ModelBadge({
  provider,
  model,
  className,
}: {
  provider: string;
  model: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
        kindColor[provider] ?? "bg-secondary text-secondary-foreground ring-border",
        className,
      )}
    >
      {model}
    </span>
  );
}
