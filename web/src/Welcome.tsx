import { useI18n } from "./i18n.ts";
import iconUrl from "./icon.svg";
import { Button, Step, Steps } from "./ui.tsx";

/** The first run: what Mingle does, in three steps, and one button. */
export function Welcome({ onStart }: { onStart: () => void }) {
  const { t } = useI18n();
  return (
    <div className="drag flex min-h-0 flex-1 overflow-y-auto">
      <div className="m-auto flex w-full max-w-[460px] flex-col gap-8 px-6 py-12">
        <div className="flex flex-col gap-3">
          <img src={iconUrl} alt="" className="size-14 rounded-[14px]" />
          <h1 className="text-title1 font-bold">{t("welcome.title")}</h1>
          <p className="text-headline text-ink2">{t("welcome.body")}</p>
        </div>
        <Steps>
          <Step n={1} state="todo" title={t("welcome.step1")} hint={t("welcome.step1Hint")} />
          <Step n={2} state="todo" title={t("welcome.step2")} hint={t("welcome.step2Hint")} />
          <Step n={3} state="todo" title={t("welcome.step3")} hint={t("welcome.step3Hint")} />
        </Steps>
        <div className="flex flex-col gap-3">
          <Button variant="primary" className="self-start" onClick={onStart}>
            {t("welcome.start")}
          </Button>
          <p className="text-caption text-ink3">{t("welcome.privacy")}</p>
        </div>
      </div>
    </div>
  );
}
