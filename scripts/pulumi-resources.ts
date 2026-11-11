/**
 * Reads what each `pulumi up` changed from a deploy job's log (`gh run view --log --job`), whose lines
 * are `<job>\t<step>\t<timestamp> <text>`. Pulumi ends an update with a Resources block:
 *
 *   Resources:
 *       + 1 created
 *       2 changes. 11 unchanged
 *
 * Each block becomes one line, named after its step: "pulumi up: 13 unchanged".
 */
export function resourceSummaries(log: string): string[] {
  const summaries: string[] = [];
  let open: { step: string; counts: string[] } | undefined;
  for (const raw of log.split("\n")) {
    const [, step = "", stamped = ""] = raw.split("\t");
    const text = stamped.replace(/^\S+ ?/, "");
    if (open && step === open.step && /^\s+\S/.test(text)) {
      open.counts.push(text.trim());
      continue;
    }
    if (open) summaries.push(`${open.step}: ${open.counts.join(", ")}`);
    open = text === "Resources:" ? { step, counts: [] } : undefined;
  }
  if (open) summaries.push(`${open.step}: ${open.counts.join(", ")}`);
  return summaries;
}
