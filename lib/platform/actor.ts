// Platform area: workspace lookup and the CMS actor (permission) resolver, with the backend
// dispatcher. Each function runs on Supabase (actor.supabase.ts) or directly on PostgreSQL
// (actor.postgres.ts), chosen per call by the `platform` switch in POLYNOVEA_DATA_BACKEND.
// Both implementations keep the same signatures and return shapes.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/platform/actor.postgres";
import * as supabase from "@/lib/platform/actor.supabase";

export type { WorkspaceCollaborator, WorkspaceRole } from "@/lib/platform/actor.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("platform") ? direct : supabase);

export const getDefaultWorkspace: typeof supabase.getDefaultWorkspace = (...args) => impl().getDefaultWorkspace(...args);
export const getWorkspaceById: typeof supabase.getWorkspaceById = (...args) => impl().getWorkspaceById(...args);
export const resolveActor: typeof supabase.resolveActor = (...args) => impl().resolveActor(...args);
export const listWorkspaceRoles: typeof supabase.listWorkspaceRoles = (...args) => impl().listWorkspaceRoles(...args);
export const listWorkspaceCollaborators: typeof supabase.listWorkspaceCollaborators = (...args) => impl().listWorkspaceCollaborators(...args);
