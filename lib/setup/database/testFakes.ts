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
export interface FakeDatabaseState {
  ledger?: boolean;
  /** The workspaces table (core tables) exists. */
  core?: boolean;
  installation?: boolean;
  admins?: boolean;
  members?: boolean;
  content?: boolean;
  /** Result of the "installation row or any install probe" check, read as the owner. */
  inUse?: boolean;
  /** Owners of the Polynovea tables that exist (default polynovea_owner). */
  owners?: readonly string[];
  /** Other databases relying on the cluster-wide roles. */
  rolesElsewhere?: { role: string; database: string }[];
}

export function adminRoutes(state: FakeDatabaseState = {}): Route[] {
  const present = [
    state.ledger && "polynovea_migration_ledger",
    state.installation && "installation",
    state.admins && "admin_users",
    state.members && "workspace_members",
    state.content && "content_entries",
    state.core && "workspaces",
  ].filter(Boolean);
  return [
    [/as present,/, () => ({ rows: [{ present, owners: state.owners ?? (present.length ? ["polynovea_owner"] : []) }] })],
    [/as in_use$/, () => ({ rows: [{ in_use: state.inUse ?? false }] })],
    [/with roles as/, () => ({ rows: state.rolesElsewhere ?? [] })],
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
