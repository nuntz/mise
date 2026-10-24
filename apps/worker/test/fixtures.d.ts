/** A binary fixture, imported as its bytes by the vitest config's `binary-fixtures` plugin. */
declare module "*.paprikarecipes" {
  const bytes: Uint8Array<ArrayBuffer>;
  export default bytes;
}

/** A recorded page (`fixtures/pages`), imported as its text by Vite's `?raw`. */
declare module "*.html?raw" {
  const text: string;
  export default text;
}
