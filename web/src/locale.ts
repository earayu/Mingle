export type Locale = "en" | "zh-CN";
export type LocalePreference = Locale | "system";

export function localePreference(saved: string | null): LocalePreference {
  return saved === "en" || saved === "zh-CN" ? saved : "system";
}

export function resolveLocale(preference: LocalePreference, languages: readonly string[]): Locale {
  if (preference !== "system") return preference;
  for (const language of languages) {
    const base = language.trim().toLowerCase().split(/[-_]/)[0];
    if (base === "zh") return "zh-CN";
    if (base === "en") return "en";
  }
  return "en";
}
