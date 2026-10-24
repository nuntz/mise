import { HOUSEHOLD_DEFAULTS, type HouseholdSettings } from "@mise/domain";
import { createSignal, Index, Show } from "solid-js";
import type { MiseClient } from "./client";
import { errorText } from "./errors";
import { HouseholdSettingsFields } from "./HouseholdSettings";
import { emptyMember, type MemberDraft, MemberFields, memberOf } from "./MemberFields";
import { t } from "./messages";

/** First-run setup. On success the change notice makes every open tab refetch, this one included. */
export function SetupForm(props: { client: MiseClient }) {
  const [input, setInput] = createSignal<HouseholdSettings>({ name: "", ...HOUSEHOLD_DEFAULTS });
  const [members, setMembers] = createSignal<MemberDraft[]>([]);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string>();

  const update = <K extends keyof HouseholdSettings>(key: K, value: HouseholdSettings[K]) =>
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

      <HouseholdSettingsFields settings={input()} onChange={update} />

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
