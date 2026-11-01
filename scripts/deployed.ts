/**
 * Waits for a pushed commit's CI run and says whether it was deployed. Deploying is the `deploy` job
 * of the CI run on master (.github/workflows/ci.yml), not a separate workflow, so a commit is live
 * once that job succeeds. Exits 0 only then; 1 if a job failed or deploy was skipped; 2 if there is
 * no run to wait for.
 *
 *   bun run deployed [commit]    (defaults to HEAD)
 *
 * Once it passes, Settings in Mise shows the same short SHA as the build it runs.
 */
import { $ } from "bun";

const WORKFLOW = "ci.yml";
const BRANCH = "master";
/** A run appears a few seconds after the push. */
const APPEAR_TIMEOUT_MS = 90_000;
const POLL_MS = 10_000;
/** Test and deploy together take a few minutes; give up well after that. */
const RUN_TIMEOUT_MS = 30 * 60_000;

type Job = { name: string; status: string; conclusion: string | null };
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
  const view = (await $`gh run view ${run.databaseId} --json status,conclusion,jobs`.json()) as {
    status: string;
    conclusion: string | null;
    jobs: Job[];
  };
  jobs = view.jobs;
  for (const job of jobs) {
    const state = job.status === "completed" ? (job.conclusion ?? "completed") : job.status;
    if (reported.get(job.name) !== state) {
      console.log(`  ${job.name}: ${state}`);
      reported.set(job.name, state);
    }
  }
  done = view.status === "completed";
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
  process.exit(0);
}
const failed = jobs.filter((job) => job.conclusion === "failure").map((job) => job.name);
if (failed.length > 0) {
  console.log(`Not deployed: ${failed.join(", ")} failed. Logs: gh run view ${run.databaseId} --log-failed`);
} else {
  console.log(`Not deployed: deploy was ${deploy?.conclusion ?? "absent"}.`);
}
process.exit(1);

async function findRun(): Promise<Run | null> {
  const until = Date.now() + APPEAR_TIMEOUT_MS;
  for (;;) {
    const runs =
      (await $`gh run list --workflow ${WORKFLOW} --branch ${BRANCH} --event push --limit 20 --json databaseId,headSha,status,conclusion,url`.json()) as Run[];
    const found = runs.find((r) => r.headSha === sha);
    if (found) return found;
    if (Date.now() > until) return null;
    await Bun.sleep(5_000);
  }
}
