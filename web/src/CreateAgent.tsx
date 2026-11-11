import { type FormEvent, useEffect, useState } from "react";
import { type AgentView, api, type Harness } from "./api.ts";
import { errorText, useI18n } from "./i18n.ts";
import { Button, Field, Input, Muted, Select, Textarea } from "./ui.tsx";

export function CreateAgent({ onCreated, onCancel }: { onCreated: (agent: AgentView) => void; onCancel?: () => void }) {
  const { t } = useI18n();
  const [harnesses, setHarnesses] = useState<Harness[] | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [harness, setHarness] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .harnesses()
      .then((list) => {
        setHarnesses(list);
        setHarness((current) => current || list[0]?.id || "");
      })
      .catch(() => setHarnesses([]));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const agent = await api.createAgent({ name, role, harness, ...(model.trim() ? { model: model.trim() } : {}) });
      onCreated(agent);
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <h1 className="text-title font-semibold">{t("create.title")}</h1>
      <Field label={t("create.name")}>
        <Input
          autoFocus
          required
          value={name}
          maxLength={40}
          placeholder={t("create.namePlaceholder")}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label={t("create.role")}>
        <Textarea
          value={role}
          rows={5}
          placeholder={t("create.rolePlaceholder")}
          onChange={(e) => setRole(e.target.value)}
        />
      </Field>
      {harnesses && harnesses.length === 0 ? (
        <Muted>{t("create.noHarness")}</Muted>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <Field label={t("create.brain")}>
            <Select value={harness} onChange={(e) => setHarness(e.target.value)} disabled={!harnesses}>
              {(harnesses ?? []).map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("create.model")}>
            <Input value={model} placeholder={t("create.modelDefault")} onChange={(e) => setModel(e.target.value)} />
          </Field>
        </div>
      )}
      <p className="text-small text-text-secondary">{t("create.notice")}</p>
      {error ? <p className="text-small text-error">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy || !name.trim() || !harness}>
          {t("create.submit")}
        </Button>
        {onCancel ? (
          <Button variant="text" onClick={onCancel}>
            {t("create.cancel")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
