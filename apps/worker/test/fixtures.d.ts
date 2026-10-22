/** A binary fixture, imported as its bytes by the vitest config's `binary-fixtures` plugin. */
declare module "*.paprikarecipes" {
  const bytes: Uint8Array<ArrayBuffer>;
  export default bytes;
}
