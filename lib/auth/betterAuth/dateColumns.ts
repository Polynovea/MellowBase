import type { KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs, QueryResult, RootOperationNode, UnknownRow } from "kysely";

/**
 * The shared lib/db pool returns timestamps as ISO strings, exactly as PostgREST did, so the rest of
 * the CMS sees identical shapes on both data paths. Better Auth compares its timestamps as Date
 * objects (an expiry check against a string silently fails), so its own Kysely instance converts
 * them back. Only Better Auth's timestamp columns are touched, and only on its instance.
 */
export const AUTH_DATE_COLUMNS = new Set([
  "createdAt", "updatedAt", "expiresAt", "lockedUntil", "banExpires", "accessTokenExpiresAt", "refreshTokenExpiresAt",
]);

export class AuthDateColumnsPlugin implements KyselyPlugin {
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return args.node;
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const rows = args.result.rows.map((row) => {
      let copy: UnknownRow | null = null;
      for (const key of Object.keys(row)) {
        const value = row[key];
        if (typeof value === "string" && AUTH_DATE_COLUMNS.has(key)) {
          copy ??= { ...row };
          copy[key] = new Date(value);
        }
      }
      return copy ?? row;
    });
    return { ...args.result, rows };
  }
}
