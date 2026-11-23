// Operations area (delivery jobs): types.
//
// The queries run on PostgreSQL in deliveryJobService.postgres.ts.
import * as postgres from "@/lib/operations/deliveryJobService.postgres";

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


export const enqueueDeliveryJob = postgres.enqueueDeliveryJob;
export const listDeliveryJobs = postgres.listDeliveryJobs;
export const getDeliveryJob = postgres.getDeliveryJob;
export const replayDeliveryJob = postgres.replayDeliveryJob;
export const cancelDeliveryJob = postgres.cancelDeliveryJob;
export const listDestinationHealth = postgres.listDestinationHealth;
