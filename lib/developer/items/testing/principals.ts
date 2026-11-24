// Fixture principals and accesses for the items API unit tests.
import { decideModelAccess, type FieldRuleRow, type ModelAccess, type ModelRef, type Principal } from "@/lib/developer/items/access";
import { ARTICLE_SCHEMA, FIXTURE_HASHES, PERSON_SCHEMA } from "@/lib/developer/items/testing/fixtureModels";

export const WS = "00000000-0000-4000-8000-000000000001";
export const ROLE = { owner: "10000000-0000-4000-8000-000000000001", editor: "10000000-0000-4000-8000-000000000002", writer: "10000000-0000-4000-8000-000000000003", viewer: "10000000-0000-4000-8000-000000000004" };

export const ARTICLE: ModelRef = { id: "20000000-0000-4000-8000-000000000001", apiKey: "article", workspaceId: WS, schema: ARTICLE_SCHEMA, schemaHash: FIXTURE_HASHES.article };
export const PERSON: ModelRef = { id: "20000000-0000-4000-8000-000000000002", apiKey: "person", workspaceId: WS, schema: PERSON_SCHEMA, schemaHash: FIXTURE_HASHES.person };

/** editor: cannot read article.secret or person.salary. writer: title is read-only, secret write-only-not-readable. */
export const RULES: FieldRuleRow[] = [
  { field_key: "secret", role_id: ROLE.editor, can_read: false, can_write: false },
  { field_key: "title", role_id: ROLE.writer, can_read: true, can_write: false },
  { field_key: "secret", role_id: ROLE.writer, can_read: false, can_write: true },
  { field_key: "salary", role_id: ROLE.editor, can_read: false, can_write: false },
];

export function tokenPrincipal(over: Partial<Principal> = {}): Principal {
  return {
    workspaceId: WS,
    kind: "token",
    roleIds: [ROLE.editor],
    roleKeys: ["editor"],
    scopes: new Set(["content.read", "content.write", "content.delete"]),
    allowedModels: null,
    applyModelPolicy: true,
    ...over,
  };
}

export function accessesFor(principal: Principal, rules: FieldRuleRow[] = RULES): ModelAccess[] {
  return [decideModelAccess(principal, ARTICLE, rules), decideModelAccess(principal, PERSON, rules)];
}
