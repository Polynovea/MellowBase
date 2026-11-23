// Content area: webhook subscriptions and deliveries, with the backend dispatcher (the `content`
// switch). webhookService.ts keeps secrets, signing, URL safety, the request and the retry rules.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/content/webhookData.postgres";
import * as supabase from "@/lib/content/webhookData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("content") ? direct : supabase);

export const insertSubscription: typeof supabase.insertSubscription = (...args) => impl().insertSubscription(...args);
export const listSubscriptions: typeof supabase.listSubscriptions = (...args) => impl().listSubscriptions(...args);
export const listDeliveries: typeof supabase.listDeliveries = (...args) => impl().listDeliveries(...args);
export const setSubscriptionActive: typeof supabase.setSubscriptionActive = (...args) => impl().setSubscriptionActive(...args);
export const replaceSigningSecret: typeof supabase.replaceSigningSecret = (...args) => impl().replaceSigningSecret(...args);
export const queueEvent: typeof supabase.queueEvent = (...args) => impl().queueEvent(...args);
export const deliveryForDispatch: typeof supabase.deliveryForDispatch = (...args) => impl().deliveryForDispatch(...args);
export const markDeliveryRunning: typeof supabase.markDeliveryRunning = (...args) => impl().markDeliveryRunning(...args);
export const recordDeliveryOutcome: typeof supabase.recordDeliveryOutcome = (...args) => impl().recordDeliveryOutcome(...args);
