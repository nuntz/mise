import { HOUSEHOLD_DEFAULTS, LOCALES, type ToolInput, UNITS, WEEKDAYS } from "@mise/domain";
import { createSignal, For, Index, Show } from "solid-js";
import type { MiseClient } from "./client";
import { errorText } from "./errors";
import { emptyMember, type MemberDraft, MemberFields, memberOf } from "./MemberFields";
import { t } from "./messages";

type SetupInput = Required<Omit<ToolInput<"setup_household">, "members">>;

/** First-run setup. On success the change notice makes every open tab refetch, this one included. */
export function SetupForm(props: { client: MiseClient }) {
  const [input, setInput] = createSignal<SetupInput>({ name: "", ...HOUSEHOLD_DEFAULTS });
  const [members, setMembers] = createSignal<MemberDraft[]>([]);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string>();

  const update = <K extends keyof SetupInput>(key: K, value: SetupInput[K]) =>
    setInput((current) => ({ ...current, [key]: value }));

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await props.client.call("setup_household", { ...input(), members: members().map(memberOf) });
      if (!result.ok) setError(errorText(result.error, "household"));
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
          <For each={UNITS}>{(units) => <option value={units}>{t(`units.${units}`)}</option>}</For>
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

      <h3>{t("setup.members")}</h3>
      <p>{t("setup.membersIntro")}</p>
      <Index each={members()}>
        {(member, index) => (
          <div>
            <MemberFields
              draft={member()}
              onChange={(draft) => setMembers((all) => all.map((m, i) => (i === index ? draft : m)))}
            />
            <button type="button" onClick={() => setMembers((all) => all.filter((_, i) => i !== index))}>
              {t("member.remove")}
            </button>
          </div>
        )}
      </Index>
      <button type="button" onClick={() => setMembers((all) => [...all, emptyMember()])}>
        {t("members.add")}
      </button>

      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>

      <button type="submit" disabled={submitting()}>
        {submitting() ? t("setup.submitting") : t("setup.submit")}
      </button>
    </form>
  );
}
