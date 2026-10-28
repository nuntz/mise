import { ItemName, NewRecipe, parseIngredient } from "@mise/domain";
import { itemHandlers, readCatalogue } from "./items";
import { recipeHandlers } from "./recipes";
import type { Handlers } from "./tools";

/**
 * Adding a Ready-made dish (ADR 0026): its Household Item and its Recipe, in the one call's
 * transaction, so a refusal of either leaves neither.
 */
export const readyMadeHandlers: Pick<Handlers, "create_ready_made_recipe"> = {
  create_ready_made_recipe: (sql, input, context) => {
    const line = `1 package ${input.product}`;
    // As the line reads it, so it resolves to the Item: "(family size)" stays the line's note.
    const name = ItemName.safeParse(parseIngredient(line).name);
    if (!name.success) {
      return {
        ok: false,
        error: {
          code: "invalid_input",
          message: "Name the product as it is sold",
          issues: [{ path: "product", message: "Names no product" }],
        },
      };
    }
    const catalogue = readCatalogue(sql);
    const known = catalogue.named(name.data);
    const item = known === null ? undefined : catalogue.item(known);
    if (item && item.unitFamily !== "count") {
      return {
        ok: false,
        error: {
          code: "measured_item",
          message: `${item.name} is weighed or measured, not bought whole: name the product as it is sold`,
        },
      };
    }
    if (!item) {
      if (input.allergens === undefined) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: `State the Allergens on ${name.data}'s label, or none`,
            issues: [{ path: "allergens", message: "Required for a new product" }],
          },
        };
      }
      const created = itemHandlers.create_item(
        sql,
        { name: name.data, section: input.section, allergens: input.allergens, unitFamily: "count", aliases: [] },
        context,
      );
      if (!created.ok) return created;
    }
    return recipeHandlers.create_recipe(
      sql,
      NewRecipe.parse({
        title: input.title,
        baseServings: input.baseServings,
        ingredients: [line],
        steps: input.steps,
        effortMinutes: input.effortMinutes,
        course: "main",
        readyMade: true,
      }),
      context,
    );
  },
};
