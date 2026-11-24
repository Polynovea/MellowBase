# @polynovea/cms-cli

CLI for the stable Polynovea CMS Developer API.

## Requirements

- Node.js 22 or later (`engines.node` is `>=22`). The CLI is a single ESM script that uses Node's built-in `fetch`; it has no npm dependencies and no build step.
- A running Polynovea CMS instance. Set its origin with `POLYNOVEA_CMS_URL` or `--url`. If neither is set, the CLI uses `http://localhost:3000`.
- A Developer API token (`pnv_...`) in `POLYNOVEA_CMS_TOKEN` or `--token`. The CLI exits with an error if it is missing. Create it in the admin under **Developer** (`/admin/developer`) with the scopes for the commands you run (for example `schema.read` for `schema pull`, `content.write` for `entries create`). Write commands are audited against the admin who created the token, and fail with `TOKEN_ACTOR_UNAVAILABLE` if the token no longer has a recorded creator.

From this repository, run it without installing: `node packages/cms-cli/bin/polynovea-cms.mjs --help`.

## Types for the typed SDK

```bash
export POLYNOVEA_CMS_TOKEN=pnv_...                      # schema.read
polynovea-cms types pull --url https://cms.example.com   # writes ./polynovea-cms.ts
polynovea-cms types pull --url https://cms.example.com --check
```

- `--out <file>` chooses the file (default `polynovea-cms.ts`).
- `--check` writes nothing: exit 0 when the file is current, 1 when it is out of date or missing (it
  names the models that changed), 2 when it could not check (auth, network, not a types file). Use it
  in your local CI.
- The token comes only from `POLYNOVEA_CMS_TOKEN` or `--token-file <path>`; `types pull` refuses
  `--token`, which would end up in shell history. The token is never printed or written to the file.
- The URL must be https, except for this machine (`localhost`, `127.0.0.1`, `::1`).

## Usage

```bash
polynovea-cms --help
POLYNOVEA_CMS_URL=https://cms.example.com POLYNOVEA_CMS_TOKEN=pnv_... polynovea-cms schema pull schema.json
```
