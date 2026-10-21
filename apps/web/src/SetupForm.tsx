import { HOUSEHOLD_DEFAULTS, LOCALES, type ToolInput, WEEKDAYS } from "@mise/domain";
import { createSignal, For, Show } from "solid-js";
import type { MiseClient } from "./client";
import { type MessageKey, t } from "./messages";

type SetupInput = Required<ToolInput<"setup_household">>;

const fieldLabels: Record<keyof SetupInput, MessageKey> = {
  name: "setup.name",
  timezone: "setup.timezone",
  dinnerTime: "setup.dinnerTime",
  weekStartsOn: "setup.weekStartsOn",
  units: "setup.units",
  locale: "setup.locale",
};

/** First-run setup. On success the change notice makes every open tab refetch, this one included. */
export function SetupForm(props: { client: MiseClient }) {
  const [input, setInput] = createSignal<SetupInput>({ name: "", ...HOUSEHOLD_DEFAULTS });
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string>();

  const update = <K extends keyof SetupInput>(key: K, value: SetupInput[K]) =>
    setInput((current) => ({ ...current, [key]: value }));

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await props.client.call("setup_household", input());
      if (result.ok) return;
      if (result.error.code === "invalid_input") {
        const fields = (result.error.issues ?? []).map((issue) =>
          issue.path in fieldLabels ? t(fieldLabels[issue.path as keyof SetupInput]) : issue.path,
        );
        setError(t("setup.invalid", { fields: fields.join(", ") }));
      } else if (result.error.code === "already_set_up") {
        setError(t("setup.alreadySetUp"));
      } else {
        setError(t("app.error"));
      }
    } catch {
      setError(t("app.error"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <h2>{t("setup.title")}</h2>
      <p>{t("setup.intro")}</p>

      <label>
        {t("setup.name")}
        <input required maxLength={100} value={input().name} onInput={(e) => update("name", e.currentTarget.value)} />
      </label>

      <label>
        {t("setup.timezone")}
        <select value={input().timezone} onChange={(e) => update("timezone", e.currentTarget.value)}>
          <For each={Intl.supportedValuesOf("timeZone")}>{(zone) => <option value={zone}>{zone}</option>}</For>
        </select>
      </label>

      <label>
        {t("setup.dinnerTime")}
        <input
          type="time"
          required
          value={input().dinnerTime}
          onInput={(e) => update("dinnerTime", e.currentTarget.value)}
        />
      </label>

      <label>
        {t("setup.weekStartsOn")}
        <select
          value={input().weekStartsOn}
          onChange={(e) => update("weekStartsOn", e.currentTarget.value as SetupInput["weekStartsOn"])}
        >
          <For each={WEEKDAYS}>{(day) => <option value={day}>{t(`weekday.${day}`)}</option>}</For>
        </select>
      </label>

      <label>
        {t("setup.units")}
        <select value={input().units} onChange={(e) => update("units", e.currentTarget.value as SetupInput["units"])}>
          <option value="metric">{t("units.metric")}</option>
          <option value="imperial">{t("units.imperial")}</option>
        </select>
      </label>

      <label>
        {t("setup.locale")}
        <select
          value={input().locale}
          onChange={(e) => update("locale", e.currentTarget.value as SetupInput["locale"])}
        >
          <For each={LOCALES}>{(locale) => <option value={locale}>{t(`locale.${locale}`)}</option>}</For>
        </select>
      </label>

      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>

      <button type="submit" disabled={submitting()}>
        {submitting() ? t("setup.submitting") : t("setup.submit")}
      </button>
    </form>
  );
}
