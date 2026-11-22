/**
 * Fails if a committed file, or one `git add` would commit, holds a deployment's private values
 * (ADR 0005). Files not yet tracked are scanned too, so a local run sees what CI will.
 *
 *   bun run check:private                    # any email address outside the placeholder domains,
 *                                            # and any Cloudflare ray id but the placeholder
 *   pulumi config --show-secrets --json | bun run check:private -
 *                                            # also every value in the stack's config, ESC included
 *
 * Findings name the file, line and setting, never the value: CI logs are public.
 */
import { $ } from "bun";

/** Domains reserved for documentation (RFC 2606), and the commit trailers' no-reply addresses. */
const PLACEHOLDER_EMAIL = /(@example\.(com|org|net)|@users\.noreply\.github\.com|^noreply@anthropic\.com)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** A package at a version, as in Bun's patch file names (`patches/@scope%2Fname@1.2.3.patch`). */
const PACKAGE_VERSION = /@\d+\.\d+\.\d+/;
/**
 * A Cloudflare ray id, as a recorded response carries it: its suffix is the data centre that
 * answered, which says where the operator is. Fixtures use `0000000000000000-XXX`.
 */
const RAY_ID = /\b[0-9a-f]{16}-[A-Z]{3}\b/g;
const PLACEHOLDER_RAY_ID = "0000000000000000-XXX";
/** Shorter values would match everywhere; so would booleans and numbers, which identify no one. */
const MIN_LENGTH = 4;
const NOT_IDENTIFYING = /^(true|false|\d+)$/i;

type Finding = { file: string; line: number; what: string };

/** What private value `text`, one line of a committed file, holds, each named but never quoted. */
export function lineFindings(text: string, privateValues: { key: string; value: string }[]): string[] {
  const found: string[] = [];
  const lower = text.toLowerCase();
  for (const { key, value } of privateValues) {
    if (lower.includes(value)) found.push(`the value of ${key}`);
  }
  for (const [email] of text.matchAll(EMAIL)) {
    if (!PLACEHOLDER_EMAIL.test(email) && !PACKAGE_VERSION.test(email)) found.push("an email address");
  }
  for (const [ray] of text.matchAll(RAY_ID)) {
    if (ray !== PLACEHOLDER_RAY_ID) found.push("a Cloudflare ray id");
  }
  return found;
}

if (import.meta.main) {
  const privateValues = process.argv[2] === "-" ? configValues(JSON.parse(await Bun.stdin.text())) : [];
  const files = (await $`git ls-files -z --cached --others --exclude-standard`.text()).split("\0").filter(Boolean);
  const findings: Finding[] = [];

  for (const file of files) {
    const bytes = await Bun.file(file).bytes();
    if (bytes.includes(0)) continue; // binary
    const lines = new TextDecoder().decode(bytes).split("\n");
    lines.forEach((text, index) => {
      for (const what of lineFindings(text, privateValues)) findings.push({ file, line: index + 1, what });
    });
  }

  for (const { file, line, what } of findings) console.error(`${file}:${line}: ${what}`);
  if (findings.length > 0) {
    console.error(`\n${findings.length} private value(s) committed. Use placeholders such as mise.example.com.`);
    process.exit(1);
  }
  console.log(`No private values in ${files.length} files (${privateValues.length} config values checked).`);
}

/** Every string in `pulumi config --json` output, lower-cased, with the setting it came from. */
function configValues(config: Record<string, { value?: string; objectValue?: unknown }>) {
  const values: { key: string; value: string }[] = [];
  const collect = (key: string, value: unknown) => {
    if (typeof value === "string" && value.length >= MIN_LENGTH && !NOT_IDENTIFYING.test(value))
      values.push({ key, value: value.toLowerCase() });
    else if (Array.isArray(value)) for (const item of value) collect(key, item);
    else if (value && typeof value === "object") for (const item of Object.values(value)) collect(key, item);
  };
  for (const [key, setting] of Object.entries(config)) collect(key, setting.objectValue ?? setting.value);
  return values;
}
