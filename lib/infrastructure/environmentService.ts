import * as environmentData from "@/lib/infrastructure/environmentData";
import type { EnvironmentKind, EnvironmentStatus, SecretProviderKind, WorkspaceEnvironmentRow } from "@/lib/infrastructure/types";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeUrl(value?: string | null) {
  const raw=value?.trim()||""; if(!raw) return null;
  const url=new URL(raw); if(!["http:","https:"].includes(url.protocol)) throw new Error("Environment URLs must use HTTP or HTTPS");
  url.hash=""; return url.toString().replace(/\/$/,"");
}
function normalizePublicUrls(values?: unknown) {
  if(!Array.isArray(values)) return [] as string[];
  return [...new Set(values.map(v=>normalizeUrl(String(v))).filter((v):v is string=>Boolean(v)))];
}

export async function listEnvironments(workspaceId:string) {
  const {environments,providers,components,connections}=await environmentData.environmentRows(workspaceId);
  return environments.map((environment)=>({
    ...environment,
    secretProviders:(providers??[]).filter(p=>p.environment_id===environment.id),
    components:(components??[]).filter(c=>c.environment_id===environment.id),
    connectionSummary:{
      total:(connections??[]).filter(c=>c.environment_id===environment.id).length,
      healthy:(connections??[]).filter(c=>c.environment_id===environment.id&&c.status==="active").length,
      degraded:(connections??[]).filter(c=>c.environment_id===environment.id&&["degraded","failed"].includes(c.status)).length,
    },
  }));
}

export async function getEnvironment(workspaceId:string,environmentId:string){
  const all=await listEnvironments(workspaceId);return all.find(e=>e.id===environmentId)??null;
}

export async function createEnvironment(params:{workspaceId:string;actorId:string;key:string;name:string;kind:EnvironmentKind;isDefault?:boolean;cmsBaseUrl?:string|null;publicSiteUrls?:unknown;databaseProvider?:string|null;storageProvider?:string|null;runtimeProvider?:string|null;secretProviderKind?:SecretProviderKind}){
  const key=params.key.trim().toLowerCase();if(!/^[a-z][a-z0-9_-]{0,62}$/.test(key))throw new Error("Environment key must start with a letter and contain only lowercase letters, numbers, _ or -");
  const name=params.name.trim();if(!name)throw new Error("Environment name is required");
  return environmentData.createEnvironment({
    p_workspace_id:params.workspaceId,p_actor_id:params.actorId,p_key:key,p_name:name,p_kind:params.kind,p_is_default:Boolean(params.isDefault),
    p_cms_base_url:normalizeUrl(params.cmsBaseUrl),p_public_site_urls:normalizePublicUrls(params.publicSiteUrls),p_database_provider:params.databaseProvider?.trim()||null,p_storage_provider:params.storageProvider?.trim()||null,p_runtime_provider:params.runtimeProvider?.trim()||null,p_secret_provider_kind:params.secretProviderKind??"encrypted_postgres",
  });
}

export async function updateEnvironment(params:{workspaceId:string;actorId:string;environmentId:string;name:string;status:EnvironmentStatus;isDefault:boolean;cmsBaseUrl?:string|null;publicSiteUrls?:unknown;databaseProvider?:string|null;storageProvider?:string|null;runtimeProvider?:string|null;config?:Record<string,unknown>}){
  const name=params.name.trim();if(!name)throw new Error("Environment name is required");
  if(!UUID.test(params.environmentId))throw Object.assign(new Error("Environment not found in workspace"),{status:404});
  return environmentData.updateEnvironment({
    p_workspace_id:params.workspaceId,p_actor_id:params.actorId,p_environment_id:params.environmentId,p_name:name,p_status:params.status,p_is_default:params.isDefault,
    p_cms_base_url:normalizeUrl(params.cmsBaseUrl),p_public_site_urls:normalizePublicUrls(params.publicSiteUrls),p_database_provider:params.databaseProvider?.trim()||null,p_storage_provider:params.storageProvider?.trim()||null,p_runtime_provider:params.runtimeProvider?.trim()||null,p_config_json:params.config??{},
  });
}
