import {
  ALLERGENS,
  type Allergen,
  CONSTRAINT_KINDS,
  type Constraint,
  type ConstraintKind,
  constraintSeverity,
  type Member,
  type ToolInput,
} from "@mise/domain";
import { For, Index, Show } from "solid-js";
import { t } from "./messages";

/** A Constraint as the form holds it: empty strings for what hasn't been chosen or typed. */
export type ConstraintDraft = { kind: ConstraintKind; allergen: Allergen | ""; term: string };

/** A Member as the form holds it, before it is checked. */
export type MemberDraft = { name: string; email: string; constraints: ConstraintDraft[] };

export const emptyMember = (): MemberDraft => ({ name: "", email: "", constraints: [] });

export function draftOf(member: Member): MemberDraft {
  return {
    name: member.name,
    email: member.email ?? "",
    constraints: constraintDraftsOf(member.constraints),
  };
}

/** The draft as tool input; the tools validate it. */
export function memberOf(draft: MemberDraft): Required<ToolInput<"add_member">> {
  return {
    name: draft.name,
    email: draft.email.trim() || null,
    constraints: constraintsOf(draft.constraints),
  };
}

export function constraintDraftsOf(constraints: Constraint[]): ConstraintDraft[] {
  return constraints.map((constraint) => ({
    kind: constraint.kind,
    allergen: constraint.allergen ?? "",
    term: constraint.term ?? "",
  }));
}

/** The drafts as tool input; the tools validate them. */
export function constraintsOf(drafts: ConstraintDraft[]): Constraint[] {
  return drafts.map(
    ({ kind, allergen, term }) =>
      ({
        kind,
        ...(allergen && { allergen }),
        ...(term.trim() && { term: term.trim() }),
      }) as Constraint,
  );
}

/** Name, sign-in email and Constraints of one Member. */
export function MemberFields(props: { draft: MemberDraft; onChange: (draft: MemberDraft) => void }) {
  const update = <K extends keyof MemberDraft>(key: K, value: MemberDraft[K]) =>
    props.onChange({ ...props.draft, [key]: value });

  return (
    <fieldset>
      <label>
        {t("member.name")}
        <input
          required
          maxLength={100}
          value={props.draft.name}
          onInput={(e) => update("name", e.currentTarget.value)}
        />
      </label>

      <label>
        {t("member.email")}
        <input type="email" value={props.draft.email} onInput={(e) => update("email", e.currentTarget.value)} />
      </label>
      <small>{t("member.emailHint")}</small>

      <ConstraintFields constraints={props.draft.constraints} onChange={(list) => update("constraints", list)} />
    </fieldset>
  );
}

/** A list of Constraints, a Member's or a Slot's Guests', with buttons to add and remove them. */
export function ConstraintFields(props: {
  constraints: ConstraintDraft[];
  onChange: (constraints: ConstraintDraft[]) => void;
}) {
  const updateConstraint = (index: number, change: Partial<ConstraintDraft>) =>
    props.onChange(props.constraints.map((constraint, i) => (i === index ? { ...constraint, ...change } : constraint)));
  const changeKind = (index: number, kind: ConstraintKind) => {
    const current = props.constraints[index];
    // A Hard Constraint must name an Allergen, so pick the first rather than leave the select lying.
    const allergen = constraintSeverity(kind) === "hard" && !current?.allergen ? ALLERGENS[0] : current?.allergen;
    updateConstraint(index, { kind, ...(allergen !== undefined && { allergen }) });
  };

  return (
    <>
      <ul>
        <Index each={props.constraints}>
          {(constraint, index) => (
            <li>
              <select
                aria-label={t("constraint.kind")}
                value={constraint().kind}
                onChange={(e) => changeKind(index, e.currentTarget.value as ConstraintKind)}
              >
                <For each={CONSTRAINT_KINDS}>
                  {(kind) => (
                    <option value={kind}>
                      {t(`constraint.${kind}`)} ({t(`constraint.${constraintSeverity(kind)}`)})
                    </option>
                  )}
                </For>
              </select>

              <select
                aria-label={t("constraint.allergen")}
                value={constraint().allergen}
                onChange={(e) => updateConstraint(index, { allergen: e.currentTarget.value as Allergen | "" })}
              >
                <Show when={constraintSeverity(constraint().kind) === "soft"}>
                  <option value="">{t("constraint.noAllergen")}</option>
                </Show>
                <For each={ALLERGENS}>
                  {(allergen) => <option value={allergen}>{t(`allergen.${allergen}`)}</option>}
                </For>
              </select>

              <input
                aria-label={t("constraint.term")}
                placeholder={t("constraint.termPlaceholder")}
                maxLength={100}
                value={constraint().term}
                onInput={(e) => updateConstraint(index, { term: e.currentTarget.value })}
              />

              <button type="button" onClick={() => props.onChange(props.constraints.filter((_, i) => i !== index))}>
                {t("constraint.remove")}
              </button>
            </li>
          )}
        </Index>
      </ul>
      <button
        type="button"
        onClick={() => props.onChange([...props.constraints, { kind: "allergy", allergen: ALLERGENS[0], term: "" }])}
      >
        {t("constraint.add")}
      </button>
    </>
  );
}
