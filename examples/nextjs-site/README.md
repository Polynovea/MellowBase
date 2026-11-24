# Next.js delivery example

A minimal site that reads published Polynovea content through the typed SDK
(`@polynovea/cms-sdk`), typed by a generated types file.

## Types

`polynovea-cms.ts` is generated from your CMS's model metadata, for the token that pulls it: it holds
only the models and fields that token can read. The committed copy is generated from the repository's
fixture models (`article`, `person`), so this example builds without a CMS.

For your own install:

```text
POLYNOVEA_CMS_URL=https://cms.example.com
POLYNOVEA_CMS_TOKEN=pnv_...        # schema.read to pull types; content.read to read items
```

```sh
npm install
npm run types:pull      # writes polynovea-cms.ts
npm run dev
```

`npm run build` first runs `types:check`: with `POLYNOVEA_CMS_URL` set it asks the CMS
(`polynovea-cms types pull --check`) and fails when the file is out of date. Without it, the file must
match the repository fixture.

At runtime the SDK sends the hash its types were pulled from, and warns once if the CMS's models have
changed in a breaking way since (a field removed, renamed or retyped). Adding fields does not warn.

Keep the token server-only; never use a `NEXT_PUBLIC_*` variable for it. The URL must be https except
for this machine (`localhost`).
