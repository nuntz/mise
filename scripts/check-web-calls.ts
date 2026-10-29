/**
 * Fails if a web screen calls a tool that no web test names, as the Ready-made form's
 * `create_ready_made_recipe` went untested until #83: a screen's writes are tested where it makes them.
 *
 *   bun run check:web-calls
 *
 * A test names a tool by its quoted name, as a fake's `case "<tool>":` or an expected call does.
 */
import { Glob } from "bun";

const CALL = /\.call\(\s*"([a-z_]+)"/g;

const tests = await Promise.all(
  [...new Glob("apps/web/test/**/*.{ts,tsx}").scanSync()].map((file) => Bun.file(file).text()),
);
const named = (tool: string) => tests.some((text) => text.includes(`"${tool}"`));

const untested: { file: string; line: number; tool: string }[] = [];
const called = new Set<string>();
for (const file of new Glob("apps/web/src/**/*.{ts,tsx}").scanSync()) {
  const text = await Bun.file(file).text();
  for (const match of text.matchAll(CALL)) {
    const tool = match[1] as string;
    called.add(tool);
    if (named(tool)) continue;
    const line = text.slice(0, match.index).split("\n").length;
    untested.push({ file, line, tool });
  }
}

for (const { file, line, tool } of untested) console.error(`${file}:${line}: calls ${tool}, which no web test names`);
if (untested.length > 0) {
  console.error(`\n${untested.length} call(s) untested. Test the screen that makes each one in apps/web/test.`);
  process.exit(1);
}
console.log(`Every one of the ${called.size} tools the web app calls is named by a web test.`);
