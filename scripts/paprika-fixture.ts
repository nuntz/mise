/** Writes `fixtures/sample.paprikarecipes` from the fictional Recipes in `fixtures/paprika.ts`. */
import { paprikaExport, SAMPLE_PAPRIKA_RECIPES } from "../fixtures/paprika";

await Bun.write(
  new URL("../fixtures/sample.paprikarecipes", import.meta.url),
  await paprikaExport(SAMPLE_PAPRIKA_RECIPES),
);
