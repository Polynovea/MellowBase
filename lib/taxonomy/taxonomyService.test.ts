import { describe, it, expect, vi } from "vitest";
import { mergeTerms } from "@/lib/taxonomy/taxonomyService";

vi.mock("@/lib/platform/audit", () => ({
  logPlatformEvent: vi.fn().mockResolvedValue(undefined),
}));

// The atomic merge itself (cms_merge_taxonomy_terms) is covered by taxonomyService.dual.test.ts.
describe("Taxonomy Service", () => {
  it("rejects merge into self", async () => {
    await expect(
      mergeTerms({
        workspaceId: "ws-1",
        actorAdminUserId: "user-1",
        sourceTermId: "term-1",
        targetTermId: "term-1",
      })
    ).rejects.toThrow("Cannot merge a term into itself");
  });

});
