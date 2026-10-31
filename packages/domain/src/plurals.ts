/** English words not made plural by the rule. */
const IRREGULAR: [string, string][] = [
  ["leaf", "leaves"],
  ["loaf", "loaves"],
  ["potato", "potatoes"],
  ["tomato", "tomatoes"],
];
const IRREGULAR_PLURALS = new Map(IRREGULAR);
const IRREGULAR_SINGULARS = new Map(IRREGULAR.map(([singular, plural]) => [plural, singular]));

/** Words that count what follows them: "2 leaves basil" is leaves of it, "1 loaf sourdough" a loaf. */
const COUNTING_WORDS = new Set(["leaf", "leaves", "loaf", "loaves"]);

export function isCountingWord(word: string): boolean {
  return COUNTING_WORDS.has(word.toLowerCase());
}

/**
 * A word made singular or plural, or left alone when it already is: "peas" is never "peases". Only
 * English has the rule (#82 brings French), so other languages keep the word as written.
 */
export function nounInNumber(word: string, plural: boolean, locale: string): string {
  if (!locale.startsWith("en")) return word;
  const lower = word.toLowerCase();
  if (plural) {
    if (IRREGULAR_SINGULARS.has(lower) || /[^s]s$/.test(lower)) return word;
    return matchCase(word, IRREGULAR_PLURALS.get(lower) ?? englishPlural(lower));
  }
  if (IRREGULAR_PLURALS.has(lower)) return word;
  return matchCase(word, IRREGULAR_SINGULARS.get(lower) ?? englishSingular(lower));
}

/** `word` capitalised as `written` is: "Tins" made singular is "Tin". */
export function matchCase(written: string, word: string): string {
  return written[0] === written[0]?.toUpperCase() ? (word[0]?.toUpperCase() ?? "") + word.slice(1) : word;
}

function englishPlural(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

function englishSingular(word: string): string {
  if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}
