// Operations area (delivery jobs): types and the backend dispatcher.
//
// Each function runs on Supabase (deliveryJobService.supabase.ts) or directly on PostgreSQL
// (deliveryJobService.postgres.ts), chosen per call by the `operations` switch in
// POLYNOVEA_DATA_BACKEND. Both keep the same signatures and return shapes.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/operations/deliveryJobService.postgres";
import * as supabase from "@/lib/operations/deliveryJobService.supabase";

export type DeliveryJobKind =
  | "publish"
  | "scheduled_release"
  | "webhook"
  | "search_index"
  | "image_processing"
  | "health_scan"
  | "analytics_sync";

export type DeliveryJobStatus = "queued" | "running" | "retrying" | "succeeded" | "dead_letter" | "cancelled";

export interface EnqueueDeliveryJobInput {
  workspaceId: string;
  actorId?: string | null;
  kind: DeliveryJobKind;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  safeMetadata?: Record<string, unknown>;
  runAfter?: string;
  priority?: number;
  maxAttempts?: number;
  queueName?: string;
  correlationId?: string | null;
}

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("operations") ? direct : supabase);

export const enqueueDeliveryJob: typeof supabase.enqueueDeliveryJob = (...args) => impl().enqueueDeliveryJob(...args);
export const listDeliveryJobs: typeof supabase.listDeliveryJobs = (...args) => impl().listDeliveryJobs(...args);
export const getDeliveryJob: typeof supabase.getDeliveryJob = (...args) => impl().getDeliveryJob(...args);
export const replayDeliveryJob: typeof supabase.replayDeliveryJob = (...args) => impl().replayDeliveryJob(...args);
export const cancelDeliveryJob: typeof supabase.cancelDeliveryJob = (...args) => impl().cancelDeliveryJob(...args);
export const listDestinationHealth: typeof supabase.listDestinationHealth = (...args) => impl().listDestinationHealth(...args);
