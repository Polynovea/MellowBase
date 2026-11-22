# @polynovea/cms-sdk

Typed client for the stable Polynovea CMS `/api/v1` Developer API.

## Requirements

- Node.js 22 or later (`engines.node` is `>=22`). The client uses the global `fetch`, `Headers` and `FormData`, so it also runs in modern browsers and other runtimes that provide them.
- ESM only. The package is `"type": "module"` and exports an `import` entry; there is no CommonJS build, so use `import`, not `require()`.
- A running Polynovea CMS instance. Pass its origin as `baseUrl` (for example `https://cms.example.com`, no `/api/v1` suffix; a trailing slash is stripped).
- A Developer API token (`pnv_...`) passed as `token`. Create it in the admin under **Developer** (`/admin/developer`, needs the `cms.developer` module). Give it the scopes for the calls you make, for example `content.read` for `entries.list`. The SDK sends it as `Authorization: Bearer <token>`. The SDK reads no environment variables; the example below reads the token from one by choice.
- No runtime dependencies.

## Building from this repository

`dist/` is not committed. From the repository root, after `npm install` (the build uses the root `typescript` dev dependency):

```bash
npm run sdk:build
```

## Usage

```ts
import { PolynoveaCmsClient } from "@polynovea/cms-sdk";

const cms = new PolynoveaCmsClient({
  baseUrl: "https://cms.example.com",
  token: process.env.POLYNOVEA_CMS_TOKEN!,
});

const entries = await cms.entries.list({ model: "article" });
```

Failed requests throw `PolynoveaCmsError` with the HTTP `status`, the API error `code`, and the `requestId` when the server returns one.

The SDK uses only the public Developer API and does not import Polynovea server internals.
