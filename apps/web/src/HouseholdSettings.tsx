import { type Household, HouseholdSettings, LOCALES, UNITS, WEEKDAYS } from "@mise/domain";
import { createEffect, createSignal, For, on, Show } from "solid-js";
import type { MiseClient } from "./client";
import { errorText } from "./errors";
import { t } from "./messages";

/** The settings of a Household, chosen at setup and changed after it. */
export function HouseholdSettingsFields(props: {
  settings: HouseholdSettings;
  onChange: <K extends keyof HouseholdSettings>(key: K, value: HouseholdSettings[K]) => void;
}) {
  return (
    <>
      <label>
        {t("setup.name")}
        <input
          required
          maxLength={100}
          value={props.settings.name}
          onInput={(e) => props.onChange("name", e.currentTarget.value)}
        />
      </label>

      <label>
        {t("setup.timezone")}
        <select value={props.settings.timezone} onChange={(e) => props.onChange("timezone", e.currentTarget.value)}>
          <For each={Intl.supportedValuesOf("timeZone")}>{(zone) => <option value={zone}>{zone}</option>}</For>
        </select>
      </label>

      <label>
        {t("setup.dinnerTime")}
        <input
          type="time"
          required
          value={props.settings.dinnerTime}
          onInput={(e) => props.onChange("dinnerTime", e.currentTarget.value)}
        />
      </label>

      <label>
        {t("setup.weekStartsOn")}
        <select
          value={props.settings.weekStartsOn}
          onChange={(e) => props.onChange("weekStartsOn", e.currentTarget.value as HouseholdSettings["weekStartsOn"])}
        >
          <For each={WEEKDAYS}>{(day) => <option value={day}>{t(`weekday.${day}`)}</option>}</For>
        </select>
      </label>

      <label>
        {t("setup.units")}
        <select
          value={props.settings.units}
          onChange={(e) => props.onChange("units", e.currentTarget.value as HouseholdSettings["units"])}
        >
          <For each={UNITS}>{(units) => <option value={units}>{t(`units.${units}`)}</option>}</For>
        </select>
      </label>

      <label>
        {t("setup.locale")}
        <select
          value={props.settings.locale}
          onChange={(e) => props.onChange("locale", e.currentTarget.value as HouseholdSettings["locale"])}
        >
          <For each={LOCALES}>{(locale) => <option value={locale}>{t(`locale.${locale}`)}</option>}</For>
        </select>
      </label>
    </>
  );
}

function settingsOf(household: Household): HouseholdSettings {
  return Object.fromEntries(HouseholdSettings.keyof().options.map((key) => [key, household[key]])) as HouseholdSettings;
}

/**
 * Changes the Household's settings. Until someone edits it, the form follows the Household as it
 * changes, on this device or another; once edited, it keeps what was typed until saved.
 */
export function HouseholdSettingsForm(props: { client: MiseClient; household: Household }) {
  const [draft, setDraft] = createSignal(settingsOf(props.household));
  const [edited, setEdited] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string>();

  createEffect(
    on(
      () => settingsOf(props.household),
      (settings) => {
        if (!edited()) setDraft(settings);
      },
    ),
  );

  const change = <K extends keyof HouseholdSettings>(key: K, value: HouseholdSettings[K]) => {
    setEdited(true);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await props.client.call("update_household_settings", draft());
      if (result.ok) {
        setEdited(false);
        setDraft(settingsOf(result.value));
      } else setError(errorText(result.error, "household"));
    } catch {
      setError(t("app.error"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <HouseholdSettingsFields settings={draft()} onChange={change} />
      <Show when={draft().weekStartsOn !== props.household.weekStartsOn}>
        <p class="meta">{t("settings.weekStartHint", { weekday: t(`weekday.${draft().weekStartsOn}`) })}</p>
      </Show>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
      <button type="submit" class="button-primary" disabled={submitting()}>
        {submitting() ? t("settings.saving") : t("settings.save")}
      </button>
    </form>
  );
}
