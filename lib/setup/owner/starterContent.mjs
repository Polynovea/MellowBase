/**
 * The starter content (a "Starter Article" model and a draft "Welcome to Polynovea" entry), shared by
 * `npm run seed:starter` (scripts/seed-starter.mjs, through the CMS API) and the setup wizard (after
 * the owner is committed, through the services directly: lib/setup/owner/starterJob.ts).
 *
 * Idempotent: an existing model (api key `starter_article`) or entry (slug `welcome-to-polynovea`) is
 * reused, so a retry after a partial failure finishes the job instead of duplicating it.
 */

export const STARTER_MODEL_API_KEY = "starter_article";
export const STARTER_ENTRY_SLUG = "welcome-to-polynovea";

export const STARTER_MODEL = Object.freeze({
  description: "Starter publishable article model created by the OSS onboarding command.",
  icon: "FileText",
  schema: {
    apiKey: STARTER_MODEL_API_KEY,
    name: "Starter Article",
    capability: "publishable",
    fields: [
      { key: "title", label: "Title", type: "text", required: true, localized: false, unique: false, index: true },
      { key: "slug", label: "Slug", type: "slug", required: true, localized: false, unique: true, generatedFrom: "title" },
      { key: "summary", label: "Summary", type: "long_text", required: false, localized: false, unique: false },
      { key: "body", label: "Body", type: "rich_text", required: false, localized: false, unique: false },
    ],
  },
});

export const STARTER_ENTRY_DATA = Object.freeze({
  title: "Welcome to Polynovea",
  slug: STARTER_ENTRY_SLUG,
  summary: "Your first structured entry is ready to edit, review and publish.",
  body: {
    type: "document",
    version: 1,
    content: [
      { type: "heading", level: 2, text: "Your CMS is ready" },
      { type: "paragraph", text: "Use this entry to explore the editorial workflow, preview, releases and the scoped delivery API." },
    ],
  },
});

/**
 * Creates whatever of the starter content is missing, through `api`:
 *   listModels() → models with `api_key`; createModel({description, icon, schema}) → the model;
 *   listEntries(modelId) → entries with `data.slug`; createEntry({modelId, data, changeSummary}) → the entry.
 */
export async function seedStarterContent(api, { changeSummary = "Created by the OSS starter-content command" } = {}) {
  const models = (await api.listModels()) || [];
  let model = models.find((candidate) => candidate.api_key === STARTER_MODEL_API_KEY);
  let modelCreated = false;
  if (!model) {
    model = await api.createModel(structuredClone(STARTER_MODEL));
    modelCreated = true;
  }
  if (!model?.id) throw new Error("Starter model creation did not return a model identifier.");

  const entries = (await api.listEntries(model.id)) || [];
  let entry = entries.find((candidate) => candidate.data?.slug === STARTER_ENTRY_SLUG);
  let entryCreated = false;
  if (!entry) {
    entry = await api.createEntry({ modelId: model.id, data: structuredClone(STARTER_ENTRY_DATA), changeSummary });
    entryCreated = true;
  }
  if (!entry?.id) throw new Error("Starter entry creation did not return an entry identifier.");

  return {
    model: { id: model.id, apiKey: STARTER_MODEL_API_KEY, created: modelCreated },
    entry: { id: entry.id, slug: STARTER_ENTRY_SLUG, created: entryCreated, status: entry.status },
  };
}
