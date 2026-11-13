import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useRef,
  useState,
} from "react";
import type { AgentStatus } from "./api.ts";
import { useI18n } from "./i18n.ts";

/** The building blocks DESIGN.md defines. Nothing here takes a raw color. */

type Variant = "default" | "primary" | "danger" | "ghost";

export function Button({
  variant = "default",
  small = false,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; small?: boolean }) {
  const look: Record<Variant, string> = {
    default: "border border-line2 bg-card text-ink enabled:hover:bg-bg3",
    primary: "border border-transparent bg-accent-btn text-white enabled:hover:brightness-110",
    danger: "border border-red-line bg-card text-red enabled:hover:bg-red-tint",
    ghost: "border border-transparent text-ink2 enabled:hover:bg-bg3 enabled:hover:text-ink",
  };
  const size = small ? "h-7 px-2.5 text-small" : "h-[34px] px-3.5 text-body";
  return (
    <button
      type="button"
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control font-medium whitespace-nowrap transition-[background-color,filter] duration-[120ms] disabled:opacity-45 ${size} ${look[variant]} ${className}`}
      {...props}
    />
  );
}

/** A button that opens a page outside, in the browser. */
export function LinkButton({ href, children, small }: { href: string; children: ReactNode; small?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex shrink-0 items-center gap-1.5 self-start rounded-control border border-line2 bg-card font-medium whitespace-nowrap text-ink transition-colors duration-[120ms] hover:bg-bg3 ${small ? "h-7 px-2.5 text-small" : "h-[34px] px-3.5 text-body"}`}
    >
      {children}
      <ArrowUpRight />
    </a>
  );
}

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
    <label className="flex flex-col gap-1.5">
      <span className="text-small font-medium text-ink2">{label}</span>
      {children}
      {hint ? <span className="text-caption text-ink3">{hint}</span> : null}
    </label>
  );
}

const control =
  "w-full rounded-control border border-line2 bg-bg px-3 text-body text-ink placeholder:text-ink3 outline-none transition-[border-color,box-shadow] duration-[120ms] focus:border-accent focus:ring-3 focus:ring-accent/20 disabled:opacity-50";

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`h-[34px] ${control} ${className}`} {...props} />;
}

export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`min-h-24 resize-y py-2 leading-5 ${control} ${className}`} {...props} />;
}

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`h-[34px] ${control} ${className}`} {...props} />;
}

/** A row of choices where one is on: appearance, language. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-control bg-bg3 p-0.5">
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: a styled choice; a native radio cannot take this look
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className="h-7 rounded-small px-3 text-small text-ink2 transition-colors duration-[120ms] aria-checked:bg-card aria-checked:font-medium aria-checked:text-ink aria-checked:shadow-card"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Rows on a rounded field, as macOS settings group them. */
export function Group({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-card border border-line bg-card ${className}`}>
      <div className="flex flex-col divide-y divide-line">{children}</div>
    </div>
  );
}

export function GroupRow({
  children,
  className = "",
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`flex min-h-[52px] w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-[120ms] hover:bg-bg2 ${className}`}
      >
        {children}
      </button>
    );
  }
  return <div className={`flex min-h-[52px] items-center gap-3 px-4 py-2.5 ${className}`}>{children}</div>;
}

export function Section({
  title,
  action,
  children,
  className = "",
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex flex-col gap-2.5 ${className}`}>
      <div className="flex min-h-7 items-center justify-between gap-3 px-1">
        <h2 className="text-headline font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A small grey heading over a list, as "AGENTS" in the sidebar. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pt-1 pb-1.5 text-caption font-semibold text-ink3">{children}</div>;
}

const dot: Record<string, string> = {
  idle: "bg-green",
  thinking: "bg-green breathe",
  working: "bg-green breathe",
  connected: "bg-green",
  reconnecting: "bg-amber-dot",
  awaiting_approval: "bg-amber-dot",
  awaiting_credentials: "bg-ink3",
  offline: "bg-ink3",
  error: "bg-red",
};

export function StatusDot({ state }: { state: string }) {
  return <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${dot[state] ?? "bg-ink3"}`} />;
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const initial = [...name.trim()][0]?.toUpperCase() ?? "?";
  // A stable hue per name, so agents tell apart at a glance; soft, never loud.
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  const hue = hash % 360;
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        fontSize: size * 0.46,
        borderRadius: Math.round(size * 0.28),
        background: `oklch(0.62 0.12 ${hue})`,
      }}
      className="flex shrink-0 items-center justify-center font-semibold text-white"
    >
      {initial}
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="spin shrink-0 text-ink3" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Why something is stuck, in the person's language, and what to do. */
export function Problem({
  title,
  children,
  tone = "amber",
}: {
  title: ReactNode;
  children?: ReactNode;
  tone?: "amber" | "red";
}) {
  const box = tone === "red" ? "border-red-line bg-red-tint" : "border-amber-line bg-amber-tint";
  return (
    <div role="status" className={`flex flex-col gap-1 rounded-[10px] border px-3 py-2.5 ${box}`}>
      <div className="flex items-start gap-2">
        <AlertIcon className={tone === "red" ? "text-red" : "text-amber-dot"} />
        <span className="min-w-0 flex-1 text-body font-semibold">{title}</span>
      </div>
      {children ? <div className="pl-6 text-small text-ink2">{children}</div> : null}
    </div>
  );
}

export type StepState = "later" | "todo" | "now" | "done";

/**
 * One step of a guide: a number (a check once done) and a title, and under the step
 * the person is at, what to do or what Mingle waits for. After Pinky's Add phone.
 */
export function Step({
  n,
  title,
  state,
  hint,
  open = false,
  children,
}: {
  n: number;
  title: ReactNode;
  state: StepState;
  hint?: ReactNode;
  /** Keep the step's content showing once done, as a form's fields. */
  open?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      {state === "done" ? (
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-green text-white">
          <CheckIcon />
        </span>
      ) : state === "now" ? (
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-accent text-small font-bold text-accent">
          {n}
        </span>
      ) : (
        <span
          className={`flex size-6 shrink-0 items-center justify-center rounded-full border border-line2 text-caption ${state === "todo" ? "text-ink2" : "text-ink3"}`}
        >
          {n}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        <span className={`text-body font-semibold ${state === "later" ? "text-ink3" : ""}`}>{title}</span>
        {hint ? <span className="-mt-1.5 text-caption text-ink3">{hint}</span> : null}
        {(open || state === "now" || state === "todo") && children ? (
          <div className="rise flex flex-col gap-3">{children}</div>
        ) : null}
      </div>
    </li>
  );
}

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="flex flex-col gap-5">{children}</ol>;
}

export function Waiting({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-2 text-small text-ink2">
      <Spinner />
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}

/** The header of a page, as tall as the sidebar's brand row beside it. */
export function PageHeader({
  title,
  meta,
  leading,
  actions,
}: {
  title: ReactNode;
  meta?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-6">
      {leading}
      <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
        {/* The name keeps its room; what follows it gives way first. */}
        <h1 className="max-w-[60%] shrink-0 truncate text-title3 font-semibold">{title}</h1>
        {meta ? <span className="min-w-0 flex-1 truncate text-small text-ink2">{meta}</span> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A "…" button with a short menu under it. Closes on a choice, Escape or a click elsewhere. */
export function MoreMenu({
  label,
  items,
}: {
  label: string;
  items: { label: string; onSelect: () => void; danger?: boolean }[];
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <Button variant="ghost" small aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        <MoreIcon />
      </Button>
      {open ? (
        <div
          role="menu"
          className="rise absolute top-8 right-0 z-30 flex min-w-44 flex-col rounded-control border border-line bg-card p-1 shadow-card"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={`flex h-8 items-center rounded-small px-2.5 text-left text-body hover:bg-bg3 ${item.danger ? "text-red" : ""}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AgentStatusText({ status, detail }: { status: AgentStatus; detail?: string | null }) {
  const { t } = useI18n();
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <StatusDot state={status} />
      <span className="truncate">
        {t(`status.${status}`)}
        {detail && status === "working" ? ` · ${detail}` : ""}
      </span>
    </span>
  );
}

// ------------------------------------------------------------------ icons
// Line icons, 1.5 stroke, drawn on a 16 grid.

function Icon({ children, className = "", size = 16 }: { children: ReactNode; className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const PlusIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);
export const SettingsIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5 3.4 3.4" />
  </Icon>
);
export const CheckIcon = (p: { className?: string }) => (
  <Icon {...p} size={14}>
    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeWidth="2" />
  </Icon>
);
export const AlertIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M8 1.8 14.6 13.5H1.4Z" />
    <path d="M8 6.2v3.3M8 11.6v.1" />
  </Icon>
);
export const MoreIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.2" />
  </Icon>
);
export const ArrowUpRight = (p: { className?: string }) => (
  <Icon {...p} size={12}>
    <path d="M5 11 11 5M6 5h5v5" />
  </Icon>
);
export const BackIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M10 3 5 8l5 5" />
  </Icon>
);
export const FolderIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.6H13c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2Z" />
  </Icon>
);
export const ChatIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2Z" />
  </Icon>
);

// ------------------------------------------------------------------ time

/** "Tomorrow 20:02", "Thu 09:00", or "Nov 20, 09:00" for further out. */
export function shortDateTime(ms: number, locale: string): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(date) - startOfDay(new Date())) / 86_400_000);
  if (days === 0 || days === 1) {
    const word = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day");
    return `${word} ${time}`;
  }
  if (days > 1 && days < 7) return `${date.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString(locale, { month: "short", day: "numeric" })} ${time}`;
}

export function relativeTime(ms: number, locale: string): string {
  const diff = (ms - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 45) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return new Date(ms).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** The harness's own mark, for the light or dark background it sits on. */
export function HarnessIcon({
  harness,
  size = 24,
}: {
  harness: { name: string; icon?: { light: string; dark: string } };
  size?: number;
}) {
  if (!harness.icon) return <Avatar name={harness.name} size={size} />;
  return (
    <span className="flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <img src={harness.icon.light} alt="" className="size-full dark:hidden" />
      <img src={harness.icon.dark} alt="" className="hidden size-full dark:block" />
    </span>
  );
}
