/**
 * Builds `.paprikarecipes` files for tests: a zip holding one gzipped JSON file per Recipe, as
 * Paprika exports them. `bun scripts/paprika-fixture.ts` writes `sample.paprikarecipes` from
 * `SAMPLE_PAPRIKA_RECIPES`. Web standards only, so it runs in Bun and in workerd.
 */

/** A Paprika Recipe as its export writes it; every field is optional so tests can leave some out. */
export type PaprikaRecipeJson = Record<string, unknown>;

/** The start of a JPEG: enough for Mise to recognise the photo as one. Not a viewable image. */
export const SAMPLE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

/** UTF-8 bytes on their own ArrayBuffer (workerd's TextEncoder types only promise ArrayBufferLike). */
export const utf8 = (text: string) => new Uint8Array(new TextEncoder().encode(text));

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** Clearly fictional Recipes covering the fields the import maps. */
export const SAMPLE_PAPRIKA_RECIPES: PaprikaRecipeJson[] = [
  {
    uid: "6F1B2A44-0C3D-4E5F-8A9B-1C2D3E4F5A6B",
    name: "Weeknight Dal",
    ingredients: "1 cup red lentils\n2 cloves garlic, minced\n\n1 tbsp ghee",
    directions: "Rinse the lentils.\n\nSimmer everything for 25 minutes.",
    description: "A pot of comfort.",
    notes: "Double the garlic.",
    servings: "Serves 4-6",
    prep_time: "10 min",
    cook_time: "25 mins",
    total_time: "",
    rating: 5,
    on_favorites: false,
    in_trash: false,
    categories: ["Indian", "Vegetarian", "Weeknight"],
    source: "The Example Kitchen",
    source_url: "https://recipes.example.com/dal",
    hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    photo: "dal.jpg",
    photo_hash: "photo-dal",
    photo_data: base64(SAMPLE_JPEG),
    photos: [],
    created: "2024-02-10 18:30:00",
  },
  {
    uid: "9A8B7C6D-5E4F-4A3B-9C2D-1E0F9A8B7C6D",
    name: "Sheet-pan Chicken",
    ingredients: "4 chicken thighs\n1 lemon\n2 tbsp olive oil",
    directions: "Roast at 220°C until golden.",
    description: "",
    notes: "",
    servings: "",
    prep_time: "",
    cook_time: "",
    total_time: "1 hr 15 min",
    rating: 0,
    on_favorites: true,
    in_trash: false,
    categories: ["Chicken"],
    source: "",
    source_url: "",
    hash: "0f9e8d7c6b5a49382716f5e4d3c2b1a00f9e8d7c6b5a49382716f5e4d3c2b1a0",
    photo: null,
    photo_hash: null,
    photo_data: null,
    photos: [],
    created: "2024-03-01 12:00:00",
  },
  {
    uid: "1D2C3B4A-5F6E-4D7C-8B9A-0F1E2D3C4B5A",
    name: "Soggy Toast",
    ingredients: "2 slices bread\n1 cup water",
    directions: "Don't.",
    servings: "1",
    total_time: "",
    prep_time: "",
    cook_time: "",
    rating: 1,
    on_favorites: false,
    in_trash: false,
    categories: [],
    hash: "5a4b3c2d1e0f5a4b3c2d1e0f5a4b3c2d1e0f5a4b3c2d1e0f5a4b3c2d1e0f5a4b",
    photo_data: null,
    photos: [],
  },
  {
    uid: "7E6D5C4B-3A2F-4E1D-9C8B-7A6F5E4D3C2B",
    name: "Binned Brownies",
    ingredients: "1 cup sugar",
    directions: "Bake.",
    servings: "12",
    rating: 3,
    on_favorites: false,
    in_trash: true,
    categories: ["Dessert"],
    hash: "c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff",
    photo_data: null,
    photos: [],
  },
];

/** An entry given as its bytes, for testing entries that are not gzipped JSON. */
export type RawEntry = { entry: string; bytes: Uint8Array<ArrayBuffer> };

function isRaw(recipe: PaprikaRecipeJson | RawEntry): recipe is RawEntry {
  return recipe.bytes instanceof Uint8Array;
}

/** How each zip entry is stored: as is, or deflated again (both occur in the wild). */
export type ZipMethod = "stored" | "deflate";

/**
 * A `.paprikarecipes` file holding `recipes`, one `<name>.paprikarecipe` entry each. An entry given
 * as raw bytes is stored as is, for testing entries that are not gzipped JSON.
 */
export async function paprikaExport(
  recipes: (PaprikaRecipeJson | RawEntry)[],
  method: ZipMethod = "deflate",
): Promise<Uint8Array<ArrayBuffer>> {
  const files = await Promise.all(
    recipes.map(async (recipe, index) => {
      if (isRaw(recipe)) return { name: recipe.entry, data: recipe.bytes };
      const name = `${typeof recipe.name === "string" ? recipe.name : `Recipe ${index + 1}`}.paprikarecipe`;
      return { name, data: await compress(utf8(JSON.stringify(recipe)), "gzip") };
    }),
  );
  return zip(files, method);
}

/** A zip archive of `files`, without zip64, timestamps at 1980-01-01 so the bytes are deterministic. */
export async function zip(
  files: { name: string; data: Uint8Array<ArrayBuffer> }[],
  method: ZipMethod = "deflate",
): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const file of files) {
    const name = utf8(file.name);
    const data = method === "deflate" ? await compress(file.data, "deflate-raw") : file.data;
    const fields = {
      method: method === "deflate" ? 8 : 0,
      crc: crc32(file.data),
      compressed: data.length,
      size: file.data.length,
      nameLength: name.length,
    };
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, fields.method, true);
    local.setUint16(12, 0x0021, true);
    local.setUint32(14, fields.crc, true);
    local.setUint32(18, fields.compressed, true);
    local.setUint32(22, fields.size, true);
    local.setUint16(26, fields.nameLength, true);
    parts.push(new Uint8Array(local.buffer), name, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, fields.method, true);
    entry.setUint16(14, 0x0021, true);
    entry.setUint32(16, fields.crc, true);
    entry.setUint32(20, fields.compressed, true);
    entry.setUint32(24, fields.size, true);
    entry.setUint16(28, fields.nameLength, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

async function compress(
  data: Uint8Array<ArrayBuffer>,
  format: "gzip" | "deflate-raw",
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
