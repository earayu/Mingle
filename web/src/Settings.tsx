import { type FormEvent, useEffect, useRef, useState } from "react";
import { api, type BrainStatus, type ProxyMode, type ProxyView } from "./api.ts";
import { BrainList } from "./Brains.tsx";
import { remember, useCached } from "./cache.ts";
import { errorText, type LocalePreference, type MessageKey, useI18n } from "./i18n.ts";
import { type OnlineState, online, useOnline } from "./online.ts";
import { applyTheme, savedTheme, type Theme } from "./theme.ts";
import {
  AlertIcon,
  Button,
  Field,
  Group,
  GroupRow,
  Input,
  PageHeader,
  Section,
  Segmented,
  Spinner,
  StatusDot,
} from "./ui.tsx";
import { type UpdateState, updates, useUpdates } from "./updates.ts";

export function SettingsPage({
  version,
  focus,
  usedHarnesses,
}: {
  version: string;
  focus?: "network";
  usedHarnesses?: ReadonlySet<string>;
}) {
  const { t, localePreference, setLocale } = useI18n();
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const update = useUpdates();
  const keep = useOnline();
  return (
    <>
      <PageHeader title={t("settings.title")} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex max-w-[640px] flex-col gap-7 px-6 py-6 md:px-8">
          <Section title={t("settings.general")}>
            <Group>
              <GroupRow>
                <span className="flex-1">{t("settings.appearance")}</span>
                <Segmented<Theme>
                  label={t("settings.appearance")}
                  value={theme}
                  onChange={(next) => {
                    setTheme(next);
                    void applyTheme(next);
                  }}
                  options={[
                    { value: "system", label: t("settings.system") },
                    { value: "light", label: t("settings.light") },
                    { value: "dark", label: t("settings.dark") },
                  ]}
                />
              </GroupRow>
              <GroupRow className="flex-wrap">
                <span className="flex-1">{t("settings.language")}</span>
                <Segmented<LocalePreference>
                  label={t("settings.language")}
                  value={localePreference}
                  onChange={setLocale}
                  options={[
                    { value: "system", label: t("settings.system") },
                    { value: "zh-CN", label: "简体中文" },
                    { value: "en", label: "English" },
                  ]}
                />
              </GroupRow>
            </Group>
          </Section>
          <NetworkProxy focus={focus === "network"} />
          {keep ? (
            <Section title={t("online.title")}>
              <Group>
                <OnlineRows state={keep} />
              </Group>
            </Section>
          ) : null}
          <Brains used={usedHarnesses} />
          <Section title={t("settings.about")}>
            <Group>
              <GroupRow>
                <span className="flex-1">{t("settings.version")}</span>
                <span className="selectable text-ink2">{version}</span>
              </GroupRow>
              {update ? <UpdateRows update={update} /> : null}
              <GroupRow>
                <span className="flex flex-col gap-0.5">
                  <span>{t("settings.privacy")}</span>
                  <span className="text-small text-ink2">{t("settings.privacyBody")}</span>
                </span>
              </GroupRow>
            </Group>
          </Section>
        </div>
      </div>
    </>
  );
}

function hasProxyCredentials(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim());
    return Boolean(parsed.username || parsed.password);
  } catch {
    return false;
  }
}

function stripMaskedAuth(url: string | null): string {
  return url ? url.replace("//••••••@", "//") : "";
}

/** Global outbound network proxy settings (docs/spec.md 9.1). */
function NetworkProxy({ focus }: { focus: boolean }) {
  const { t } = useI18n();
  const { value: cached, reload } = useCached<ProxyView>("proxy", api.proxy);
  const [latest, setLatest] = useState<ProxyView | null>(null);
  const [draftManual, setDraftManual] = useState(false);
  const [editing, setEditing] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [bypassInput, setBypassInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [applied, setApplied] = useState(false);
  const [highlighted, setHighlighted] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

  const proxy = latest ?? cached;

  const commit = (next: ProxyView) => {
    remember("proxy", next);
    setLatest(next);
  };

  // Refresh live OS proxy status when the window comes back to the front.
  useEffect(() => {
    const onFocus = () => {
      setLatest(null);
      void reload();
    };
    addEventListener("focus", onFocus);
    return () => removeEventListener("focus", onFocus);
  }, [reload]);

  useEffect(() => {
    if (!focus) return;
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlighted(true);
    const timer = setTimeout(() => setHighlighted(false), 1600);
    return () => clearTimeout(timer);
  }, [focus]);

  const showApplied = () => {
    setApplied(true);
    setTimeout(() => setApplied(false), 3200);
  };

  if (!proxy) return null;

  const selectedMode: ProxyMode = draftManual ? "manual" : proxy.mode;
  const manualNeedsForm = selectedMode === "manual" && (!proxy.url || editing || draftManual);

  const openManualEdit = () => {
    setUrlInput(stripMaskedAuth(proxy.url));
    setBypassInput(proxy.bypass);
    setFeedback(null);
    setEditing(true);
  };

  const cancelManualEdit = () => {
    setDraftManual(false);
    setEditing(false);
    setFeedback(null);
  };

  const changeMode = async (mode: ProxyMode) => {
    if (mode === selectedMode) return;
    setFeedback(null);
    if (mode === "manual" && !proxy.url) {
      setUrlInput("");
      setBypassInput(proxy.bypass);
      setDraftManual(true);
      setEditing(true);
      return;
    }
    if (draftManual && mode === proxy.mode) {
      cancelManualEdit();
      return;
    }
    setBusy(true);
    try {
      const next = await api.setProxy({ mode });
      commit(next);
      setDraftManual(false);
      setEditing(false);
      showApplied();
    } catch (e) {
      setFeedback({ kind: "err", text: errorText(t, e) });
    } finally {
      setBusy(false);
    }
  };

  const saveManual = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const trimmed = urlInput.trim();
      const unchangedAuthUrl = proxy.hasAuth && trimmed === stripMaskedAuth(proxy.url);
      const next = await api.setProxy({
        mode: "manual",
        url: trimmed,
        ...(unchangedAuthUrl ? { keepAuth: true } : {}),
        bypass: bypassInput.trim(),
      });
      commit(next);
      setDraftManual(false);
      setEditing(false);
      showApplied();
    } catch (e) {
      setFeedback({ kind: "err", text: errorText(t, e) });
    } finally {
      setBusy(false);
    }
  };

  const runTest = async (useSaved: boolean) => {
    setTesting(true);
    setFeedback(null);
    try {
      const input = useSaved
        ? { useSaved: true }
        : proxy.hasAuth && urlInput.trim() === stripMaskedAuth(proxy.url)
          ? { useSaved: true }
          : { url: urlInput.trim() };
      const result = await api.testProxy(input);
      if (result.ok) {
        setFeedback({ kind: "ok", text: t("proxy.testOk", { ms: String(result.latencyMs) }) });
      } else {
        const key = `error.${result.code}` as MessageKey;
        setFeedback({ kind: "err", text: t(key) !== key ? t(key) : t("error.proxy_unreachable") });
      }
    } catch (e) {
      setFeedback({ kind: "err", text: errorText(t, e) });
    } finally {
      setTesting(false);
    }
  };

  const toggleHarness = async (passToHarness: boolean) => {
    setBusy(true);
    setFeedback(null);
    try {
      const next = await api.setProxy({ passToHarness });
      commit(next);
    } catch (e) {
      setFeedback({ kind: "err", text: errorText(t, e) });
    } finally {
      setBusy(false);
    }
  };

  let statusDot: "connected" | "reconnecting" | "offline" = "offline";
  let statusText = t("proxy.statusDirect");
  let statusTone = "text-ink2";
  if (proxy.mode === "system") {
    if (proxy.effective.url) {
      statusDot = "connected";
      statusText = t("proxy.statusUsing", { url: proxy.effective.url });
    } else if (proxy.effective.pacOnly) {
      statusDot = "reconnecting";
      statusText = t("proxy.statusPac");
      statusTone = "text-amber";
    } else {
      statusDot = "offline";
      statusText = t("proxy.statusDirect");
    }
  } else if (proxy.mode === "manual") {
    if (proxy.authMissing) {
      statusDot = "reconnecting";
      statusText = t("proxy.authMissing");
      statusTone = "text-amber";
    } else if (proxy.url) {
      statusDot = "connected";
      statusText = t("proxy.statusUsing", { url: proxy.url });
    } else {
      statusDot = "reconnecting";
      statusText = t("proxy.statusManualUnset");
    }
  } else {
    statusDot = "offline";
    statusText = t("proxy.statusOff");
  }

  return (
    <div ref={sectionRef}>
      <Section title={t("settings.network")}>
        <Group
          className={
            highlighted ? "!border-accent ring-3 ring-accent/20 transition-[border-color,box-shadow] duration-200" : ""
          }
        >
          <GroupRow className="flex-wrap">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span>{t("proxy.title")}</span>
              <span className={`flex items-start gap-1.5 text-small ${statusTone}`}>
                <span className="mt-[6px] inline-flex shrink-0">
                  <StatusDot state={statusDot} />
                </span>
                <span className="selectable min-w-0 break-all">{statusText}</span>
              </span>
            </span>
            <Segmented<ProxyMode>
              label={t("proxy.title")}
              value={selectedMode}
              onChange={(next) => void changeMode(next)}
              options={[
                { value: "system", label: t("proxy.modeSystem") },
                { value: "manual", label: t("proxy.modeManual") },
                { value: "off", label: t("proxy.modeOff") },
              ]}
            />
          </GroupRow>

          {selectedMode === "manual" ? (
            <div className="rise flex flex-col gap-3 bg-group px-4 py-3.5">
              {manualNeedsForm ? (
                <form
                  onSubmit={saveManual}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && (proxy.url || draftManual)) {
                      cancelManualEdit();
                    }
                  }}
                  className="flex flex-col gap-3"
                >
                  <Field label={t("proxy.url")} hint={t("proxy.urlHint")}>
                    <Input
                      autoFocus={editing}
                      value={urlInput}
                      onChange={(e) => {
                        setUrlInput(e.target.value);
                        if (feedback) setFeedback(null);
                      }}
                      placeholder={t("proxy.urlPlaceholder")}
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono text-small"
                    />
                  </Field>
                  {hasProxyCredentials(urlInput) ? (
                    <p className="flex items-center gap-1.5 rounded-control border border-line bg-bg px-2.5 py-1.5 text-caption text-ink2">
                      <AlertIcon className="text-accent" />
                      <span>{t("proxy.keychainHint")}</span>
                    </p>
                  ) : null}
                  <Field label={t("proxy.bypass")} hint={t("proxy.bypassHint")}>
                    <Input
                      value={bypassInput}
                      onChange={(e) => setBypassInput(e.target.value)}
                      placeholder={t("proxy.bypassPlaceholder")}
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono text-small"
                    />
                  </Field>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="submit" variant="primary" small disabled={busy || !urlInput.trim()}>
                      {t("proxy.save")}
                    </Button>
                    <Button small disabled={testing || !urlInput.trim()} onClick={() => void runTest(false)}>
                      {testing ? (
                        <>
                          <Spinner /> {t("proxy.testing")}
                        </>
                      ) : (
                        t("proxy.test")
                      )}
                    </Button>
                    {proxy.url || draftManual ? (
                      <Button variant="ghost" small onClick={cancelManualEdit}>
                        {t("agent.cancel")}
                      </Button>
                    ) : null}
                  </div>
                </form>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line bg-bg px-3 py-2">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="selectable truncate font-mono text-small">{proxy.url}</span>
                    <span className="truncate text-caption text-ink3">
                      {proxy.bypass ? t("proxy.bypassSummary", { list: proxy.bypass }) : t("proxy.bypassLoopbackOnly")}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Button small disabled={testing} onClick={() => void runTest(true)}>
                      {testing ? (
                        <>
                          <Spinner /> {t("proxy.testing")}
                        </>
                      ) : (
                        t("proxy.test")
                      )}
                    </Button>
                    <Button small onClick={openManualEdit}>
                      {t("proxy.edit")}
                    </Button>
                  </span>
                </div>
              )}

              {feedback ? (
                <p role="status" className={`text-small ${feedback.kind === "ok" ? "text-green" : "text-red"}`}>
                  {feedback.text}
                </p>
              ) : null}
            </div>
          ) : null}

          <GroupRow>
            <label
              className={`flex min-w-0 flex-1 items-center gap-3 ${selectedMode === "off" ? "opacity-50" : "cursor-pointer"}`}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span>{t("proxy.passToHarness")}</span>
                <span className="text-small text-ink2">{t("proxy.passToHarnessHint")}</span>
              </span>
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-[var(--accent-btn)]"
                checked={proxy.passToHarness}
                disabled={selectedMode === "off" || busy}
                onChange={(e) => void toggleHarness(e.target.checked)}
              />
            </label>
          </GroupRow>
        </Group>
        {feedback && selectedMode !== "manual" ? (
          <p role="status" className={`px-1 text-small ${feedback.kind === "ok" ? "text-green" : "text-red"}`}>
            {feedback.text}
          </p>
        ) : null}
        {applied ? <p className="rise px-1 text-small text-ink2">{t("proxy.applied")}</p> : null}
      </Section>
    </div>
  );
}

/** The desktop app's updates, under the version. */
function UpdateRows({ update }: { update: UpdateState }) {
  const { t } = useI18n();
  const version = update.available ?? "";
  let status = t("update.latest");
  let action = <Button onClick={() => updates.check()}>{t("update.check")}</Button>;
  if (!update.supported) status = t("update.unsupported");
  else if (update.ready) {
    status = t("update.ready", { version });
    action = (
      <Button variant="primary" onClick={() => updates.restart()}>
        {t("update.restartNow")}
      </Button>
    );
  } else if (version) {
    status = t(update.automaticDownloads ? "update.downloading" : "update.available", { version });
    action = (
      <Button onClick={() => updates.check()}>
        {update.automaticDownloads ? t("update.progress") : t("update.installNow")}
      </Button>
    );
  }
  return (
    <>
      <GroupRow>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span>{t("update.title")}</span>
          <span className="text-small text-ink2">{status}</span>
        </span>
        {action}
      </GroupRow>
      {update.supported ? (
        <GroupRow>
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span>{t("update.automatic")}</span>
              <span className="text-small text-ink2">{t("update.automaticHint")}</span>
            </span>
            <input
              type="checkbox"
              className="size-4 shrink-0 accent-[var(--accent-btn)]"
              checked={update.automaticDownloads}
              onChange={(e) => updates.setAutomaticDownloads(e.target.checked)}
            />
          </label>
        </GroupRow>
      ) : null}
    </>
  );
}

/** The desktop app's settings that keep the agents online, in Settings and in the agent page's card. */
export function OnlineRows({ state, notifications = true }: { state: OnlineState; notifications?: boolean }) {
  const { t } = useI18n();
  return (
    <>
      <ToggleRow
        label={t("online.openAtLogin")}
        hint={t("online.openAtLoginHint")}
        checked={state.openAtLogin}
        onChange={(on) => online.setOpenAtLogin(on)}
      />
      <ToggleRow
        label={t("online.keepAwake")}
        hint={t(state.platform === "darwin" ? "online.keepAwakeHintMac" : "online.keepAwakeHint")}
        checked={state.keepAwake}
        onChange={(on) => online.setKeepAwake(on)}
      />
      {notifications ? (
        <ToggleRow
          label={t("online.notifications")}
          hint={t("online.notificationsHint")}
          checked={state.notifications}
          onChange={(on) => online.setNotifications(on)}
        />
      ) : null}
    </>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <GroupRow>
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span>{label}</span>
          <span className="text-small text-ink2">{hint}</span>
        </span>
        <input
          type="checkbox"
          className="size-4 shrink-0 accent-[var(--accent-btn)]"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
      </label>
    </GroupRow>
  );
}

/** Every harness Mingle can drive: what is installed, signed in, and a way to fix the rest. */
function Brains({ used }: { used?: ReadonlySet<string> }) {
  const { t } = useI18n();
  const { value: brains, reload } = useCached<BrainStatus[]>(
    "brains",
    () => api.brains(),
    [],
    () => api.brains(true),
  );
  return (
    <Section title={t("settings.brains")}>
      <p className="-mt-1 px-1 text-small text-ink2">{t("settings.brainsBody")}</p>
      {brains === null ? null : (
        <BrainList brains={brains} {...(used ? { used } : {})} onChanged={() => void reload()} />
      )}
    </Section>
  );
}
