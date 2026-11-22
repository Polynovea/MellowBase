import { bindTokenToAgent, findBoundAgent, insertAgentIdentity, insertAgentProvenance, listAgentIdentities as listAgentIdentityRows } from "@/lib/developer/governanceData";
import { sha256Canonical } from "@/lib/intelligence/operationalCanonical";
import { evaluateAgentToolAccess, getAgentToolDefinition, type AgentOperationClass } from "@/lib/developer/agentToolRegistry";

export interface AgentIdentityRecord {
  id: string;
  workspace_id: string;
  agent_key: string;
  name: string;
  status: "active" | "suspended" | "revoked";
  default_mode: "draft_only" | "scoped";
  provider: string | null;
  model: string | null;
  metadata_json: Record<string, unknown>;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export async function listAgentIdentities(workspaceId: string) {
  return listAgentIdentityRows(workspaceId);
}

export async function createAgentIdentity(params: {
  workspaceId: string;
  actorId: string;
  agentKey: string;
  name: string;
  provider?: string | null;
  model?: string | null;
  defaultMode?: "draft_only" | "scoped";
  metadata?: Record<string, unknown>;
}) {
  const agentKey = params.agentKey.trim().toLowerCase();
  const name = params.name.trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(agentKey)) throw new Error("Agent key is invalid");
  if (!name) throw new Error("Agent name is required");

  return insertAgentIdentity({
    workspace_id: params.workspaceId,
    agent_key: agentKey,
    name,
    status: "active",
    default_mode: params.defaultMode ?? "draft_only",
    provider: params.provider?.trim() || null,
    model: params.model?.trim() || null,
    metadata_json: params.metadata ?? {},
    created_by: params.actorId,
    updated_by: params.actorId,
  }, (data) => ({
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorId,
    action: "agent.identity.created",
    entityType: "agent_identity",
    entityId: data.id,
    metadata: { agentKey, defaultMode: data.default_mode, provider: data.provider, model: data.model },
  }));
}

export async function bindDeveloperTokenToAgent(params: {
  workspaceId: string;
  actorId: string;
  tokenId: string;
  agentIdentityId: string;
}) {
  return bindTokenToAgent(params);
}

export async function resolveBoundAgent(params: { workspaceId: string; tokenId: string }) {
  return findBoundAgent(params);
}

export async function authorizeBoundAgentTool(params: {
  workspaceId: string;
  tokenId: string;
  toolName: string;
  initiatingAdminUserId?: string | null;
}) {
  const bound = await resolveBoundAgent({ workspaceId: params.workspaceId, tokenId: params.tokenId });
  if (!bound) return { allowed: false as const, code: "AGENT_IDENTITY_REQUIRED", bound: null, tool: getAgentToolDefinition(params.toolName) };
  const access = evaluateAgentToolAccess({
    toolName: params.toolName,
    tokenScopes: Array.isArray(bound.token.scopes) ? bound.token.scopes.map(String) : [],
    agentDefaultMode: bound.agent.default_mode,
    initiatingAdminUserId: params.initiatingAdminUserId ?? null,
  });
  return { ...access, bound };
}

export async function recordAgentOperationProvenance(params: {
  workspaceId: string;
  agentIdentityId: string;
  developerApiTokenId?: string | null;
  initiatingAdminUserId?: string | null;
  requestId: string;
  toolName: string;
  operationClass?: AgentOperationClass;
  status: "requested" | "allowed" | "blocked" | "approval_required" | "succeeded" | "failed";
  modelProvider?: string | null;
  modelName?: string | null;
  sourceContext?: Array<Record<string, unknown>>;
  changedFields?: string[];
  beforeJson?: unknown;
  afterJson?: unknown;
  safeInputSummary?: unknown;
  approvalReferenceType?: string | null;
  approvalReferenceId?: string | null;
  operationalPlanId?: string | null;
  simulationRunId?: string | null;
  evidencePackageId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const definition = getAgentToolDefinition(params.toolName);
  const operationClass = params.operationClass ?? definition?.operationClass;
  if (!operationClass) throw new Error(`Unknown agent tool provenance class: ${params.toolName}`);
  if (operationClass !== "read" && !params.initiatingAdminUserId) throw new Error("Agent mutations require an initiating admin user");

  return insertAgentProvenance({
    workspace_id: params.workspaceId,
    agent_identity_id: params.agentIdentityId,
    developer_api_token_id: params.developerApiTokenId ?? null,
    initiating_admin_user_id: params.initiatingAdminUserId ?? null,
    request_id: params.requestId,
    tool_name: params.toolName,
    operation_class: operationClass,
    status: params.status,
    model_provider: params.modelProvider ?? null,
    model_name: params.modelName ?? null,
    source_context_json: params.sourceContext ?? [],
    changed_fields: [...new Set(params.changedFields ?? [])],
    before_json: params.beforeJson ?? null,
    after_json: params.afterJson ?? null,
    input_digest_sha256: params.safeInputSummary === undefined ? null : sha256Canonical(params.safeInputSummary),
    approval_reference_type: params.approvalReferenceType ?? null,
    approval_reference_id: params.approvalReferenceId ?? null,
    operational_plan_id: params.operationalPlanId ?? null,
    simulation_run_id: params.simulationRunId ?? null,
    evidence_package_id: params.evidencePackageId ?? null,
    metadata_json: params.metadata ?? {},
  });
}

export async function recordBoundAgentMutation(params: { context: { agentIdentityId: string | null; tokenId: string; workspaceId: string; actorAdminUserId: string | null; requestId: string; agentToolName: string | null }; toolName: string; changedFields?: string[]; beforeJson?: unknown; afterJson?: unknown; safeInputSummary?: unknown; operationalPlanId?: string | null; simulationRunId?: string | null; evidencePackageId?: string | null }) {
  if (!params.context.agentIdentityId) return null;
  return recordAgentOperationProvenance({
    workspaceId: params.context.workspaceId, agentIdentityId: params.context.agentIdentityId, developerApiTokenId: params.context.tokenId,
    initiatingAdminUserId: params.context.actorAdminUserId, requestId: params.context.requestId, toolName: params.toolName,
    status: "succeeded", changedFields: params.changedFields, beforeJson: params.beforeJson, afterJson: params.afterJson,
    safeInputSummary: params.safeInputSummary, operationalPlanId: params.operationalPlanId, simulationRunId: params.simulationRunId, evidencePackageId: params.evidencePackageId,
  });
}
