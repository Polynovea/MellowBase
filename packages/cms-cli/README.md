# @polynovea/cms-cli

CLI for the stable Polynovea CMS Developer API.

## Requirements

- Node.js 22 or later (`engines.node` is `>=22`). The CLI is a single ESM script that uses Node's built-in `fetch`; it has no npm dependencies and no build step.
- A running Polynovea CMS instance. Set its origin with `POLYNOVEA_CMS_URL` or `--url`. If neither is set, the CLI uses `http://localhost:3000`.
- A Developer API token (`pnv_...`) in `POLYNOVEA_CMS_TOKEN` or `--token`. The CLI exits with an error if it is missing. Create it in the admin under **Developer** (`/admin/developer`) with the scopes for the commands you run (for example `schema.read` for `schema pull`, `content.write` for `entries create`). Write commands are audited against the admin who created the token, and fail with `TOKEN_ACTOR_UNAVAILABLE` if the token no longer has a recorded creator.

From this repository, run it without installing: `node packages/cms-cli/bin/polynovea-cms.mjs --help`.

## Usage

```bash
polynovea-cms --help
POLYNOVEA_CMS_URL=https://cms.example.com POLYNOVEA_CMS_TOKEN=pnv_... polynovea-cms schema pull schema.json
```
