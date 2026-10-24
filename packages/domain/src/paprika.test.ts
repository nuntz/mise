import { describe, expect, test } from "bun:test";
import { paprikaExport, SAMPLE_JPEG, SAMPLE_PAPRIKA_RECIPES } from "../../../fixtures/paprika";
import { type PaprikaEntry, readPaprikaExport } from "./paprika";

const [dal, chicken, toast, brownies, lemonade] = SAMPLE_PAPRIKA_RECIPES as [
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
];

async function entriesOf(file: Uint8Array<ArrayBuffer>): Promise<PaprikaEntry[]> {
  const entries = readPaprikaExport(file);
  if (!entries) throw new Error("Expected a Paprika export");
  return Array.fromAsync(entries);
}

/** The one Recipe an export of `recipe` holds, mapped. */
async function mapped(recipe: Record<string, unknown>) {
  const [entry] = await entriesOf(await paprikaExport([recipe]));
  if (!entry?.ok) throw new Error(`Expected the entry to map: ${entry?.error}`);
  return entry.recipe;
}

describe("reading a Paprika export", () => {
  test("maps each Recipe onto Mise's fields, with its photo", async () => {
    const entries = await entriesOf(
      await Bun.file(`${import.meta.dir}/../../../fixtures/sample.paprikarecipes`).bytes(),
    );

    expect(entries.map((entry) => entry.entry)).toEqual([
      "Weeknight Dal.paprikarecipe",
      "Sheet-pan Chicken.paprikarecipe",
      "Soggy Toast.paprikarecipe",
      "Binned Brownies.paprikarecipe",
      "Fizzy Lemonade.paprikarecipe",
    ]);
    expect(entries[0]).toEqual({
      entry: "Weeknight Dal.paprikarecipe",
      ok: true,
      recipe: {
        externalId: "6F1B2A44-0C3D-4E5F-8A9B-1C2D3E4F5A6B",
        revision: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
        title: "Weeknight Dal",
        baseServings: 4,
        ingredients: ["1 cup red lentils", "2 cloves garlic, minced", "1 tbsp ghee"],
        steps: ["Rinse the lentils.", "Simmer everything for 25 minutes."],
        tags: ["indian", "vegetarian", "weeknight"],
        effortMinutes: 35,
        cuisine: "indian",
        mainProtein: null,
        course: "main",
        notes: "A pot of comfort.\n\nDouble the garlic.",
        url: "https://recipes.example.com/dal",
        author: "The Example Kitchen",
        importedPreference: "positive",
        inTrash: false,
      },
      photo: { bytes: SAMPLE_JPEG, type: "image/jpeg" },
      photoError: null,
    });
  });
});

describe("effort", () => {
  test("is the total time when there is one", async () => {
    expect((await mapped(chicken)).effortMinutes).toBe(75);
  });

  test("is prep plus cook without a total, or whichever of them is known", async () => {
    expect((await mapped({ ...dal, prep_time: "10 min", cook_time: "25 mins" })).effortMinutes).toBe(35);
    expect((await mapped({ ...dal, prep_time: "", cook_time: "40 minutes" })).effortMinutes).toBe(40);
  });

  test("is unknown when no time is given or none can be read", async () => {
    expect((await mapped(toast)).effortMinutes).toBeNull();
    expect((await mapped({ ...toast, total_time: "overnight" })).effortMinutes).toBeNull();
  });

  test.each([
    ["45 minutes", 45],
    ["1 hr 30 mins", 90],
    ["1h30", 90],
    ["2 hours", 120],
    ["1 ½ hours", 90],
    ["1.5 hrs", 90],
    ["1:15", 75],
    ["90", 90],
    ["PT1H5M", 65],
    ["20-30 min", 30],
    ["0 min", null],
    ["2 days", null],
  ])("reads %p as %p minutes", async (written, minutes) => {
    expect((await mapped({ ...toast, total_time: written })).effortMinutes).toBe(minutes);
  });
});

describe("servings", () => {
  test.each([
    ["Serves 4-6", 4],
    ["Makes 12 muffins", 12],
    ["2", 2],
  ])("reads %p as %p", async (servings, count) => {
    expect((await mapped({ ...toast, servings })).baseServings).toBe(count);
  });

  test("fall back to four when no number is given", async () => {
    expect((await mapped({ ...toast, servings: "a crowd" })).baseServings).toBe(4);
    expect((await mapped(chicken)).baseServings).toBe(4);
  });
});

describe("Imported Preference", () => {
  test.each([
    [5, false, "positive"],
    [4, false, "positive"],
    [0, true, "positive"],
    [2, false, "negative"],
    [1, false, "negative"],
    [3, false, null],
    [0, false, null],
  ] as const)("%p stars, favourite %p, is %p", async (rating, favourite, preference) => {
    expect((await mapped({ ...toast, rating, on_favorites: favourite })).importedPreference).toBe(preference);
  });

  test("a favourite with one star is still positive", async () => {
    expect((await mapped({ ...toast, rating: 1, on_favorites: 1 })).importedPreference).toBe("positive");
  });
});

describe("categories", () => {
  test("become tags, in lower case", async () => {
    expect((await mapped({ ...toast, categories: ["Weeknight", "Kids", "weeknight"] })).tags).toEqual([
      "weeknight",
      "kids",
    ]);
  });

  test("set the cuisine and main protein through synonyms, the first match winning", async () => {
    const recipe = await mapped({ ...toast, categories: ["Weeknight", "Tex-Mex", "Shrimp", "Italian", "Beef"] });

    expect(recipe).toMatchObject({ cuisine: "mexican", mainProtein: "seafood" });
  });

  test("that name neither leave them unset", async () => {
    expect(await mapped({ ...toast, categories: ["Dessert"] })).toMatchObject({ cuisine: null, mainProtein: null });
  });

  test("set the Course of a Recipe filed under drinks", async () => {
    expect((await mapped(lemonade)).course).toBe("drink");
  });

  test.each([
    ["Desserts", "dessert"],
    ["Drinks", "drink"],
    ["Beverages", "drink"],
    ["Cocktails", "drink"],
    ["Breakfast", "breakfast"],
    ["Sides", "side"],
    ["Condiments", "side"],
    ["Dips", "side"],
    ["Snacks", "snack"],
    ["Appetizers", "snack"],
    ["Main", "main"],
    ["Dinner", "main"],
    ["Weeknight", "main"],
  ] as const)("read %p as the Course %p", async (category, course) => {
    expect((await mapped({ ...toast, categories: [category] })).course).toBe(course);
  });

  test.each(["Baking", "Brunch", "Sauces", "Sauce"])(
    "leave the Course unknown for %p, which can hold a dinner",
    async (category) => {
      expect((await mapped({ ...toast, categories: [category] })).course).toBeNull();
    },
  );

  test("set the Course to main when any names a main, whatever the others name", async () => {
    expect((await mapped({ ...toast, categories: ["Italian", "Desserts", "Dinner"] })).course).toBe("main");
    expect((await mapped({ ...toast, categories: ["Baking", "Dinner"] })).course).toBe("main");
  });

  test("set the Course that all of them name when none names a main", async () => {
    expect((await mapped({ ...toast, categories: ["Desserts", "Italian", "Dessert"] })).course).toBe("dessert");
  });

  test("leave the Course unknown when they name different ones and none a main", async () => {
    expect((await mapped({ ...toast, categories: ["Desserts", "Drinks"] })).course).toBeNull();
  });

  test("leave the Course unknown when none names one, whatever the title or Ingredients", async () => {
    const recipe = await mapped({
      ...toast,
      name: "Lemonade Cake",
      ingredients: "1 cup lemonade",
      categories: ["Kids"],
    });

    expect(recipe.course).toBeNull();
  });
});

describe("what an export can't give", () => {
  test("a file that is not a zip is not an export", () => {
    expect(readPaprikaExport(new TextEncoder().encode("hello"))).toBeNull();
  });

  test("an entry that is not gzipped JSON, or lacks a name or uid, is reported and the rest are read", async () => {
    const entries = await entriesOf(
      await paprikaExport([
        { entry: "Broken.paprikarecipe", bytes: new Uint8Array([0x1f, 0x8b, 1, 2, 3]) },
        { entry: "Text.paprikarecipe", bytes: new TextEncoder().encode("not json") },
        { ...toast, name: " " },
        { ...toast, uid: undefined },
        toast,
      ]),
    );

    expect(entries).toEqual([
      { entry: "Broken.paprikarecipe", ok: false, error: "The file could not be unpacked" },
      { entry: "Text.paprikarecipe", ok: false, error: "The file is not JSON" },
      { entry: " .paprikarecipe", ok: false, error: "The Recipe has no name" },
      { entry: "Soggy Toast.paprikarecipe", ok: false, error: "Soggy Toast has no uid" },
      expect.objectContaining({ entry: "Soggy Toast.paprikarecipe", ok: true }),
    ]);
  });

  test("the full-size photo is taken over the thumbnail when the export has both", async () => {
    // As Paprika writes them: `photo_data` is a thumbnail; `photo_large` names the full photo in `photos`.
    const full = new Uint8Array([...SAMPLE_JPEG, 9, 9, 9]);
    const [entry] = await entriesOf(
      await paprikaExport([
        {
          ...toast,
          photo_data: btoa(String.fromCharCode(...SAMPLE_JPEG)),
          photo_large: "FULL.jpg",
          photos: [
            { name: "2", filename: "OTHER.jpg", data: btoa("not this one") },
            { name: "1", filename: "FULL.jpg", data: btoa(String.fromCharCode(...full)) },
          ],
        },
      ]),
    );

    expect(entry).toMatchObject({ ok: true, photo: { bytes: full, type: "image/jpeg" }, photoError: null });
  });

  test("a photo that is not an image is reported, and the Recipe kept without it", async () => {
    const [entry] = await entriesOf(await paprikaExport([{ ...toast, photo_data: btoa("<svg/>") }]));

    expect(entry).toMatchObject({
      ok: true,
      recipe: { title: "Soggy Toast" },
      photo: null,
      photoError: "The photo is not a JPEG, PNG, WebP, GIF or AVIF image",
    });
  });

  test("without a hash, the revision is a hash of the entry, changing with it", async () => {
    const { hash: _, ...unhashed } = toast;

    const first = await mapped(unhashed);
    const same = await mapped(unhashed);
    const changed = await mapped({ ...unhashed, directions: "Toast it first." });

    expect(first.revision).toMatch(/^content:[0-9a-f]+$/);
    expect(same.revision).toBe(first.revision);
    expect(changed.revision).not.toBe(first.revision);
  });

  test("entries stored without compression are read too", async () => {
    const [entry] = await entriesOf(await paprikaExport([toast], "stored"));

    expect(entry).toMatchObject({ ok: true, recipe: { title: "Soggy Toast" } });
  });

  test("a Recipe in Paprika's trash is read and marked as such", async () => {
    expect((await mapped(brownies)).inTrash).toBe(true);
  });
});
