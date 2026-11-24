import type { CanonicalSchema, ModelOperation } from "@/lib/schema/fields/types";

/**
 * The model-level policy rule itself (pure), shared by canActorOperateModel and the items API's
 * resolveModelAccess so there is one copy: no policy rows keep the workspace default; otherwise one of
 * the role keys must be granted the operation.
 */
export function modelPolicyAllows(schema: Pick<CanonicalSchema, "permissions">, roleKeys: readonly string[], operation: ModelOperation): boolean {
  const policies = schema.permissions ?? [];
  if (policies.length === 0) return true;
  return policies.some((policy) => roleKeys.includes(policy.role) && policy.operations.includes(operation));
}
