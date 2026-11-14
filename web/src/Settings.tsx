import { useState } from "react";
import { api, type BrainStatus } from "./api.ts";
import { BrainRow } from "./Brains.tsx";
import { useCached } from "./cache.ts";
import { type LocalePreference, useI18n } from "./i18n.ts";
import { type OnlineState, online, useOnline } from "./online.ts";
import { applyTheme, savedTheme, type Theme } from "./theme.ts";
import { Button, Group, GroupRow, PageHeader, Section, Segmented } from "./ui.tsx";
import { type UpdateState, updates, useUpdates } from "./updates.ts";

export function SettingsPage({ version }: { version: string }) {
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
          {keep ? (
            <Section title={t("online.title")}>
              <Group>
                <OnlineRows state={keep} />
              </Group>
            </Section>
          ) : null}
          <Brains />
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
function Brains() {
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
        <div className="overflow-hidden rounded-card border border-line bg-card">
          <div className="divide-y divide-line">
            {brains.map((b) => (
              <BrainRow key={b.id} brain={b} onChanged={() => void reload()} />
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}
