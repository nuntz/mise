/**
 * Runs `bun run ci` one step at a time and prints only what an agent needs: each step's result, the
 * failing step's error lines, and `exit=N`. The full output goes to `.ci.log`. It exits with CI's
 * status, so `bun run ci:summary` can be piped or chained without losing it.
 *
 *   bun run ci:summary
 *
 * The steps are read from the `ci` script in package.json, so the two can't drift apart. Like `&&`,
 * it stops at the first failing step.
 */
export {};

const LOG = ".ci.log";
/** Lines from a failing step worth showing: compiler, linter and test-runner errors. */
const ERROR =
  /\berror\b|\bfail(ed|ure)?\b|\bFAIL\b|[✗×✖❯]|Assertion|Expected|Received|^\s*at .+:\d+:\d+|^\s*[-+] |:\d+:\d+/i;
/** Lines that match ERROR but are passing summaries or known noise. */
const NOISE = /^\s*0 fail|\b0 errors?\b|npm notice|Using secrets defined in|NOSENTRY|Install @types\/node/i;
const MAX_LINES = 80;
const TAIL = 40;

const pkg = (await Bun.file("package.json").json()) as { scripts: Record<string, string> };
const ci = pkg.scripts.ci;
if (!ci) {
  console.error('package.json has no "ci" script.');
  process.exit(2);
}
const steps = ci.split("&&").map((step) => step.trim());

const log = Bun.file(LOG).writer();
let exitCode = 0;
for (const step of steps) {
  const started = performance.now();
  const proc = Bun.spawn(["sh", "-c", `${step} 2>&1`], {
    stdout: "pipe",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  const output = stripAnsi(await new Response(proc.stdout).text());
  const code = await proc.exited;
  const seconds = Math.round((performance.now() - started) / 1000);
  log.write(`\n===== ${step} (exit ${code}, ${seconds}s) =====\n${output}`);

  if (code === 0) {
    console.log(`✓ ${step} (${seconds}s)`);
    continue;
  }
  console.log(`✗ ${step} (exit ${code}, ${seconds}s)`);
  const lines = output.split("\n");
  const errors = lines.filter((line) => ERROR.test(line) && !NOISE.test(line));
  const shown = errors.length >= 3 ? errors : lines.slice(-TAIL);
  for (const line of shown.slice(0, MAX_LINES)) console.log(`  ${line}`);
  if (shown.length > MAX_LINES) console.log(`  … ${shown.length - MAX_LINES} more lines in ${LOG}`);
  exitCode = code;
  break;
}
await log.end();

console.log(`Full log: ${LOG}`);
console.log(`exit=${exitCode}`);
process.exit(exitCode);

function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes start with ESC.
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}
