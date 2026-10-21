// Pulumi program for a Mise deployment: Access, R2, Worker secrets and the Worker's custom domain.
// Deployment values come from a Pulumi ESC environment, never from this repo (ADR 0005); see
// Pulumi.example.yaml for the settings. The Worker's code deploys with `wrangler deploy` after this.
import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

/** Must match `name` and the R2 `bucket_name` in apps/worker/wrangler.jsonc. */
const WORKER_NAME = "mise";
const BUCKET_NAME = "mise";

const config = new pulumi.Config("mise");
const accountId = config.require("accountId");
const zone = config.require("zone");
const hostname = config.require("hostname");
const accessTeamDomain = config.require("accessTeamDomain");
const allowedEmails = config.getObject<string[]>("allowedEmails") ?? [];
const allowedEmailDomain = config.get("allowedEmailDomain");
const sentryDsn = config.getSecret("sentryDsn");

if (allowedEmails.length === 0 && !allowedEmailDomain) {
  throw new Error("Set mise:allowedEmails or mise:allowedEmailDomain: otherwise no one can sign in");
}

new cloudflare.R2Bucket("photos-and-exports", { accountId, name: BUCKET_NAME });

// Access: Members sign in with Google; the calendar feed carries its own token instead.
const google = new cloudflare.ZeroTrustAccessIdentityProvider("google", {
  accountId,
  name: "Google",
  type: "google",
  config: {
    clientId: config.require("googleClientId"),
    clientSecret: config.requireSecret("googleClientSecret"),
  },
});

const members = new cloudflare.ZeroTrustAccessPolicy("members", {
  accountId,
  name: "Mise: Members of the Household",
  decision: "allow",
  includes: [
    ...allowedEmails.map((email) => ({ email: { email } })),
    ...(allowedEmailDomain ? [{ emailDomain: { domain: allowedEmailDomain } }] : []),
  ],
});

const calendarFeedBypass = new cloudflare.ZeroTrustAccessPolicy("calendar-feed", {
  accountId,
  name: "Mise: calendar feed",
  decision: "bypass",
  includes: [{ everyone: {} }],
});

const app = new cloudflare.ZeroTrustAccessApplication("mise", {
  accountId,
  name: "Mise",
  type: "self_hosted",
  domain: hostname,
  allowedIdps: [google.id],
  autoRedirectToIdentity: true,
  sessionDuration: "720h",
  policies: [{ id: members.id, precedence: 1 }],
});

// The more specific path wins, so `/cal/*` skips sign-in while everything else requires it.
new cloudflare.ZeroTrustAccessApplication("calendar-feed", {
  accountId,
  name: "Mise calendar feed",
  type: "self_hosted",
  domain: `${hostname}/cal/*`,
  policies: [{ id: calendarFeedBypass.id, precedence: 1 }],
});

// The custom domain needs the Worker to exist, and `wrangler deploy` needs the bucket, so a brand-new
// deployment binds its hostname on a second `pulumi up` once the Worker is up (CI does this).
// The custom domain also creates the hostname's DNS record, so Pulumi owns DNS through it.
const domain = (await workerExists())
  ? new cloudflare.WorkersCustomDomain("hostname", { accountId, hostname, service: WORKER_NAME, zoneName: zone })
  : undefined;

/** For CI: who wrangler deploys as, and the secrets it uploads with the Worker. */
export const cloudflareAccountId = pulumi.secret(accountId);
export const workerSecrets = pulumi.secret(
  pulumi.all([app.aud, sentryDsn]).apply(([aud, dsn]) => ({
    ACCESS_TEAM_DOMAIN: accessTeamDomain,
    ACCESS_AUD: aud,
    ...(dsn ? { SENTRY_DSN: dsn } : {}),
  })),
);
export const hostnameBound = domain !== undefined;

/**
 * Whether the Worker has been deployed, asked of the Cloudflare API with the provider's token.
 * Anything but a clear yes or no fails the update: guessing "no" would unbind a live hostname.
 */
async function workerExists(): Promise<boolean> {
  const configured = new pulumi.Config("cloudflare").getSecret("apiToken");
  const token = configured ? await secretValue(configured) : process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("Set CLOUDFLARE_API_TOKEN so Pulumi can reach Cloudflare");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${WORKER_NAME}/settings`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (response.ok) return true;
  // Deleting the Worker therefore also unbinds its hostname on the next update.
  if (response.status === 404) return false;
  throw new Error(`Could not tell whether the ${WORKER_NAME} Worker exists: HTTP ${response.status}`);
}

function secretValue(secret: pulumi.Output<string>): Promise<string> {
  return new Promise((resolve) => secret.apply(resolve));
}
