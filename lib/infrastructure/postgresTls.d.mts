export interface PostgresConnectionConfig {
  connectionString: string;
  ssl: false | { rejectUnauthorized: true; ca?: string[] };
}

export function postgresConnectionConfig(connectionString: string, env?: Record<string, string | undefined>): PostgresConnectionConfig;
