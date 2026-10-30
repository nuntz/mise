/**
 * Which build of Mise this is, as Settings shows it: the commit it was built from, short. In CI that's
 * the commit being deployed; locally it's the checked-out one, marked `-dirty` when the working tree
 * has changes. Without git it's `dev`, so a build never fails for want of one.
 *
 * `git` runs git with the given arguments and gives back what it printed, or undefined when it can't.
 */
export function buildId(ciSha: string | undefined, git: (args: string[]) => string | undefined): string {
  if (ciSha) return ciSha.slice(0, 7);
  const sha = git(["rev-parse", "--short=7", "HEAD"]);
  if (!sha) return "dev";
  return git(["status", "--porcelain"]) ? `${sha}-dirty` : sha;
}
