/**
 * Fails if a spec issue has a numbered user story that none of its tickets claims. Run it after
 * splitting a spec into tickets, so a missed story becomes a ticket now rather than at the end.
 *
 *   bun run check:stories <spec-issue>
 *
 * Stories are the numbered lines under the spec's `## User Stories` heading. Tickets are the
 * spec's sub-issues, open or closed, and claim stories with a line such as `Stories: 11–13, 71`
 * (see docs/agents/issue-tracker.md).
 */
import { $ } from "bun";

const spec = Number(process.argv[2]);
if (!Number.isInteger(spec) || spec <= 0) {
  console.error("Usage: bun run check:stories <spec-issue>");
  process.exit(2);
}

const specBody = await $`gh issue view ${spec} --json body --jq .body`.text();
const stories = storyNumbers(specBody);
if (stories.length === 0) {
  console.error(`#${spec} has no numbered stories under a "## User Stories" heading.`);
  process.exit(2);
}

const tickets: { number: number; body: string | null }[] =
  await $`gh api --paginate --slurp repos/{owner}/{repo}/issues/${spec}/sub_issues`
    .json()
    .then((pages: { number: number; body: string | null }[][]) => pages.flat());
const claimed = new Map<number, number[]>();
for (const ticket of tickets) {
  for (const story of claimedStories(ticket.body ?? "")) {
    claimed.set(story, [...(claimed.get(story) ?? []), ticket.number]);
  }
}

const missing = stories.filter((story) => !claimed.has(story));
const unknown = [...claimed.keys()].filter((story) => !stories.includes(story)).sort((a, b) => a - b);
for (const story of unknown) {
  console.error(
    `Story ${story} is claimed by ${(claimed.get(story) ?? []).map((n) => `#${n}`).join(", ")} but #${spec} has no such story.`,
  );
}
if (missing.length > 0) {
  console.error(`No ticket of #${spec} claims ${missing.length} of its ${stories.length} stories: ${ranges(missing)}.`);
}
if (missing.length > 0 || unknown.length > 0) process.exit(1);
console.log(`All ${stories.length} stories of #${spec} are claimed by its ${tickets.length} tickets.`);

/** The numbers of the `1. As a …` lines in the spec's User Stories section. */
function storyNumbers(body: string): number[] {
  const section = body.split(/^## User Stories\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  return [...section.matchAll(/^(\d+)\. /gm)].map(([, n]) => Number(n));
}

/** The stories named on a ticket's `Stories:` lines: numbers and ranges such as `11–13` or `11-13`. */
function claimedStories(body: string): number[] {
  const stories: number[] = [];
  for (const [, list = ""] of body.matchAll(/^\**Stories:?\**:?\s*(.+)$/gim)) {
    for (const [, from, to] of list.matchAll(/(\d+)(?:\s*[–-]\s*(\d+))?/g)) {
      for (let story = Number(from); story <= Number(to ?? from); story++) stories.push(story);
    }
  }
  return stories;
}

/** `[1, 2, 3, 7]` → `1–3, 7`. */
function ranges(numbers: number[]): string {
  const runs: [number, number][] = [];
  for (const n of numbers) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`)).join(", ");
}
