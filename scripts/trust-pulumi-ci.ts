import { parseArgs } from "node:util";

/**
 * Who may deploy as whom: the Pulumi Cloud side of CI's OIDC sign-in (README → CI's sign-in to
 * Pulumi Cloud, ADR 0005). It allows only this repository's deploy job, on a push to master, to
 * exchange its GitHub ID token for a short-lived personal access token, on the organization's
 * GitHub Actions issuer, which other repositories may share.
 */

/** The GitHub repository whose deploy job may sign in, as its ID tokens name it. */
export interface GithubRepository {
  /** `owner/name` on GitHub. */
  repository: string;
  /** GitHub's numeric IDs, which survive a rename or a re-created repository of the same name. */
  repositoryId: string;
  repositoryOwnerId: string;
  /**
   * Whether the repository's ID tokens carry GitHub's immutable subject, which names both IDs
   * (`repo:owner@id/name@id:…`): the default for repositories made since July 2026.
   */
  immutableSubject: boolean;
}

export interface CiIdentity extends GithubRepository {
  /** The Pulumi organization the stack lives in: the first part of `PULUMI_STACK`. */
  organization: string;
  /** The Pulumi user CI acts as; the token carries that user's permissions. */
  userLogin: string;
}

export interface AuthPolicyDefinition {
  decision: "allow" | "deny";
  tokenType: string;
  userLogin?: string;
  teamName?: string;
  runnerID?: string;
  roleID?: string;
  authorizedPermissions: string[];
  rules: Record<string, string>;
}

/** The deploy job's workflow file, the only one that may sign in. */
const WORKFLOW = ".github/workflows/ci.yml";
const BRANCH = "refs/heads/master";

/** The subject GitHub's default template gives a job on `ref` outside any environment. */
export function subjectPrefix(repo: GithubRepository): string {
  if (!repo.immutableSubject) return `repo:${repo.repository}`;
  const [owner, name] = repo.repository.split("/");
  return `repo:${owner}@${repo.repositoryOwnerId}/${name}@${repo.repositoryId}`;
}

/**
 * Pulumi matches every rule against the claim of the same name, all of them at once. In a rule
 * value `*` and `?` are wildcards and so is `.` (exactly one character), so `ci.yml` also
 * matches `ciXyml`; the repository's numeric IDs keep that from reaching beyond this repository.
 * Only `push` deploys: a `workflow_dispatch` run on master gets no token.
 */
export function ciTrustPolicies(identity: CiIdentity): AuthPolicyDefinition[] {
  for (const [field, value] of Object.entries(identity)) {
    if (typeof value !== "string") continue;
    if (!value) throw new Error(`${field} is required`);
    if (/[*?]/.test(value)) throw new Error(`${field} must not contain a wildcard: ${value}`);
  }
  if (!/^[^/]+\/[^/]+$/.test(identity.repository)) {
    throw new Error(`repository must be owner/name: ${identity.repository}`);
  }
  const workflowRef = `${identity.repository}/${WORKFLOW}@${BRANCH}`;
  return [
    {
      decision: "allow",
      tokenType: "personal",
      userLogin: identity.userLogin,
      authorizedPermissions: [],
      rules: {
        aud: `urn:pulumi:org:${identity.organization}`,
        sub: `${subjectPrefix(identity)}:ref:${BRANCH}`,
        repository: identity.repository,
        repository_id: identity.repositoryId,
        repository_owner_id: identity.repositoryOwnerId,
        // The subject names the branch already; the claims of its own say it without parsing.
        ref: BRANCH,
        ref_type: "branch",
        event_name: "push",
        workflow_ref: workflowRef,
        job_workflow_ref: workflowRef,
        runner_environment: "github-hosted",
      },
    },
  ];
}

const GITHUB_ISSUER_URL = "https://token.actions.githubusercontent.com";

export interface OidcIssuer {
  id: string;
  name: string;
  url: string;
  maxExpiration?: number;
}

export interface IssuerRegistration {
  name: string;
  url: string;
  maxExpiration: number;
}

/** An issuer's policies: Pulumi Cloud keeps one list per issuer. */
export interface IssuerPolicy {
  id: string;
  policies: AuthPolicyDefinition[];
}

/** The slice of the Pulumi Cloud REST API this script uses. */
export interface PulumiOidcClient {
  listIssuers(): Promise<OidcIssuer[]>;
  registerIssuer(request: IssuerRegistration): Promise<OidcIssuer>;
  updateIssuer(id: string, update: { maxExpiration: number }): Promise<void>;
  getPolicy(issuerId: string): Promise<IssuerPolicy>;
  updatePolicy(policyId: string, policies: AuthPolicyDefinition[]): Promise<void>;
}

const ISSUER_NAME = "github-actions";
/**
 * The longest Pulumi token the issuer hands out, in seconds, when this script registers it. The
 * deploy job asks for less (ci.yml); a token that expires mid-`pulumi up` leaves the stack locked.
 */
const MAX_EXPIRATION_SECONDS = 3600;

/**
 * A policy as Pulumi Cloud means it: the API may send back empty optional fields, or the fields
 * in another order, for a policy this script wrote.
 */
function normalized(policy: AuthPolicyDefinition): AuthPolicyDefinition {
  const { decision, tokenType, userLogin, teamName, runnerID, roleID } = policy;
  return {
    decision,
    tokenType,
    ...(userLogin ? { userLogin } : {}),
    ...(teamName ? { teamName } : {}),
    ...(runnerID ? { runnerID } : {}),
    ...(roleID ? { roleID } : {}),
    authorizedPermissions: [...(policy.authorizedPermissions ?? [])].sort(),
    rules: Object.fromEntries(Object.entries(policy.rules ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function samePolicies(a: AuthPolicyDefinition[], b: AuthPolicyDefinition[]): boolean {
  return JSON.stringify(a.map(normalized)) === JSON.stringify(b.map(normalized));
}

/**
 * Pulumi Cloud gives a new issuer a deny policy with an empty `sub` rule, which matches no token,
 * so its policy list is never empty; it refuses that placeholder back in an update.
 */
function isPlaceholder(policy: AuthPolicyDefinition): boolean {
  return Object.values(policy.rules ?? {}).includes("");
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export async function applyTrust(
  client: PulumiOidcClient,
  identity: CiIdentity,
  options: { dryRun: boolean; log: (line: string) => void },
): Promise<void> {
  const { dryRun, log } = options;
  const desired = ciTrustPolicies(identity);
  const issuer = (await client.listIssuers()).find((found) => found.url === GITHUB_ISSUER_URL);

  if (!issuer) {
    log(`Register ${GITHUB_ISSUER_URL} as "${ISSUER_NAME}", tokens up to ${MAX_EXPIRATION_SECONDS}s`);
    log(`Allow only:\n${JSON.stringify(desired, null, 2)}`);
    if (dryRun) return;
    const registered = await client.registerIssuer({
      name: ISSUER_NAME,
      url: GITHUB_ISSUER_URL,
      maxExpiration: MAX_EXPIRATION_SECONDS,
    });
    const policy = await client.getPolicy(registered.id);
    await client.updatePolicy(policy.id, [...policy.policies.filter((found) => !isPlaceholder(found)), ...desired]);
    return;
  }

  log(`Issuer ${issuer.url} is registered as "${issuer.name}" (${issuer.id})`);
  const policy = await client.getPolicy(issuer.id);
  const current = policy.policies.map((found) => ({ ...found, rules: found.rules ?? {} }));
  // One GitHub issuer serves the whole organization: only this repository's allow policies are
  // this script's to replace. Deny policies, and every other repository's, stay.
  const kept = current.filter(
    (found) =>
      !isPlaceholder(found) && !(found.decision === "allow" && found.rules.repository_id === identity.repositoryId),
  );
  if (kept.length > 0) {
    log(`Keep ${plural(kept.length, "other policy", "other policies")}:`);
    log(JSON.stringify(kept, null, 2));
  }
  const unscoped = kept.filter((found) => found.decision === "allow" && !found.rules.repository_id);
  if (unscoped.length > 0) {
    log(
      `Warning: ${plural(unscoped.length, "allow policy names", "allow policies name")} no repository_id, so it may also let this repository's pull requests or branches sign in: narrow or remove it.`,
    );
  }

  if (issuer.maxExpiration !== MAX_EXPIRATION_SECONDS) {
    const was = `${issuer.maxExpiration ?? "the default"}s`;
    if (kept.some((found) => found.decision === "allow")) {
      log(`Leave its longest token at ${was}: other policies rely on this issuer.`);
    } else {
      log(`Change its longest token from ${was} to ${MAX_EXPIRATION_SECONDS}s`);
      if (!dryRun) await client.updateIssuer(issuer.id, { maxExpiration: MAX_EXPIRATION_SECONDS });
    }
  }

  const next = [...kept, ...desired];
  if (samePolicies(policy.policies, next)) {
    log("This repository's policy is already in place.");
    return;
  }
  log(`Set this repository's policy to:\n${JSON.stringify(desired, null, 2)}`);
  if (!dryRun) await client.updatePolicy(policy.id, next);
}

const PULUMI_API = "https://api.pulumi.com";

/** The REST API behind `PulumiOidcClient` (https://api.pulumi.com/api/openapi/pulumi-spec.json). */
export function pulumiCloudClient(organization: string, accessToken: string): PulumiOidcClient {
  const org = `${PULUMI_API}/api/orgs/${encodeURIComponent(organization)}`;
  async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const response = await fetch(url, {
      method,
      headers: {
        accept: "application/vnd.pulumi+8",
        authorization: `token ${accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${url} answered ${response.status}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
  return {
    listIssuers: async () => (await call<{ oidcIssuers: OidcIssuer[] }>("GET", `${org}/oidc/issuers`)).oidcIssuers,
    registerIssuer: (request) => call("POST", `${org}/oidc/issuers`, request),
    updateIssuer: async (id, update) => {
      await call("PATCH", `${org}/oidc/issuers/${encodeURIComponent(id)}`, update);
    },
    getPolicy: (issuerId) => call("GET", `${org}/auth/policies/oidcissuers/${encodeURIComponent(issuerId)}`),
    updatePolicy: async (policyId, policies) => {
      await call("PATCH", `${org}/auth/policies/${encodeURIComponent(policyId)}`, { policies });
    },
  };
}

/** `PULUMI_ACCESS_TOKEN`, or the token `pulumi login` saved for Pulumi Cloud. */
async function pulumiAccessToken(): Promise<string> {
  if (process.env.PULUMI_ACCESS_TOKEN) return process.env.PULUMI_ACCESS_TOKEN;
  const path = `${process.env.PULUMI_HOME ?? `${process.env.HOME}/.pulumi`}/credentials.json`;
  const credentials = (await Bun.file(path)
    .json()
    .catch(() => ({}))) as { accessTokens?: Record<string, string> };
  const token = credentials.accessTokens?.[PULUMI_API] ?? credentials.accessTokens?.["https://app.pulumi.com"];
  if (!token) throw new Error("Not signed in to Pulumi Cloud: run `pulumi login` first");
  return token;
}

function gh<T>(args: string[]): T {
  const result = Bun.spawnSync(["gh", ...args], { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`gh ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return JSON.parse(result.stdout.toString()) as T;
}

/**
 * The repository's IDs and subject format, read from GitHub. Refuses a customized subject
 * template: the `sub` rule assumes GitHub's default, legacy or immutable.
 */
function githubRepository(repository: string): GithubRepository {
  const repo = gh<{ id: number; owner: { id: number } }>(["api", `repos/${repository}`]);
  const template = gh<{ use_default?: boolean; use_immutable_subject?: boolean; sub_claim_prefix?: string }>([
    "api",
    `repos/${repository}/actions/oidc/customization/sub`,
  ]);
  if (template.use_default !== true) {
    throw new Error(
      `${repository} customizes its OIDC subject (${JSON.stringify(template)}): the sub rule assumes GitHub's default, so change ciTrustPolicies first`,
    );
  }
  const found: GithubRepository = {
    repository,
    repositoryId: String(repo.id),
    repositoryOwnerId: String(repo.owner.id),
    immutableSubject: template.use_immutable_subject === true,
  };
  // GitHub states the prefix its tokens carry: it must be the one the sub rule is built from.
  const expected = subjectPrefix(found);
  if (template.sub_claim_prefix && template.sub_claim_prefix !== expected) {
    throw new Error(`${repository}'s ID tokens start their subject with ${template.sub_claim_prefix}, not ${expected}`);
  }
  return found;
}

const USAGE = `Usage: bun run trust:pulumi-ci --org <pulumi-org> --user <pulumi-login> [--dry-run]

Allows only this repository's deploy job, on a push to master, to sign in to Pulumi Cloud as
<pulumi-login> through GitHub OIDC, registering GitHub Actions as an OIDC issuer of the
organization if it isn't one yet (README → CI's sign-in to Pulumi Cloud). Other repositories'
policies on the issuer stay. Signs in as \`pulumi login\` did; reads the repository from \`gh\`.

  --org <name>        the Pulumi organization (the first part of PULUMI_STACK)
  --user <login>      the Pulumi user CI acts as (\`pulumi whoami\`)
  --repository <o/n>  the GitHub repository (default: this checkout's, from \`gh repo view\`)
  --dry-run           show what would change and write nothing`;

async function main() {
  const { values } = parseArgs({
    options: {
      org: { type: "string" },
      user: { type: "string" },
      repository: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help || !values.org || !values.user) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  const repository =
    values.repository ?? gh<{ nameWithOwner: string }>(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;
  const identity: CiIdentity = {
    organization: values.org,
    userLogin: values.user,
    ...githubRepository(repository),
  };
  const dryRun = values["dry-run"] ?? false;
  const log = (line: string) => console.log(`${dryRun ? "[dry-run] " : ""}${line}`);
  await applyTrust(pulumiCloudClient(values.org, await pulumiAccessToken()), identity, { dryRun, log });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
