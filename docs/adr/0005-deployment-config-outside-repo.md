# Deployment configuration lives outside the repo

Mise is open source and serves one household per deployment. Every deployment-specific value (hostname, Cloudflare zone, Access email list or domain, secrets) therefore lives in Pulumi Cloud: state in the Pulumi Cloud backend, configuration and secrets in Pulumi ESC environments. None of it is committed. The repo ships only `Pulumi.example.yaml` documenting the settings, plus placeholders like `mise.example.com`. CI authenticates with a single `PULUMI_ACCESS_TOKEN` secret and runs `pulumi up` as in SPEC.md.

Pulumi also owns the Worker's custom-domain binding, so `wrangler.toml` contains no hostname or zone. Household data (Members, Constraints) is never config: it is created through a first-run setup screen and lives only in the household Durable Object. Local development and the backup round-trip test use a clearly fictional sample household.

## Considered Options

- Local `file://` Pulumi backend with gitignored stack files: rejected because CI could not run `pulumi up`.
