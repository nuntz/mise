import { describe, expect, test } from "bun:test";
import { readRecipePage } from "./pages";

/** A fictional page recorded under fixtures/pages, shaped like a real recipe site's. */
function recorded(name: string): Promise<string> {
  return Bun.file(`${import.meta.dir}/../../../fixtures/pages/${name}`).text();
}

describe("reading a recipe page", () => {
  test("maps a schema.org Recipe in a Yoast graph onto Mise's fields, at the page's canonical URL", async () => {
    const page = readRecipePage(
      await recorded("yoast-graph.html"),
      "https://kitchen.example.com/recipes/red-lentil-dal/?utm_source=share",
    );

    expect(page.url).toBe("https://kitchen.example.com/recipes/red-lentil-dal/");
    expect(page.image).toBe("https://kitchen.example.com/wp-content/uploads/dal-1x1.jpg");
    expect(page.recipe).toMatchObject({
      externalId: "https://kitchen.example.com/recipes/red-lentil-dal/",
      title: "Weeknight Red Lentil Dal & Rice",
      baseServings: 4,
      ingredients: [
        "1 cup red lentils, rinsed",
        "2 tbsp ghee",
        "1 onion, finely chopped",
        "3 cloves garlic, minced",
        "1 tsp ground cumin",
        "½ tsp turmeric",
        "400 g can chopped tomatoes",
      ],
      steps: [
        "Rinse the lentils until the water runs clear.",
        "Simmer the lentils with the tomatoes for 25 minutes.",
        "Fry the onion, garlic and spices in the ghee, then stir into the dal.",
      ],
      tags: ["dinner", "indian"],
      effortMinutes: 45,
      cuisine: "indian",
      mainProtein: "lentils",
      course: "main",
      notes: 'A cosy, "one-pot" dal for busy evenings.',
      url: "https://kitchen.example.com/recipes/red-lentil-dal/",
      author: "Alex Example",
      importedPreference: null,
      inTrash: false,
    });
  });

  test("finds a Recipe among other nodes, with steps written as HTML, at the URL it was fetched from", async () => {
    const page = readRecipePage(
      await recorded("json-ld-array.html"),
      "https://bakes.example.net/lemon-drizzle#comments",
    );

    expect(page.url).toBe("https://bakes.example.net/lemon-drizzle");
    expect(page.image).toBe("https://bakes.example.net/images/lemon-drizzle-large.jpg");
    expect(page.recipe).toMatchObject({
      externalId: "https://bakes.example.net/lemon-drizzle",
      title: "Lemon Drizzle Cake",
      baseServings: 8,
      steps: [
        "Heat the oven to 180C.",
        "Beat the butter and sugar, then the eggs and flour.",
        "Bake for 45 minutes and pour over the lemon syrup.",
      ],
      tags: ["dessert", "baking"],
      effortMinutes: 80,
      course: "dessert",
      author: "Sam Baker",
      notes: null,
    });
    expect(page.recipe?.ingredients).toHaveLength(5);
  });

  test("gives a page without a schema.org Recipe its title, photo and the text of its article", async () => {
    const page = readRecipePage(await recorded("no-json-ld.html"), "https://blog.example.org/?p=812");

    expect(page).toMatchObject({
      url: "https://blog.example.org/2026/04/shepherds-pie",
      title: "My Nan's Shepherd’s Pie",
      image: "https://blog.example.org/photos/shepherds-pie.jpg",
      recipe: null,
    });
    expect(page.text).toBe(
      [
        "My Nan's Shepherd's Pie",
        "Every Sunday my nan made this. It serves 6.",
        "Ingredients",
        "500 g lamb mince",
        "1 onion, diced",
        "2 carrots, diced",
        "1 kg potatoes",
        "50 g butter",
        "Method",
        "Brown the mince with the onion and carrots.",
        "Mash the potatoes with the butter and spread on top.",
        "Bake for 30 minutes at 200°C.",
      ].join("\n"),
    );
  });

  test("reads the whole body when a page has no article, leaving out its scripts and navigation", () => {
    const html = `<html><head><title>Soup</title><script>var x = "<p>no</p>";</script></head>
      <body><nav>Home</nav><div><p>2 leeks</p><p>Simmer &amp; blend.</p></div><footer>©</footer></body></html>`;

    expect(readRecipePage(html, "https://soup.example.com/").text).toBe("2 leeks\nSimmer & blend.");
  });

  test("gives the same revision to the same Recipe, whatever else on the page changed", async () => {
    const html = await recorded("yoast-graph.html");
    const url = "https://kitchen.example.com/recipes/red-lentil-dal/";
    const rated = html.replace('"ratingCount":"112"', '"ratingCount":"113"').replace("A long story", "A longer story");
    const edited = html.replace("2 tbsp ghee", "3 tbsp ghee");

    const revision = readRecipePage(html, url).recipe?.revision;

    expect(readRecipePage(rated, url).recipe?.revision).toBe(revision as string);
    expect(readRecipePage(edited, url).recipe?.revision).not.toBe(revision as string);
  });

  test("reads JSON-LD that breaks a string over two lines, as some sites write it", () => {
    const html = `<script type="application/ld+json">{"@type": "Recipe", "name": "Toast",
      "recipeIngredient": ["2 slices bread"], "recipeInstructions": "Toast the bread.
      Butter it."}</script>`;

    expect(readRecipePage(html, "https://toast.example.com/").recipe).toMatchObject({
      title: "Toast",
      ingredients: ["2 slices bread"],
    });
  });

  test("leaves a Recipe without Ingredients for the model to read from the page", () => {
    const html = `<script type="application/ld+json">{"@type": "Recipe", "name": "Toast"}</script>
      <body><p>2 slices bread</p></body>`;

    expect(readRecipePage(html, "https://toast.example.com/")).toMatchObject({ title: "Toast", recipe: null });
  });

  test("keeps the URL it fetched when the page names its site's home, or another site, as canonical", () => {
    const page = (canonical: string) =>
      readRecipePage(
        `<link rel="canonical" href="${canonical}"><body><p>Soup</p></body>`,
        "https://soup.example.com/leek-soup",
      );

    expect(page("https://soup.example.com/").url).toBe("https://soup.example.com/leek-soup");
    expect(page("https://elsewhere.example.net/leek-soup").url).toBe("https://soup.example.com/leek-soup");
    expect(page("https://www.soup.example.com/recipes/leek-soup").url).toBe(
      "https://www.soup.example.com/recipes/leek-soup",
    );
  });

  test("gives a new revision to a Recipe whose photo changed", async () => {
    const html = await recorded("yoast-graph.html");
    const url = "https://kitchen.example.com/recipes/red-lentil-dal/";

    expect(readRecipePage(html.replace("dal-1x1.jpg", "dal-new.jpg"), url).recipe?.revision).not.toBe(
      readRecipePage(html, url).recipe?.revision as string,
    );
  });
});
