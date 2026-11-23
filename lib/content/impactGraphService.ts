import { getEntry } from "@/lib/content/entryService";
import * as impactData from "@/lib/content/impactData";

export interface GraphEdge {
  entryId: string;
  field: string;
  relationType: string;
  status: string;
  active: boolean;
  targetType?: "entry" | "asset" | "term" | "route" | "menu";
  targetId?: string;
  sourceType?: "entry" | "menu" | "route" | "redirect" | "translation" | "release";
}

export interface AssetUsageReference {
  entryId: string;
  versionId: string;
  title: string;
  fieldKey: string;
  status: string;
  isPublished: boolean;
}

export interface ImpactDestination {
  routeId: string;
  path: string;
  locale: string;
  canonical: boolean;
  indexingPolicy: string;
  dependentSources: Array<{ sourceType: string; sourceId: string; relationType: string }>;
}

export interface ImpactReport {
  entryId: string;
  dependencies: GraphEdge[];
  dependents: GraphEdge[];
  releaseIds: string[];
  destinations: ImpactDestination[];
  sourceTypeCounts: Record<string, number>;
  publishedDependents: number;
  totalImpact: number;
}

async function activeEntries(workspaceId: string, ids: string[]) {
  if (!ids.length) {
    return new Map<string, { status: string; current_draft_version_id: string | null; published_version_id: string | null }>();
  }
  const data = await impactData.entryStates(workspaceId, ids);
  return new Map(data.map((item) => [item.id, item]));
}

export async function getDependencies(workspaceId: string, entryId: string): Promise<GraphEdge[] | null> {
  const entry = await getEntry(workspaceId, entryId);
  if (!entry?.current_draft_version_id) return null;

  const data = await impactData.outgoingRelations(workspaceId, entry.id, entry.current_draft_version_id);

  const entryTargetIds = data.map((item) => item.target_entry_id).filter((id): id is string => Boolean(id));
  const targets = await activeEntries(workspaceId, entryTargetIds);

  return data.map((item) => {
    if (item.target_entry_id) {
      const t = targets.get(item.target_entry_id);
      return {
        entryId: item.target_entry_id,
        field: item.source_field_key,
        relationType: item.relation_type,
        status: t?.status || "unknown",
        active: Boolean(t),
        targetType: "entry" as const,
        targetId: item.target_entry_id,
      };
    }
    if (item.target_asset_id) {
      return {
        entryId: item.target_asset_id,
        field: item.source_field_key,
        relationType: item.relation_type,
        status: "active",
        active: true,
        targetType: "asset" as const,
        targetId: item.target_asset_id,
      };
    }
    if (item.target_term_id) {
      return {
        entryId: item.target_term_id,
        field: item.source_field_key,
        relationType: item.relation_type,
        status: "active",
        active: true,
        targetType: "term" as const,
        targetId: item.target_term_id,
      };
    }
    if (item.target_route_id) {
      return {
        entryId: item.target_route_id,
        field: item.source_field_key,
        relationType: item.relation_type,
        status: "active",
        active: true,
        targetType: "route" as const,
        targetId: item.target_route_id,
      };
    }
    return {
      entryId: item.target_menu_id || "unknown",
      field: item.source_field_key,
      relationType: item.relation_type,
      status: "active",
      active: true,
      targetType: "menu" as const,
      targetId: item.target_menu_id || undefined,
    };
  });
}

export async function getDependents(workspaceId: string, entryId: string): Promise<GraphEdge[] | null> {
  const target = await getEntry(workspaceId, entryId);
  if (!target) return null;

  const data = await impactData.incomingRelations(workspaceId, target.id);

  const sourceIds = [...new Set(data.map((item) => item.source_entry_id).filter(Boolean))];
  const sources = await activeEntries(workspaceId, sourceIds as string[]);

  return data.flatMap((item): GraphEdge[] => {
    if (item.source_release_id) {
      return [{ entryId: item.source_release_id, field: item.source_field_key || "release_item", relationType: item.relation_type, status: "active", active: true, sourceType: "release" as const, targetType: "entry" as const, targetId: target.id }];
    }
    if (item.source_translation_id) {
      return [{ entryId: item.source_translation_id, field: item.source_field_key || "translation", relationType: item.relation_type, status: "active", active: true, sourceType: "translation" as const, targetType: "entry" as const, targetId: target.id }];
    }
    if (item.source_redirect_id) {
      return [{ entryId: item.source_redirect_id, field: item.source_field_key || "redirect", relationType: item.relation_type, status: "active", active: true, sourceType: "redirect" as const, targetType: "entry" as const, targetId: target.id }];
    }
    if (item.source_menu_id) {
      return [{
        entryId: item.source_menu_id,
        field: item.source_field_key || "menu_item",
        relationType: item.relation_type,
        status: "active",
        active: true,
        targetType: "menu" as const,
        targetId: target.id,
        sourceType: "menu" as const,
      }];
    }
    if (item.source_route_id) {
      return [{
        entryId: item.source_route_id,
        field: item.source_field_key || "route_entry",
        relationType: item.relation_type,
        status: "active",
        active: true,
        targetType: "route" as const,
        targetId: target.id,
        sourceType: "route" as const,
      }];
    }
    const source = sources.get(item.source_entry_id);
    if (!source || (source.current_draft_version_id !== item.source_version_id && source.published_version_id !== item.source_version_id)) {
      return [];
    }
    return [{
      entryId: item.source_entry_id,
      field: item.source_field_key,
      relationType: item.relation_type,
      status: source.status,
      active: true,
      targetType: "entry" as const,
      targetId: target.id,
      sourceType: "entry" as const,
    }];
  });
}

export async function getImpact(workspaceId: string, entryId: string): Promise<ImpactReport | null> {
  const [dependencies, dependents] = await Promise.all([
    getDependencies(workspaceId, entryId),
    getDependents(workspaceId, entryId),
  ]);

  if (!dependencies || !dependents) return null;

  const releaseIds = [...new Set(await impactData.releaseIdsForEntry(workspaceId, entryId))];
  const { routes, routeRelations } = await impactData.destinationRows(workspaceId, entryId);
  const sourceOf = (edge: Record<string, string | null>) => {
    if (edge.source_release_id) return { sourceType: "release", sourceId: edge.source_release_id };
    if (edge.source_translation_id) return { sourceType: "translation", sourceId: edge.source_translation_id };
    if (edge.source_redirect_id) return { sourceType: "redirect", sourceId: edge.source_redirect_id };
    if (edge.source_menu_id) return { sourceType: "menu", sourceId: edge.source_menu_id };
    if (edge.source_route_id) return { sourceType: "route", sourceId: edge.source_route_id };
    return edge.source_entry_id ? { sourceType: "entry", sourceId: edge.source_entry_id } : null;
  };
  const destinations: ImpactDestination[] = routes.map((route) => ({
    routeId: route.id, path: route.path, locale: route.locale, canonical: route.is_canonical, indexingPolicy: route.indexing_policy,
    dependentSources: routeRelations.filter((edge) => edge.target_route_id === route.id).flatMap((edge) => { const source = sourceOf(edge as Record<string, string | null>); return source ? [{ ...source, relationType: String(edge.relation_type) }] : []; }),
  }));
  const sourceTypeCounts: Record<string, number> = {};
  for (const edge of dependents) sourceTypeCounts[edge.sourceType ?? "entry"] = (sourceTypeCounts[edge.sourceType ?? "entry"] ?? 0) + 1;
  for (const destination of destinations) for (const source of destination.dependentSources) sourceTypeCounts[source.sourceType] = (sourceTypeCounts[source.sourceType] ?? 0) + 1;
  const publishedDependents = dependents.filter((item) => item.status === "published").length;

  return {
    entryId, dependencies, dependents, releaseIds, destinations, sourceTypeCounts, publishedDependents,
    totalImpact: dependents.length + releaseIds.length + destinations.reduce((sum, destination) => sum + destination.dependentSources.length, 0),
  };
}

/**
 * Unified Asset Usage Graph:
 * Finds all content entries, navigation menus, and routes that reference this asset.
 */
export async function getAssetUsageGraph(workspaceId: string, assetId: string): Promise<AssetUsageReference[]> {
  const { relations, versions, menus, routes } = await impactData.assetUsageRows(workspaceId, assetId);
  const entryIds = [...new Set(relations.map((r) => r.source_entry_id).filter(Boolean))];
  const entriesMap = await activeEntries(workspaceId, entryIds as string[]);
  const titlesMap = new Map<string, string>();
  for (const v of versions) titlesMap.set(v.id, String(v.data_jsonb?.title || v.data_jsonb?.name || "Untitled Entry"));
  const menuMap = new Map(menus.map((m) => [m.id, m.name]));
  const routeMap = new Map(routes.map((rt) => [rt.id, rt.path]));

  const results: AssetUsageReference[] = [];
  for (const r of relations) {
    if (r.source_menu_id) {
      results.push({
        entryId: r.source_menu_id,
        versionId: r.source_menu_id,
        title: menuMap.get(r.source_menu_id) || "Navigation Menu",
        fieldKey: r.source_field_key || "menu_item",
        status: "active",
        isPublished: true,
      });
      continue;
    }
    if (r.source_route_id) {
      results.push({
        entryId: r.source_route_id,
        versionId: r.source_route_id,
        title: routeMap.get(r.source_route_id) || "Route",
        fieldKey: r.source_field_key || "route_asset",
        status: "active",
        isPublished: true,
      });
      continue;
    }
    if (r.source_entry_id) {
      const entry = entriesMap.get(r.source_entry_id);
      if (!entry) continue;

      const isPublished = entry.published_version_id === r.source_version_id;
      results.push({
        entryId: r.source_entry_id,
        versionId: r.source_version_id,
        title: titlesMap.get(r.source_version_id) || `Entry ${r.source_entry_id.slice(0, 8)}`,
        fieldKey: r.source_field_key,
        status: entry.status,
        isPublished,
      });
    }
  }

  return results;
}
