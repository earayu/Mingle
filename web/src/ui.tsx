import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  memo,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { AgentStatus } from "./api.ts";
import { useI18n } from "./i18n.ts";
import { type Keys, keysAria, keysLabel, useShortcutHints, withMod } from "./shortcuts.ts";

/** The building blocks DESIGN.md defines. Nothing here takes a raw color. */

type Variant = "default" | "primary" | "danger" | "ghost";

export function Button({
  variant = "default",
  small = false,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  small?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
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

/** Return writes a new line; Command-Return (Ctrl+Enter elsewhere) submits the form it is in. */
export function Textarea({ className = "", onKeyDown, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`min-h-24 resize-y py-2 leading-5 ${control} ${className}`}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.key !== "Enter" || !withMod(event) || event.nativeEvent.isComposing) return;
        const form = event.currentTarget.form;
        if (!form) return;
        event.preventDefault();
        // As Return in a field: nothing while the form's button is disabled (busy, or not ready).
        const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
        if (!button?.disabled) form.requestSubmit(button ?? undefined);
      }}
      {...props}
    />
  );
}

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`h-[34px] ${control} ${className}`} {...props} />;
}

/** A row of choices where one is on: appearance, language, an agent's tabs (with their keys). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  onPrefetch,
  label,
}: {
  value: T;
  options: { value: T; label: string; keys?: Keys }[];
  onChange: (value: T) => void;
  /** Warm the target view when the pointer or focus rests on an inactive choice. */
  onPrefetch?: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-control bg-bg3 p-0.5">
      {options.map((o) => {
        const warm = onPrefetch && o.value !== value ? () => onPrefetch(o.value) : undefined;
        const choice = (
          // biome-ignore lint/a11y/useSemanticElements: a styled choice; a native radio cannot take this look
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            aria-keyshortcuts={o.keys ? keysAria(o.keys) : undefined}
            onClick={() => onChange(o.value)}
            onPointerEnter={warm}
            onFocus={warm}
            className="h-7 rounded-small px-3 text-small text-ink2 transition-colors duration-[120ms] aria-checked:bg-card aria-checked:font-medium aria-checked:text-ink aria-checked:shadow-card"
          >
            {o.label}
          </button>
        );
        return o.keys ? (
          <Shortcut key={o.value} label={o.label} keys={o.keys} side="bottom">
            {choice}
          </Shortcut>
        ) : (
          choice
        );
      })}
    </div>
  );
}

/** A key as it is printed on the keyboard: "⌘N", "Ctrl+N". */
export function Kbd({ keys, className = "" }: { keys: Keys; className?: string }) {
  return (
    <kbd
      className={`inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[5px] border border-line2 bg-bg2 px-1 font-sans text-[11px] leading-none font-medium tracking-[0.02em] whitespace-nowrap text-ink2 ${className}`}
    >
      {keysLabel(keys)}
    </kbd>
  );
}

/** Moving from one tooltip to the next shows it at once, as in macOS. */
let tipShownAt = 0;
const TIP_DELAY = 400;
const TIP_WARM = 600;

/**
 * A button that has a shortcut. Pointing at it shows its name and keys in a small tooltip, soon
 * and without the browser's long delay; holding the modifier shows the keys beside it for every
 * such button at once (useShortcutHints). Touch shows neither.
 */
export function Shortcut({
  label,
  keys,
  side,
  className = "",
  children,
}: {
  label: string;
  keys: Keys | undefined;
  /** Where the tooltip and the held-modifier key go: right of a sidebar row, or below a button. */
  side: "right" | "bottom";
  className?: string;
  children: ReactNode;
}) {
  const hints = useShortcutHints();
  const box = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => () => clearTimeout(timer.current), []);
  // Kept inside the window: the header's buttons sit near its right edge.
  useLayoutEffect(() => {
    const el = tip.current;
    if (!el || !at) return;
    const r = el.getBoundingClientRect();
    const shift = Math.min(0, innerWidth - 8 - r.right) || Math.max(0, 8 - r.left);
    if (shift) el.style.marginLeft = `${shift}px`;
  }, [at]);
  if (!keys) return <>{children}</>;
  const show = (now: boolean) => {
    clearTimeout(timer.current);
    const place = () => {
      const r = box.current?.getBoundingClientRect();
      if (!r) return;
      setAt(
        side === "right" ? { x: r.right + 8, y: r.top + r.height / 2 } : { x: r.left + r.width / 2, y: r.bottom + 6 },
      );
      tipShownAt = Date.now();
    };
    if (now || Date.now() - tipShownAt < TIP_WARM) place();
    else timer.current = setTimeout(place, TIP_DELAY);
  };
  const hide = () => {
    clearTimeout(timer.current);
    if (at) tipShownAt = Date.now();
    setAt(null);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it only watches the button it wraps, to show its tooltip
    <span
      ref={box}
      className={`relative ${side === "right" ? "flex" : "inline-flex"} ${className}`}
      aria-describedby={at ? id : undefined}
      onPointerEnter={(e) => e.pointerType === "mouse" && show(false)}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={(e) => e.target.matches(":focus-visible") && show(true)}
      onBlur={hide}
      onKeyDown={(e) => e.key === "Escape" && hide()}
    >
      {children}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute z-30 transition-opacity duration-[120ms] ${hints ? "opacity-100" : "opacity-0"} ${side === "right" ? "top-1/2 right-2 -translate-y-1/2" : "top-full left-1/2 mt-1.5 -translate-x-1/2"}`}
      >
        <Kbd keys={keys} className="shadow-card" />
      </span>
      {at && !hints
        ? createPortal(
            <span
              ref={tip}
              id={id}
              role="tooltip"
              style={{ left: at.x, top: at.y }}
              className={`pointer-events-none fixed z-50 flex max-w-[280px] items-center gap-2 rounded-control border border-line bg-card py-1 pr-1 pl-2.5 text-small text-ink shadow-card ${side === "right" ? "-translate-y-1/2" : "-translate-x-1/2"}`}
            >
              <span className="min-w-0 truncate">{label}</span>
              <Kbd keys={keys} />
            </span>,
            document.body,
          )
        : null}
    </span>
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
  id,
  tabIndex,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  /** Lets a link elsewhere on the page land on this row. */
  id?: string;
  tabIndex?: number;
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
  return (
    <div id={id} tabIndex={tabIndex} className={`flex min-h-[52px] items-center gap-3 px-4 py-2.5 ${className}`}>
      {children}
    </div>
  );
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
  // Paused on purpose: a hollow dot, so it does not read as "offline" or "broken".
  paused: "border-[1.5px] border-ink3",
};

export const StatusDot = memo(function StatusDot({ state }: { state: string }) {
  return <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${dot[state] ?? "bg-ink3"}`} />;
});

export const Avatar = memo(function Avatar({
  name,
  src,
  size = 32,
}: {
  name: string;
  src?: string | null;
  size?: number;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const radius = Math.round(size * 0.28);
  if (src && broken !== src) {
    return (
      <img
        alt=""
        src={src}
        width={size}
        height={size}
        decoding="async"
        draggable={false}
        onError={() => setBroken(src)}
        style={{ width: size, height: size, borderRadius: radius }}
        className="shrink-0 bg-bg3 object-cover"
      />
    );
  }
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
        borderRadius: radius,
        background: `oklch(0.62 0.12 ${hue})`,
      }}
      className="flex shrink-0 items-center justify-center font-semibold text-white"
    >
      {initial}
    </span>
  );
});

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

/** Official docs for using an API key instead of signing in, for harnesses we can point to. */
const API_KEY_DOCS: Readonly<Record<string, string>> = {
  claude: "https://code.claude.com/docs/en/llm-gateway-connect",
  codex: "https://developers.openai.com/codex/config-advanced",
};

/**
 * Under a "not signed in" problem: signing in is not the only way. Says how to use an
 * API key with this harness and that Mingle needs a restart to see a shell variable.
 */
export function ApiKeyHint({ harness }: { harness: string }) {
  const { t } = useI18n();
  const docs = API_KEY_DOCS[harness];
  if (!docs) return null;
  return (
    <p className="mt-1">
      {t(`apiKey.${harness}` as "apiKey.claude")}{" "}
      <a className="text-accent underline-offset-2 hover:underline" href={docs} target="_blank" rel="noreferrer">
        {t("apiKey.docs")}
      </a>
      <br />
      {t("apiKey.restart")}
    </p>
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

/**
 * A "…" button with a short menu under it. Closes on a choice, Escape or a click elsewhere.
 * The panel sits in a body portal: rows group inside overflow-hidden cards that would clip it.
 */
export function MoreMenu({
  label,
  items,
  trigger,
}: {
  label: string;
  items: { label: string; onSelect: () => void; danger?: boolean; checked?: boolean }[];
  /** A word in a sentence that opens the menu instead of the "…" button; the panel opens under its start. */
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const box = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = box.current?.getBoundingClientRect();
      const panel = menu.current;
      if (!anchor || !panel) return;
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const margin = 8;
      const below = anchor.bottom + 4;
      const top = below + height <= window.innerHeight - margin ? below : anchor.top - height - 4;
      setPosition({
        top: Math.max(margin, Math.min(top, window.innerHeight - height - margin)),
        left: Math.max(
          margin,
          Math.min(trigger ? anchor.left : anchor.right - width, window.innerWidth - width - margin),
        ),
      });
    };
    place();
    (
      menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      menu.current?.querySelector<HTMLButtonElement>("button")
    )?.focus({ preventScroll: true });
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    addEventListener("resize", schedule, { passive: true });
    addEventListener("scroll", schedule, { capture: true, passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      removeEventListener("resize", schedule);
      removeEventListener("scroll", schedule, true);
    };
  }, [open, trigger]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        setOpen(false);
        box.current?.querySelector("button")?.focus({ preventScroll: true });
      } else if (!box.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", close);
    };
  }, [open]);
  const restore = () => box.current?.querySelector("button")?.focus({ preventScroll: true });
  const Box = trigger ? "span" : "div";
  return (
    <Box ref={box} className={trigger ? "relative inline" : "relative"}>
      {trigger ? (
        <button
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-controls={open ? menuId : undefined}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="inline-flex items-baseline gap-0.5 rounded-small text-ink2 underline decoration-line2 decoration-dashed underline-offset-[3px] transition-colors duration-[120ms] hover:text-ink hover:decoration-ink3 focus-visible:outline-2 focus-visible:outline-accent"
        >
          {trigger}
          <ChevronIcon className="self-center text-ink3" />
        </button>
      ) : (
        <Button
          variant="ghost"
          small
          aria-label={label}
          aria-haspopup="menu"
          aria-controls={open ? menuId : undefined}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <MoreIcon />
        </Button>
      )}
      {open
        ? createPortal(
            <div
              ref={menu}
              id={menuId}
              role="menu"
              aria-label={label}
              style={position}
              className={`fixed z-50 flex ${trigger ? "w-max min-w-44 max-w-[min(20rem,calc(100vw-16px))]" : "w-44 max-w-[calc(100vw-16px)]"} max-h-[calc(100vh-16px)] flex-col overflow-y-auto rounded-control border border-line bg-card p-1 shadow-card`}
            >
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  {...(item.checked === undefined
                    ? { role: "menuitem" }
                    : { role: "menuitemradio", "aria-checked": item.checked })}
                  onClick={() => {
                    setOpen(false);
                    restore();
                    item.onSelect();
                  }}
                  className={`flex min-h-8 shrink-0 items-center gap-2 rounded-small px-2.5 py-1 text-left text-body wrap-anywhere hover:bg-bg3 focus-visible:bg-bg3 focus-visible:outline-none ${item.danger ? "text-red" : ""}`}
                >
                  <span className="min-w-0 flex-1">{item.label}</span>
                  {item.checked ? <CheckIcon className="shrink-0 text-accent" /> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </Box>
  );
}

/**
 * A "?" beside a heading: the detail that would otherwise be a paragraph. Shows on hover,
 * keyboard focus or a click (touch), and closes on Escape or when the pointer leaves.
 */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        className="flex size-7 items-center justify-center rounded-full text-ink3 transition-colors duration-[120ms] hover:text-ink2 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <HelpIcon />
      </button>
      {open ? (
        <span
          id={id}
          role="tooltip"
          className="rise absolute top-full left-0 z-40 mt-1 w-72 max-w-[calc(100vw-48px)] rounded-control border border-line bg-card px-3 py-2 text-small font-normal text-ink2 shadow-card"
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}

export const AgentStatusText = memo(function AgentStatusText({
  status,
  detail,
  where,
  more,
}: {
  status: AgentStatus;
  detail?: string | null;
  /** The SSH host it runs on; the status reads "unknown" while that host is out of reach. */
  where?: { host: string; reachable: boolean };
  /** What follows, such as the chat apps in the sidebar. */
  more?: string;
}) {
  const { t } = useI18n();
  const known = where?.reachable !== false;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {known ? <StatusDot state={status} /> : null}
      <span className="truncate">
        {known ? t(`status.${status}`) : t("ssh.unknown")}
        {known && detail && status === "working" ? ` · ${detail}` : ""}
        {where ? ` · ${where.host}` : ""}
        {more ? ` · ${more}` : ""}
      </span>
    </span>
  );
});

/** Copy text, falling back to a hidden text area where the clipboard API is not offered (some webviews). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}

/**
 * Text the person types somewhere else (a name, a command), copied with one click.
 * Sits inline in a sentence, so the instruction and the exact words read as one.
 */
export function Copyable({ value }: { value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={async () => setCopied(await copyText(value))}
      title={copied ? t("copy.done") : t("copy.action")}
      aria-label={`${copied ? t("copy.done") : t("copy.action")}: ${value}`}
      className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-small border border-line2 bg-bg2 px-1.5 align-[-2px] font-mono text-[0.9em] leading-[1.45] font-normal text-ink transition-colors duration-[120ms] hover:border-accent hover:bg-accent-tint"
    >
      <span className="selectable truncate">{value}</span>
      {copied ? <CheckIcon className="text-green" /> : <CopyIcon className="text-ink3" />}
    </button>
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
export const UpdateIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.5" />
    <path d="M8 11V5M5.5 7.5 8 5l2.5 2.5" />
  </Icon>
);
export const CheckIcon = (p: { className?: string }) => (
  <Icon {...p} size={14}>
    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeWidth="2" />
  </Icon>
);
export const CopyIcon = (p: { className?: string }) => (
  <Icon {...p} size={13}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
  </Icon>
);
export const PauseIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M6 3.5v9M10 3.5v9" />
  </Icon>
);
export const PlayIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M5 3.5v9l7-4.5z" />
  </Icon>
);
export const AlertIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M8 1.8 14.6 13.5H1.4Z" />
    <path d="M8 6.2v3.3M8 11.6v.1" />
  </Icon>
);
export const ChevronIcon = (p: { className?: string }) => (
  <Icon {...p} size={12}>
    <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
  </Icon>
);
/** A thread under its channel: a line that turns into the reply. */
export const ThreadIcon = (p: { className?: string }) => (
  <Icon {...p} size={12}>
    <path d="M4 2.5v6a2.5 2.5 0 0 0 2.5 2.5H13M10.5 8.5 13 11l-2.5 2.5" />
  </Icon>
);
export const MoreIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.2" />
  </Icon>
);
/** A dice face: pick a random value (a generated name). */
export const DiceIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="2.75" />
    <path d="M5.7 5.7h.01M10.3 5.7h.01M5.7 10.3h.01M10.3 10.3h.01" strokeWidth="2" />
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
export const HelpIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M6.3 6.2a1.8 1.8 0 0 1 3.5.5c0 1.2-1.8 1.5-1.8 2.6M8 11.4v.1" />
  </Icon>
);
export const EyeIcon = (p: { className?: string; off?: boolean }) => (
  <Icon className={p.className}>
    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="1.8" />
    {p.off ? <path d="M2.5 13.5 13.5 2.5" /> : null}
  </Icon>
);
/** A handoff: something carried over from elsewhere, to the line it stops at. */
export const HandoffIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M2.5 8h8M7.5 4.5 11 8l-3.5 3.5M13.5 3v10" />
  </Icon>
);
export const ChatIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2Z" />
  </Icon>
);

// ------------------------------------------------------------------ time
// Intl formatters are expensive to construct; reuse one per locale so lists render without jank.

function cachedFormatter<T>(map: Map<string, T>, key: string, create: () => T): T {
  let formatter = map.get(key);
  if (!formatter) {
    formatter = create();
    map.set(key, formatter);
  }
  return formatter;
}

const timeFmt = new Map<string, Intl.DateTimeFormat>();
const weekdayFmt = new Map<string, Intl.DateTimeFormat>();
const monthDayFmt = new Map<string, Intl.DateTimeFormat>();
const dayThisYearFmt = new Map<string, Intl.DateTimeFormat>();
const dayOtherYearFmt = new Map<string, Intl.DateTimeFormat>();
const relTimeFmt = new Map<string, Intl.RelativeTimeFormat>();
const intFmt = new Map<string, Intl.NumberFormat>();
const decFmt = new Map<string, Intl.NumberFormat>();

const getTimeFmt = (locale: string) =>
  cachedFormatter(
    timeFmt,
    locale,
    () => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }),
  );
const getWeekdayFmt = (locale: string) =>
  cachedFormatter(weekdayFmt, locale, () => new Intl.DateTimeFormat(locale, { weekday: "short" }));
const getMonthDayFmt = (locale: string) =>
  cachedFormatter(monthDayFmt, locale, () => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }));
const getDayFmt = (locale: string, sameYear: boolean) =>
  sameYear
    ? cachedFormatter(
        dayThisYearFmt,
        locale,
        () => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", weekday: "short" }),
      )
    : cachedFormatter(
        dayOtherYearFmt,
        locale,
        () => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", weekday: "short", year: "numeric" }),
      );
const getRelFmt = (locale: string) =>
  cachedFormatter(relTimeFmt, locale, () => new Intl.RelativeTimeFormat(locale, { numeric: "auto" }));

/** "09:00", formatted with a reused Intl.DateTimeFormat. */
export function clockTime(ms: number, locale: string): string {
  return getTimeFmt(locale).format(ms);
}

/** The day a run of messages was said on: "Today", "Yesterday", or the date. */
export function dayLabel(ms: number, locale: string): string {
  const date = new Date(ms);
  const now = new Date();
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(date) - start(now)) / 86_400_000);
  if (days === 0 || days === -1) {
    const word = getRelFmt(locale).format(days, "day");
    return word.charAt(0).toUpperCase() + word.slice(1);
  }
  return getDayFmt(locale, date.getFullYear() === now.getFullYear()).format(date);
}

/** Human-readable file size with cached Intl.NumberFormat. */
export function formatBytes(bytes: number | null, locale: string): string {
  if (bytes === null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  const fmt = u
    ? cachedFormatter(decFmt, locale, () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }))
    : cachedFormatter(intFmt, locale, () => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }));
  return `${fmt.format(n)} ${units[u]}`;
}

/** "Yesterday 09:00", "Tomorrow 20:02", "Thu 09:00", or "Nov 20, 09:00" for further out. */
export function shortDateTime(ms: number, locale: string): string {
  const date = new Date(ms);
  const time = getTimeFmt(locale).format(date);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(date) - startOfDay(new Date())) / 86_400_000);
  if (days >= -1 && days <= 1) {
    const word = getRelFmt(locale).format(days, "day");
    return `${word} ${time}`;
  }
  if (days > 1 && days < 7) return `${getWeekdayFmt(locale).format(date)} ${time}`;
  return `${getMonthDayFmt(locale).format(date)} ${time}`;
}

export function relativeTime(ms: number, locale: string): string {
  const diff = (ms - Date.now()) / 1000;
  const rtf = getRelFmt(locale);
  const abs = Math.abs(diff);
  if (abs < 45) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return getMonthDayFmt(locale).format(ms);
}

/** The harness's own mark, for the light or dark background it sits on. */
export const HarnessIcon = memo(function HarnessIcon({
  harness,
  size = 24,
}: {
  harness: { name: string; icon?: { light: string; dark: string } };
  size?: number;
}) {
  if (!harness.icon) return <Avatar name={harness.name} size={size} />;
  return (
    <span className="flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <img src={harness.icon.light} alt="" decoding="async" className="size-full dark:hidden" />
      <img src={harness.icon.dark} alt="" decoding="async" className="hidden size-full dark:block" />
    </span>
  );
});
