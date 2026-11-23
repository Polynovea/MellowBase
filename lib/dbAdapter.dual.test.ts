import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describeBothBackends } from "@/lib/db/testing/dualBackend";
import { createRecorder } from "@/lib/db/testing/compare";

const db = await import("@/lib/dbAdapter");

// The legacy marketing tables are global (no workspace), so each test uses unique slugs and labels
// and only asserts on its own rows.
const recorder = createRecorder();

describeBothBackends(["routes"], "legacy marketing tables adapter", (backend) => {
  it("creates, reads, updates and deletes blog posts", async () => {
    const slug = `post-${randomUUID().slice(0, 8)}`;
    const created = await db.insertDbItem("blog_posts", { title: "Hello", slug, status: "draft" });
    expect(created.error).toBeNull();
    expect(created.data).toMatchObject({ title: "Hello", slug, status: "draft" });
    const id = created.data.id as string;

    expect((await db.getDbItem("blog_posts", id)).data).toMatchObject({ id, slug });
    expect((await db.getDbItemByField("blog_posts", "slug", slug)).data).toMatchObject({ id });
    expect((await db.getDbItems("blog_posts")).data.map((p: { id: string }) => p.id)).toContain(id);
    expect(await db.getDbItem("blog_posts", randomUUID())).toEqual({ data: null, error: null });

    const updated = await db.updateDbItem("blog_posts", id, { title: "Hello again", status: "published", published_at: "2026-01-01T00:00:00+00:00" });
    expect(updated).toMatchObject({ data: { id, title: "Hello again", status: "published" }, error: null });
    expect((await db.updateDbItem("blog_posts", randomUUID(), { title: "x" })).data).toBeNull();

    expect(await db.deleteDbItem("blog_posts", id)).toEqual({ success: true, error: null });
    expect((await db.getDbItem("blog_posts", id)).data).toBeNull();
    recorder.record(backend.name, "blog", { keys: Object.keys(created.data).sort() });
  });

  it("replaces the live metrics, keeping edited ids", async () => {
    const before = await db.getDbItems("live_metrics");
    expect(before.error).toBeNull();
    const first = await db.insertDbItem("live_metrics", { label: "Visitors", value: "10", trend_direction: "up" });
    expect(first.data).toMatchObject({ label: "Visitors", value: "10" });

    const saved = await db.bulkUpsertMetrics([{ id: first.data.id, label: "Visitors", value: "12", trend_direction: "down" }, { id: null, label: "Signups", value: "3" }]);
    expect(saved.error).toBeNull();
    expect(saved.data?.map((m: { label: string; value: string }) => [m.label, m.value])).toEqual([["Visitors", "12"], ["Signups", "3"]]);
    expect(saved.data?.[0].id).toBe(first.data.id);
    const after = await db.getDbItems("live_metrics");
    expect(after.data.map((m: { label: string }) => m.label).sort()).toEqual(["Signups", "Visitors"]);
    recorder.record(backend.name, "metrics", { keys: Object.keys(first.data).sort() });
  });

  it("stores social posts and ad campaigns with numbers and arrays intact", async () => {
    const title = `Reel ${randomUUID().slice(0, 8)}`;
    const post = await db.insertDbItem("social_posts", { entity: "polynovea", title, platform: "Instagram", type: "Reel", posted: "2026-01-02", views: 5, checkpoints: ["done", "future"] });
    expect(post).toMatchObject({ data: { title, posted: "2026-01-02", views: 5, checkpoints: ["done", "future"] }, error: null });
    const campaign = await db.insertDbItem("ad_campaigns", { entity: "polynovea", campaign: title, platform: "Meta Ads", objective: "Reach", budget: 100.5, ctr: 1.25, conversions: 3 });
    expect(campaign).toMatchObject({ data: { campaign: title, budget: 100.5, spend: 0, ctr: 1.25, conversions: 3, status: "ACTIVE" }, error: null });
    await db.deleteDbItem("social_posts", post.data.id);
    await db.deleteDbItem("ad_campaigns", campaign.data.id);
    recorder.record(backend.name, "social", { post: Object.keys(post.data).sort(), campaign: Object.keys(campaign.data).sort() });
  });
});

describe("legacy adapter backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
