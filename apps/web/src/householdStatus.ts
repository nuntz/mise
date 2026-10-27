import type { Signal } from "solid-js";
import type { MiseClient } from "./client";
import { keepFresh } from "./fresh";
import { t } from "./messages";
import { flagsOutsideDrafts } from "./Review";

/** A chip on a Household row: its words, and its status colour when it has one. */
export type StatusChip = { text: string; tone?: "leaf" | "amber" };

/** The Household's sections that can have something waiting on a person. */
export type StatusChips = { review: StatusChip[]; resolve: StatusChip[]; tag: StatusChip[] };

/**
 * What waits on a person in each section, kept fresh from the same listing tools the sections use:
 * Drafts and Import Flags on Review, Unresolved Ingredients on Resolve Ingredients, and untagged
 * Recipes (or "All tagged", once there are Recipes) on Tag Recipes. A section shows nothing until its
 * listing answers, and a failed refresh keeps what showed. The chips live in `status`, which may
 * outlive this owner, so whatever shows them next starts from what showed last.
 */
export function createHouseholdStatus(client: MiseClient, status: Signal<StatusChips>) {
  const [chips, setChips] = status;

  keepFresh(
    client,
    ["recipes"],
    () =>
      Promise.all([
        client.call("list_drafts", {}),
        client.call("list_import_flags", {}),
        client.call("list_unresolved_ingredients", {}),
        client.call("list_untagged_recipes", {}),
        client.call("search_recipes", {}),
      ]),
    ([drafts, flags, unresolved, untagged, recipes]) =>
      setChips((shown) => ({
        review:
          drafts.ok && flags.ok
            ? [
                ...countChip(drafts.value.length, "drafts"),
                ...countChip(flagsOutsideDrafts(drafts.value, flags.value).length, "flags"),
              ]
            : shown.review,
        resolve: unresolved.ok ? countChip(unresolved.value.length, "unresolved", "amber") : shown.resolve,
        tag: untagged.ok && recipes.ok ? tagChips(untagged.value.length, recipes.value.length) : shown.tag,
      })),
  );

  return chips;
}

/** How many Recipes wait on tags, or a leaf "All tagged" when none do; nothing before the first Recipe. */
function tagChips(untagged: number, recipes: number): StatusChip[] {
  if (untagged > 0) return countChip(untagged, "untagged");
  return recipes > 0 ? [{ text: t("household.allTagged"), tone: "leaf" }] : [];
}

/** "1 Draft", "3 Drafts", or no chip at all for none. */
function countChip(
  count: number,
  key: "drafts" | "flags" | "unresolved" | "untagged",
  tone?: StatusChip["tone"],
): StatusChip[] {
  if (count === 0) return [];
  const text = count === 1 ? t(`household.${key}One`) : t(`household.${key}`, { count: String(count) });
  return [{ text, ...(tone && { tone }) }];
}
