import { expect, test } from "bun:test";

interface Step {
  name?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string | number>;
  run?: string;
}

const source = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
const workflow = Bun.YAML.parse(source) as {
  jobs: { deploy: { if: string; env: Record<string, string>; steps: Step[] } };
};
const deploy = workflow.jobs.deploy;
const wizard = await Bun.file(new URL("./setup-deployment.sh", import.meta.url)).text();

// Fictional identifiers only. The organization differs from the CI user, so masking the login
// alone cannot hide it. These tests inspect the actual workflow and execute its validation script;
// they do not pretend to implement GitHub's log masker or contact a deployment.
const SECRETS = {
  PULUMI_ORG: "example-organization",
  PULUMI_STACK: "example-organization/mise/production",
  PULUMI_ESC_ENVIRONMENT: "example-environments/production",
  PULUMI_CI_USER: "example-ci-user",
  CLOUDFLARE_API_TOKEN: "example-token-not-a-credential",
};
const secretRef = (name: string) => `\${{ secrets.${name} }}`;

function step(name: string): Step {
  const found = deploy.steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing workflow step: ${name}`);
  return found;
}

function bash(script: string, env: Record<string, string>) {
  const result = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", script], { env });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

test("the deploy gate reveals only a boolean and still excludes PRs and manual runs", () => {
  expect(deploy.if).toBe(
    "github.event_name == 'push' && github.ref == 'refs/heads/master' && vars.DEPLOY_ENABLED == 'true'",
  );
  expect(source).not.toMatch(/\bvars\.PULUMI_/);
  expect(source).not.toContain("steps.names.outputs.organization");
});

test("identifiers are secrets before any step header or OIDC action input can print them", () => {
  const check = step("Check deployment configuration");
  const select = step("Select the stack and its ESC environment");
  const auth = step("Sign in to Pulumi Cloud through OIDC");

  expect({ ...deploy.env, ...check.env }).toEqual(
    Object.fromEntries(Object.keys(SECRETS).map((name) => [name, secretRef(name)])),
  );
  expect(select.env).toEqual({
    PULUMI_STACK: secretRef("PULUMI_STACK"),
    PULUMI_ESC_ENVIRONMENT: secretRef("PULUMI_ESC_ENVIRONMENT"),
    PULUMI_CI_USER: secretRef("PULUMI_CI_USER"),
  });
  expect(auth.with?.organization).toBe(secretRef("PULUMI_ORG"));
  expect(auth.with?.scope).toBe(`user:${secretRef("PULUMI_CI_USER")}`);
  expect(deploy.steps.indexOf(check)).toBeLessThan(deploy.steps.indexOf(auth));
  expect(deploy.steps.indexOf(auth)).toBeLessThan(deploy.steps.indexOf(select));
});

test("valid configuration passes without printing an identifier", () => {
  expect(bash(step("Check deployment configuration").run ?? "exit 99", SECRETS)).toEqual({
    code: 0,
    output: "",
  });
});

for (const name of Object.keys(SECRETS)) {
  test(`missing ${name} fails before sign-in and names only the setting`, () => {
    const result = bash(step("Check deployment configuration").run ?? "exit 99", { ...SECRETS, [name]: "" });
    expect(result.code).toBe(1);
    expect(result.output).toContain(`The ${name} secret is not set`);
    for (const value of Object.values(SECRETS)) expect(result.output).not.toContain(value);
  });
}

for (const stack of [
  "other-example-org/mise/production",
  "production",
  "example-organization/production",
  "example-organization//production",
  "example-organization/mise/",
  "example-organization/mise/production/extra",
]) {
  test(`refuses a mismatched or incomplete stack (${stack}) without echoing it`, () => {
    const result = bash(step("Check deployment configuration").run ?? "exit 99", {
      ...SECRETS,
      PULUMI_STACK: stack,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("PULUMI_STACK must be an organization/project/stack in PULUMI_ORG");
    expect(result.output).not.toContain(stack);
    for (const value of Object.values(SECRETS)) expect(result.output).not.toContain(value);
  });
}

// Run only the wizard's GitHub-settings block. Its helpers write via gh in production; these
// fakes preserve the helper contract, including recording only successful writes and returning
// success after a skipped secret. No wizard prompts, logins or network commands are executed.
function configure(failedSecret = "") {
  const block = wizard.match(/secrets_before=\$\{#WRITTEN_SECRET\[@\]\}[\s\S]*?\npause/);
  if (!block) throw new Error("Missing wizard's deployment-settings block");
  return bash(
    `
WRITTEN_SECRET=()
SKIPPED=()
set_secret() {
  [[ "$1" == "$FAILED_SECRET" ]] && return 0
  WRITTEN_SECRET+=("$1")
  printf 'secret:%s=%s\\n' "$1" "$2"
}
set_var() { printf 'variable:%s=%s\\n' "$1" "$2"; }
warn() { :; }
pause() { :; }
${block[0]}
`,
    { ...SECRETS, STACK: SECRETS.PULUMI_STACK, ESC_ENV: SECRETS.PULUMI_ESC_ENVIRONMENT, FAILED_SECRET: failedSecret },
  );
}

test("the wizard saves all five secrets before enabling the non-identifying deploy flag", () => {
  const result = configure();
  expect(result.code).toBe(0);
  expect(result.output.trim().split("\n")).toEqual([
    ...["CLOUDFLARE_API_TOKEN", "PULUMI_CI_USER", "PULUMI_ORG", "PULUMI_STACK", "PULUMI_ESC_ENVIRONMENT"].map(
      (name) => `secret:${name}=${SECRETS[name as keyof typeof SECRETS]}`,
    ),
    "variable:DEPLOY_ENABLED=true",
  ]);
  expect(wizard).not.toMatch(/set_var PULUMI_/);
});

for (const name of Object.keys(SECRETS)) {
  test(`the wizard does not enable deployment when saving ${name} failed`, () => {
    const result = configure(name);
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("variable:DEPLOY_ENABLED");
  });
}
