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

## Typed items

Pull a types file for your models (`polynovea-cms types pull`, see `@polynovea/cms-cli`). It holds one
set of types per model the token can read, plus a `schema` constant with the schema hashes.

```ts
import { createCmsClient } from "@polynovea/cms-sdk";
import { schema, type Models } from "./polynovea-cms";

const cms = createCmsClient<Models>({ baseUrl: "https://cms.example.com", token: process.env.POLYNOVEA_CMS_TOKEN!, schema });

const { data, meta } = await cms.items("article").list({
  filter: { and: [{ rating: { gt: 3 } }, { author: { name: { eq: "Asha" } } }] },
  sort: ["-published_on", "title"],   // up to three keys
  expand: ["author"],
  limit: 20,
});
// data: Item<ArticleData>[]; meta.page.nextCursor for the next page
for await (const article of cms.items("article").all({ sort: "title" })) { /* every page */ }
await cms.items("article").create({ title: "Hello" });   // drafts only; read-only fields don't type-check
```

- Filters, sort keys, expansion paths and write bodies are checked by TypeScript against what your token
  can read and write. Without generated types, `createCmsClient()` works the same, loosely typed.
- Drafts: pass `preview` (a preview token) in the options or per call, with `variant: "draft"`.
- Errors throw `PolynoveaItemsError` with the API's error `code`, `status`, `requestId` and `retryAfter`.
- Schema drift: the SDK sends the hash its types came from. If the CMS's models changed in a breaking
  way since (a field removed, renamed or retyped, an option removed, a field newly required), it warns
  once per process. Additive changes don't warn. `strictSchema: true` throws `PolynoveaSchemaDriftError`
  instead; `onSchemaChange` receives every change.

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
