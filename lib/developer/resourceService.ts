import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/developer/resourceService.postgres";
import * as supabase from "@/lib/developer/resourceService.supabase";
import { getModel, getVersion, listModels } from "@/lib/schema/modelService";
import { getEntry, listEntryVersions } from "@/lib/content/entryService";

export async function getModelByApiKey(workspaceId:string,apiKey:string){return (await listModels(workspaceId)).find(m=>m.api_key===apiKey)??null;}
export async function getEntryDeveloperView(workspaceId:string,entryId:string){
  const entry=await getEntry(workspaceId,entryId);if(!entry)return null;
  const model=await getModel(workspaceId,entry.content_model_id);if(!model)return null;
  const versions=await listEntryVersions(entry.id);
  return {entry,model:{id:model.id,apiKey:model.api_key,name:model.name,currentSchemaVersion:model.current_schema_version,capability:model.settings_json?.capability??"publishable"},versions};
}
// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("developer") ? direct : supabase);

export const listDeveloperEntries: typeof supabase.listDeveloperEntries = (...args) => impl().listDeveloperEntries(...args);
export async function getModelContract(workspaceId:string,apiKey:string){const model=await getModelByApiKey(workspaceId,apiKey);if(!model)return null;const version=await getVersion(model.id,model.current_schema_version);return version?{model,version}:null;}
