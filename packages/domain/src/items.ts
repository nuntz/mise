import { z } from "zod";
import type { Allergen } from "./members";
import type { UnitFamily } from "./units";

/** Areas of the store. The Household will order them in walking order. */
export const STORE_SECTIONS = [
  "produce",
  "bakery",
  "meat",
  "seafood",
  "dairy",
  "frozen",
  "pantry",
  "baking",
  "spices",
  "condiments",
  "international",
  "beverages",
] as const;
export const StoreSection = z.enum(STORE_SECTIONS);
export type StoreSection = z.infer<typeof StoreSection>;

/** A canonical grocery thing that Ingredients and Staples refer to (ADR 0001). */
export type Item = {
  id: string;
  name: string;
  /** Other names for it; plurals and common adjectives are handled by matching, not listed here. */
  aliases: readonly string[];
  section: StoreSection;
  allergens: readonly Allergen[];
  /** What it is usually measured in. */
  unitFamily: UnitFamily;
};

type CatalogueEntry = Omit<Item, "id" | "aliases" | "allergens"> & {
  aliases?: readonly string[];
  allergens?: readonly Allergen[];
};

/**
 * The Item catalogue (ADR 0009), curated by hand. Ingredients store the key, so never rename or
 * remove one. Only add an Item whose Allergens are dependable whatever the brand: anything that
 * varies (bread, stock cubes, sausages, curry paste) stays out, so its Ingredients stay Unresolved
 * and fail closed.
 */
const CATALOGUE = {
  // Produce
  garlic: { name: "garlic", section: "produce", unitFamily: "count", aliases: ["garlic clove"] },
  onion: {
    name: "onion",
    section: "produce",
    unitFamily: "count",
    aliases: ["yellow onion", "white onion", "brown onion"],
  },
  red_onion: { name: "red onion", section: "produce", unitFamily: "count" },
  green_onion: { name: "green onion", section: "produce", unitFamily: "count", aliases: ["scallion", "spring onion"] },
  shallot: { name: "shallot", section: "produce", unitFamily: "count" },
  leek: { name: "leek", section: "produce", unitFamily: "count" },
  ginger: { name: "ginger", section: "produce", unitFamily: "mass", aliases: ["ginger root", "fresh ginger"] },
  carrot: { name: "carrot", section: "produce", unitFamily: "count" },
  celery: { name: "celery", section: "produce", unitFamily: "count" },
  potato: { name: "potato", section: "produce", unitFamily: "mass", aliases: ["yukon gold potato", "russet potato"] },
  sweet_potato: { name: "sweet potato", section: "produce", unitFamily: "mass", aliases: ["yam"] },
  tomato: { name: "tomato", section: "produce", unitFamily: "count", aliases: ["roma tomato"] },
  cherry_tomato: { name: "cherry tomato", section: "produce", unitFamily: "volume", aliases: ["grape tomato"] },
  bell_pepper: {
    name: "bell pepper",
    section: "produce",
    unitFamily: "count",
    aliases: ["red bell pepper", "green bell pepper", "yellow bell pepper", "red pepper", "green pepper", "capsicum"],
  },
  jalapeno: { name: "jalapeño", section: "produce", unitFamily: "count", aliases: ["jalapeno", "jalapeño pepper"] },
  zucchini: { name: "zucchini", section: "produce", unitFamily: "count", aliases: ["courgette"] },
  eggplant: { name: "eggplant", section: "produce", unitFamily: "count", aliases: ["aubergine"] },
  cucumber: { name: "cucumber", section: "produce", unitFamily: "count", aliases: ["english cucumber"] },
  broccoli: { name: "broccoli", section: "produce", unitFamily: "mass", aliases: ["broccoli floret"] },
  cauliflower: { name: "cauliflower", section: "produce", unitFamily: "count" },
  cabbage: { name: "cabbage", section: "produce", unitFamily: "count", aliases: ["green cabbage", "red cabbage"] },
  spinach: { name: "spinach", section: "produce", unitFamily: "mass", aliases: ["baby spinach"] },
  kale: { name: "kale", section: "produce", unitFamily: "count" },
  lettuce: {
    name: "lettuce",
    section: "produce",
    unitFamily: "count",
    aliases: ["romaine", "romaine lettuce", "iceberg lettuce"],
  },
  mushroom: {
    name: "mushroom",
    section: "produce",
    unitFamily: "mass",
    aliases: ["cremini mushroom", "button mushroom"],
  },
  corn: { name: "corn", section: "produce", unitFamily: "count", aliases: ["corn on the cob", "ear of corn"] },
  green_bean: { name: "green bean", section: "produce", unitFamily: "mass" },
  avocado: { name: "avocado", section: "produce", unitFamily: "count" },
  lemon: { name: "lemon", section: "produce", unitFamily: "count" },
  lime: { name: "lime", section: "produce", unitFamily: "count" },
  apple: { name: "apple", section: "produce", unitFamily: "count" },
  banana: { name: "banana", section: "produce", unitFamily: "count" },
  basil: { name: "basil", section: "produce", unitFamily: "count", aliases: ["basil leaf", "basil leaves"] },
  cilantro: {
    name: "cilantro",
    section: "produce",
    unitFamily: "count",
    aliases: ["coriander leaves", "fresh coriander"],
  },
  parsley: {
    name: "parsley",
    section: "produce",
    unitFamily: "count",
    aliases: ["flat-leaf parsley", "italian parsley"],
  },
  thyme: { name: "thyme", section: "produce", unitFamily: "count" },
  rosemary: { name: "rosemary", section: "produce", unitFamily: "count" },
  mint: { name: "mint", section: "produce", unitFamily: "count", aliases: ["mint leaf", "mint leaves"] },
  dill: { name: "dill", section: "produce", unitFamily: "count" },
  chives: { name: "chives", section: "produce", unitFamily: "count" },

  // Meat
  chicken_breast: { name: "chicken breast", section: "meat", unitFamily: "mass" },
  chicken_thigh: { name: "chicken thigh", section: "meat", unitFamily: "mass" },
  whole_chicken: { name: "whole chicken", section: "meat", unitFamily: "count" },
  ground_beef: { name: "ground beef", section: "meat", unitFamily: "mass", aliases: ["minced beef", "beef mince"] },
  ground_pork: { name: "ground pork", section: "meat", unitFamily: "mass", aliases: ["minced pork", "pork mince"] },
  ground_turkey: { name: "ground turkey", section: "meat", unitFamily: "mass" },
  beef_steak: {
    name: "beef steak",
    section: "meat",
    unitFamily: "mass",
    aliases: ["steak", "flank steak", "sirloin steak"],
  },
  stewing_beef: { name: "stewing beef", section: "meat", unitFamily: "mass", aliases: ["beef chuck", "stew meat"] },
  pork_chop: { name: "pork chop", section: "meat", unitFamily: "count" },
  pork_tenderloin: { name: "pork tenderloin", section: "meat", unitFamily: "mass" },
  bacon: { name: "bacon", section: "meat", unitFamily: "count" },

  // Seafood
  salmon: { name: "salmon", section: "seafood", unitFamily: "mass", allergens: ["fish"], aliases: ["salmon fillet"] },
  cod: { name: "cod", section: "seafood", unitFamily: "mass", allergens: ["fish"], aliases: ["cod fillet"] },
  tuna: { name: "tuna", section: "seafood", unitFamily: "mass", allergens: ["fish"], aliases: ["canned tuna"] },
  anchovy: {
    name: "anchovy",
    section: "seafood",
    unitFamily: "count",
    allergens: ["fish"],
    aliases: ["anchovy fillet"],
  },
  shrimp: { name: "shrimp", section: "seafood", unitFamily: "mass", allergens: ["shellfish"], aliases: ["prawn"] },
  mussels: { name: "mussels", section: "seafood", unitFamily: "mass", allergens: ["shellfish"] },
  scallop: { name: "scallop", section: "seafood", unitFamily: "mass", allergens: ["shellfish"] },

  // Dairy and eggs
  egg: { name: "egg", section: "dairy", unitFamily: "count", allergens: ["egg"], aliases: ["egg white", "egg yolk"] },
  milk: {
    name: "milk",
    section: "dairy",
    unitFamily: "volume",
    allergens: ["milk"],
    aliases: ["whole milk", "2% milk"],
  },
  butter: {
    name: "butter",
    section: "dairy",
    unitFamily: "mass",
    allergens: ["milk"],
    aliases: ["unsalted butter", "salted butter"],
  },
  heavy_cream: {
    name: "heavy cream",
    section: "dairy",
    unitFamily: "volume",
    allergens: ["milk"],
    aliases: ["whipping cream", "heavy whipping cream", "35% cream", "cream", "double cream"],
  },
  sour_cream: { name: "sour cream", section: "dairy", unitFamily: "volume", allergens: ["milk"] },
  yogurt: {
    name: "yogurt",
    section: "dairy",
    unitFamily: "volume",
    allergens: ["milk"],
    aliases: ["plain yogurt", "greek yogurt", "yoghurt"],
  },
  cheddar: { name: "cheddar", section: "dairy", unitFamily: "mass", allergens: ["milk"], aliases: ["cheddar cheese"] },
  mozzarella: {
    name: "mozzarella",
    section: "dairy",
    unitFamily: "mass",
    allergens: ["milk"],
    aliases: ["mozzarella cheese"],
  },
  parmesan: {
    name: "parmesan",
    section: "dairy",
    unitFamily: "mass",
    allergens: ["milk"],
    aliases: ["parmesan cheese", "parmigiano reggiano", "parmigiano-reggiano"],
  },
  feta: { name: "feta", section: "dairy", unitFamily: "mass", allergens: ["milk"], aliases: ["feta cheese"] },
  cream_cheese: { name: "cream cheese", section: "dairy", unitFamily: "mass", allergens: ["milk"] },
  ghee: { name: "ghee", section: "dairy", unitFamily: "volume", allergens: ["milk"] },
  tofu: {
    name: "tofu",
    section: "dairy",
    unitFamily: "mass",
    allergens: ["soy"],
    aliases: ["firm tofu", "extra-firm tofu", "silken tofu"],
  },

  // Frozen
  frozen_peas: { name: "frozen peas", section: "frozen", unitFamily: "volume", aliases: ["pea", "green pea"] },
  edamame: { name: "edamame", section: "frozen", unitFamily: "volume", allergens: ["soy"] },

  // Pantry
  rice: {
    name: "rice",
    section: "pantry",
    unitFamily: "volume",
    aliases: ["white rice", "long-grain rice", "jasmine rice", "basmati rice"],
  },
  brown_rice: { name: "brown rice", section: "pantry", unitFamily: "volume" },
  pasta: {
    name: "pasta",
    section: "pantry",
    unitFamily: "mass",
    allergens: ["wheat"],
    aliases: ["dried pasta", "spaghetti", "penne", "fusilli", "linguine", "rigatoni", "macaroni", "orzo"],
  },
  egg_noodles: { name: "egg noodles", section: "pantry", unitFamily: "mass", allergens: ["wheat", "egg"] },
  rice_noodles: { name: "rice noodles", section: "international", unitFamily: "mass", aliases: ["rice vermicelli"] },
  couscous: { name: "couscous", section: "pantry", unitFamily: "volume", allergens: ["wheat"] },
  bulgur: { name: "bulgur", section: "pantry", unitFamily: "volume", allergens: ["wheat"] },
  quinoa: { name: "quinoa", section: "pantry", unitFamily: "volume" },
  rolled_oats: { name: "rolled oats", section: "pantry", unitFamily: "volume", aliases: ["oats", "oatmeal"] },
  dried_lentils: {
    name: "lentils",
    section: "pantry",
    unitFamily: "volume",
    aliases: ["red lentil", "green lentil", "brown lentil"],
  },
  chickpeas: {
    name: "chickpeas",
    section: "pantry",
    unitFamily: "count",
    aliases: ["garbanzo bean", "canned chickpeas"],
  },
  black_beans: { name: "black beans", section: "pantry", unitFamily: "count", aliases: ["canned black beans"] },
  kidney_beans: { name: "kidney beans", section: "pantry", unitFamily: "count", aliases: ["red kidney beans"] },
  canned_tomatoes: {
    name: "canned tomatoes",
    section: "pantry",
    unitFamily: "count",
    aliases: ["diced tomatoes", "crushed tomatoes", "whole tomatoes", "tinned tomatoes", "whole peeled tomatoes"],
  },
  tomato_paste: { name: "tomato paste", section: "pantry", unitFamily: "volume" },
  coconut_milk: { name: "coconut milk", section: "international", unitFamily: "count" },
  olive_oil: {
    name: "olive oil",
    section: "pantry",
    unitFamily: "volume",
    aliases: ["extra virgin olive oil", "extra-virgin olive oil"],
  },
  vegetable_oil: {
    name: "vegetable oil",
    section: "pantry",
    unitFamily: "volume",
    aliases: ["canola oil", "neutral oil", "sunflower oil"],
  },
  sesame_oil: {
    name: "sesame oil",
    section: "international",
    unitFamily: "volume",
    allergens: ["sesame"],
    aliases: ["toasted sesame oil"],
  },
  peanut_butter: { name: "peanut butter", section: "pantry", unitFamily: "volume", allergens: ["peanut"] },
  honey: { name: "honey", section: "pantry", unitFamily: "volume" },
  maple_syrup: { name: "maple syrup", section: "pantry", unitFamily: "volume" },
  white_wine: {
    name: "white wine",
    section: "beverages",
    unitFamily: "volume",
    allergens: ["sulphite"],
    aliases: ["dry white wine"],
  },
  red_wine: {
    name: "red wine",
    section: "beverages",
    unitFamily: "volume",
    allergens: ["sulphite"],
    aliases: ["dry red wine"],
  },
  water: {
    name: "water",
    section: "beverages",
    unitFamily: "volume",
    aliases: ["cold water", "warm water", "hot water", "boiling water"],
  },

  // Baking
  flour: {
    name: "all-purpose flour",
    section: "baking",
    unitFamily: "volume",
    allergens: ["wheat"],
    aliases: ["flour", "all purpose flour", "plain flour", "white flour"],
  },
  sugar: { name: "sugar", section: "baking", unitFamily: "volume", aliases: ["white sugar", "granulated sugar"] },
  brown_sugar: {
    name: "brown sugar",
    section: "baking",
    unitFamily: "volume",
    aliases: ["light brown sugar", "dark brown sugar"],
  },
  baking_powder: { name: "baking powder", section: "baking", unitFamily: "volume" },
  baking_soda: { name: "baking soda", section: "baking", unitFamily: "volume", aliases: ["bicarbonate of soda"] },
  cornstarch: { name: "cornstarch", section: "baking", unitFamily: "volume", aliases: ["corn starch", "cornflour"] },
  vanilla_extract: {
    name: "vanilla extract",
    section: "baking",
    unitFamily: "volume",
    aliases: ["vanilla", "pure vanilla extract"],
  },
  almonds: {
    name: "almonds",
    section: "baking",
    unitFamily: "volume",
    allergens: ["tree_nut"],
    aliases: ["sliced almonds", "slivered almonds"],
  },
  walnuts: { name: "walnuts", section: "baking", unitFamily: "volume", allergens: ["tree_nut"] },
  pecans: { name: "pecans", section: "baking", unitFamily: "volume", allergens: ["tree_nut"] },
  cashews: { name: "cashews", section: "baking", unitFamily: "volume", allergens: ["tree_nut"] },
  pine_nuts: { name: "pine nuts", section: "baking", unitFamily: "volume", allergens: ["tree_nut"] },
  peanuts: {
    name: "peanuts",
    section: "baking",
    unitFamily: "volume",
    allergens: ["peanut"],
    aliases: ["roasted peanuts"],
  },
  sesame_seeds: { name: "sesame seeds", section: "spices", unitFamily: "volume", allergens: ["sesame"] },
  panko: {
    name: "panko",
    section: "baking",
    unitFamily: "volume",
    allergens: ["wheat"],
    aliases: ["panko breadcrumbs"],
  },
  raisins: { name: "raisins", section: "baking", unitFamily: "volume", allergens: ["sulphite"] },

  // Spices
  salt: {
    name: "salt",
    section: "spices",
    unitFamily: "volume",
    aliases: ["kosher salt", "sea salt", "table salt", "flaky salt"],
  },
  black_pepper: {
    name: "black pepper",
    section: "spices",
    unitFamily: "volume",
    aliases: ["pepper", "ground black pepper", "peppercorns"],
  },
  cumin: { name: "cumin", section: "spices", unitFamily: "volume", aliases: ["ground cumin", "cumin seeds"] },
  paprika: { name: "paprika", section: "spices", unitFamily: "volume", aliases: ["smoked paprika", "sweet paprika"] },
  chili_powder: { name: "chili powder", section: "spices", unitFamily: "volume", aliases: ["chilli powder"] },
  chili_flakes: {
    name: "chili flakes",
    section: "spices",
    unitFamily: "volume",
    aliases: ["red pepper flakes", "crushed red pepper", "crushed red pepper flakes", "chilli flakes"],
  },
  cinnamon: { name: "cinnamon", section: "spices", unitFamily: "volume", aliases: ["ground cinnamon"] },
  oregano: { name: "oregano", section: "spices", unitFamily: "volume", aliases: ["dried oregano"] },
  turmeric: { name: "turmeric", section: "spices", unitFamily: "volume", aliases: ["ground turmeric"] },
  ground_coriander: { name: "ground coriander", section: "spices", unitFamily: "volume", aliases: ["coriander seeds"] },
  bay_leaf: { name: "bay leaf", section: "spices", unitFamily: "count", aliases: ["bay leaves"] },
  garam_masala: { name: "garam masala", section: "spices", unitFamily: "volume" },
  mustard_seeds: { name: "mustard seeds", section: "spices", unitFamily: "volume", allergens: ["mustard"] },

  // Condiments
  dijon_mustard: {
    name: "Dijon mustard",
    section: "condiments",
    unitFamily: "volume",
    allergens: ["mustard"],
    aliases: ["dijon"],
  },
  mustard: {
    name: "mustard",
    section: "condiments",
    unitFamily: "volume",
    allergens: ["mustard"],
    aliases: ["yellow mustard", "whole grain mustard"],
  },
  mayonnaise: {
    name: "mayonnaise",
    section: "condiments",
    unitFamily: "volume",
    allergens: ["egg"],
    aliases: ["mayo"],
  },
  ketchup: { name: "ketchup", section: "condiments", unitFamily: "volume" },
  soy_sauce: {
    name: "soy sauce",
    section: "international",
    unitFamily: "volume",
    allergens: ["soy", "wheat"],
    aliases: ["light soy sauce", "dark soy sauce", "low-sodium soy sauce"],
  },
  tamari: { name: "tamari", section: "international", unitFamily: "volume", allergens: ["soy"] },
  fish_sauce: { name: "fish sauce", section: "international", unitFamily: "volume", allergens: ["fish"] },
  oyster_sauce: {
    name: "oyster sauce",
    section: "international",
    unitFamily: "volume",
    allergens: ["shellfish", "soy", "wheat"],
  },
  hoisin_sauce: {
    name: "hoisin sauce",
    section: "international",
    unitFamily: "volume",
    allergens: ["soy", "wheat", "sesame"],
    aliases: ["hoisin"],
  },
  miso: {
    name: "miso",
    section: "international",
    unitFamily: "volume",
    allergens: ["soy"],
    aliases: ["miso paste", "white miso"],
  },
  tahini: { name: "tahini", section: "international", unitFamily: "volume", allergens: ["sesame"] },
  worcestershire_sauce: {
    name: "Worcestershire sauce",
    section: "condiments",
    unitFamily: "volume",
    allergens: ["fish"],
    aliases: ["worcestershire"],
  },
  rice_vinegar: {
    name: "rice vinegar",
    section: "international",
    unitFamily: "volume",
    aliases: ["rice wine vinegar"],
  },
  red_wine_vinegar: { name: "red wine vinegar", section: "condiments", unitFamily: "volume", allergens: ["sulphite"] },
  white_wine_vinegar: {
    name: "white wine vinegar",
    section: "condiments",
    unitFamily: "volume",
    allergens: ["sulphite"],
  },
  balsamic_vinegar: {
    name: "balsamic vinegar",
    section: "condiments",
    unitFamily: "volume",
    allergens: ["sulphite"],
    aliases: ["balsamic"],
  },
  sriracha: { name: "sriracha", section: "international", unitFamily: "volume" },
} as const satisfies Record<string, CatalogueEntry>;

export type ItemId = keyof typeof CATALOGUE;
export const ITEM_IDS = Object.keys(CATALOGUE) as [ItemId, ...ItemId[]];
export const ItemId = z.enum(ITEM_IDS);

/** Every Item, in catalogue order. */
export const ITEMS: readonly Item[] = ITEM_IDS.map((id) => {
  const entry: CatalogueEntry = CATALOGUE[id];
  return { aliases: [], allergens: [], ...entry, id };
});

export function itemById(id: ItemId): Item {
  return ITEMS.find((item) => item.id === id) as Item;
}

/**
 * Words that describe an Ingredient's state or size rather than which Item it is. Matching tries the
 * name as written first, so an alias that includes one ("ground beef", "fresh ginger") still wins.
 */
const DESCRIPTIVE_WORDS = new Set([
  "fresh",
  "freshly",
  "large",
  "medium",
  "small",
  "big",
  "extra",
  "jumbo",
  "whole",
  "ripe",
  "raw",
  "cold",
  "warm",
  "chopped",
  "minced",
  "diced",
  "sliced",
  "grated",
  "shredded",
  "crushed",
  "peeled",
  "halved",
  "quartered",
  "finely",
  "roughly",
  "coarsely",
  "thinly",
  "packed",
  "lightly",
  "softened",
  "melted",
  "room-temperature",
  "boneless",
  "skinless",
  "organic",
  "dried",
  "frozen",
  "canned",
  "cooked",
  "uncooked",
]);

/** A name reduced to what matching compares: lower case, single spaces, every word singular. */
function normalise(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}%'\- ]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(singular)
    .join(" ");
}

/**
 * The singular of an English word, by the common rules. It need not be right, only consistent:
 * aliases go through it too, so "olives" and "olive" agree even though both become "olive".
 */
function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("oes")) return word.slice(0, -2);
  if (/(sh|ch|x|ss)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

const itemsByName = new Map<string, ItemId>();
for (const item of ITEMS) {
  for (const name of [item.name, ...item.aliases]) itemsByName.set(normalise(name), item.id as ItemId);
}

/** The Item an Ingredient's name refers to, ignoring case, plurals and descriptive words; null if none. */
export function matchItem(name: string): ItemId | null {
  const normalised = normalise(name);
  const exact = itemsByName.get(normalised);
  if (exact) return exact;
  const plain = normalised
    .split(" ")
    .filter((word) => !DESCRIPTIVE_WORDS.has(word))
    .join(" ");
  return itemsByName.get(plain) ?? null;
}
