import type pg from "pg";

/** A stand-in for a pg.Client in unit tests: records every statement and parameter it is sent. */
export interface FakeClient {
  client: pg.Client;
  statements: string[];
  params: unknown[][];
  ended: () => boolean;
  config?: pg.ClientConfig;
}

export type Route = [RegExp, (params: unknown[]) => { rows: Record<string, unknown>[] } | Error];

export function fakeClient(routes: Route[] = [], config?: pg.ClientConfig): FakeClient {
  const statements: string[] = [];
  const params: unknown[][] = [];
  let ended = false;
  const holder = {
    password: config?.password,
    connectionParameters: { password: config?.password },
    async connect() {},
    async query(text: string, values: unknown[] = []) {
      if (ended) throw new Error("Client was closed");
      statements.push(text);
      params.push(values);
      for (const [pattern, respond] of routes) {
        if (pattern.test(text)) {
          const result = respond(values);
          if (result instanceof Error) throw result;
          return result;
        }
      }
      return { rows: [] };
    },
    async end() {
      ended = true;
    },
    on() {
      return holder;
    },
    escapeLiteral(value: string) {
      return `'${value.replace(/'/g, "''")}'`;
    },
  };
  return { client: holder as unknown as pg.Client, statements, params, ended: () => ended, config };
}

/** Routes that make a fake admin client look like a managed-database admin on PostgreSQL 16. */
export function adminRoutes(state: { ledger?: boolean; core?: boolean; installation?: boolean; installed?: boolean; installationOwner?: string } = {}): Route[] {
  return [
    [/to_regclass\('public\.installation'\) is not null as has_installation/, () => ({ rows: [{
      has_installation: state.installation ?? false,
      has_ledger: state.ledger ?? false,
      has_core: state.core ?? false,
      installation_owner: state.installation ? (state.installationOwner ?? "polynovea_owner") : null,
    }] })],
    [/select exists \(select 1 from public\.installation\)/, () => ({ rows: [{ installed: state.installed ?? false }] })],
    [/as superuser, current_setting/, () => ({ rows: [{ superuser: false, member: false, version: 160000 }] })],
    [/unnest\(\$1::text\[\]\)/, () => ({ rows: [] })],
    [/rolsuper or rolcreaterole or rolcreatedb or rolbypassrls\)/, () => ({ rows: [] })],
  ];
}

/** Routes for a fake owner client whose app role has exactly its intended limits. */
export function ownerRoutes(problems: { bypass?: boolean; schemas?: string[]; missingPolicy?: string[] } = {}): Route[] {
  return [
    [/as create_schemas/, () => ({ rows: [{ bypass: problems.bypass ?? false, create_schemas: problems.schemas ?? [], create_database: false, temporary: false, member_of: [], owned: "0" }] })],
    [/polynovea_app_all|p\.cmd = 'ALL'/, () => ({ rows: (problems.missingPolicy ?? []).map((relname) => ({ relname })) })],
  ];
}
