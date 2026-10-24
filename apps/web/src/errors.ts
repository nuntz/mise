import type { ToolError } from "@mise/domain";
import { type MessageKey, t } from "./messages";

const householdFields: Record<string, MessageKey> = {
  name: "setup.name",
  timezone: "setup.timezone",
  dinnerTime: "setup.dinnerTime",
  weekStartsOn: "setup.weekStartsOn",
  units: "setup.units",
  locale: "setup.locale",
};

const memberFields: Record<string, MessageKey> = {
  name: "member.name",
  email: "member.email",
  kind: "constraint.kind",
  allergen: "constraint.allergen",
  term: "constraint.term",
  constraints: "member.constraints",
};

const recipeFields: Record<string, MessageKey> = {
  title: "recipeForm.title",
  baseServings: "recipeForm.baseServings",
  ingredients: "recipeForm.ingredients",
  steps: "recipeForm.steps",
  tags: "recipeForm.tags",
  effortMinutes: "recipeForm.effortMinutes",
  cuisine: "recipeForm.cuisine",
  mainProtein: "recipeForm.mainProtein",
  recurring: "recipeForm.recurring",
  prepAhead: "recipeForm.prepAhead",
};

const itemFields: Record<string, MessageKey> = {
  name: "item.name",
  section: "item.section",
  unitFamily: "item.unitFamily",
  allergens: "item.allergens",
  text: "item.name",
  aliases: "items.otherNames",
  item: "resolve.item",
};

const slotFields: Record<string, MessageKey> = {
  kind: "slot.kind",
  recipeId: "slot.recipe",
  note: "slot.note",
  diners: "slot.diners",
  guests: "slot.guests",
  guestConstraints: "slot.guestConstraints",
};

type Form = "household" | "member" | "recipe" | "item" | "slot";

/** What to show when a tool refuses; `form` says which fields a bare name like `name` means. */
export function errorText(error: ToolError, form: Form): string {
  switch (error.code) {
    case "invalid_input": {
      const fields = new Set((error.issues ?? []).map((issue) => fieldLabel(issue.path, form)));
      return t("form.invalid", { fields: [...fields].join(", ") });
    }
    case "already_set_up":
      return t("setup.alreadySetUp");
    case "email_in_use":
      return t("member.emailInUse");
    case "name_in_use":
      return t("item.nameInUse");
    case "shipped_item":
      return t("item.shippedItem");
    case "not_found":
      return t(
        form === "recipe"
          ? "recipe.notFound"
          : form === "item"
            ? "item.notFound"
            : form === "slot"
              ? "slot.notFound"
              : "member.notFound",
      );
    default:
      return t("app.error");
  }
}

/** A field's label from an issue path such as `name` or `members.1.constraints.0.allergen`. */
function fieldLabel(path: string, form: Form): string {
  const labels =
    form === "recipe"
      ? recipeFields
      : form === "item"
        ? itemFields
        : form === "slot" && !path.startsWith("guestConstraints.")
          ? slotFields
          : form === "household" && !path.startsWith("members.")
            ? householdFields
            : memberFields;
  const field =
    path
      .split(".")
      .filter((segment) => !/^\d+$/.test(segment))
      .at(-1) ?? path;
  const key = labels[field];
  return key ? t(key) : path;
}
