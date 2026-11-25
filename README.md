# MellowBase

MellowBase is an open-source, self-hosted content and data platform by [Polynovea](https://github.com/Polynovea). A team runs it on its own server, keeps its content and structured data in one place, and sends it to every website, app and AI tool it uses.

- **Installs from the browser.** A one-time setup code protects a first-run wizard that connects the database, creates the owner with two-step sign-in and opens the admin. No terminal needed after the server starts.
- **Real tables, typed code.** Every content model is a real PostgreSQL table, changed only through reviewed, plain-words migration plans that keep the site online. Developers get a per-model API and TypeScript types generated from their own models.
- **AI agents with rules.** AI tools connect over MCP with their own identity and permissions, down to single fields, and their changes go through the same approvals as anyone's.
- **Runs itself.** Daily backups with a monthly restore test, a System Doctor, and signed one-click upgrades that switch back on their own if the new version is unhealthy.
- **Your cloud, your data.** One package on your own server, on PostgreSQL 15, 16 or 17: on the same server, Amazon RDS or Azure Database for PostgreSQL. Polynovea never holds your data.

It ships with a browser admin, a typed REST API, a TypeScript SDK, a CLI, an MCP server and governed extensions, under the MIT licence.

> MellowBase was previously published as **Polynovea CMS** (repository `Polynovea/OSS1`; old links redirect here). Package names, environment variables (`POLYNOVEA_*`, `CMS_*`) and CLI commands keep those names, so existing installs and scripts keep working.

## What's inside

| Area | What you get |
| --- | --- |
| Content | Content models with text, rich text, media, dates, choices, relations and repeating sections; versions and restore; private previews; translations |
| Workflow | Review steps, releases published together now or on a schedule, a content calendar |
| Quality | SEO and social card checks, structured data, broken links, image sizes, a content health view |
| Delivery | A per-model REST API, webhooks with retries, sitemaps, redirects and menus |
| Data | Real PostgreSQL tables per model, safe schema changes (lock timeouts, background index builds, expand-and-contract renames), deletion as a separate confirmed step |
| Security | Built-in sign-in (passkeys, authenticator apps, recovery codes, breached-password check), two-step sign-in for owners and admins, field-level permissions applied everywhere, an audit log |
| Operations | Setup wizard, backups to S3 or Azure Blob, monthly restore tests, System Doctor, signed upgrades with automatic switch-back |
| Developers | `@polynovea/cms-sdk`, `@polynovea/cms-cli`, `@polynovea/cms-mcp`, OpenAPI, and a sample Next.js site |

## Install

MellowBase runs as one container image (the app, its background workers and an optional bundled PostgreSQL) on a single Linux server. There are three ways to run it.

### 1. One-click cloud templates

Templates for AWS (CloudFormation), Azure (Bicep) and OpenTofu create the server, its database and storage in your own cloud account, show the expected monthly cost first, and accept only Polynovea's signed release image. See [deploy/README.md](deploy/README.md), [AWS](deploy/aws/README.md), [Azure](deploy/azure/README.md) and [OpenTofu](deploy/opentofu/README.md).

The templates are filled in with the signed image and server images at release time ([deploy/release-images.json](deploy/release-images.json)). Until the first signed release is published, use the container route below with an image you build yourself.

### 2. The container on your own server

Build the image (or use a released one), then start it with Docker Compose. Two routes reach the setup wizard safely:

- **SSH tunnel**, no domain needed: the app listens on the server's loopback only and you open it through `ssh -L`.
- **HTTPS through the bundled Caddy**, with your own domain and an automatic Let's Encrypt certificate.

```bash
docker buildx build --platform linux/amd64 -t polynovea-cms:local .
POLYNOVEA_IMAGE=polynovea-cms:local docker compose -f docker/compose.yaml --profile tunnel up -d
```

Then open the address in `POLYNOVEA_PUBLIC_URL` (for the tunnel, `http://localhost:3000` through `ssh -L 3000:127.0.0.1:3000 you@your-server`) and enter the setup code from the server log. Full guide: [Running MellowBase from the server image](docs/self-hosting/container.md).

### 3. From source, for development

Requirements: Node.js 24.7 or later, and Docker for the local PostgreSQL stack.

```bash
npm ci
node scripts/dev-db/setup.mjs          # starts PostgreSQL in Docker and writes .env.test.local
npm run db:migrate
npm run dev
```

Copy `.env.example` to `.env.local` for your own settings. `npm run bootstrap:admin` creates the first owner from the command line instead of the wizard, and `npm run seed:starter` adds a starter model and a welcome draft. Run the background workers as persistent processes:

```bash
npm run worker:delivery   # publishing, schedules, webhooks, indexing, health checks
npm run worker:schema     # applies content-model changes to their tables
```

## Setup and self-hosting guides

- [Setup wizard](docs/self-hosting/setup/README.md): [setup code](docs/self-hosting/setup/setup-code.md), [database step](docs/self-hosting/setup/database.md), [owner step](docs/self-hosting/setup/owner.md), [modes and keys](docs/self-hosting/setup/modes-and-keys.md)
- [Built-in sign-in](docs/self-hosting/BUILT_IN_AUTH.md)
- [PostgreSQL](docs/self-hosting/POSTGRESQL.md) and [storage](docs/self-hosting/STORAGE.md)
- [Upgrades and rollback](docs/self-hosting/upgrades.md)
- [VM images](docs/self-hosting/vm-images.md) and [release signing](docs/self-hosting/release-signing.md)

## For developers

Pull TypeScript types for your own models, then use the typed client:

```bash
POLYNOVEA_CMS_TOKEN=pnv_... npm run cms -- types pull --url https://cms.example.com
```

```ts
import { createCmsClient } from "@polynovea/cms-sdk";
import { schema, type Models } from "./polynovea-cms";

const cms = createCmsClient<Models>({ baseUrl: "https://cms.example.com", token: process.env.POLYNOVEA_CMS_TOKEN!, schema });

const { data } = await cms.items("article").list({
  filter: { and: [{ rating: { gt: 3 } }, { author: { name: { eq: "Asha" } } }] },
  sort: ["-published_on"],
  expand: ["author"],
});
```

- **`/api/v1/models/{model}/items`**: one API per model, with filters, sorting, cursor paging and related records. Published content by default; drafts only with a preview token or permission.
- **Per-caller documents:** `/api/v1/openapi.json` and `/api/v1/types.ts` list only the models and fields the token can read. A field the caller cannot read behaves exactly like one that does not exist, in results, filters, sorting, search and expansion.
- **Drift checks:** `polynovea-cms types pull --check` fails a build when the types are out of date, and the SDK warns before a model change would break your app.
- **Limits per role:** page size, filter depth, joins and query time are capped, and a workspace can lower them per role.
- **[`packages/cms-sdk`](packages/cms-sdk)** (build with `npm run sdk:build`), **[`packages/cms-cli`](packages/cms-cli)** (`npm run cms -- --help`), **[`packages/cms-mcp`](packages/cms-mcp)** for AI assistants, and **[`examples/nextjs-site`](examples/nextjs-site)**, a sample website built against the generated types.
- Extensions declare permissions, routes, events and allowed network origins, and need a workspace administrator's approval. See [extension manifests](docs/extensions/MANIFEST.md).

MellowBase is headless: it does not impose a public-site theme. Your own sites and apps display the content.

## Security

- The running app uses a limited database role that can read and write rows but cannot create, change or drop tables; schema changes run in a separate worker that rebuilds every plan from trusted data.
- Database connections use full certificate checks; secrets saved in the admin are encrypted with keys kept outside the database.
- One permission check covers the API, search, exports, releases, webhooks, previews and AI agents.
- Releases are signed with cosign and ship with an SBOM; upgrades verify the signature and never downgrade.

Known limitation: inside the container, the CMS process can reach the database owner login (and, with the bundled database, superuser access over the local socket). Running the web process, schema worker and PostgreSQL as separate operating-system users is the next change. See [container.md](docs/self-hosting/container.md#security-what-the-cms-process-can-reach-today).

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Testing

Everything runs locally; no hosted CI is required.

```bash
npx tsc --noEmit
npm run lint
npm test                      # unit tests
node scripts/dev-db/setup.mjs --pg=16 --reset
npm run test:dual             # database tests against the local stack
npm run build
npm audit --omit=dev
```

`scripts/certify-all.mjs` runs the 26 certification suites against a running app on built-in sign-in, and `scripts/image/run-smoke.sh` tests the container image end to end. Each release is tested on PostgreSQL 15, 16 and 17.

## Project

- [Upgrade design](docs/Upgrade%20Plans/Polynovea%20CMS%20Self-Hosted%20Platform%20Upgrade%20Design.md) and [implementation plan](docs/Upgrade%20Plans/Polynovea%20CMS%20Upgrade%20Implementation%20Plan.md), with the progress of each phase
- [CHANGELOG.md](CHANGELOG.md), [ROADMAP.md](ROADMAP.md)
- [Operations runbooks](docs/operations/RUNBOOKS.md)
- [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [SUPPORT.md](SUPPORT.md)

MIT licensed. Copyright Polynovea.
