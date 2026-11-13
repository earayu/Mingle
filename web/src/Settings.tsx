import { useState } from "react";
import { type Locale, useI18n } from "./i18n.ts";
import { Group, GroupRow, PageHeader, Section, Segmented } from "./ui.tsx";

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
