import { ALLERGENS, type Allergen } from "@mise/domain";
import { For } from "solid-js";
import { t } from "./messages";

/**
 * The Allergens a new Item contains, read from its label. Every Recipe using the Item trusts them, so
 * "none" is ticked, never assumed (ADR 0009): a form refuses to save until one or the other is.
 */
export function AllergenPicker(props: {
  allergens: Allergen[];
  none: boolean;
  onAllergens: (allergens: Allergen[]) => void;
  onNone: (none: boolean) => void;
}) {
  const toggle = (allergen: Allergen, on: boolean) =>
    props.onAllergens(on ? [...props.allergens, allergen] : props.allergens.filter((a) => a !== allergen));

  return (
    <fieldset>
      <legend>{t("item.allergens")}</legend>
      <p>{t("item.allergensHint")}</p>
      <div class="chips">
        <For each={ALLERGENS}>
          {(allergen) => (
            <label class="toggle-chip">
              <input
                type="checkbox"
                checked={props.allergens.includes(allergen)}
                disabled={props.none}
                onChange={(e) => toggle(allergen, e.currentTarget.checked)}
              />
              {t(`allergen.${allergen}`)}
            </label>
          )}
        </For>
      </div>
      <label class="toggle-chip">
        <input
          type="checkbox"
          checked={props.none}
          disabled={props.allergens.length > 0}
          onChange={(e) => props.onNone(e.currentTarget.checked)}
        />
        {t("item.allergensNone")}
      </label>
    </fieldset>
  );
}
