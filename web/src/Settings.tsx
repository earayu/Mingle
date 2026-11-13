import { useState } from "react";
import { type Locale, useI18n } from "./i18n.ts";
import { Button, Group, GroupRow, PageHeader, Section, Segmented } from "./ui.tsx";
import { type UpdateState, updates, useUpdates } from "./updates.ts";

export type Theme = "system" | "light" | "dark";

export function savedTheme(): Theme {
  const saved = localStorage.getItem("mingle.theme");
  return saved === "light" || saved === "dark" ? saved : "system";
}

export function applyTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  localStorage.setItem("mingle.theme", theme);
}

export function SettingsPage({ version }: { version: string }) {
  const { t, locale, setLocale } = useI18n();
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const update = useUpdates();
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
                    applyTheme(next);
                  }}
                  options={[
                    { value: "system", label: t("settings.system") },
                    { value: "light", label: t("settings.light") },
                    { value: "dark", label: t("settings.dark") },
                  ]}
                />
              </GroupRow>
              <GroupRow>
                <span className="flex-1">{t("settings.language")}</span>
                <Segmented<Locale>
                  label={t("settings.language")}
                  value={locale}
                  onChange={setLocale}
                  options={[
                    { value: "zh-CN", label: "简体中文" },
                    { value: "en", label: "English" },
                  ]}
                />
              </GroupRow>
            </Group>
          </Section>
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
