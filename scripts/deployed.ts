/**
 * Waits for a pushed commit's CI run and says whether it was deployed. Deploying is the `deploy` job
 * of the CI run on master (.github/workflows/ci.yml), not a separate workflow, so a commit is live
 * once that job succeeds. Exits 0 only then; 1 if a job failed or deploy was skipped; 2 if there is
 * no run to wait for, or gh fails for a reason other than a GitHub server error (which it tries again).
 *
 *   bun run deployed [commit]    (defaults to HEAD)
 *
 * Once it passes, Settings in Mise shows the same short SHA as the build it runs, and this prints
 * what each `pulumi up` changed ("pulumi up: 13 unchanged").
 */
import { $ } from "bun";
import { ghFailure } from "./gh-failure";
import { resourceSummaries } from "./pulumi-resources";

const WORKFLOW = "ci.yml";
const BRANCH = "master";
/** A run appears a few seconds after the push. */
const APPEAR_TIMEOUT_MS = 90_000;
const POLL_MS = 10_000;
/** Test and deploy together take a few minutes; give up well after that. */
const RUN_TIMEOUT_MS = 30 * 60_000;
/** A job's log can lag its success by some seconds: read it again until it has a summary, this long. */
const LOG_TIMEOUT_MS = 60_000;

type Job = { databaseId: number; name: string; status: string; conclusion: string | null };
type Run = { databaseId: number; headSha: string; status: string; conclusion: string | null; url: string };

const ref = process.argv[2] ?? "HEAD";
const sha = (await $`git rev-parse ${ref}`.text()).trim();
const short = sha.slice(0, 7);

await $`git fetch --quiet origin ${BRANCH}`.nothrow();
const pushed = (await $`git merge-base --is-ancestor ${sha} origin/${BRANCH}`.nothrow()).exitCode === 0;
if (!pushed) {
  console.log(`${short} is not on origin/${BRANCH}: push it first.`);
  process.exit(2);
}

const run = await findRun();
if (!run) {
  // An older commit's own run may not exist when it was pushed together with newer ones.
  console.log(`No CI run for ${short} on ${BRANCH} after ${APPEAR_TIMEOUT_MS / 1000}s.`);
  console.log("If it was pushed with later commits, run this for the newest one.");
  process.exit(2);
}
console.log(`Watching CI run ${run.databaseId} for ${short}: ${run.url}`);

const reported = new Map<string, string>();
const deadline = Date.now() + RUN_TIMEOUT_MS;
let jobs: Job[] = [];
let done = false;
while (!done) {
  const view = await ghJson<{ status: string; conclusion: string | null; jobs: Job[] }>(
    $`gh run view ${run.databaseId} --json status,conclusion,jobs`,
  );
  if (view) {
    jobs = view.jobs;
    for (const job of jobs) {
      const state = job.status === "completed" ? (job.conclusion ?? "completed") : job.status;
      if (reported.get(job.name) !== state) {
        console.log(`  ${job.name}: ${state}`);
        reported.set(job.name, state);
      }
    }
    done = view.status === "completed";
  }
  if (!done) {
    if (Date.now() > deadline) {
      console.log(`Still running after ${RUN_TIMEOUT_MS / 60_000} minutes; giving up.`);
      process.exit(1);
    }
    await Bun.sleep(POLL_MS);
  }
}

const deploy = jobs.find((job) => job.name === "deploy");
if (deploy?.conclusion === "success") {
  console.log(`Deployed: ${short}. Settings in Mise shows this build once the app reloads.`);
  const { summaries, error } = await pulumiSummaries(run.databaseId, deploy.databaseId);
  for (const summary of summaries) console.log(`  ${summary}`);
  if (summaries.length === 0) {
    console.log(`  The deploy log has no Pulumi Resources summary after ${LOG_TIMEOUT_MS / 1000}s.`);
    if (error) console.log(`  gh run view said: ${error}`);
  }
  process.exit(0);
}
const failed = jobs.filter((job) => job.conclusion === "failure").map((job) => job.name);
if (failed.length > 0) {
  console.log(`Not deployed: ${failed.join(", ")} failed. Logs: gh run view ${run.databaseId} --log-failed`);
} else {
  console.log(`Not deployed: deploy was ${deploy?.conclusion ?? "absent"}.`);
}
process.exit(1);

/** What each `pulumi up` in the job changed, or none once its log has had time; with gh's last error. */
async function pulumiSummaries(runId: number, jobId: number): Promise<{ summaries: string[]; error: string }> {
  const until = Date.now() + LOG_TIMEOUT_MS;
  for (;;) {
    // Any failure is read again: a log not yet written is not known to fail with a server error.
    const read = await $`gh run view ${runId} --log --job ${jobId}`.nothrow().quiet();
    if (read.exitCode !== 0) reportServerError(read.stderr.toString().trim());
    const summaries = resourceSummaries(read.stdout.toString());
    if (summaries.length > 0 || Date.now() > until) return { summaries, error: read.stderr.toString().trim() };
    await Bun.sleep(5_000);
  }
}

async function findRun(): Promise<Run | null> {
  const until = Date.now() + APPEAR_TIMEOUT_MS;
  for (;;) {
    const runs = await ghJson<Run[]>(
      $`gh run list --workflow ${WORKFLOW} --branch ${BRANCH} --event push --limit 20 --json databaseId,headSha,status,conclusion,url`,
    );
    const found = runs?.find((r) => r.headSha === sha);
    if (found) return found;
    if (Date.now() > until) return null;
    await Bun.sleep(5_000);
  }
}

/**
 * A `gh … --json` call's answer, or null when GitHub answered a server error and the caller's next
 * poll should try again. Any other failure would fail again, so it ends the script with gh's message.
 */
async function ghJson<T>(call: $.ShellPromise): Promise<T | null> {
  const result = await call.nothrow().quiet();
  if (result.exitCode === 0) return result.json() as T;
  const stderr = result.stderr.toString().trim();
  if (reportServerError(stderr)) return null;
  console.log(`gh failed: ${stderr}`);
  process.exit(2);
}

/** Says so when gh's failure is a GitHub server error, which the caller tries again. */
function reportServerError(stderr: string): boolean {
  if (ghFailure(stderr) !== "transient") return false;
  console.log(`  GitHub answered a server error (${stderr.split("\n")[0]}); trying again.`);
  return true;
}
