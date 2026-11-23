import { describe, expect, it } from "vitest";
import { describeBothBackends, type BackendFixtures } from "@/lib/db/testing/dualBackend";
import { createRecorder } from "@/lib/db/testing/compare";
import { createEntry } from "@/lib/content/entryService";
import {
  assignRelease,
  createRelease,
  getRelease,
  getReleaseReadiness,
  listReleases,
  processDueReleases,
  publishRelease,
  replaceReleaseItems,
  setReleaseLocales,
  transitionRelease,
} from "@/lib/content/releaseService";
import { createCalendarEvent, listCalendarEvents } from "@/lib/content/calendarService";
import { createModel } from "@/lib/schema/modelService";

// Releases pin entry versions and read their models: content and schema switch together.
const recorder = createRecorder();

async function approvedEntries(backend: BackendFixtures, count: number) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  await backend.query("insert into workspace_members (workspace_id, admin_user_id) values ($1, $2)", [workspaceId, adminUserId]);
  const model = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Post", apiKey: "post", fields: [{ key: "title", label: "Title", type: "text", required: true }] } });
  if (!model.ok) throw new Error(model.error);
  const versions: string[] = [];
  const entries: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const created = await createEntry({ workspaceId, modelId: model.data.model.id, data: { title: `Post ${n}` }, actorAdminUserId: adminUserId });
    if (!created.ok) throw new Error(created.error);
    await backend.query("update content_entries set status = 'approved' where id = $1", [created.data.entry.id]);
    await backend.query("insert into content_routes (workspace_id, entry_id, path, locale, is_canonical) values ($1, $2, $3, 'en', true)", [workspaceId, created.data.entry.id, `/post-${n}`]);
    versions.push(created.data.version.id);
    entries.push(created.data.entry.id);
  }
  return { workspaceId, adminUserId, versions, entries, modelId: model.data.model.id };
}

const stable = (value: unknown) => JSON.parse(JSON.stringify(value), (key, v) => (["created_at", "updated_at", "scheduled_for", "approved_at", "published_at", "execution_started_at"].includes(key) && v ? "<t>" : v));

describeBothBackends(["content", "schema"], "content releases and the editorial calendar", (backend) => {
  it("creates a release and reads it back with every child relation in the same shape", async () => {
    const { workspaceId, adminUserId, versions, entries } = await approvedEntries(backend, 2);
    await backend.query("insert into workspace_locales (workspace_id, locale, enabled, required, is_default) values ($1, 'en', true, true, true)", [workspaceId]);
    const created = await createRelease({ workspaceId, actorId: adminUserId, name: " Launch ", description: "Spring", itemVersionIds: [versions[0], versions[0]] });
    if (!created.ok) throw new Error(created.error);
    const releaseId = (created.data as { id: string }).id;
    expect(await replaceReleaseItems({ workspaceId, actorId: adminUserId, releaseId, itemVersionIds: versions })).toMatchObject({ ok: true });
    expect(await setReleaseLocales({ workspaceId, actorId: adminUserId, releaseId, locales: ["en"] })).toMatchObject({ ok: true });
    expect(await assignRelease({ workspaceId, actorId: adminUserId, releaseId, assigneeId: adminUserId, role: "reviewer", note: "please" })).toMatchObject({ ok: true });
    expect(await assignRelease({ workspaceId, actorId: adminUserId, releaseId, assigneeId: adminUserId, role: "reviewer", dueAt: "soon" })).toMatchObject({ ok: false, status: 400 });

    const release = await getRelease(workspaceId, releaseId);
    expect(release).toMatchObject({ id: releaseId, name: "Launch", status: "draft", workspace_id: workspaceId });
    expect(release.release_items.map((item: { entry_id: string }) => item.entry_id).sort()).toEqual([...entries].sort());
    expect(release.release_items[0].content_entries).toMatchObject({ status: "approved", content_models: { api_key: "post" } });
    expect(release.release_items[0].content_entry_versions).toMatchObject({ locale: "en", version_number: 1 });
    expect(release.release_locale_targets).toEqual([expect.objectContaining({ locale: "en", required: true })]);
    expect(release.release_assignments).toEqual([expect.objectContaining({ role: "reviewer", note: "please" })]);
    expect(release.release_history.length).toBeGreaterThan(0);
    expect(Object.keys(release).sort()).toEqual(expect.arrayContaining(["release_approvals", "release_assignments", "release_history", "release_items", "release_locale_targets", "release_rollback_items"]));

    const listed = await listReleases(workspaceId);
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0].release_items[0]).sort()).toEqual(["delivery_error", "delivery_status", "entry_id", "entry_version_id", "id"]);
    expect(await getRelease(workspaceId, "not-a-uuid")).toBeNull();

    const sortItems = (r: { release_items: Array<{ entry_id: string }> }) => ({ ...r, release_items: [...r.release_items].sort((x, y) => x.entry_id.localeCompare(y.entry_id)) });
    recorder.record(backend.name, "release detail", { keys: Object.keys(release).sort(), itemKeys: Object.keys(release.release_items[0]).sort(), entryKeys: Object.keys(release.release_items[0].content_entries).sort(), versionKeys: Object.keys(release.release_items[0].content_entry_versions).sort(), listedKeys: Object.keys(listed[0]).sort(), detail: stable(sortItems(release)).release_locale_targets });
  });

  it("checks readiness, approves, schedules, publishes due releases and refuses bad input", async () => {
    const { workspaceId, adminUserId, versions, entries } = await approvedEntries(backend, 1);
    expect(await createRelease({ workspaceId, actorId: adminUserId, name: " ", itemVersionIds: versions })).toMatchObject({ ok: false, status: 400 });
    expect(await createRelease({ workspaceId, actorId: adminUserId, name: "Empty", itemVersionIds: [] })).toMatchObject({ ok: false, status: 400 });
    const created = await createRelease({ workspaceId, actorId: adminUserId, name: "Ship", itemVersionIds: versions });
    if (!created.ok) throw new Error(created.error);
    const releaseId = (created.data as { id: string }).id;

    const readiness = await getReleaseReadiness(workspaceId, releaseId);
    if (!readiness.ok) throw new Error(readiness.error);
    expect(readiness.data.itemReports).toEqual([expect.objectContaining({ entryId: entries[0], versionId: versions[0], locale: "en", drifted: false })]);
    recorder.record(backend.name, "readiness", { ...readiness.data, itemReports: readiness.data.itemReports.map((report) => ({ ...report, preflight: report.preflight?.status })) });

    if (readiness.data.status === "ready") {
      expect(await transitionRelease({ workspaceId, actorId: adminUserId, releaseId, action: "schedule", scheduledFor: "nope" })).toMatchObject({ ok: false });
      expect(await transitionRelease({ workspaceId, actorId: adminUserId, releaseId, action: "approve" })).toMatchObject({ ok: true });
      expect(await transitionRelease({ workspaceId, actorId: adminUserId, releaseId, action: "schedule", scheduledFor: new Date(Date.now() + 60_000).toISOString() })).toMatchObject({ ok: true });
      await backend.query("update releases set scheduled_for = now() - interval '1 minute' where id = $1", [releaseId]);
      const processed = await processDueReleases({ workspaceId, actorId: adminUserId });
      expect(processed).toMatchObject({ processed: 1 });
      recorder.record(backend.name, "processed", processed);
    } else {
      expect(await publishRelease({ workspaceId, actorId: adminUserId, releaseId })).toMatchObject({ ok: false, status: 409 });
    }
    // Errors from the lifecycle functions are mapped to the same statuses on both paths.
    expect(await transitionRelease({ workspaceId, actorId: adminUserId, releaseId: "00000000-0000-0000-0000-000000000000", action: "cancel" })).toMatchObject({ ok: false, status: 404 });
  });

  it("schedules calendar events and keeps everything in one workspace", async () => {
    const a = await approvedEntries(backend, 1);
    const b = await backend.createWorkspace();
    const release = await createRelease({ workspaceId: a.workspaceId, actorId: a.adminUserId, name: "R", itemVersionIds: a.versions });
    if (!release.ok) throw new Error(release.error);
    const releaseId = (release.data as { id: string }).id;
    const event = await createCalendarEvent({ workspaceId: a.workspaceId, actorId: a.adminUserId, title: " Go live ", kind: "release", startsAt: "2030-01-01T09:00:00Z", releaseId, entryId: a.entries[0] });
    expect(event).toMatchObject({ title: "Go live", kind: "release", release_id: releaseId });
    expect((await listCalendarEvents(a.workspaceId, "2029-12-31T00:00:00Z", "2030-01-02T00:00:00Z")).map((e: { id: string }) => e.id)).toEqual([event.id]);
    expect(await listCalendarEvents(a.workspaceId, "2031-01-01T00:00:00Z")).toEqual([]);
    await expect(createCalendarEvent({ workspaceId: b.workspaceId, actorId: b.adminUserId, title: "x", kind: "release", startsAt: "2030-01-01T00:00:00Z", releaseId })).rejects.toThrow("Release not found in this workspace");
    await expect(createCalendarEvent({ workspaceId: a.workspaceId, actorId: a.adminUserId, title: "x", kind: "publish", startsAt: "2030-01-02T00:00:00Z", endsAt: "2030-01-01T00:00:00Z" })).rejects.toThrow("End time");

    expect(await listReleases(b.workspaceId)).toEqual([]);
    expect(await getRelease(b.workspaceId, releaseId)).toBeNull();
    expect(await getReleaseReadiness(b.workspaceId, releaseId)).toMatchObject({ ok: false, status: 404 });
    expect(await replaceReleaseItems({ workspaceId: b.workspaceId, actorId: b.adminUserId, releaseId, itemVersionIds: a.versions })).toMatchObject({ ok: false });
    expect(await listCalendarEvents(b.workspaceId)).toEqual([]);
    expect(await backend.query("select 1 from platform_audit_events where workspace_id = $1 and action = 'editorial.calendar.scheduled'", [a.workspaceId])).toHaveLength(1);
  });
});

describe("release backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
