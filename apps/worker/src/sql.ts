/**
 * A `WHERE` clause requiring every `always` condition and each key given by equality, so SQLite seeks
 * its index rather than scanning; a key left undefined filters nothing. For readers that serve both
 * "every row" and "just this one": a predicate that also holds when the bound key is null can use no
 * index, so reading one row would scan the whole table.
 */
export function whereKeys(
  keys: Record<string, SqlStorageValue | undefined>,
  ...always: string[]
): { where: string; values: SqlStorageValue[] } {
  const given = Object.entries(keys).filter((entry): entry is [string, SqlStorageValue] => entry[1] !== undefined);
  const conditions = [...always, ...given.map(([column]) => `${column} = ?`)];
  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    values: given.map(([, value]) => value),
  };
}
