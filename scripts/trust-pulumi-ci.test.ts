import { expect, test } from "bun:test";
import {
  type AuthPolicyDefinition,
  applyTrust,
  ciTrustPolicies,
  type OidcIssuer,
  type PulumiOidcClient,
} from "./trust-pulumi-ci";

const GITHUB = "https://token.actions.githubusercontent.com";

/** What Pulumi Cloud puts in a new issuer's policy (seen in Nov 2026). */
const PLACEHOLDER = {
  decision: "deny",
  tokenType: "personal",
  authorizedPermissions: null,
  rules: { aud: "urn:pulumi:org:example-org", sub: "" },
} as unknown as AuthPolicyDefinition;

/**
 * Pulumi Cloud's OIDC issuers and their policies, in memory. No test drives `pulumiCloudClient`
 * too, as it only talks to Pulumi Cloud: the fake's placeholder and its refusal of a blank rule are
 * what Pulumi Cloud did on the first live run of the same script in a sibling project.
 */
class FakePulumiOidc implements PulumiOidcClient {
  issuers: OidcIssuer[] = [];
  policies = new Map<string, { id: string; policies: AuthPolicyDefinition[] }>();
  writes = 0;

  async listIssuers() {
    return this.issuers.map((issuer) => ({ ...issuer }));
  }
  async registerIssuer(request: { name: string; url: string; maxExpiration: number }) {
    this.writes++;
    const issuer = { id: `issuer-${this.issuers.length + 1}`, ...request };
    this.issuers.push(issuer);
    // Pulumi Cloud gives a new issuer a placeholder deny that matches no token, and refuses the
    // placeholder back in an update.
    this.policies.set(issuer.id, { id: `policy-${issuer.id}`, policies: [PLACEHOLDER] });
    return { ...issuer };
  }
  async updateIssuer(id: string, update: { maxExpiration: number }) {
    this.writes++;
    const issuer = this.issuers.find((candidate) => candidate.id === id);
    if (!issuer) throw new Error(`no issuer ${id}`);
    issuer.maxExpiration = update.maxExpiration;
  }
  async getPolicy(issuerId: string) {
    const policy = this.policies.get(issuerId);
    if (!policy) throw new Error(`no policy for ${issuerId}`);
    return structuredClone(policy);
  }
  async updatePolicy(policyId: string, policies: AuthPolicyDefinition[]) {
    const blank = policies.findIndex((found) => Object.values(found.rules).includes(""));
    if (blank >= 0) throw new Error(`400: a rule should at least have a strict matching portion () on index ${blank}`);
    this.writes++;
    const policy = [...this.policies.values()].find((candidate) => candidate.id === policyId);
    if (!policy) throw new Error(`no policy ${policyId}`);
    policy.policies = structuredClone(policies);
  }
}

const quiet = () => {};

/** A sibling project's deploy policy on the same issuer, as another repository's script wrote it. */
const SIBLING: AuthPolicyDefinition = {
  decision: "allow",
  tokenType: "personal",
  userLogin: "example-ci",
  authorizedPermissions: [],
  rules: {
    aud: "urn:pulumi:org:example-org",
    repository_id: "999",
    sub: "repo:example/sibling:environment:production",
  },
};

async function sharedIssuer(pulumi: FakePulumiOidc, policies: AuthPolicyDefinition[], maxExpiration = 3600) {
  const { id } = await pulumi.registerIssuer({ name: "github-actions", url: GITHUB, maxExpiration });
  await pulumi.updatePolicy(`policy-${id}`, policies);
  return id;
}

/** A fictional deployment: Mise is open source, so no real organization, user or repository. */
const IDENTITY = {
  organization: "example-org",
  userLogin: "example-ci",
  repository: "example/mise",
  repositoryId: "4567",
  repositoryOwnerId: "123",
  immutableSubject: true,
};

const DEPLOY_CLAIMS = {
  aud: "urn:pulumi:org:example-org",
  sub: "repo:example@123/mise@4567:ref:refs/heads/master",
  repository: "example/mise",
  repository_id: "4567",
  repository_owner_id: "123",
  ref: "refs/heads/master",
  ref_type: "branch",
  event_name: "push",
  workflow_ref: "example/mise/.github/workflows/ci.yml@refs/heads/master",
  job_workflow_ref: "example/mise/.github/workflows/ci.yml@refs/heads/master",
  runner_environment: "github-hosted",
};

test("only the deploy job of a push to master gets a personal token", () => {
  expect(ciTrustPolicies(IDENTITY)).toEqual([
    {
      decision: "allow",
      tokenType: "personal",
      userLogin: "example-ci",
      authorizedPermissions: [],
      rules: DEPLOY_CLAIMS,
    },
  ]);
});

test("a repository older than GitHub's immutable subject is trusted under its name", () => {
  const [policy] = ciTrustPolicies({ ...IDENTITY, immutableSubject: false });
  expect(policy?.rules.sub).toBe("repo:example/mise:ref:refs/heads/master");
  expect(policy?.rules.repository_id).toBe("4567");
});

test("refuses an identity a wildcard would widen", () => {
  expect(() => ciTrustPolicies({ ...IDENTITY, repository: "example/*" })).toThrow(/wildcard/);
  expect(() => ciTrustPolicies({ ...IDENTITY, userLogin: "example-?" })).toThrow(/wildcard/);
  expect(() => ciTrustPolicies({ ...IDENTITY, repositoryId: "" })).toThrow(/repositoryId/);
  expect(() => ciTrustPolicies({ ...IDENTITY, repository: "mise" })).toThrow(/owner\/name/);
});

test("adds this repository's policy to an issuer another repository already trusts", async () => {
  const pulumi = new FakePulumiOidc();
  const id = await sharedIssuer(pulumi, [SIBLING]);

  await applyTrust(pulumi, IDENTITY, { dryRun: false, log: quiet });

  expect(pulumi.issuers).toHaveLength(1);
  expect((await pulumi.getPolicy(id)).policies).toEqual([SIBLING, ...ciTrustPolicies(IDENTITY)]);
});

test("registers GitHub as an issuer, without its placeholder, and allows only the deploy job", async () => {
  const pulumi = new FakePulumiOidc();

  await applyTrust(pulumi, IDENTITY, { dryRun: false, log: quiet });

  expect(pulumi.issuers).toEqual([{ id: "issuer-1", name: "github-actions", url: GITHUB, maxExpiration: 3600 }]);
  expect((await pulumi.getPolicy("issuer-1")).policies).toEqual(ciTrustPolicies(IDENTITY));
});

test("replaces this repository's earlier allow policy and keeps its deny policies", async () => {
  const pulumi = new FakePulumiOidc();
  const stale: AuthPolicyDefinition = {
    decision: "allow",
    tokenType: "personal",
    userLogin: "example-ci",
    authorizedPermissions: [],
    rules: { aud: "urn:pulumi:org:example-org", repository_id: "4567", sub: "repo:example/mise:*" },
  };
  const denyBranches: AuthPolicyDefinition = {
    decision: "deny",
    tokenType: "personal",
    userLogin: "example-ci",
    authorizedPermissions: [],
    rules: { repository_id: "4567", ref: "refs/heads/release-*" },
  };
  const id = await sharedIssuer(pulumi, [SIBLING, stale, denyBranches]);

  await applyTrust(pulumi, IDENTITY, { dryRun: false, log: quiet });

  expect((await pulumi.getPolicy(id)).policies).toEqual([SIBLING, denyBranches, ...ciTrustPolicies(IDENTITY)]);
});

test("flags an allow policy that names no repository", async () => {
  const pulumi = new FakePulumiOidc();
  const ownerWide: AuthPolicyDefinition = {
    decision: "allow",
    tokenType: "personal",
    userLogin: "example-ci",
    authorizedPermissions: [],
    rules: { sub: "repo:example/*" },
  };
  await sharedIssuer(pulumi, [ownerWide]);
  const lines: string[] = [];

  await applyTrust(pulumi, IDENTITY, { dryRun: false, log: (line) => lines.push(line) });

  expect(lines.join("\n")).toContain("1 allow policy names no repository_id");
});

test("leaves the lifetime of an issuer other repositories rely on", async () => {
  const pulumi = new FakePulumiOidc();
  await sharedIssuer(pulumi, [SIBLING], 90_000);

  await applyTrust(pulumi, IDENTITY, { dryRun: false, log: quiet });

  expect(pulumi.issuers[0]?.maxExpiration).toBe(90_000);
});

test("shortens the lifetime of an issuer no one else relies on", async () => {
  const pulumi = new FakePulumiOidc();
  await sharedIssuer(pulumi, [], 90_000);

  await applyTrust(pulumi, IDENTITY, { dryRun: false, log: quiet });

  expect(pulumi.issuers[0]?.maxExpiration).toBe(3600);
});

test("a second run finds the policy in place and writes nothing", async () => {
  const pulumi = new FakePulumiOidc();
  await sharedIssuer(pulumi, [SIBLING]);
  await applyTrust(pulumi, IDENTITY, { dryRun: false, log: quiet });
  const writes = pulumi.writes;
  const lines: string[] = [];

  await applyTrust(pulumi, IDENTITY, { dryRun: false, log: (line) => lines.push(line) });

  expect(pulumi.writes).toBe(writes);
  expect(lines.join("\n")).toContain("already in place");
});

test("a dry run writes nothing and says what it would change", async () => {
  const pulumi = new FakePulumiOidc();
  const id = await sharedIssuer(pulumi, [SIBLING]);
  const writes = pulumi.writes;
  const lines: string[] = [];

  await applyTrust(pulumi, IDENTITY, { dryRun: true, log: (line) => lines.push(line) });

  expect(pulumi.writes).toBe(writes);
  expect((await pulumi.getPolicy(id)).policies).toEqual([SIBLING]);
  expect(lines.join("\n")).toContain('"sub": "repo:example@123/mise@4567:ref:refs/heads/master"');
});
