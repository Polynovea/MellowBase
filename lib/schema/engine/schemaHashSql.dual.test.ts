// Migration 0075's canonical JSON in SQL must give exactly the app's schema hash (hashModelSchema):
// the certification scripts compute model hashes in SQL with it (Phase 4 follow-up).
import { describe, expect, it } from "vitest";
import pg from "pg";
import { hashModelSchema } from "@/lib/schema/engine/hash";
import type { CanonicalSchema } from "@/lib/schema/fields/types";

const field = (key: string, type: string, extra: Record<string, unknown> = {}) => ({ key, label: key, type, required: false, localized: false, unique: false, ...extra });
const SCHEMAS = [
  { name: "Phase 5 Collaboration Record", apiKey: "phase5_collab_cert", description: "Certification record for assignments, reviews, comments, and calendar", capability: "content_enabled",
    fields: [field("title", "text", { label: "Title", required: true }), field("notes", "long_text", { label: "Notes" })] },
  { name: "Landing Page", apiKey: "landing_page_cert", description: "Canonical landing page", capability: "publishable",
    fields: [field("title", "text", { required: true }), field("slug", "slug", { required: true, unique: true }), field("seo_description", "long_text"), field("experience", "component")] },
  { name: "Phase 5 Verification Record", apiKey: "phase5_verification", description: "Isolated, reusable fixture — with “quotes”, é and 1.5e3", capability: "content_enabled",
    fields: [field("title", "text", { required: true, validation: { maxLength: 200, min: 1.5 } })] },
];

describe("0075 SQL schema hash equals the app's hash [postgres]", () => {
  it("for the certification scripts' schemas", async () => {
    const client = new pg.Client({ connectionString: process.env.POLYNOVEA_TEST_POSTGRES_URL, ssl: false });
    await client.connect();
    try {
      for (const schema of SCHEMAS) {
        const { rows: [row] } = await client.query<{ hash: string }>(
          "select encode(sha256(convert_to(public.polynovea_canonical_json($1::jsonb), 'UTF8')), 'hex') as hash", [JSON.stringify(schema)]);
        expect(row.hash).toBe(hashModelSchema(schema as unknown as CanonicalSchema));
      }
    } finally {
      await client.end();
    }
  });
});
