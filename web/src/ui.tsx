import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import type { AgentStatus } from "./api.ts";
import { useI18n } from "./i18n.ts";

/** The few building blocks DESIGN.md allows. Nothing here takes a color. */

type Variant = "primary" | "secondary" | "text";

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const look: Record<Variant, string> = {
    primary: "bg-accent text-on-accent",
    secondary: "border border-border text-text hover:bg-surface",
    text: "text-text-secondary hover:text-text",
  };
  return (
    <button
      type="button"
      className={`h-8 shrink-0 rounded-sm px-3 text-body transition-colors duration-[120ms] disabled:opacity-40 ${look[variant]} ${className}`}
      {...props}
    />
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
    <label className="flex flex-col gap-1">
      <span className="text-small text-text-secondary">{label}</span>
      {children}
      {hint ? <span className="text-small text-text-tertiary">{hint}</span> : null}
    </label>
  );
}

const control =
  "w-full rounded-sm bg-surface px-3 text-body text-text placeholder:text-text-tertiary outline-none focus-visible:outline-none focus:ring-1 focus:ring-text";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`h-8 ${control}`} {...props} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`min-h-24 resize-y py-2 ${control}`} {...props} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`h-8 ${control}`} {...props} />;
}

const dot: Record<string, string> = {
  idle: "bg-ok",
  thinking: "bg-ok breathe",
  working: "bg-ok breathe",
  connected: "bg-ok",
  reconnecting: "bg-wait",
  awaiting_approval: "bg-wait",
  awaiting_credentials: "bg-text-tertiary",
  offline: "bg-text-tertiary",
  error: "bg-error",
};

export function StatusDot({ state }: { state: string }) {
  return (
    <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${dot[state] ?? "bg-text-tertiary"}`} />
  );
}

export function AgentStatusLine({ status, detail }: { status: AgentStatus; detail?: string | null }) {
  const { t } = useI18n();
  return (
    <span className="flex min-w-0 items-center gap-2 text-small text-text-secondary">
      <StatusDot state={status} />
      <span className="truncate">
        {t(`status.${status}`)}
        {detail && (status === "working" || status === "error") ? ` · ${detail}` : ""}
      </span>
    </span>
  );
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const initial = [...name.trim()][0]?.toUpperCase() ?? "?";
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.45 }}
      className="flex shrink-0 items-center justify-center rounded-md bg-surface font-semibold text-text-secondary"
    >
      {initial}
    </span>
  );
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex h-8 items-center justify-between">
        <h2 className="text-heading font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="text-text-secondary">{children}</p>;
}

/** Monospace for IDs, commands and paths. */
export function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-small">{children}</code>;
}

export function relativeTime(ms: number, locale: string): string {
  const diff = (ms - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return new Date(ms).toLocaleDateString(locale, { month: "short", day: "numeric" });
}
