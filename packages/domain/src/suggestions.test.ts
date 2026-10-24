import { describe, expect, test } from "bun:test";
import { ItemCatalogue, SHIPPED_ITEMS } from "./items";
import { FakeLlm } from "./llm";
import {
  SUGGESTION_BATCH_SIZE,
  type SuggestedItem,
  type SuggestionAnswer,
  type SuggestionBatch,
  suggestItems,
} from "./suggestions";

const gochujang: Extract<SuggestedItem, { kind: "new" }> = {
  kind: "new",
  name: "gochujang",
  section: "international",
  unitFamily: "volume",
  allergens: ["wheat", "soy"],
};

/** Each batch's answers. */
async function collect(batches: AsyncIterable<SuggestionBatch>): Promise<SuggestionAnswer[][]> {
  const all: SuggestionAnswer[][] = [];
  for await (const batch of batches) all.push(batch.answers);
  return all;
}

describe("suggestItems", () => {
  test("asks about every name with the catalogue, and gives back what the model suggests", async () => {
    const llm = new FakeLlm({ beurre: { kind: "existing", item: "butter" }, gochujang });

    const batches = await collect(suggestItems(llm, ["beurre", "gochujang", "mystery spread"], SHIPPED_ITEMS));

    expect(batches).toEqual([
      [
        { name: "beurre", suggested: { kind: "existing", item: "butter" } },
        { name: "gochujang", suggested: gochujang },
      ],
    ]);
    expect(llm.requests).toEqual([
      { names: ["beurre", "gochujang", "mystery spread"], catalogue: SHIPPED_ITEMS.items },
    ]);
  });

  test("asks in batches, one request per batch", async () => {
    const names = Array.from({ length: SUGGESTION_BATCH_SIZE + 3 }, (_, i) => `mystery ${i}`);
    const llm = new FakeLlm({ "mystery 0": gochujang, [`mystery ${SUGGESTION_BATCH_SIZE}`]: gochujang });

    const batches = await collect(suggestItems(llm, names, SHIPPED_ITEMS));

    expect(llm.requests.map((request) => request.names.length)).toEqual([SUGGESTION_BATCH_SIZE, 3]);
    expect(batches).toEqual([
      [{ name: "mystery 0", suggested: gochujang }],
      [{ name: `mystery ${SUGGESTION_BATCH_SIZE}`, suggested: gochujang }],
    ]);
  });

  test("drops answers for names it was not asked about, and all but the first for a name", async () => {
    const llm = new FakeLlm({}, () => [
      { name: "beurre", suggested: { kind: "existing", item: "butter" } },
      { name: "Beurre", suggested: { kind: "existing", item: "ghee" } },
      { name: "something else", suggested: gochujang },
    ]);

    const [batch] = await collect(suggestItems(llm, ["beurre"], SHIPPED_ITEMS));

    expect(batch).toEqual([{ name: "beurre", suggested: { kind: "existing", item: "butter" } }]);
  });

  test("drops an existing Item the catalogue does not have", async () => {
    const llm = new FakeLlm({ beurre: { kind: "existing", item: "household:9" } });

    expect(await collect(suggestItems(llm, ["beurre"], SHIPPED_ITEMS))).toEqual([[]]);
  });

  test("makes a new Item whose name an Item already has a suggestion of that Item", async () => {
    const catalogue = new ItemCatalogue([], [{ item: "ghee", alias: "clarified butter" }]);
    const llm = new FakeLlm({ "desi ghee": { ...gochujang, name: "Clarified butter", allergens: [] } });

    expect(await collect(suggestItems(llm, ["desi ghee"], catalogue))).toEqual([
      [{ name: "desi ghee", suggested: { kind: "existing", item: "ghee" } }],
    ]);
  });

  test("fails as the model does, after the batches it already answered", async () => {
    const names = Array.from({ length: SUGGESTION_BATCH_SIZE + 1 }, (_, i) => `mystery ${i}`);
    const llm = new FakeLlm({ "mystery 0": gochujang });
    const answered: SuggestionAnswer[][] = [];

    const run = (async () => {
      for await (const batch of suggestItems(llm, names, SHIPPED_ITEMS)) {
        answered.push(batch.answers);
        llm.failing = true;
      }
    })();

    await expect(run).rejects.toThrow("The model could not make Suggestions");
    expect(answered).toEqual([[{ name: "mystery 0", suggested: gochujang }]]);
  });
});
