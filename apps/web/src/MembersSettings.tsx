import { type Constraint, constraintSeverity, type Member, type MemberId, type ToolError } from "@mise/domain";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { MiseClient } from "./client";
import { errorText } from "./errors";
import { draftOf, emptyMember, type MemberDraft, MemberFields, memberOf } from "./MemberFields";
import { t } from "./messages";

/** Settings: the Household's Members and their Constraints, editable at any time. */
export function MembersSettings(props: { client: MiseClient; members: Member[] }) {
  // Which Member the Caller is, so they can find themselves.
  const [callerMemberId, setCallerMemberId] = createSignal<MemberId>();
  const refetchCaller = async () => {
    try {
      const result = await props.client.call("get_caller", {});
      setCallerMemberId(result.ok ? result.value?.member?.id : undefined);
    } catch {
      setCallerMemberId(undefined);
    }
  };
  onCleanup(props.client.subscribe("household", refetchCaller));
  void refetchCaller();

  return (
    <section>
      <h2>{t("members.title")}</h2>
      <Show when={props.members.length > 0} fallback={<p>{t("members.none")}</p>}>
        <ul>
          <For each={props.members}>
            {(member) => (
              <li>
                <MemberRow client={props.client} member={member} isCaller={member.id === callerMemberId()} />
              </li>
            )}
          </For>
        </ul>
      </Show>
      <AddMember client={props.client} />
    </section>
  );
}

function MemberRow(props: { client: MiseClient; member: Member; isCaller: boolean }) {
  const [draft, setDraft] = createSignal<MemberDraft>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const current = draft();
    if (!current) return;
    await submitChange(() => props.client.call("update_member", { id: props.member.id, ...memberOf(current) }));
  };

  const remove = async () => {
    if (!window.confirm(t("member.removeConfirm", { name: props.member.name }))) return;
    await submitChange(() => props.client.call("remove_member", { id: props.member.id }));
  };

  /** Runs a change; on success the change notice refetches the Household, which redraws this row. */
  const submitChange = async (change: () => Promise<{ ok: true } | { ok: false; error: ToolError }>) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await change();
      if (result.ok) setDraft(undefined);
      else setError(errorText(result.error, "member"));
    } catch {
      setError(t("app.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show
      when={draft()}
      fallback={
        <div>
          <strong>{props.member.name}</strong> {props.isCaller && t("member.you")}{" "}
          <span>{props.member.email ?? t("member.noEmail")}</span>
          <p>
            {props.member.constraints.length > 0
              ? props.member.constraints.map(constraintText).join("; ")
              : t("member.noConstraints")}
          </p>
          <button type="button" onClick={() => setDraft(draftOf(props.member))}>
            {t("member.edit")}
          </button>
          <button type="button" disabled={busy()} onClick={remove}>
            {t("member.remove")}
          </button>
          <Show when={error()}>
            <p role="alert">{error()}</p>
          </Show>
        </div>
      }
    >
      {(current) => (
        <form onSubmit={save}>
          <MemberFields draft={current()} onChange={setDraft} />
          <Show when={error()}>
            <p role="alert">{error()}</p>
          </Show>
          <button type="submit" disabled={busy()}>
            {busy() ? t("member.saving") : t("member.save")}
          </button>
          <button type="button" onClick={() => setDraft(undefined)}>
            {t("member.cancel")}
          </button>
        </form>
      )}
    </Show>
  );
}

function AddMember(props: { client: MiseClient }) {
  const [draft, setDraft] = createSignal<MemberDraft>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();

  const add = async (event: SubmitEvent) => {
    event.preventDefault();
    const current = draft();
    if (!current) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await props.client.call("add_member", memberOf(current));
      if (result.ok) setDraft(undefined);
      else setError(errorText(result.error, "member"));
    } catch {
      setError(t("app.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show
      when={draft()}
      fallback={
        <button type="button" onClick={() => setDraft(emptyMember())}>
          {t("members.add")}
        </button>
      }
    >
      {(current) => (
        <form onSubmit={add}>
          <MemberFields draft={current()} onChange={setDraft} />
          <Show when={error()}>
            <p role="alert">{error()}</p>
          </Show>
          <button type="submit" disabled={busy()}>
            {busy() ? t("member.saving") : t("members.add")}
          </button>
          <button type="button" onClick={() => setDraft(undefined)}>
            {t("member.cancel")}
          </button>
        </form>
      )}
    </Show>
  );
}

/** "Allergy (hard): Peanut", "Dislike (soft): mushrooms". */
function constraintText(constraint: Constraint): string {
  const kind = `${t(`constraint.${constraint.kind}`)} (${t(`constraint.${constraintSeverity(constraint.kind)}`)})`;
  const named = [constraint.allergen && t(`allergen.${constraint.allergen}`), constraint.term].filter(Boolean);
  return `${kind}: ${named.join(", ")}`;
}
