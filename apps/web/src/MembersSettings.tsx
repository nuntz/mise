import { type Constraint, isHardConstraint, type Member, type MemberId, type ToolError } from "@mise/domain";
import { createSignal, For, Show } from "solid-js";
import { createConfirm } from "./ConfirmSheet";
import type { MiseClient } from "./client";
import { errorText } from "./errors";
import { keepFresh } from "./fresh";
import { draftOf, emptyMember, type MemberDraft, MemberFields, memberOf } from "./MemberFields";
import { nameText, t } from "./messages";

/** Settings: the Household's Members and their Constraints, editable at any time. */
export function MembersSettings(props: { client: MiseClient; members: Member[] }) {
  // Which Member the Caller is, so they can find themselves.
  const [callerMemberId, setCallerMemberId] = createSignal<MemberId>();
  keepFresh(
    props.client,
    ["household"],
    () => props.client.call("get_caller", {}),
    (result) => setCallerMemberId(result.ok ? result.value?.member?.id : undefined),
    () => setCallerMemberId(undefined),
  );

  return (
    <section>
      <h2>{t("members.title")}</h2>
      <Show when={props.members.length > 0} fallback={<p>{t("members.none")}</p>}>
        <ul class="rows">
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

  const confirm = createConfirm();
  const remove = async () => {
    const { name } = props.member;
    const confirmed = await confirm.ask({
      title: t("member.removeTitle", { name }),
      lost: t("member.removeLost", { name }),
      action: t("member.removeAction"),
    });
    if (!confirmed) return;
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
    <>
      <Show
        when={draft()}
        fallback={
          <div class="row">
            <span class="row-lead avatar name" aria-hidden="true">
              {initialOf(props.member.name)}
            </span>
            <div class="row-body">
              <span class="row-title">
                <span class="name">{nameText(props.member.name)}</span> {props.isCaller && t("member.you")}
              </span>
              <span class="row-meta">{props.member.email ?? t("member.noEmail")}</span>
              <Show when={props.member.constraints.length > 0}>
                <span class="chips">
                  <For each={props.member.constraints}>
                    {(constraint) => (
                      <span class={isHardConstraint(constraint) ? "chip chip-warn" : "chip"}>
                        {constraintText(constraint)}
                      </span>
                    )}
                  </For>
                </span>
              </Show>
            </div>
            <div class="row-end">
              <button
                type="button"
                class="button-row"
                aria-label={t("member.editName", { name: props.member.name })}
                onClick={() => setDraft(draftOf(props.member))}
              >
                {t("member.edit")}
              </button>
            </div>
            <Show when={error()}>
              <p class="banner banner-warn" role="alert">
                {error()}
              </p>
            </Show>
          </div>
        }
      >
        {(current) => (
          <form class="stack" onSubmit={save}>
            <MemberFields draft={current()} onChange={setDraft} />
            <Show when={error()}>
              <p class="banner banner-warn" role="alert">
                {error()}
              </p>
            </Show>
            <button type="submit" class="button-primary" disabled={busy()}>
              {busy() ? t("member.saving") : t("member.save")}
            </button>
            <button type="button" class="button-quiet" onClick={() => setDraft(undefined)}>
              {t("member.cancel")}
            </button>
            <button
              type="button"
              class="button-danger"
              aria-label={t("member.removeName", { name: props.member.name })}
              disabled={busy()}
              onClick={remove}
            >
              {t("member.remove")}
            </button>
          </form>
        )}
      </Show>
      <confirm.ConfirmSheet />
    </>
  );
}

/** The first letter of a Member's name, for their avatar. */
function initialOf(name: string): string {
  return [...nameText(name)][0] ?? "";
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
        <button type="button" class="button-primary" onClick={() => setDraft(emptyMember())}>
          {t("members.add")}
        </button>
      }
    >
      {(current) => (
        <form class="stack" onSubmit={add}>
          <MemberFields draft={current()} onChange={setDraft} />
          <Show when={error()}>
            <p class="banner banner-warn" role="alert">
              {error()}
            </p>
          </Show>
          <button type="submit" class="button-primary" disabled={busy()}>
            {busy() ? t("member.saving") : t("members.add")}
          </button>
          <button type="button" class="button-quiet" onClick={() => setDraft(undefined)}>
            {t("member.cancel")}
          </button>
        </form>
      )}
    </Show>
  );
}

/** "Peanut allergy", "Milk intolerance: lactose", "Dislikes cilantro": one message per kind and Allergen. */
function constraintText(constraint: Constraint): string {
  const term = constraint.term ?? "";
  if (!constraint.allergen) return t("memberConstraint.dislike.termOnly", { term });
  const key = `memberConstraint.${constraint.kind}.${constraint.allergen}` as const;
  return term ? t(`${key}.term`, { term }) : t(key);
}
