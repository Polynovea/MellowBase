import { randomUUID } from "node:crypto";
import * as connectionData from "@/lib/infrastructure/connectionData";
import * as environmentData from "@/lib/infrastructure/environmentData";
import { getConnectorDefinition, listConnectorDefinitions, validateConnectorConfiguration } from "@/lib/infrastructure/connectorRegistry";
import { prepareCredentialForProvider, redactCredentials, resolveConnectionCredentials } from "@/lib/infrastructure/credentialProvider";
import type { ConnectionSafeView, EnvironmentKind, SecretProviderKind, WorkspaceConnectionRow } from "@/lib/infrastructure/types";

export function getConnectorCatalog(){return listConnectorDefinitions();}

export async function listConnections(workspaceId:string):Promise<ConnectionSafeView[]> {
  const {connections,environments,bindings,refs,providers,verifications}=await connectionData.connectionRows(workspaceId);
  const envMap=new Map((environments??[]).map(e=>[e.id,e]));const refMap=new Map((refs??[]).map(r=>[r.id,r]));const providerMap=new Map((providers??[]).map(p=>[p.id,p.provider_kind as SecretProviderKind]));
  return (connections??[] as WorkspaceConnectionRow[]).map(connection=>({
    ...connection,
    environment:envMap.get(connection.environment_id)??null,
    secrets:(bindings??[]).filter(b=>b.connection_id===connection.id).map(binding=>{const ref=refMap.get(binding.secret_ref_id);if(!ref)return null;const providerKind=providerMap.get(ref.provider_id)??"external";return{id:ref.id,purpose:binding.purpose,label:ref.label,state:ref.state,providerKind,locator:providerKind==="environment"?ref.locator:undefined,maskedHint:ref.masked_hint,lastVerifiedAt:ref.last_verified_at,rotatedAt:ref.rotated_at};}).filter(Boolean) as ConnectionSafeView["secrets"],
    latestVerification:(verifications??[]).find(v=>v.connection_id===connection.id)??null,
  }));
}

export async function getConnection(workspaceId:string,connectionId:string){return (await listConnections(workspaceId)).find(c=>c.id===connectionId)??null;}

type CredentialInput={purpose:string;value?:string|null;locator?:string|null};
export async function createConnection(params:{workspaceId:string;actorId:string;environmentId:string;connectorType:string;name:string;config?:Record<string,unknown>;secretProviderId?:string|null;credentials?:CredentialInput[]}){
  const environment=await connectionData.environmentInWorkspace(params.workspaceId,params.environmentId);
  if(!environment)throw Object.assign(new Error("Environment not found"),{status:404});
  const providerId=params.secretProviderId||environment.secret_provider_id;if(!providerId)throw new Error("Environment has no active credential provider");
  const provider=await connectionData.environmentProvider(params.workspaceId,params.environmentId,providerId);
  if(!provider||provider.status!=="active")throw new Error("Active credential provider not found");
  const definition=getConnectorDefinition(params.connectorType);if(!definition)throw new Error("Unsupported connector type");
  const supplied=new Map((params.credentials??[]).map(item=>[item.purpose,item]));
  const prepared=[];
  for(const credential of definition.credentials){
    const input=supplied.get(credential.purpose);const hasExplicit=Boolean(input?.value?.trim()||input?.locator?.trim());
    if(!credential.required&&!hasExplicit)continue;
    prepared.push(prepareCredentialForProvider({providerKind:provider.provider_kind as SecretProviderKind,purpose:credential.purpose,label:credential.label,value:input?.value,locator:input?.locator,defaultLocator:credential.defaultEnvironmentVariable,metadata:{connectorType:definition.type}}));
  }
  validateConnectorConfiguration(definition.type,params.config??{},prepared.map(p=>p.purpose));
  const name=params.name.trim();if(!name)throw new Error("Connection name is required");
  return connectionData.createConnection({p_workspace_id:params.workspaceId,p_actor_id:params.actorId,p_environment_id:params.environmentId,p_connector_type:definition.type,p_connector_family:definition.family,p_name:name,p_config_json:params.config??{},p_secret_provider_id:provider.id,p_secrets:prepared},definition.type==="analytics.ga4");
}

export async function rotateConnectionCredential(params:{workspaceId:string;actorId:string;connectionId:string;purpose:string;value?:string|null;locator?:string|null;approvalRequestId?:string|null}){
  const connection=await connectionData.connectionRow(params.workspaceId,params.connectionId);if(!connection)throw Object.assign(new Error("Connection not found"),{status:404});
  const environment=await connectionData.environmentInWorkspace(params.workspaceId,connection.environment_id);if(!environment)throw new Error("Connection environment is unavailable");
  const definition=getConnectorDefinition(connection.connector_type);if(!definition)throw new Error("Connector definition is unavailable");const credential=definition.credentials.find(c=>c.purpose===params.purpose);if(!credential)throw new Error("Unsupported credential purpose for this connector");
  const binding=await connectionData.secretBinding(params.workspaceId,params.connectionId,params.purpose);if(!binding)throw Object.assign(new Error("Credential binding not found"),{status:404});
  const ref=await environmentData.secretRef(binding.secret_ref_id,params.workspaceId);if(!ref)throw new Error("Credential reference not found");
  const provider=await environmentData.secretProvider(ref.provider_id,params.workspaceId);if(!provider||provider.status!=="active")throw new Error("Credential provider is unavailable");
  const prepared=prepareCredentialForProvider({providerKind:provider.provider_kind as SecretProviderKind,purpose:credential.purpose,label:credential.label,value:params.value,locator:params.locator,defaultLocator:credential.defaultEnvironmentVariable,metadata:{connectorType:definition.type}});
  let approvalRequestId=params.approvalRequestId??null;
  if(environment.kind==="production"&&!approvalRequestId){const approved=await connectionData.approvedRotationRequests(params.workspaceId,environment.id,params.connectionId);approvalRequestId=approved.find(a=>(!a.expires_at||new Date(a.expires_at)>new Date())&&(!a.request_json?.purpose||a.request_json.purpose===params.purpose))?.id??null;}
  if(environment.kind==="production"&&!approvalRequestId)throw Object.assign(new Error("Production credential rotation requires approval. Request it from Setup & Infrastructure, then retry."),{status:409,requiresApproval:true});
  const data=await connectionData.rotateSecret({p_workspace_id:params.workspaceId,p_actor_id:params.actorId,p_connection_id:params.connectionId,p_purpose:params.purpose,p_locator:prepared.locator,p_encrypted_value:prepared.encryptedValue,p_masked_hint:prepared.maskedHint,p_metadata:prepared.metadata,p_approval_request_id:approvalRequestId});
  return {id:data.id,state:data.state,maskedHint:data.masked_hint,rotatedAt:data.rotated_at,locator:provider.provider_kind==="environment"?data.locator:undefined};
}

export async function verifyConnection(params:{workspaceId:string;actorId:string;connectionId:string}){
  const connection=await connectionData.connectionRow(params.workspaceId,params.connectionId);if(!connection)throw Object.assign(new Error("Connection not found"),{status:404});
  if(!connection.active)throw Object.assign(new Error("Disabled connections cannot be verified"),{status:409});
  const environment=await connectionData.environmentInWorkspace(params.workspaceId,connection.environment_id);if(!environment)throw new Error("Connection environment is unavailable");
  const definition=getConnectorDefinition(connection.connector_type);if(!definition)throw new Error("Connector definition is unavailable");
  const correlationId=randomUUID(),started=Date.now();await connectionData.markVerifying(params.workspaceId,connection.id);
  let credentials:Record<string,string>={};
  try{
    credentials=await resolveConnectionCredentials(params.workspaceId,connection.id);
    validateConnectorConfiguration(definition.type,connection.config_json??{},Object.keys(credentials));
    const outcome=await definition.verify({config:connection.config_json??{},credentials,environmentKind:environment.kind as EnvironmentKind});
    return await connectionData.recordVerification({p_workspace_id:params.workspaceId,p_actor_id:params.actorId,p_connection_id:connection.id,p_status:outcome.status,p_checks:outcome.checks,p_safe_evidence:outcome.safeEvidence??{},p_error_code:outcome.errorCode??null,p_error_message:outcome.errorMessage??null,p_duration_ms:Date.now()-started,p_correlation_id:correlationId});
  }catch(error){
    const message=redactCredentials(error instanceof Error?error.message:"Connection verification failed",credentials);
    const data=await connectionData.recordVerification({p_workspace_id:params.workspaceId,p_actor_id:params.actorId,p_connection_id:connection.id,p_status:"failed",p_checks:[{key:"verification",label:"Connection verification",status:"failed",message}],p_safe_evidence:{connectorType:definition.type},p_error_code:"VERIFICATION_FAILED",p_error_message:message,p_duration_ms:Date.now()-started,p_correlation_id:correlationId}).catch(()=>null);
    if(data)return data;throw new Error(message);
  }
}
